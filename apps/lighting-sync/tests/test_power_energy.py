from pathlib import Path
import tempfile,sys
sys.path.insert(0,r"G:\DifSync")
import power_energy as p
def sample(watts=500):
    return {"cpu_power_status":"measured","estimated_wall_w":watts,
            "estimated_wall_low_w":watts*.85,"estimated_wall_high_w":watts*1.2}
saved=(p.STORE,p.DB,p.SETTINGS,p._PREVIOUS,p._LAST_VALID,p._boot)
try:
  with tempfile.TemporaryDirectory() as tmp:
    p.STORE=Path(tmp)
    p.DB=p.STORE/"ledger.sqlite3"
    p.SETTINGS=p.STORE/"tariff.json"
    p._PREVIOUS=None
    p._LAST_VALID=None
    p._boot=lambda:("boot-A",0.0)
    assert p.sample(sample(),when=1000,mono=10,boot="boot-A") is False
    assert p.sample(sample(),when=1020,mono=30,boot="boot-A") is True
    a=p.report(now=1030,wall_w=500)
    assert abs(a["today"]["kwh"] - (500*20/3600000))<1e-5,a
    assert a["uptime"]["kwh"]==a["today"]["kwh"]
    assert a["month"]["pkr"]>0
    assert a["projected_30day_pc_pkr"]==6000.0,a
    p.sample(sample(),when=1100,mono=110,boot="boot-A")
    b=p.report(now=1100,wall_w=500)
    assert b["uptime"]["kwh"]==a["uptime"]["kwh"],(a,b)
    # Invalid CPU sensor breaks integration; never invents watt-hours.
    assert not p.sample({"cpu_power_status":"stale"},when=1120,mono=130,boot="boot-A")
    assert not p.sample(sample(),when=1140,mono=150,boot="boot-A")
    assert p.sample(sample(),when=1160,mono=170,boot="boot-A")
    prev=p.report(now=1160,wall_w=500)["uptime"]["kwh"]
    # New reboot cannot consume the off interval.
    assert not p.sample(sample(),when=1180,mono=5,boot="boot-B")
    p._boot=lambda:("boot-B",1170.0)
    c=p.report(now=1180,wall_w=500)
    assert c["uptime"]["kwh"]==0
    assert c["month"]["kwh"]==prev
    assert p.sample(sample(),when=1200,mono=25,boot="boot-B")
    c=p.report(now=1200,wall_w=500)
    assert c["uptime"]["kwh"]>0
    assert c["month"]["kwh"]>prev
    cfg=p.update_tariff({"rate_pkr_kwh":64.2,"tax_percent":8,"expected_hours_per_day":10})
    assert cfg["rate_pkr_kwh"]==64.2
    d=p.report(now=1200,wall_w=500)
    assert d["projected_30day_pc_pkr"]==round(.5*10*30*64.2*1.08,2)
    try:p.update_tariff({"rate_pkr_kwh":float("nan")})
    except ValueError:pass
    else:raise AssertionError("NaN rate accepted")
    try:p.update_tariff({"unexpected":3})
    except ValueError:pass
    else:raise AssertionError("Unexpected setting accepted")
    # Persistent across in-memory collector reset; no retroactive bill.
    p._PREVIOUS=None
    assert p.report(now=1201,wall_w=500)["month"]["kwh"]==c["month"]["kwh"]
    print("ENERGY_TESTS_PASS database persistence, trapezoidal integration, gap/sleep rejection, sensor loss, reboot separation, PKR billing, editable tariff, projections")
finally:
 p.STORE,p.DB,p.SETTINGS,p._PREVIOUS,p._LAST_VALID,p._boot=saved
