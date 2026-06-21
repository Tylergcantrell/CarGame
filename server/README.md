# Car Tag Server

This folder is the deployable Node server boundary.

It contains:

- `game-server.mjs`: thin process entrypoint.
- `runtime.mjs`: HTTP/WebSocket room server.
- `config.mjs`: local vs production environment config.
- `shared/`: authoritative gameplay, protocol, physics, AI, and vehicle tuning used by both server and browser.

The server serves the built client from `server/dist` when present, otherwise from root `dist/` during local development. For a one-folder Lightsail deploy, copy the built client into `server/dist`.

```bash
npm run build:server
```

## Local

```bash
npm run build
npm run server
```

Default local mode binds to `127.0.0.1:8787`.

## LAN

```bash
npm run build
npm run server:lan
```

This binds to `0.0.0.0:8787` for same-network testing.

## Stress Checks

Run against an already-running local server:

```bash
npm run stress:multiplayer
```

Start an isolated temporary server and stress it:

```bash
npm run check:stress
npm run check:wan
```

Useful overrides:

```bash
STRESS_ROOMS=16 STRESS_PLAYERS_PER_ROOM=8 STRESS_DURATION_MS=12000 npm run check:stress
WAN_LATENCY_MS=90 WAN_JITTER_MS=40 npm run check:wan
```

## Production Profile

```bash
SERVER_PROFILE=production \
HOST=0.0.0.0 \
PORT=8787 \
ALLOWED_ORIGINS=https://your-domain.example \
SESSION_SECRET=$(openssl rand -base64 32) \
npm run server:prod
```

`SERVER_PROFILE=production` requires `ALLOWED_ORIGINS` and `SESSION_SECRET` by default so browser WebSocket origins are not open accidentally and reconnect session tokens cannot be forged.

Production config is validated on boot. Keep `MAX_CLIENTS_PER_ROOM <= MAX_CARS` and `SNAPSHOT_RATE <= TICK_RATE`; invalid values fail fast instead of running a degraded server.
