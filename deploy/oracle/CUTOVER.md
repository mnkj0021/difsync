# Oracle VPS cutover

The DifSync application is designed to remain isolated from other Oracle VPS projects.

## Assigned resources

- source: `/home/opc/projects/difsync`
- listener: `127.0.0.1:8890`
- PM2 home: `/home/opc/.pm2-difsync`
- process: `difsync-hub`
- database: `services/hub/var/difsync.sqlite`
- production secrets: `services/hub/.env` (mode 0600)

Do not reuse another application's port, PM2 home, database, environment file or Nginx server block.

## Cutover order

1. Verify the private app before touching public ingress:
   ```bash
   curl -fsS http://127.0.0.1:8890/health
   ss -ltn | grep '127.0.0.1:8890'
   PM2_HOME=/home/opc/.pm2-difsync pm2 status
   ```

2. Point the DNS records for `difsync.com` and `www.difsync.com` at the Oracle VPS public IP.

3. Install **only** the dedicated `deploy/nginx/difsync-http.conf` as a new Nginx file. Do not edit existing Agent47, Selene or other application vhosts.

4. Validate Nginx before reloading:
   ```bash
   nginx -t
   ```
   If validation fails, remove the new DifSync file and leave the existing Nginx configuration untouched.

5. Reload Nginx only after a successful config test.

6. Once public DNS resolves to the Oracle VPS, obtain a certificate for the DifSync names only:
   ```bash
   certbot --nginx -d difsync.com -d www.difsync.com
   ```

7. Verify:
   ```bash
   curl -fsS https://difsync.com/health
   curl -fsSI https://difsync.com/
   curl -fsSI https://difsync.com/app
   ```

8. Verify existing production domains after the Nginx reload. A DifSync cutover is not complete if an unrelated application regresses.

9. Only after Oracle HTTPS is confirmed should the old Vercel deployment/domain association be retired.

## Rollback

DNS can be pointed back to the previous target while TTLs are still propagating. Removing the dedicated DifSync Nginx server block and reloading Nginx returns the VPS ingress to its previous state because DifSync does not share an existing vhost.
