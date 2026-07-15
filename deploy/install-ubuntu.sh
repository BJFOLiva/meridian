#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo "Run as root: sudo bash deploy/install-ubuntu.sh" >&2
  exit 1
fi

APP_DIR=/opt/meridian-city
APP_USER=meridian

apt-get update
apt-get install -y ca-certificates curl gnupg nginx certbot python3-certbot-nginx rsync

if ! command -v node >/dev/null || [[ $(node -p 'Number(process.versions.node.split(".")[0])') -lt 20 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR"
rsync -a --delete --exclude node_modules --exclude .git ./ "$APP_DIR"/
cd "$APP_DIR"
npm ci --omit=dev
[[ -f .env ]] || cp .env.example .env
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
install -m 0644 deploy/systemd/meridian-city.service /etc/systemd/system/meridian-city.service
systemctl daemon-reload
systemctl enable --now meridian-city

echo
systemctl --no-pager --full status meridian-city || true
echo
printf 'Installed. Edit deploy/nginx/meridian-city.conf, replace YOUR_DOMAIN, then run:\n'
printf '  sudo cp deploy/nginx/meridian-city.conf /etc/nginx/sites-available/meridian-city\n'
printf '  sudo ln -sf /etc/nginx/sites-available/meridian-city /etc/nginx/sites-enabled/meridian-city\n'
printf '  sudo nginx -t && sudo systemctl reload nginx\n'
printf '  sudo certbot --nginx -d your-domain.example\n'
