# DifSync Lighting Sync

Lighting Sync is the local hardware-control side of DifSync. It discovers and controls PC RGB hardware and room lighting, while the main DifSync device agent provides secure remote access through difsync.com.

## Layout

- `runtime/` Python control API and native hardware backends
- `studio/` React/Vite Lighting Studio used by desktop and mobile clients
- `desktop/` Electron shell for the local Lighting Studio
- `windows/` local Windows launchers and runtime helpers

## Runtime model

The local control API listens on `127.0.0.1:8080` by default. The main DifSync device agent discovers this runtime locally and publishes only safe inventory metadata to the DifSync hub. Scene commands from the authenticated hub are forwarded to the local API.

Secrets stay local and are read from environment configuration. Do not commit `.env` files, device credentials, or provider tokens.

## Development

Install Python requirements from `runtime/requirements.txt`, install Studio dependencies with `npm install`, then run the Studio build with `npm run build`.

The production Windows setup currently lives at `G:\DifSync` on the development machine; this directory in the repository is the canonical source snapshot for continued integration into the main DifSync platform.
