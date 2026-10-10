"""DifSync PC energy ledger: 5-second power integration, 15-minute kWh.

Records *estimated* AC watts from CPU/GPU sensor-informed model. No physical
mains meter is present. Tariff A-1 ToU is a user-unconfirmed illustrative
IESCO tariff profile; household slab and pass-through charges are unknown.
"""
from __future__ import annotations

import datetime as dt
import html
import re
import json
import logging
import math
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STORE = ROOT / "var" / "power-energy"
DB = STORE / "energy.sqlite3"
SETTINGS = STORE / "tariff.json"
OFFICIAL_CACHE = STORE / "official-iesco.json"
SAMPLE_SECONDS = 5.0
MAX_GAP_SECONDS = 15.0
SOURCE_URL = "https://www.iesco.com.pk/tariff-guide"
# IESCO S.R.O. 279(I)/2026 February 2026, A-1 residential TOU.
DEFAULT = {
    "provider": "IESCO",
    "mode": "iesco_tou",
    "confirmed": False,
    "auto_refresh_official": True,
    "peak_rate_pkr_kwh": 46.85,
    "offpeak_rate_pkr_kwh": 34.53,
    "flat_rate_pkr_kwh": 50.0,
    "tax_percent": 0.0,
}
_BOUNDS = {
    "peak_rate_pkr_kwh": (0.01, 500),
    "offpeak_rate_pkr_kwh": (0.01, 500),
    "flat_rate_pkr_kwh": (0.01, 500),
    "tax_percent": (0, 100),
}
_LOCK = threading.RLock()
_PREVIOUS = None
_WORKER = None
_TARIFF_WORKER = None
_LAST_TARIFF_ERROR = None
_LAST_VALID = None
_LAST_ERROR = None

def _number(value, lo, hi):
    if isinstance(value, bool):
        raise ValueError("Expected a numeric value")
    try:
        n = float(value)
    except (TypeError, ValueError):
        raise ValueError("Expected a numeric value") from None
    if not math.isfinite(n) or not lo <= n <= hi:
        raise ValueError("Electricity tariff value outside permitted range")
    return n

