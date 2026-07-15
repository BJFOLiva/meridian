import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { WebSocketServer, WebSocket } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, '../public');

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_PLAYERS = Math.max(1, Number.parseInt(process.env.MAX_PLAYERS || '32', 10));
const TICK_RATE = Math.min(30, Math.max(5, Number.parseInt(process.env.TICK_RATE || '15', 10)));
const MAX_SPEED = Math.max(100, Number.parseFloat(process.env.MAX_SPEED || '650'));
const WORLD_WIDTH = 4536;
const WORLD_HEIGHT = 4536;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));
app.get('/healthz', (_req, res) => {
  res.json({ ok: true, players: players.size, uptimeSeconds: Math.floor(process.uptime()) });
});
app.use(express.static(publicDir, {
  extensions: ['html'],
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0
}));
app.get('*', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
const players = new Map();

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function cleanName(value) {
  const name = String(value ?? 'Player').replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 20);
  return name || 'Player';
}

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function broadcast(payload, except = null) {
  const encoded = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client !== except && client.readyState === WebSocket.OPEN) client.send(encoded);
  }
}

function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    x: p.x,
    y: p.y,
    heading: p.heading,
    inVehicle: p.inVehicle,
    vehicleType: p.vehicleType,
    updatedAt: p.updatedAt
  };
}

wss.on('connection', (ws, request) => {
  if (players.size >= MAX_PLAYERS) {
    send(ws, { type: 'error', code: 'SERVER_FULL', message: 'Server is full.' });
    ws.close(1013, 'Server full');
    return;
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  const player = {
    id,
    name: 'Player',
    x: WORLD_WIDTH / 2,
    y: WORLD_HEIGHT / 2,
    heading: 0,
    inVehicle: false,
    vehicleType: null,
    updatedAt: now,
    lastInputAt: now,
    remoteAddress: request.socket.remoteAddress
  };
  players.set(id, player);

  send(ws, {
    type: 'welcome',
    id,
    tickRate: TICK_RATE,
    world: { width: WORLD_WIDTH, height: WORLD_HEIGHT },
    players: [...players.values()].map(publicPlayer)
  });
  broadcast({ type: 'playerJoined', player: publicPlayer(player) }, ws);

  ws.on('message', raw => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send(ws, { type: 'error', code: 'BAD_JSON', message: 'Invalid message.' });
      return;
    }

    if (msg.type === 'hello') {
      player.name = cleanName(msg.name);
      broadcast({ type: 'playerUpdated', player: publicPlayer(player) });
      return;
    }

    if (msg.type !== 'state') return;

    const nowMs = Date.now();
    const dt = clamp((nowMs - player.lastInputAt) / 1000, 1 / 120, 1);
    player.lastInputAt = nowMs;

    const requestedX = Number(msg.x);
    const requestedY = Number(msg.y);
    if (!Number.isFinite(requestedX) || !Number.isFinite(requestedY)) return;

    const maxDistance = MAX_SPEED * dt + 80;
    const dx = requestedX - player.x;
    const dy = requestedY - player.y;
    const distance = Math.hypot(dx, dy);
    const scale = distance > maxDistance ? maxDistance / distance : 1;

    player.x = clamp(player.x + dx * scale, 0, WORLD_WIDTH);
    player.y = clamp(player.y + dy * scale, 0, WORLD_HEIGHT);
    player.heading = Number.isFinite(Number(msg.heading)) ? Number(msg.heading) : player.heading;
    player.inVehicle = Boolean(msg.inVehicle);
    player.vehicleType = player.inVehicle && typeof msg.vehicleType === 'string'
      ? msg.vehicleType.slice(0, 24)
      : null;
    player.updatedAt = nowMs;
  });

  ws.on('close', () => {
    players.delete(id);
    broadcast({ type: 'playerLeft', id });
  });

  ws.on('error', error => {
    console.error('WebSocket client error:', error.message);
  });
});

const interval = setInterval(() => {
  if (players.size === 0) return;
  broadcast({
    type: 'snapshot',
    serverTime: Date.now(),
    players: [...players.values()].map(publicPlayer)
  });
}, Math.round(1000 / TICK_RATE));
interval.unref();

server.listen(PORT, HOST, () => {
  console.log(`Meridian City listening on http://${HOST}:${PORT}`);
  console.log(`WebSocket endpoint: /ws | max players: ${MAX_PLAYERS} | tick rate: ${TICK_RATE}`);
});

function shutdown(signal) {
  console.log(`${signal} received; shutting down.`);
  clearInterval(interval);
  for (const client of wss.clients) client.close(1001, 'Server shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
