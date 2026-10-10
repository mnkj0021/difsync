# Fifteen-minute electricity accounting (PC-only)

The local DifSync Studio on NADIR-PC samples sensor-informed *estimated* AC
power about every **5 seconds** and integrates variable watts using short
trapezoids. If an interval crosses a 15-minute or tariff boundary, watts
are linearly interpolated at the boundary. Historical data is aggregated into
fifteen-minute records; per-interval actual covered seconds, energy
kWh and estimated power range persist in SQLite.

It does NOT have a physical mains electricity meter. CPU RAPL watts and
NVIDIA GPU board watts are measured; whole-PC AC input, PSU losses, SSDs,
fans, USB, lighting and RAM load are estimated. A calibrated external wall
meter is necessary for accurate actual AC consumption.

## Storage and runtime

Database: `var/power-energy/energy.sqlite3` within the installed Studio
(`G:\DifSync\var\power-energy` currently).
Tariff settings: `var/power-energy/tariff.json`.
Published IESCO rate cache: `var/power-energy/official-iesco.json`.
All three are machine-local, not published in Git. Historical `hourly`
records remain preserved but **are NOT subdivided** or falsely assigned
time-of-use charges. They appear under `legacy_unpriced_*` fields.

A daemon thread begins sampling when `dashboard_server.py` launches,
independent of UI polling. It skips missing sensor readings, long gaps,
sleep/resume, reboots, and clock jumps. Stopping the background backend
stops tracking; Windows uptime is NOT an accurate wattage log.

`GET /api/power/energy` returns today's kWh/PKR, monthly summary, current
boot energy, last 96 fifteen-minute intervals with watts/kWh/band/rate/PKR,
peak/off-peak totals, legacy-hourly totals and 12 months of history.
`GET/POST /api/power/tariff` reads/updates the profile.


Earlier hourly-era readings are retained and added to today's/month's
**total recorded kWh**, but their TOU split and cost remain explicitly
**unpriced**. The UI labels PKR amounts as partially priced where this
legacy history exists. No 15-minute history is manufactured from hourly data.

## Pakistan electricity rates

IESCO's official tariff guide
`https://www.iesco.com.pk/tariff-guide`
lists February 2026 residential A-1 TOU **PKR 46.85/kWh peak** and
**PKR 34.53/kWh off-peak** as published BASE rates. A separate network
thread checks the official residential A-1 table once daily via HTTPS,
stores the last successful response and never blocks the energy sampler.
A failed fetch preserves the last verified cache. This is **not a feed of
all utility charges**. Quarterly/fuel adjustments, taxes, fixed fees,
solar net billing and meter-specific charges cannot be inferred.

Time windows from the standard TOU schedule:
Dec-Feb 17:00–21:00; Mar-May 18:00–22:00;
Jun-Aug 19:00–23:00; Sep-Nov 18:00–22:00.
Use the PC's local timezone, verified as Pakistan Standard Time on NADIR-PC.

**Important:** TOU applies only when the electricity account has a TOU
tariff/meter. Other households are billed by residential slabs. Their
actual marginal unit cost depends on whole-home consumption, and DifSync
cannot infer it from the PC. The starting IESCO TOU choice is deliberately
UNCONFIRMED until the user verifies the actual electricity bill.
The UI also offers user-defined single-rate billing and custom TOU rates,
tax percentage and an option to disable automatic published-rate updates.

Cost amounts shown in the UI are **estimates using the currently selected
tariff**, recalculated on profile changes even for earlier recorded kWh.
This is an electricity-contribution tracker, not a complete utility invoice.
No fixed operating-hours projection remains.

## Validation
- `tests/test_power_energy.py`: 5-second integration, tariff boundary,
  seasonal TOU, reboot/gap handling, SQLite persistence and no fake forecast.
- `tests/test_tariff_refresh.py`: parse residential A-1 only, daily
  caching, category confirmation and manual override.
- `tests/qa_energy_live.cjs`: headless desktop browser verification,
  96 bars, rate editor, source warning and no frontend exceptions.