def tariff():
    result = dict(DEFAULT)
    try:
        raw = json.loads(SETTINGS.read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            for k, (low, high) in _BOUNDS.items():
                if k in raw: result[k] = _number(raw[k], low, high)
            if raw.get("mode") in ("iesco_tou", "flat_manual"):
                result["mode"] = raw["mode"]
            if isinstance(raw.get("confirmed"), bool):
                result["confirmed"] = raw["confirmed"]
            if isinstance(raw.get("auto_refresh_official"), bool):
                result["auto_refresh_official"] = raw["auto_refresh_official"]
    except (OSError, ValueError, TypeError):
        pass
    result["provider"] = "IESCO"
    result["source_url"] = SOURCE_URL
    result["source_effective"] = "S.R.O. 279(I)/2026, February 2026 (published base rates)"
    result["last_official_check"] = None
    result["source_checked_today"] = False
    result["official_lookup_error"] = _LAST_TARIFF_ERROR
    if result["auto_refresh_official"] and result["mode"] == "iesco_tou":
        try:
            check = json.loads(OFFICIAL_CACHE.read_text(encoding="utf-8"))
            verified = float(check["checked_at"])
            p = _number(check["peak_rate_pkr_kwh"],0.01,500)
            off = _number(check["offpeak_rate_pkr_kwh"],0.01,500)
            if verified > 0 and p > off:
                result["peak_rate_pkr_kwh"] = p
                result["offpeak_rate_pkr_kwh"] = off
                result["source_effective"] = str(check.get("published_sro") or result["source_effective"])
                result["last_official_check"] = dt.datetime.fromtimestamp(verified).isoformat(timespec="minutes")
                result["source_checked_today"] = dt.date.fromtimestamp(verified)==dt.date.today()
        except (OSError,ValueError,TypeError,KeyError):
            pass
    return result

def update_tariff(changes):
    if not isinstance(changes, dict) or not changes:
        raise ValueError("Tariff settings must be supplied")
    if any(k not in (*_BOUNDS, "mode", "confirmed", "auto_refresh_official") for k in changes):
        raise ValueError("Unsupported electricity tariff setting")
    with _LOCK:
        result = tariff()
        for k, value in changes.items():
            if k in _BOUNDS:
                result[k] = _number(value, *_BOUNDS[k])
            elif k == "mode":
                if value not in ("iesco_tou", "flat_manual"):
                    raise ValueError("Select ToU or single-rate tariff")
                result[k] = value
            elif k in ("confirmed", "auto_refresh_official"):
                if not isinstance(value, bool):
                    raise ValueError(k + " must be true or false")
                result[k] = value
        # Choosing a tariff alone doesn't constitute verification against bill.
        # Frontend requires explicit confirmation, never auto-enables it.
        STORE.mkdir(parents=True, exist_ok=True)
        tmp = SETTINGS.with_suffix(".json.tmp")
        tmp.write_text(json.dumps({k: result[k] for k in DEFAULT}, indent=2), encoding="utf-8")
        tmp.replace(SETTINGS)
        return result

def _check_official():
    """Read IESCO A-1 residential ToU base prices, never FCA/tax or final bill."""
    import requests
    resp = requests.get(SOURCE_URL,timeout=12,headers={
        "User-Agent":"DifSync-LocalEnergy/1.0 (public tariff check)"})
    resp.raise_for_status()
    # Only parse the IESCO residential A-1 section, not commercial/industrial.
    words = re.sub(r"\s+"," ",html.unescape(re.sub(r"<[^>]*>"," ",resp.text)))
    head = words.find("A-1 GENERAL SUPPLY TARIFF")
    tail = words.find("A-2 GENERAL SUPPLY TARIFF", head+3)
    if head < 0 or tail < head:
        raise ValueError("Official page has no identifiable residential A-1 table")
    section = words[head:tail]
    found = re.search(r"Time Of Use\s*-\s*[\d,]+\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)",
                      section,re.IGNORECASE)
    if not found:
        raise ValueError("Official A-1 peak/offpeak rates could not be verified")
    peak,off = map(float,found.groups())
    if not (15 <= off < peak <= 150):
        raise ValueError("Unusual tariff values, retaining last verified prices")
    sro = re.search(r"S\.R\.O\s*No\.\s*[\d]+\s*\(I\)/\d{4}[^A]*",words)
    return {
      "peak_rate_pkr_kwh":peak,
      "offpeak_rate_pkr_kwh":off,
      "published_sro":(sro.group(0).strip()[:100] if sro else "IESCO A-1 tariff guide"),
      "checked_at":time.time(),
      "source_url":SOURCE_URL
    }

def refresh_official(force=False):
    global _LAST_TARIFF_ERROR
    with _LOCK:
        if not force:
            try:
                cached = json.loads(OFFICIAL_CACHE.read_text(encoding="utf-8"))
                if dt.date.fromtimestamp(float(cached["checked_at"])) == dt.date.today():
                    return False
            except (OSError,ValueError,TypeError,KeyError):
                pass
    # NEVER hold the power-sampling lock across the remote HTTPS request.
    try:
        result = _check_official()
    except Exception as exc:
        _LAST_TARIFF_ERROR = str(exc)[:180]
        logging.getLogger("difsync-energy").warning("IESCO official check failed: %s",exc)
        return False
    with _LOCK:
        STORE.mkdir(parents=True,exist_ok=True)
        try:
            tmp = OFFICIAL_CACHE.with_suffix(".tmp")
            tmp.write_text(json.dumps(result,indent=2),encoding="utf-8")
            tmp.replace(OFFICIAL_CACHE)
            _LAST_TARIFF_ERROR = None
            return True
        except (OSError,ValueError) as exc:
            _LAST_TARIFF_ERROR = str(exc)[:180]
            return False

def _tariff_loop():
    # Independent network worker. Never pause 5s power sampling for HTTPS.
    while True:
        refresh_official()
        time.sleep(3600)

@contextmanager
def _db():
    STORE.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB, timeout=8)
    try:
        con.execute("""CREATE TABLE IF NOT EXISTS interval_15 (
            boot_id TEXT NOT NULL,
            bucket_start INTEGER NOT NULL,
            local_date TEXT NOT NULL,
            seconds REAL NOT NULL DEFAULT 0,
            kwh REAL NOT NULL DEFAULT 0,
            low_kwh REAL NOT NULL DEFAULT 0,
            high_kwh REAL NOT NULL DEFAULT 0,
            PRIMARY KEY(boot_id, bucket_start))""")
        # The old 20-second collector wrote to hourly. Preserve it, but do
        # not invent 15-minute subdivisions of old hourly entries.
        con.execute("""CREATE TABLE IF NOT EXISTS hourly (
            boot_id TEXT NOT NULL,
            hour_local TEXT NOT NULL,
            seconds REAL NOT NULL DEFAULT 0,
            kwh REAL NOT NULL DEFAULT 0,
            low_kwh REAL NOT NULL DEFAULT 0,
            high_kwh REAL NOT NULL DEFAULT 0,
            PRIMARY KEY(boot_id,hour_local))""")
        with con:
            yield con
    finally:
        con.close()

