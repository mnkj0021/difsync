# Production deployment

DifSync is intended to run as an unprivileged service bound to loopback.

Recommended layout:

- source: `/home/<service-user>/projects/difsync`
- private listener: `127.0.0.1:8890`
- reverse proxy: Nginx/Caddy/HAProxy
- TLS: terminated by the reverse proxy
- database: `services/hub/var/difsync.sqlite`
- secrets: `services/hub/.env` with mode 0600

Do not publish the Node listener directly. Do not reuse another application's process-manager home, database directory or environment file.

Before publishing a repository, verify `git status`, inspect every tracked file, and run a secret scan. The committed `.gitignore` deliberately excludes credentials and runtime state.
