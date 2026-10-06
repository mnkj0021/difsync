#!/usr/bin/env bash
set -euo pipefail

DOMAIN="difsync.com"
APP_PORT="8890"
CONF="/etc/nginx/conf.d/difsync.com.conf"
BACKUP_DIR="/etc/nginx/conf.d/difsync-backups"
WEBROOT="/var/lib/letsencrypt"

if ! curl -fsS "http://127.0.0.1:${APP_PORT}/health" >/dev/null; then
  echo "DifSync is not healthy on 127.0.0.1:${APP_PORT}; refusing to touch Nginx."
  exit 1
fi

if grep -Rqs "server_name.*difsync.com" /etc/nginx/conf.d && [[ ! -f "${CONF}" ]]; then
  echo "Another Nginx config already owns ${DOMAIN}; refusing to overwrite it."
  exit 1
fi

sudo mkdir -p "${BACKUP_DIR}" "${WEBROOT}/.well-known/acme-challenge"

if [[ -f "${CONF}" ]]; then
  sudo cp -a "${CONF}" "${BACKUP_DIR}/difsync.com.conf.$(date +%Y%m%dT%H%M%S).bak"
fi

tmp="$(mktemp)"
cat >"${tmp}" <<'NGINX'
# DifSync production ingress
# Limited to difsync.com and 127.0.0.1:8890.

server {
    listen 80;
    listen [::]:80;
    server_name difsync.com www.difsync.com;

    location ^~ /.well-known/acme-challenge/ {
        root /var/lib/letsencrypt;
        default_type "text/plain";
        try_files $uri =404;
    }

    location / {
        proxy_pass http://127.0.0.1:8890;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
    }
}
NGINX

sudo install -m 0644 "${tmp}" "${CONF}"
rm -f "${tmp}"

if ! sudo nginx -t; then
  echo "Nginx validation failed. Restoring only the previous DifSync config."
  latest="$(ls -1t "${BACKUP_DIR}"/difsync.com.conf.*.bak 2>/dev/null | head -n1 || true)"
  if [[ -n "${latest}" ]]; then
    sudo cp -a "${latest}" "${CONF}"
  else
    sudo rm -f "${CONF}"
  fi
  sudo nginx -t || true
  exit 1
fi

sudo systemctl reload nginx
echo "HTTP ingress enabled for ${DOMAIN} -> 127.0.0.1:${APP_PORT}"
echo "After DNS A records point to this VPS, issue TLS with:"
echo "  sudo certbot certonly --webroot -w ${WEBROOT} -d difsync.com -d www.difsync.com"
echo "Then install deploy/nginx-tls.conf after certificate issuance."
