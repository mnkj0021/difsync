from pathlib import Path
import tempfile,sys,json,threading,time
from unittest.mock import patch
sys.path.insert(0,r"G:\DifSync")
import power_energy as m

s=(m.STORE,m.DB,m.SETTINGS,m.OFFICIAL_CACHE,m._LAST_TARIFF_ERROR)
try:
  with tempfile.TemporaryDirectory() as d:
    m.STORE=Path(d);m.DB=m.STORE/"meter.db";m.SETTINGS=m.STORE/"tariff.json";m.OFFICIAL_CACHE=m.STORE/"official.json"
    source='<html>S.R.O No. 279 (I)/2026 February 2026 A-1 GENERAL SUPPLY TARIFF - RESIDENTIAL Time Of Use - 675 47.50 34.75 A-2 GENERAL SUPPLY TARIFF Time Of Use - 1250 88.00 22.00</html>'
    class Reply:
      text=source
      def raise_for_status(self):pass
    with patch("requests.get",return_value=Reply()) as get:
      assert m.refresh_official(force=True)
      assert get.called
    t=m.tariff()
    assert t["peak_rate_pkr_kwh"]==47.50 and t["offpeak_rate_pkr_kwh"]==34.75,t
    assert t["source_checked_today"]
    # Official cache re-used on same date; no network request.
    with patch("requests.get",side_effect=AssertionError("Unexpected second request")):
      assert not m.refresh_official()
    # Meter needs customer category confirmation; website doesn't confirm it.
    assert t["confirmed"] is False
    t=m.update_tariff({"mode":"flat_manual","flat_rate_pkr_kwh":35.25,"confirmed":True})
    assert t["flat_rate_pkr_kwh"]==35.25 and t["mode"]=="flat_manual"
    assert m.price_at(time.time(),t)[1]==35.25
    t=m.update_tariff({"mode":"iesco_tou","auto_refresh_official":False,
                       "peak_rate_pkr_kwh":56,"offpeak_rate_pkr_kwh":39})
    assert t["peak_rate_pkr_kwh"]==56 and t["offpeak_rate_pkr_kwh"]==39
    print("TARIFF_REFRESH_PASS parses A-1 only, checks once daily, preserves category uncertainty, keeps manual override")
finally:
 m.STORE,m.DB,m.SETTINGS,m.OFFICIAL_CACHE,m._LAST_TARIFF_ERROR=s
