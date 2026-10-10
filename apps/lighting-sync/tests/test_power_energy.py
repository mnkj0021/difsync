from pathlib import Path
import datetime as dt
import math
import sys
import tempfile
sys.path.insert(0,r"G:\DifSync")
import power_energy as p

def watts(n):
    return {"cpu_power_status":"measured","estimated_wall_w":n,
      "estimated_wall_low_w":n*.8,"estimated_wall_high_w":n*1.2}

keep=(p.STORE,p.DB,p.SETTINGS,p._PREVIOUS,p._LAST_VALID,p._boot)
try:
  with tempfile.TemporaryDirectory() as directory:
    p.STORE=Path(directory);p.DB=p.STORE/"ledger.sqlite3";p.SETTINGS=p.STORE/"tariff.json"
    p._PREVIOUS=None;p._LAST_VALID=None;p._boot=lambda:("boot-A",dt.datetime(2026,10,10,17).timestamp())
    first=dt.datetime(2026,10,10,17,59,53).timestamp()
    assert not p.sample(watts(500),when=first,mono=100,boot="boot-A")
    assert p.sample(watts(1000),when=first+5,mono=105,boot="boot-A")
    assert p.sample(watts(600),when=first+10,mono=110,boot="boot-A")
    r=p.report(now=first+11,wall_w=600)
    # Trapezoidal: 5s * 750W + 5s * 800W.
    expected=(750*5+800*5)/3600000
    assert abs(r["today"]["kwh"]-expected)<1e-6,r
    assert r["month"]["kwh"]==r["today"]["kwh"]
    assert r["today"]["pkr"]>=0 and "projected_30day_pc_pkr" not in r
    assert r["sample_interval_seconds"]==5 and r["bucket_minutes"]==15
    assert r["current_band"]=="peak" and r["current_rate_pkr_kwh"]==46.85
    recorded=[x for x in r["intervals_15m"] if x["coverage_seconds"]>0]
    assert len(recorded)==2,recorded
    assert set(x["band"] for x in recorded)=={"peak","offpeak"}
    assert math.isclose(sum(x["kwh"] for x in recorded),r["today"]["kwh"],abs_tol=.000005)
    print("BOUNDARY",[(x["start"],x["band"],x["coverage_seconds"],x["avg_w"],x["pkr"]) for x in recorded])
    price=r["today"]["pkr"]
    # TOU profile and rate difference; corrected meter category replaces it.
    cfg=p.update_tariff({"mode":"flat_manual","flat_rate_pkr_kwh":30,"confirmed":True})
    assert cfg["mode"]=="flat_manual"
    flat=p.report(now=first+11,wall_w=600)
    assert flat["current_band"]=="single-rate" and flat["current_rate_pkr_kwh"]==30
    assert flat["today"]["pkr"]!=price
    assert flat["peak_today"]["kwh"]==0
    # Inactive sensor, sleep gap, reboot must never be charged.
    old_kwh=flat["today"]["kwh"]
    assert not p.sample(watts(600),when=first+90,mono=190,boot="boot-A")
    assert p.report(now=first+90)["today"]["kwh"]==old_kwh
    assert not p.sample({"cpu_power_status":"stale"},when=first+95,mono=195,boot="boot-A")
    assert not p.sample(watts(200),when=first+100,mono=200,boot="boot-A")
    assert p.sample(watts(400),when=first+105,mono=205,boot="boot-A")
    assert not p.sample(watts(400),when=first+108,mono=2,boot="boot-B")
    p._boot=lambda:("boot-B",first+106)
    reboot=p.report(now=first+108)
    assert reboot["uptime"]["kwh"]==0
    assert reboot["today"]["kwh"]>old_kwh
    # Persistence across process restart.
    p._PREVIOUS=None
    assert p.report(now=first+108)["today"]["kwh"]==reboot["today"]["kwh"]
    for month,start in [(1,17),(4,18),(7,19),(10,18)]:
        assert p.peak_hours(month)[0]==start
    assert p.price_at(dt.datetime(2026,12,1,17,10).timestamp(),
                      {**cfg,"mode":"iesco_tou"})[0]=="peak"
    try:p.update_tariff({"peak_rate_pkr_kwh":float("nan")})
    except ValueError:pass
    else:raise AssertionError("NaN accepted")
    try:p.update_tariff({"expected_hours_per_day":8})
    except ValueError:pass
    else:raise AssertionError("Old average-hours setting accepted")
    print("ENERGY_15M_PASS: trapezoidal 5s, two time bands, seasonal TOU, tariff selection, persistent DB, sleep/sensor/reboot gaps and no fictitious projections")
finally:
    p.STORE,p.DB,p.SETTINGS,p._PREVIOUS,p._LAST_VALID,p._boot=keep
