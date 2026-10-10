# DifSync PC Energy Ledger

The local Lighting Studio backend runs `power_energy.py` in one daemon thread.
It samples `rig_studio.telemetry()` every 20 seconds while the native
`desktop_runtime.py` backend is running. Read-only API:
`GET /api/power/energy`. Read/save user electricity assumptions:
`GET /api/power/tariff` and `POST /api/power/tariff`.

The private, machine-specific SQLite ledger is stored at
`G:\DifSync\var\power-energy\energy.sqlite3` in the current NADIR-PC
installation, with tariff settings in the same directory. `var/` is
ignored by Git. The hourly table stores each OS boot separately, with
local-calendar hours, tracked elapsed seconds, and trapezoidal integration
of estimated wall watts (mid/low/high). The ledger is durable across app
restarts, Windows reboots and month changes. It never backfills from
Windows uptime. It deliberately skips missing CPU/GPU readings, service
downtime, large time gaps, sleep and wall-clock discontinuities.

Overview > Live Power displays today, month, current boot, 30-day forecast,
actual tracked hours and a rolling 12-month history. The 3D Rig Studio
shows a compact energy summary. Tariff values can be updated in
Overview > Electricity settings. Defaults of Rs 50/kWh and 8 hours/day
are **illustrative only**; set the user's actual effective electricity
rate for a useful PKR estimate. Tax percentage can optionally augment
the blended rate. Cost history is recomputed at the currently selected
rate; changing the rate will revalue old kWh, not overwrite it.

The 30-day forecast holds current estimated PC power constant for the
user-selected daily hours. It is not a projection of a complete utility
bill. Electricity slabs, full-home appliances, monitors, and UPS losses
are not metered. `tests/test_power_energy.py` covers integration,
database persistence, missed sensor values, long gaps, reboot separation,
and PKR settings. `tests/qa_energy_live.cjs` is a single-browser
NADIR-PC integration check; do not run it unattended or in parallel with
other graphical QA sessions.

User-visible dashboard assets are copied by
`clients/difsync-react/rig-extension/install.cjs` into the Vite build.
