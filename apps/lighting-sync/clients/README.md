# DifSync Clients (No Metro)

This setup uses a single React UI and two native wrappers:

- `difsync-react`: shared React control UI (Vite build)
- `desktop-electron`: native desktop app loading the React build
- `difsync-react/android`: native Android app via Capacitor

## Why this stack

- No Expo/Metro loop
- No per-run JS bundler on phone
- Deploy to Android as normal APK (`gradlew installDebug`)
- Realtime color/brightness changes still stream instantly

## Run Desktop

```powershell
Set-Location "<YOUR_PROJECT_ROOT>\\clients"
.\RunDesktopClient.bat
```

This builds `difsync-react` and launches Electron.

## Deploy to Android Phone (USB)

```powershell
Set-Location "<YOUR_PROJECT_ROOT>\\clients"
.\RunMobileClient.bat
```

This runs:

1. Build React web assets
2. Capacitor sync
3. Gradle debug install to connected phone
4. Launch app

## App base URL

Inside the app, set Base URL to your RGB host PC:

- Local same PC: `http://127.0.0.1:8080` (desktop app)
- Phone on LAN: `http://192.168.18.22:8080` (replace with your current PC IP)

## Backend note

`dashboard_server.py` now includes CORS + preflight handling so the Android WebView app can call local DifSync API endpoints.

## Vercel frontend deploy

The React app is now prepared for Vercel as a frontend-only deploy.

Files:
- [package.json](G:\DifSync\clients\difsync-react\package.json)
- [vite.config.ts](G:\DifSync\clients\difsync-react\vite.config.ts)
- [vercel.json](G:\DifSync\clients\difsync-react\vercel.json)
- [.env.example](G:\DifSync\clients\difsync-react\.env.example)

Set these environment variables in Vercel:

```env
VITE_DIFSYNC_SYNC_CLOUD_URL=https://hub.your-domain.com
VITE_DIFSYNC_SYNC_LOCAL_URL=http://127.0.0.1:8080
```

Notes:
- Mobile/web cloud fallback now defaults to `https://difsync.com` when `VITE_DIFSYNC_SYNC_CLOUD_URL` is not set.
- Cloud auth key is no longer hardcoded in clients; set it in app settings/local storage.

Build command for Vercel:

```bash
npm run build:web
```

The VPS Node hub remains separate and should not be deployed to Vercel.
