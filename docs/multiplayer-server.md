# Multiplayer Server

The Node server is designed to run locally by default and to port to a Lightsail/EC2-style host later without changing the client protocol.

The deployable server boundary is `server/`:

- `server/game-server.mjs` is the thin process entrypoint.
- `server/runtime.mjs` owns HTTP, WebSocket rooms, lifecycle, and snapshots.
- `server/config.mjs` owns environment config and local/production profile behavior.
- `server/shared/` owns authoritative gameplay, physics, protocol, tuning, and AI shared by browser and server.

For local development the server serves root `dist/`. For a one-folder Lightsail deploy, run `npm run build:server` to write the built client into `server/dist/`; the runtime checks that location first.

## Local-Safe Mode

```bash
npm run build
npm run server
```

Default bind:

```text
HOST=127.0.0.1
PORT=8787
```

Open:

```text
http://127.0.0.1:8787/
```

The WebSocket endpoint is the same host/port:

```text
ws://127.0.0.1:8787
```

For a hosted frontend, set `VITE_MULTIPLAYER_URL` during the client build, for example:

```bash
VITE_MULTIPLAYER_URL=wss://your-backend.example npm run build
```

## LAN Test Mode

```bash
npm run build
npm run server:lan
```

This binds `HOST=0.0.0.0`, so devices on the same network can connect if the firewall allows it.

## Health And Smoke Tests

```text
http://127.0.0.1:8787/healthz
http://127.0.0.1:8787/metrics
```

With the server running:

```bash
npm run smoke:multiplayer
npm run stress:multiplayer
npm run check:wan
```

The smoke test verifies health, room isolation, round start, server snapshots, input sequence acknowledgement, and session reconnect.

For an isolated load test that starts and stops its own local server:

```bash
npm run check:stress
```

For an isolated WAN-feel test, `npm run check:wan` starts a temporary server plus a local WebSocket proxy that adds latency and jitter while preserving TCP/WebSocket ordering. Useful overrides:

```bash
WAN_LATENCY_MS=90 WAN_JITTER_MS=40 STRESS_ROOMS=4 STRESS_PLAYERS_PER_ROOM=4 npm run check:wan
```

`WAN_LOSS_RATE` exists as a chaos knob, but keep it at `0` for the normal alpha gate because WebSocket runs over TCP and does not silently drop complete messages.

## Lightsail/EC2 Shape Later

Run behind a reverse proxy such as Caddy or Nginx for HTTPS/WSS, or bind directly during a private test:

```bash
npm ci
npm run build
HOST=0.0.0.0 PORT=8787 npm start
```

Recommended production environment variables:

```text
SERVER_PROFILE=production
HOST=0.0.0.0
PORT=8787
ALLOWED_ORIGINS=https://your-domain.example
SESSION_SECRET=replace-with-at-least-32-random-bytes
MAX_ROOMS=4
MAX_CLIENTS_PER_ROOM=8
MAX_CARS=8
TICK_RATE=60
SNAPSHOT_RATE=30
```

`SERVER_PROFILE=production` requires `ALLOWED_ORIGINS` and `SESSION_SECRET` by default. This is intentional: local mode can be open for same-machine testing, but the production switch should not accidentally accept WebSocket connections from arbitrary origins or forged reconnect session tokens.

For a local production-profile check:

```bash
ALLOWED_ORIGINS=http://127.0.0.1:8787 SESSION_SECRET=local-prod-check-secret npm run server:prod
```

## Current Server Guarantees

- Multiple room codes.
- Unique colors per room.
- Controller handoff.
- Late join lobby behavior.
- Persistent session IDs for reconnect.
- Server-owned round timer, scores, tags, snapshots, and input acknowledgement.
- Confirmed tag transfers emit explicit server-authoritative `tagConfirmed` events with room event IDs, server time, sim tick, tagger/tagged car keys, contact type, and contact position.
- Critical tag events are acknowledged by clients and resent for a bounded window; clients dedupe by event ID, while snapshots remain the durable state source.
- Shared Cannon simulation module used by solo play, browser multiplayer prediction, and the authoritative Node server.
- Shared gameplay includes the Cannon world config, RaycastVehicle tuning, chassis collider shapes, arena physics bodies, boost, jump, aerial control, recovery, scoring, tag transfer, and AI via `server/shared/ai.js`.
- Snapshot timing includes server sim tick and accumulator state so browser prediction rebuilds preserve fixed-step phase.
- Queued jump/recovery and boost inputs merge until the shared sim consumes them, preventing short input pulses from being overwritten before a server tick.
- Protocol version check on connect so stale clients are rejected instead of failing silently.
- Message size limit, per-client rate limits, input sequence jump rejection, config validation, and rejection counters in `/metrics`.
- Snapshot sends check WebSocket backpressure. Slow clients can skip replaceable snapshots, but reliable tag events are retried before expiry.
- Unexpected client socket closes auto-reconnect from the browser using the previous lobby/room intent and persistent session ID.
- Static `dist/` serving from the same Node process.

## Tag Fairness Model

The server is the only source of truth for tag transfers. Tags are currently decided from the authoritative Cannon simulation using chassis contact plus the existing wheel/body overlap checks. There is no deep lag rewind and no client-authoritative hit claim.

When a tag transfers, the server changes the authoritative `isIt` state and emits a `tagConfirmed` event. Clients use that event for immediate visible feedback, then continue to accept snapshots as the state correction path. The event `contactType` is one of:

```text
chassis-contact
wheel-body
wheel-wheel
```

The main tuning constants live in `server/shared/cannon-multiplayer-sim.js` and `server/shared/vehicle-config.js`, including `wheelTagSkin`, `wheelTagBounds`, `vehicleTuning.tagImmunityDuration`, and the shared `tagCooldown`.

## Launch Readiness

Controlled alpha is acceptable when these pass on the target machine:

```bash
npm run test:sim
npm run smoke:multiplayer
npm run check:stress
npm run check:wan
```

For a full public launch, still validate HTTPS/WSS behind the real reverse proxy, real phones/laptops across Wi-Fi and cellular, server logs/metrics retention, and abuse controls at the network edge.
