#!/usr/bin/env bash
set -euo pipefail
APP_DIR=/opt/meridian-city
sudo rsync -a --delete --exclude node_modules --exclude .git ./ "$APP_DIR"/
cd "$APP_DIR"
sudo npm ci --omit=dev
sudo chown -R meridian:meridian "$APP_DIR"
sudo systemctl restart meridian-city
sudo systemctl --no-pager --full status meridian-city
