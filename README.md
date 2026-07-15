# Meridian City Online — DigitalOcean deployment package

This package serves the latest Meridian City Renderer V3 build and includes a production WebSocket multiplayer foundation.

## Current multiplayer scope

The server implements player sessions, names, validated position/state updates, join/leave messages, periodic snapshots, capacity limits, and a health endpoint. The included game client is the current playable single-player build; wiring remote-player rendering and client state transmission into its renderer is the next multiplayer milestone.

## Local test

Requires Node.js 20 or newer.

```bash
cp .env.example .env
npm install
npm start
```

Open `http://localhost:3000`. Check server health at `http://localhost:3000/healthz`.

## Deploy to an Ubuntu DigitalOcean Droplet

### 1. Put this project in GitHub

Create an empty repository, then from this folder:

```bash
git init
git add .
git commit -m "Initial Meridian City server"
git branch -M main
git remote add origin git@github.com:YOUR_ACCOUNT/YOUR_REPOSITORY.git
git push -u origin main
```

### 2. Point a domain at the droplet

Create an `A` record for your domain or subdomain pointing to the droplet's public IPv4 address. DNS may take a little time to propagate.

### 3. Clone and install

On the droplet:

```bash
sudo apt-get update
sudo apt-get install -y git
sudo git clone https://github.com/YOUR_ACCOUNT/YOUR_REPOSITORY.git /tmp/meridian-city
cd /tmp/meridian-city
sudo bash deploy/install-ubuntu.sh
```

The application runs as the locked-down `meridian` system user from `/opt/meridian-city` and restarts automatically through systemd.

### 4. Configure Nginx

Replace `YOUR_DOMAIN` in `deploy/nginx/meridian-city.conf`, then:

```bash
sudo cp deploy/nginx/meridian-city.conf /etc/nginx/sites-available/meridian-city
sudo ln -sf /etc/nginx/sites-available/meridian-city /etc/nginx/sites-enabled/meridian-city
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

### 5. Enable HTTPS

```bash
sudo certbot --nginx -d game.example.com
```

Certbot configures HTTPS and automatic certificate renewal. Browsers will connect to the WebSocket server through `wss://game.example.com/ws`.

### 6. Firewall

DigitalOcean Cloud Firewall or UFW should allow only SSH, HTTP, and HTTPS:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

Do not expose port 3000 publicly; Nginx proxies to it through localhost.

## Updating after a GitHub push

On the droplet:

```bash
cd /tmp/meridian-city
git pull
bash deploy/update.sh
```

For a cleaner workflow, clone the repository to a normal deployment directory owned by your admin user and run the update script there.

## Operations

```bash
sudo systemctl status meridian-city
sudo journalctl -u meridian-city -f
curl -fsS http://127.0.0.1:3000/healthz
sudo systemctl restart meridian-city
```

## Environment settings

Copy `.env.example` to `.env` and adjust:

- `MAX_PLAYERS`: concurrent WebSocket limit
- `TICK_RATE`: snapshots per second, clamped to 5–30
- `MAX_SPEED`: server movement-validation threshold
- `PORT`: internal application port; leave at 3000 behind Nginx

## Security notes

- Never commit `.env`, SSH private keys, DigitalOcean API tokens, or passwords.
- Use SSH keys and disable password-based root login after confirming key access.
- Keep Ubuntu and Node.js security updates current.
- Back up save databases once persistent accounts/world state are added.

## Browser multiplayer client

The game client now connects automatically to the same host at `/ws`:

- HTTPS deployments use `wss://<host>/ws`.
- Local HTTP development uses `ws://<host>/ws`.
- The client reconnects automatically after interruption.
- Local player state is sent at up to 20 updates per second.
- Server snapshots are interpolated for smoother remote movement.
- Remote players render in both WebGL and fallback Canvas 2D modes.
- The top-right network badge shows connection status.

Open the deployed URL in two browser windows or on two devices to test visible player synchronization.

## Shared vehicle replication

This build adds the first server-owned world entities: shared vehicles.

- The server seeds persistent vehicle entities with stable IDs.
- Nearby players can claim a vehicle with the normal **E** interaction.
- Only one player can own/control a shared vehicle at a time.
- The server validates movement distance, speed, health, and ownership.
- Vehicle state is included in normal world snapshots and interpolated by clients.
- Ownership is released when the driver exits or disconnects.
- Shared vehicles render in both WebGL and Canvas 2D modes.

This is the foundation for moving police, pedestrians, pickups, bullets, and explosions into the same replicated entity protocol.