def _boot():
    try:
        import psutil
        timestamp = float(psutil.boot_time())
        if timestamp > 1e9:
            return str(int(timestamp)), timestamp
    except (ImportError, OSError, ValueError):
        pass
    return None, None

def _power(reading):
    try:
        if reading.get("cpu_power_status") != "measured":
            return None
        values = tuple(float(reading[key]) for key in
                       ("estimated_wall_w", "estimated_wall_low_w", "estimated_wall_high_w"))
        if all(math.isfinite(w) and 0 < w < 3000 for w in values) and values[1] <= values[0] <= values[2]:
            return values
    except (KeyError, AttributeError, ValueError, TypeError):
        pass
    return None

def _pieces(start, end):
    """Split by UTC-aligned 15-min instants, represented in PC local time."""
    t = start
    while t < end - 0.000001:
        bucket = int(math.floor(t / 900)) * 900
        finish = min(end, bucket + 900)
        if finish <= t:
            break
        yield bucket, t-start, finish-start
        t = finish

def sample(reading, *, when=None, mono=None, boot=None):
    """Integrate adjacent power readings. Never extrapolate a missing gap."""
    global _PREVIOUS, _LAST_VALID, _LAST_ERROR
    stamp = time.time() if when is None else float(when)
    tick = time.monotonic() if mono is None else float(mono)
    if boot is None:
        boot, _ = _boot()
    current = (stamp, tick, boot, _power(reading))
    with _LOCK:
        previous, _PREVIOUS = _PREVIOUS, current
        if not boot or current[3] is None:
            return False
        _LAST_VALID = stamp
        if previous is None or previous[2] != boot or previous[3] is None:
            return False
        seconds = tick - previous[1]
        clock_seconds = stamp - previous[0]
        if not 0.2 <= seconds <= MAX_GAP_SECONDS or abs(seconds-clock_seconds) > 2.0:
            return False
        segments = list(_pieces(previous[0], stamp))
        if not segments or abs(segments[-1][2]-clock_seconds) > 0.1:
            return False
        # Interpolate a changing wattage curve at each 15-minute boundary.
        # A changing load crossing 18:00 should not use one fixed wattage.
        try:
            with _db() as conn:
                for bucket, offset_a, offset_b in segments:
                    duration = seconds * (offset_b-offset_a)/clock_seconds
                    fraction_a = offset_a/clock_seconds
                    fraction_b = offset_b/clock_seconds
                    kwh = tuple(
                        ((start_w+(end_w-start_w)*fraction_a)+
                         (start_w+(end_w-start_w)*fraction_b))/2
                        *duration/3_600_000
                        for start_w,end_w in zip(previous[3],current[3])
                    )
                    label = dt.datetime.fromtimestamp(bucket).strftime("%Y-%m-%d")
                    conn.execute("""INSERT INTO interval_15
                        (boot_id,bucket_start,local_date,seconds,kwh,low_kwh,high_kwh)
                        VALUES(?,?,?,?,?,?,?)
                        ON CONFLICT(boot_id,bucket_start) DO UPDATE SET
                        seconds=seconds+excluded.seconds,
                        kwh=kwh+excluded.kwh,
                        low_kwh=low_kwh+excluded.low_kwh,
                        high_kwh=high_kwh+excluded.high_kwh""",
                        (boot,bucket,label,duration,*kwh))
            _LAST_ERROR = None
            return True
        except (OSError, sqlite3.Error) as exc:
            _LAST_ERROR = str(exc)[:180]
            return False

