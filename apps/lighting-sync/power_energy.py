"""DifSync local estimated PC electricity ledger. Never backfill from uptime."""
from __future__ import annotations
import calendar, datetime as dt, json, logging, math, sqlite3, threading, time
from contextlib import contextmanager
from pathlib import Path

ROOT=Path(__file__).resolve().parent
STORE=ROOT/"var"/"power-energy"
DB=STORE/"energy.sqlite3"
SETTINGS=STORE/"tariff.json"
DEFAULT={"rate_pkr_kwh":50.0,"tax_percent":0.0,"expected_hours_per_day":8.0}
BOUNDS={"rate_pkr_kwh":(0.01,500),"tax_percent":(0,100),"expected_hours_per_day":(0,24)}
_LOCK=threading.RLock()
_PREVIOUS=None
_WORKER=None
_LAST_VALID=None
_LAST_ERROR=None

def _number(value,minimum,maximum):
    if isinstance(value,bool):raise ValueError("Numeric value required")
    try:n=float(value)
    except (ValueError,TypeError):raise ValueError("Numeric value required")
    if not math.isfinite(n) or not minimum<=n<=maximum:raise ValueError("Value outside supported range")
    return n

def tariff():
    result=dict(DEFAULT)
    try:
        saved=json.loads(SETTINGS.read_text(encoding="utf-8"))
        if isinstance(saved,dict):
            for k,(minimum,maximum) in BOUNDS.items():
                if k in saved:result[k]=_number(saved[k],minimum,maximum)
    except (OSError,ValueError,TypeError):pass
    return result

def update_tariff(changes):
    if not isinstance(changes,dict) or not changes or any(k not in BOUNDS for k in changes):
        raise ValueError("Unknown or missing tariff setting")
    with _LOCK:
        new=tariff()
        for k,v in changes.items():new[k]=_number(v,*BOUNDS[k])
        STORE.mkdir(parents=True,exist_ok=True)
        tmp=SETTINGS.with_suffix(".tmp")
        tmp.write_text(json.dumps(new,indent=2),encoding="utf-8")
        tmp.replace(SETTINGS)
        return new

@contextmanager
def _db():
    STORE.mkdir(parents=True,exist_ok=True)
    conn=sqlite3.connect(DB,timeout=10)
    conn.execute("""CREATE TABLE IF NOT EXISTS hourly (
      boot_id TEXT NOT NULL, hour_local TEXT NOT NULL,
      seconds REAL NOT NULL DEFAULT 0, kwh REAL NOT NULL DEFAULT 0,
      low_kwh REAL NOT NULL DEFAULT 0, high_kwh REAL NOT NULL DEFAULT 0,
      PRIMARY KEY(boot_id,hour_local))""")
    try:
        with conn:
            yield conn
    finally:
        conn.close()

def _boot():
    try:
        import psutil
        val=float(psutil.boot_time())
        if val>1e9:return str(int(val)),val
    except (ImportError,OSError,ValueError):pass
    return None,None

def _power(sample):
    try:
        if sample.get("cpu_power_status")!="measured":return None
        v=[float(sample[k]) for k in ("estimated_wall_w","estimated_wall_low_w","estimated_wall_high_w")]
        if not all(math.isfinite(w) and 0<w<3000 for w in v):return None
        if not v[1]<=v[0]<=v[2]:return None
        return v
    except (TypeError,ValueError,KeyError,AttributeError):return None

def _segments(begin,end):
    """Allocate short intervals to correct local days/hours at boundaries."""
    cursor=begin
    while cursor<end-1e-6:
        local=dt.datetime.fromtimestamp(cursor)
        next_hour=local.replace(minute=0,second=0,microsecond=0)+dt.timedelta(hours=1)
        boundary=time.mktime(next_hour.timetuple())
        finish=min(end,boundary if boundary>cursor else end)
        if finish<=cursor:break
        yield local.strftime("%Y-%m-%d %H"),finish-cursor
        cursor=finish

def sample(telemetry,when=None,mono=None,boot=None):
    """Trapezoidal integration of consecutive measured+estimated power samples."""
    global _PREVIOUS,_LAST_VALID,_LAST_ERROR
    wall=time.time() if when is None else float(when)
    tick=time.monotonic() if mono is None else float(mono)
    if boot is None:boot,_=_boot()
    current=(wall,tick,boot,_power(telemetry))
    with _LOCK:
        prev,_PREVIOUS=_PREVIOUS,current
        if not boot or not current[3]:return False
        _LAST_VALID=wall
        if not prev or prev[2]!=boot or not prev[3]:return False
        elapsed=tick-prev[1]
        wall_gap=wall-prev[0]
        if not 0.2<=elapsed<=65 or abs(wall_gap-elapsed)>5:return False
        pieces=list(_segments(prev[0],wall))
        total=sum(s for _,s in pieces)
        if not 0<total<=65:return False
        averaged=[(x+y)/2 for x,y in zip(prev[3],current[3])]
        try:
            with _db() as conn:
                for hour,seg in pieces:
                    seconds=elapsed*seg/total
                    amount=[x*seconds/3600000 for x in averaged]
                    conn.execute("""INSERT INTO hourly
                      (boot_id,hour_local,seconds,kwh,low_kwh,high_kwh) VALUES(?,?,?,?,?,?)
                      ON CONFLICT(boot_id,hour_local) DO UPDATE SET
                      seconds=seconds+excluded.seconds,kwh=kwh+excluded.kwh,
                      low_kwh=low_kwh+excluded.low_kwh,
                      high_kwh=high_kwh+excluded.high_kwh""",
                      (boot,hour,seconds,*amount))
            _LAST_ERROR=None
            return True
        except (sqlite3.Error,OSError) as exc:
            _LAST_ERROR=str(exc)[:180]
            return False

