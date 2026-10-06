# DifSync

DifSync is an open-source lighting orchestration platform for PC RGB and smart-home lighting.

It separates the system into three trust zones:

1. **Local agent**: talks to hardware on the user's machine.
2. **DifSync Hub**: handles accounts, ownership, pairing, commands, sessions and connector secrets.
3. **Web dashboard**: manages the user's own devices and integrations.

The public repository never contains deployment secrets, connector credentials, local device IDs, databases, logs or machine-specific state.

## Current integrations

- PC RGB agent protocol
- Govee connector
- Philips Hue local-bridge connector
- Google Home integration framework
- Amazon Alexa integration framework

Google Home and Alexa require provider-side developer projects, OAuth configuration and certification before production linking can be enabled.

## Security model

- HttpOnly, Secure, SameSite=Lax account sessions
- scrypt password hashing
- rate-limited authentication endpoints
- user ownership checks on every agent/command/connector query
- one-time device pairing codes
- per-agent bearer tokens stored only as SHA-256 hashes server-side
- AES-256-GCM encryption for connector credentials at rest
- same-origin enforcement on cookie-authenticated mutations
- no global panel key

See [SECURITY.md](SECURITY.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Local development

```bash
cp services/hub/.env.example services/hub/.env
npm install
npm run dev
```

The Hub serves both the API and the static dashboard/marketing site.

## Deployment

The production deployment is designed to run behind a reverse proxy on a private loopback port. Do not expose the Node process directly to the internet.

## License

MIT
