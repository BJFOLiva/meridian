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
  res.json({ ok: true, players: players.size, vehicles: vehicles.size, projectiles: projectiles.size, uptimeSeconds: Math.floor(process.uptime()) });
});
app.use(express.static(publicDir, {
  extensions: ['html'],
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0
}));
app.get('*', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
const players = new Map();
const vehicles = new Map();
const projectiles = new Map();
let projectileSeq = 0;

const VEHICLE_TYPES = ['Hatch', 'Sedan', 'Bullet', 'Taxi', 'Panelvan'];
const VEHICLE_COLORS = ['#b6402f','#3e6db5','#c8b447','#4d9a68','#8e4fa8','#c26d29','#7d8087','#d8d4c8','#30343c','#a83a5f'];

function seedVehicles() {
  if (vehicles.size) return;
  let index = 0;
  for (let by = 0; by < 7; by++) {
    for (let bx = 0; bx < 7; bx++) {
      if ((bx + by) % 2 !== 0) continue;
      const vertical = index % 2 === 0;
      const x = vertical ? bx * 648 + 22 : bx * 648 + 300 + (index % 3) * 55;
      const y = vertical ? by * 648 + 300 + (index % 3) * 55 : by * 648 + 22;
      const id = `vehicle-${index + 1}`;
      vehicles.set(id, {
        id, entityType: 'vehicle', type: VEHICLE_TYPES[index % VEHICLE_TYPES.length],
        color: VEHICLE_COLORS[index % VEHICLE_COLORS.length],
        x: clamp(x, 30, WORLD_WIDTH - 30), y: clamp(y, 30, WORLD_HEIGHT - 30),
        heading: vertical ? Math.PI / 2 : 0, speed: 0, hp: 100, ownerId: null, updatedAt: Date.now()
      });
      index++;
    }
  }
}
seedVehicles();

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


function publicVehicle(v) {
  return {
    id: v.id,
    entityType: 'vehicle',
    type: v.type,
    color: v.color,
    x: v.x,
    y: v.y,
    heading: v.heading,
    speed: v.speed,
    hp: v.hp,
    ownerId: v.ownerId,
    updatedAt: v.updatedAt
  };
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
    hp: p.hp, armor: p.armor, kills: p.kills, deaths: p.deaths, alive: p.alive,
    updatedAt: p.updatedAt
  };
}

