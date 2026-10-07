# DifSync Dashboard

This dashboard gives you one web UI to control:
- OpenRGB SDK devices (PC RGB)
- Govee cloud devices from `config.json`

## 1) Install deps

```powershell
cd /d <YOUR_PROJECT_ROOT>
.\.venv\Scripts\pip install -r requirements.txt
```

## 2) Environment

`.env` should contain at least:

```env
GOVEE_API_KEY=your-govee-api-key
```

Optional but recommended for remote access:

```env
DASHBOARD_TOKEN=choose-a-long-random-token
DASHBOARD_PORT=8080
DASHBOARD_HOST=0.0.0.0
```

Optional for no-manual-OpenRGB startup:

```env
OPENRGB_AUTOSTART=true
OPENRGB_EXECUTABLE=I:\OpenRGB\OpenRGB.exe
```

If `DASHBOARD_TOKEN` is set, API requests must send:

```
Authorization: Bearer <token>
```

## 3) Run

```powershell
cd /d <YOUR_PROJECT_ROOT>
DifSync.bat dashboard
```

Open:

```
http://127.0.0.1:8080
```

## One-Click Auto System (No Manual PowerShell)

Enable startup automation once (runs as Administrator and restarts on crash):

```powershell
cd /d <YOUR_PROJECT_ROOT>
DifSync.bat autostart-on
```

This creates a scheduled task:
- `DifSync` -> `DifSync.bat start --elevated`

Useful helpers:

```powershell
DifSync.bat start
DifSync.bat stop
DifSync.bat status
DifSync.bat autostart-off
```

## Remote hosting model

For Govee-only control, dashboard can run on any server with your API key.

For PC RGB control, the process that talks to hardware must run on the same PC/LAN where OpenRGB SDK is reachable.  
Practical setup:
- Run dashboard on your RGB PC (or a nearby machine with OpenRGB SDK access)
- Expose it securely with a tunnel/reverse proxy
- Keep `DASHBOARD_TOKEN` enabled

## API endpoints

- `GET /api/health`
- `GET /api/openrgb/devices`
- `GET /api/pc/probe`
- `POST /api/openrgb/color`
- `GET /api/govee/devices`
- `POST /api/govee/color`
- `POST /api/scene/color`
- `GET /api/presets`
- `POST /api/presets`
- `DELETE /api/presets/<name>`
- `POST /api/presets/apply`

Body examples:

```json
{"r":255,"g":80,"b":20}
```

```json
{"r":255,"g":80,"b":20,"brightness":65}
```

```json
{"rgb":[255,80,20],"device_ids":[0,2]}
```

```json
{
  "name": "Warm Studio",
  "target": "scene",
  "rgb": [255, 120, 52],
  "brightness": 72,
  "openrgb_device_ids": [0, 1],
  "govee_device_ids": ["89:B9:D0:C9:07:CC:AC:18"]
}
```

## Pure-Custom RAM Phase

- Native backend now exposes Corsair RAM detection in your own stack (no OpenRGB/iCUE required) as a `MEMORY` device.
- Use `GET /api/pc/probe` to inspect module detection, low-level transport state, and protocol stage.
- Current stage is `phase2_smbus_experimental` and prefers WinRing0, then falls back to PawnIO (`SmbusI801.bin`).
- On Windows run `DifSync.bat dashboard` and `DifSync.bat agent` as Administrator at least once so kernel drivers can load.
- If WinRing0 transport is missing, install PawnIO once:

```powershell
winget install namazso.PawnIO
```

- Optional transport paths in `.env`:
  - `PC_RGB_WINRING_DLL=...\\WinRing0x64.dll`
  - `PC_RGB_PAWNIO_DLL=...\\PawnIOLib.dll`
  - `PC_RGB_PAWNIO_I801_BIN=...\\SmbusI801.bin`
- Optional ASUS ARGB tuning:
  - `PC_RGB_ASUS_ADDRESSABLE_LEDS=24`
  - `PC_RGB_ASUS_ADDRESSABLE_LEDS_PER_HEADER=24,24` (per header)
  - `PC_RGB_ASUS_STATIC_FALLBACK=true` (push static mode packet for fixed/header channel)
  - `PC_RGB_ASUS_FORCE_STATIC_ALL_CHANNELS=true` (force static-mode packets on every ASUS channel)
  - `PC_RGB_ASUS_REASSERT_DIRECT_AFTER_STATIC=true` (switch back to direct after static packet)
  - `PC_RGB_ASUS_WRITE_PASSES=2` (repeat ASUS write/commit cycle to override sticky effects)
- Optional NZXT cooler rescue tuning:
  - `PC_RGB_NZXT_FORCE_UNKNOWN_CHANNELS=true` (write even when channel mapping reports 0 LEDs)
  - `PC_RGB_NZXT_UNKNOWN_LED_COUNT=18` (fallback LED count used for unknown channels)

## Troubleshooting OpenRGB Not Changing Hardware

If API says OpenRGB writes are skipped with:

```
Write not reflected by OpenRGB (observed ...)
```

then the SDK instance on your configured port is not applying hardware updates.

On Windows, the usual issue is a background OpenRGB service holding port `6742`.

Check:

```powershell
Get-NetTCPConnection -State Listen -LocalPort 6742 | Select-Object LocalAddress,LocalPort,OwningProcess
sc.exe queryex OpenRGB
```

If that service owns `6742`, run Admin PowerShell:

```powershell
sc stop OpenRGB
sc config OpenRGB start= demand
taskkill /IM OpenRGB.exe /F
```

Then start one OpenRGB GUI instance normally, enable SDK server, and retry dashboard writes.