def _total(conn,clause="1=1",params=()):
    row=conn.execute("SELECT COALESCE(SUM(seconds),0),COALESCE(SUM(kwh),0),"
       "COALESCE(SUM(low_kwh),0),COALESCE(SUM(high_kwh),0) FROM hourly WHERE "+clause,params).fetchone()
    return {"hours":round(row[0]/3600,3),"kwh":round(row[1],5),
            "low_kwh":round(row[2],5),"high_kwh":round(row[3],5)}

def report(now=None,wall_w=None):
    ts=time.time() if now is None else float(now)
    moment=dt.datetime.fromtimestamp(ts)
    day=moment.strftime("%Y-%m-%d")
    month=moment.strftime("%Y-%m")
    boot,boot_at=_boot()
    with _LOCK:
        with _db() as conn:
            today=_total(conn,"hour_local LIKE ?",(day+"%",))
            monthly=_total(conn,"hour_local LIKE ?",(month+"%",))
            uptime=_total(conn,"boot_id=?", (boot,)) if boot else _total(conn,"1=0")
            history=conn.execute("SELECT substr(hour_local,1,10),sum(kwh),sum(seconds)"
                 " FROM hourly WHERE hour_local LIKE ? GROUP BY substr(hour_local,1,10)"
                 " ORDER BY 1 DESC LIMIT 31",(month+"%",)).fetchall()
            past_months=conn.execute(
                "SELECT substr(hour_local,1,7),SUM(kwh),SUM(seconds)"
                " FROM hourly GROUP BY substr(hour_local,1,7)"
                " ORDER BY 1 DESC LIMIT 12").fetchall()
        setting=tariff()
        rate=setting["rate_pkr_kwh"]*(1+setting["tax_percent"]/100)
        for entry in (today,monthly,uptime):
            entry["pkr"]=round(entry["kwh"]*rate,2)
            entry["low_pkr"]=round(entry["low_kwh"]*rate,2)
            entry["high_pkr"]=round(entry["high_kwh"]*rate,2)
        try:watts=_number(wall_w,0,3000) if wall_w is not None else None
        except ValueError:watts=None
        days_total=calendar.monthrange(moment.year,moment.month)[1]
        remaining=max(0,days_total-moment.day)
        # Forecast PC electricity contribution, not whole household bill.
        forecast=monthly["kwh"]+watts/1000*setting["expected_hours_per_day"]*remaining if watts is not None else None
        return {
           "currency":"PKR","tariff":setting,"today":today,"month":monthly,"uptime":uptime,
           "pc_uptime_hours":round((ts-boot_at)/3600,2) if boot_at else None,
           "current_w":round(watts,1) if watts is not None else None,
           "cost_per_hour_pkr":round(watts/1000*rate,2) if watts is not None else None,
           "projected_30day_pc_kwh":round(watts/1000*setting["expected_hours_per_day"]*30,3) if watts is not None else None,
           "projected_30day_pc_pkr":round(watts/1000*setting["expected_hours_per_day"]*30*rate,2) if watts is not None else None,
           "month_forecast_pkr":round(forecast*rate,2) if forecast is not None else None,
           "month_forecast_kwh":round(forecast,3) if forecast is not None else None,
           "history":[{"date":d,"kwh":round(k,4),"hours":round(seconds/3600,2),"pkr":round(k*rate,2)}
                      for d,k,seconds in reversed(history)],
           "monthly_history":[{"month":m,"kwh":round(k,4),"hours":round(seconds/3600,2),
                               "pkr":round(k*rate,2)} for m,k,seconds in past_months],
           "date":day,"month_id":month,"boot_id":boot,
           "tracking_running":bool(_WORKER and _WORKER.is_alive()),
           "last_valid_age_seconds":round(max(0,ts-_LAST_VALID),1) if _LAST_VALID else None,
           "tracking_error":_LAST_ERROR,
           "rate_note":"Editable blended electricity rate; default PKR 50/kWh is illustrative, not an official tariff.",
           "scope":"Estimated PC tower only. Excludes UPS losses, monitor, other home usage, utility slabs and unobserved time.",
           "history_note":"Tracking starts when enabled. Uptime before first valid power sample is NOT backfilled."
        }

def _loop(telemetry):
    global _LAST_ERROR
    while True:
        try:sample(telemetry())
        except Exception as exc:
            _LAST_ERROR=str(exc)[:180]
            logging.getLogger("difsync-energy").warning("Energy sample: %s",exc)
        time.sleep(20)

def start(telemetry):
    global _WORKER
    with _LOCK:
        if _WORKER and _WORKER.is_alive():return
        _WORKER=threading.Thread(target=_loop,args=(telemetry,),
                                 name="DifSync-Energy-Ledger",daemon=True)
        _WORKER.start()