def peak_hours(month):
    if month in (12, 1, 2): return 17, 21
    if month in (6, 7, 8): return 19, 23
    return 18, 22  # March-May; September-November

def price_at(timestamp, settings=None):
    cfg = settings or tariff()
    local = dt.datetime.fromtimestamp(timestamp)
    hour = local.hour + local.minute/60.0
    start, end = peak_hours(local.month)
    peak = start <= hour < end
    band = "peak" if peak else "offpeak"
    if cfg["mode"] == "flat_manual":
        band = "single-rate"
        base = cfg["flat_rate_pkr_kwh"]
    else:
        base = cfg["peak_rate_pkr_kwh"] if peak else cfg["offpeak_rate_pkr_kwh"]
    return band, base * (1 + cfg["tax_percent"]/100)

def _empty():
    return {"seconds":0., "kwh":0., "low_kwh":0., "high_kwh":0.,
            "pkr":0., "low_pkr":0., "high_pkr":0.}

def _add(dst, src):
    for name in dst:
        dst[name] += src.get(name, 0)

def _public(value):
    return {
        "hours":round(value["seconds"]/3600,3),
        "kwh":round(value["kwh"],6),
        "low_kwh":round(value["low_kwh"],6),
        "high_kwh":round(value["high_kwh"],6),
        "pkr":round(value["pkr"],3),
        "low_pkr":round(value["low_pkr"],3),
        "high_pkr":round(value["high_pkr"],3),
    }