function publicProjectile(p){return {id:p.id,entityType:'projectile',ownerId:p.ownerId,x:p.x,y:p.y,vx:p.vx,vy:p.vy,ttl:p.ttl};}
const WEAPON_NET=[{rate:2.4,damage:28,melee:true,range:38},{rate:3.2,damage:24,speed:840,shots:1,spread:.035},{rate:10,damage:13,speed:860,shots:1,spread:.10},{rate:1.1,damage:11,speed:760,shots:6,spread:.26}];
function applyPlayerDamage(t,dmg,attackerId){if(!t||!t.alive)return;let d=clamp(Number(dmg)||0,0,100);if(t.armor>0){const a=Math.min(t.armor,d*.6);t.armor-=a;d-=a;}t.hp=clamp(t.hp-d,0,100);send(t.ws,{type:'playerHit',hp:t.hp,armor:t.armor,attackerId});if(t.hp>0)return;t.alive=false;t.deaths++;t.respawnAt=Date.now()+3000;t.inVehicle=false;t.vehicleType=null;for(const v of vehicles.values())if(v.ownerId===t.id)v.ownerId=null;const a=players.get(attackerId);if(a&&a.id!==t.id)a.kills++;broadcast({type:'killFeed',killer:a?.name||'The city',victim:t.name});}
function spawnProjectile(owner,w,a){const id=`projectile-${++projectileSeq}`;const o=owner.inVehicle?22:14;projectiles.set(id,{id,ownerId:owner.id,x:owner.x+Math.cos(a)*o,y:owner.y+Math.sin(a)*o,vx:Math.cos(a)*w.speed,vy:Math.sin(a)*w.speed,damage:w.damage,ttl:.9});}


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
    remoteAddress: request.socket.remoteAddress, hp:100, armor:0, kills:0, deaths:0, alive:true, respawnAt:0, lastAttackAt:0, ws
  };
  players.set(id, player);

  send(ws, {
    type: 'welcome',
    id,
    tickRate: TICK_RATE,
    world: { width: WORLD_WIDTH, height: WORLD_HEIGHT },
    players: [...players.values()].map(publicPlayer),
    entities: { vehicles: [...vehicles.values()].map(publicVehicle), projectiles:[...projectiles.values()].map(publicProjectile) }
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

    if (msg.type === 'claimVehicle') {
      const vehicle = vehicles.get(String(msg.vehicleId || ''));
      if (!vehicle) return send(ws, { type: 'error', code: 'NO_VEHICLE', message: 'Vehicle no longer exists.' });
      if (vehicle.ownerId && vehicle.ownerId !== id) return send(ws, { type: 'error', code: 'VEHICLE_TAKEN', message: 'Someone else is using that vehicle.' });
      if (Math.hypot(player.x - vehicle.x, player.y - vehicle.y) > 90) return send(ws, { type: 'error', code: 'TOO_FAR', message: 'Move closer to the vehicle.' });
      vehicle.ownerId = id;
      vehicle.updatedAt = Date.now();
      player.inVehicle = true;
      player.vehicleType = vehicle.type;
      send(ws, { type: 'vehicleClaimed', vehicle: publicVehicle(vehicle) });
      broadcast({ type: 'entityUpdated', entity: publicVehicle(vehicle) }, ws);
      return;
    }

    if (msg.type === 'releaseVehicle') {
      const vehicle = vehicles.get(String(msg.vehicleId || ''));
      if (!vehicle || vehicle.ownerId !== id) return;
      vehicle.ownerId = null;
      vehicle.speed = Number.isFinite(Number(msg.speed)) ? clamp(Number(msg.speed), -500, 500) : 0;
      vehicle.updatedAt = Date.now();
      player.inVehicle = false;
      player.vehicleType = null;
      broadcast({ type: 'entityUpdated', entity: publicVehicle(vehicle) });
      return;
    }

    if (msg.type === 'vehicleState') {
      const vehicle = vehicles.get(String(msg.vehicleId || ''));
      if (!vehicle || vehicle.ownerId !== id) return;
      const nowMs = Date.now();
      const dt = clamp((nowMs - vehicle.updatedAt) / 1000, 1 / 120, 1);
      const requestedX = Number(msg.x), requestedY = Number(msg.y);
      if (!Number.isFinite(requestedX) || !Number.isFinite(requestedY)) return;
      const maxDistance = MAX_SPEED * dt + 60;
      const dx = requestedX - vehicle.x, dy = requestedY - vehicle.y;
      const distance = Math.hypot(dx, dy);
      const scale = distance > maxDistance ? maxDistance / distance : 1;
      vehicle.x = clamp(vehicle.x + dx * scale, 0, WORLD_WIDTH);
      vehicle.y = clamp(vehicle.y + dy * scale, 0, WORLD_HEIGHT);
      vehicle.heading = Number.isFinite(Number(msg.heading)) ? Number(msg.heading) : vehicle.heading;
      vehicle.speed = Number.isFinite(Number(msg.speed)) ? clamp(Number(msg.speed), -500, 500) : vehicle.speed;
      vehicle.hp = Number.isFinite(Number(msg.hp)) ? clamp(Number(msg.hp), 0, 250) : vehicle.hp;
      vehicle.updatedAt = nowMs;
      player.x = vehicle.x; player.y = vehicle.y; player.heading = vehicle.heading;
      player.inVehicle = true; player.vehicleType = vehicle.type; player.updatedAt = nowMs;
      return;
    }


    if(msg.type==='attack'){
      if(!player.alive)return;const wi=clamp(Number.parseInt(msg.weapon,10)||0,0,WEAPON_NET.length-1),w=WEAPON_NET[wi],nowMs=Date.now();if(nowMs-player.lastAttackAt<1000/w.rate*.82)return;player.lastAttackAt=nowMs;const a=Number.isFinite(Number(msg.angle))?Number(msg.angle):player.heading;
      if(w.melee){let best=null,bd=w.range;for(const t of players.values()){if(t.id===id||!t.alive||t.inVehicle)continue;const dx=t.x-player.x,dy=t.y-player.y,d=Math.hypot(dx,dy);if(d>=bd)continue;let da=Math.atan2(dy,dx)-a;while(da>Math.PI)da-=Math.PI*2;while(da<-Math.PI)da+=Math.PI*2;if(Math.abs(da)>.85)continue;best=t;bd=d;}if(best){best.x=clamp(best.x+Math.cos(a)*12,0,WORLD_WIDTH);best.y=clamp(best.y+Math.sin(a)*12,0,WORLD_HEIGHT);applyPlayerDamage(best,w.damage,id);}}
      else for(let i=0;i<w.shots;i++)spawnProjectile(player,w,a+(Math.random()*2-1)*w.spread);return;
    }

    if (msg.type !== 'state') return;

    if(!player.alive)return;
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
    for (const vehicle of vehicles.values()) {
      if (vehicle.ownerId === id) { vehicle.ownerId = null; vehicle.speed = 0; vehicle.updatedAt = Date.now(); }
    }
    broadcast({ type: 'playerLeft', id });
  });

  ws.on('error', error => {
    console.error('WebSocket client error:', error.message);
  });
});

const interval = setInterval(() => {
  const now=Date.now(),dt=1/TICK_RATE;
  for(const p of players.values())if(!p.alive&&p.respawnAt&&now>=p.respawnAt){p.alive=true;p.hp=100;p.armor=0;p.x=2268;p.y=2106;p.heading=0;p.respawnAt=0;p.updatedAt=now;send(p.ws,{type:'respawn',player:publicPlayer(p)});}
  for(const [id,q] of projectiles){q.ttl-=dt;q.x+=q.vx*dt;q.y+=q.vy*dt;let remove=q.ttl<=0||q.x<0||q.y<0||q.x>WORLD_WIDTH||q.y>WORLD_HEIGHT;if(!remove)for(const t of players.values()){if(t.id===q.ownerId||!t.alive)continue;if(Math.hypot(t.x-q.x,t.y-q.y)<=(t.inVehicle?25:12)){applyPlayerDamage(t,q.damage,q.ownerId);remove=true;break;}}if(remove)projectiles.delete(id);}
  if(players.size===0)return;broadcast({type:'snapshot',serverTime:now,players:[...players.values()].map(publicPlayer),entities:{vehicles:[...vehicles.values()].map(publicVehicle),projectiles:[...projectiles.values()].map(publicProjectile)}});
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
