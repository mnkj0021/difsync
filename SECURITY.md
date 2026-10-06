# Security Policy

## Never commit

- `.env` files
- API keys or OAuth client secrets
- connector access/refresh tokens
- agent bearer tokens
- SQLite databases
- local RGB device inventories
- logs containing IP addresses or request data
- TLS private keys

## Authentication

DifSync account passwords are hashed with Node.js `crypto.scrypt`. Session and agent tokens are random 256-bit values. Only SHA-256 token digests are stored server-side.

## Connector secrets

Connector configurations containing credentials are encrypted with AES-256-GCM using the deployment-only `DIFSYNC_ENCRYPTION_KEY`.

## Reporting a vulnerability

Please open a private GitHub security advisory rather than a public issue for vulnerabilities.