def report(now=None, wall_w=None):
    timestamp = time.time() if now is None else float(now)
    local = dt.datetime.fromtimestamp(timestamp)
    day = local.strftime("%Y-%m-%d")
    month = local.strftime("%Y-%m")
    cfg = tariff()
    boot, boot_at = _boot()
    today = _empty()
    monthly = _empty()
    uptime = _empty()
    peak_tot = _empty()
    off_tot = _empty()
    daily = {}
    months = {}
    buckets = {}
    old_today = _empty()
    old_month = _empty()
    with _LOCK:
        with _db() as conn:
            rows = conn.execute("SELECT boot_id,bucket_start,local_date,seconds,kwh,low_kwh,high_kwh"
                " FROM interval_15 ORDER BY bucket_start DESC").fetchall()
            # Keep old hourly usage but do not split or assign it a fake ToU price.
            legacy = conn.execute("SELECT boot_id,hour_local,seconds,kwh,low_kwh,high_kwh FROM hourly").fetchall()
        for record_boot, stamp, date, seconds, kwh, low_kwh, high_kwh in rows:
            bucket_id = int(stamp)
            _, rate = price_at(bucket_id + 450, cfg)
            band, _ = price_at(bucket_id + 450, cfg)
            src = dict(seconds=seconds, kwh=kwh, low_kwh=low_kwh, high_kwh=high_kwh,
                pkr=kwh*rate,low_pkr=low_kwh*rate,high_pkr=high_kwh*rate)
            stamp_month = date[:7]
            if date == day:
                _add(today,src)
                _add((peak_tot if band=="peak" else off_tot),src)
                key = bucket_id
                if key not in buckets:
                    buckets[key] = _empty()
                _add(buckets[key],src)
            if stamp_month == month:
                _add(monthly,src)
            if record_boot == boot:
                _add(uptime,src)
            if date not in daily:
                daily[date] = _empty()
            _add(daily[date],src)
            if stamp_month not in months:
                months[stamp_month] = _empty()
            _add(months[stamp_month],src)
        for old_boot, hour, seconds, kwh, low_kwh, high_kwh in legacy:
            src = dict(seconds=seconds,kwh=kwh,low_kwh=low_kwh,high_kwh=high_kwh,
                       pkr=0.,low_pkr=0.,high_pkr=0.)
            if hour.startswith(day):
                _add(old_today,src)
            if hour.startswith(month):
                _add(old_month,src)
            # Prior hourly records are explicitly unpriced so user can't
            # mistake retroactive ToU costing for real historical rates.
        try:
            watts = _number(wall_w,0,3000) if wall_w is not None else None
        except ValueError:
            watts = None
        band_now, rate_now = price_at(timestamp,cfg)
        timeline = []
        for i in range(95,-1,-1):
            key = (int(timestamp)//900-i)*900
            record = buckets.get(key,_empty())
            secs = record["seconds"]
            block_band, block_rate = price_at(key+450,cfg)
            timeline.append({
                "start":dt.datetime.fromtimestamp(key).strftime("%H:%M"),
                "epoch":key,"band":block_band,"rate":round(block_rate,2),
                "avg_w":round(record["kwh"]*3_600_000/secs,1) if secs>0 else None,
                "coverage_seconds":round(secs,2),**_public(record)
            })
        all_days = sorted(daily,reverse=True)[:31]
        all_months = sorted(months,reverse=True)[:12]
        return {
            "currency":"PKR","tariff":cfg,
            "today":_public(today),"month":_public(monthly),"uptime":_public(uptime),
            "peak_today":_public(peak_tot),"offpeak_today":_public(off_tot),
            "legacy_unpriced_today":_public(old_today),"legacy_unpriced_month":_public(old_month),
            "intervals_15m":timeline,
            "history":[{"date":d,**_public(daily[d])} for d in reversed(all_days)],
            "monthly_history":[{"month":m,**_public(months[m])} for m in all_months],
            "current_w":round(watts,1) if watts is not None else None,
            "current_band":band_now,"current_rate_pkr_kwh":round(rate_now,2),
            "cost_per_hour_pkr":round(watts/1000*rate_now,3) if watts is not None else None,
            "pc_uptime_hours":round(max(0,timestamp-boot_at)/3600,2) if boot_at else None,
            "last_valid_age_seconds":round(max(0,timestamp-_LAST_VALID),1) if _LAST_VALID is not None else None,
            "tracking_running":bool(_WORKER and _WORKER.is_alive()),
            "tracking_error":_LAST_ERROR,
            "sample_interval_seconds":SAMPLE_SECONDS,"bucket_minutes":15,
            "effective_at":local.strftime("%Y-%m-%d %H:%M:%S"),
            "tariff_note":"IESCO February 2026 published residential A-1 base tariff used as an indicative profile. Confirm that your actual meter uses ToU; FCA/QTA, slabs and bills may differ.",
            "scope":"Estimated PC-only wall AC watts, not measured from a physical meter. No household appliances, UPS losses, or unobserved time included.",
        }

def _loop(get_telemetry):
    global _LAST_ERROR
    next_tick = time.monotonic()
    while True:
        try:
            sample(get_telemetry())
        except Exception as exc:
            _LAST_ERROR = str(exc)[:180]
            logging.getLogger("difsync-energy").warning("Sampling failed: %s",exc)
        next_tick = max(next_tick+SAMPLE_SECONDS,time.monotonic()+0.25)
        time.sleep(max(0,next_tick-time.monotonic()))

def start(telemetry):
    global _WORKER, _TARIFF_WORKER
    with _LOCK:
        if not (_WORKER and _WORKER.is_alive()):
            _WORKER = threading.Thread(target=_loop,args=(telemetry,),
                name="DifSync-Energy-5s",daemon=True)
            _WORKER.start()
        if not (_TARIFF_WORKER and _TARIFF_WORKER.is_alive()):
            _TARIFF_WORKER = threading.Thread(target=_tariff_loop,
                name="DifSync-IESCO-Tariff-Check",daemon=True)
            _TARIFF_WORKER.start()
