import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createHmac, randomUUID } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { loadServerConfig } from "./config.mjs";
import {
  arenaIds,
  clamp,
  clampInput,
  createSimState,
  makeSnapshot as makeSimSnapshot,
  mergeInput,
  tickSim,
} from "./shared/cannon-multiplayer-sim.js";
import { aiDifficultyIds, normalizeAiDifficulty } from "./shared/ai.js";
import { protocolVersion } from "./shared/protocol.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const packagedDistDir = path.join(__dirname, "dist");
const projectDistDir = path.join(rootDir, "dist");
const distDir = process.env.CLIENT_DIST_DIR
  ? path.resolve(process.env.CLIENT_DIST_DIR)
  : fs.existsSync(packagedDistDir)
    ? packagedDistDir
    : projectDistDir;

const config = loadServerConfig();

const validArenas = new Set(arenaIds);
const validAiDifficulties = new Set(aiDifficultyIds);
const colors = ["red", "teal", "yellow", "blue", "purple", "green", "orange", "pink"];
const roomVisibilities = new Set(["public", "private"]);

const rooms = new Map();
const clients = new Map();
const serverStartedAt = Date.now();
const metrics = {
  totalConnections: 0,
  rejectedConnections: 0,
  closedConnections: 0,
  terminatedConnections: 0,
  messages: 0,
  inputs: 0,
  staleInputs: 0,
  suspiciousInputs: 0,
  ignoredInputs: 0,
  droppedMessages: 0,
  rejections: {},
  snapshots: 0,
  skippedSnapshots: 0,
  reliableEventsQueued: 0,
  reliableEventsSent: 0,
  reliableEventsAcked: 0,
  reliableEventsExpired: 0,
  reliableEventsBackpressured: 0,
  tagEvents: 0,
  roundsStarted: 0,
  roundsEnded: 0,
  simTicks: 0,
  simTickMsTotal: 0,
  simTickMsMax: 0,
};

const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();

const snapshotBackpressureBytes = 512 * 1024;
const reliableBackpressureBytes = 1024 * 1024;
const disconnectBackpressureBytes = 4 * 1024 * 1024;
const reliableResendMs = 250;
const reliableEventTtlMs = 10000;
const maxInputSequenceJump = 300;
const maxPlayerNameLength = 14;

function recordRejection(reason) {
  metrics.droppedMessages += 1;
  metrics.rejections[reason] = (metrics.rejections[reason] ?? 0) + 1;
}

function nowMs() {
  return Date.now();
}

function sanitizeName(value) {
  const clean = String(value ?? "").replace(/\s+/g, " ").trim();
  return clean.slice(0, maxPlayerNameLength) || "Player";
}

function sanitizeRoomCode(value) {
  const clean = String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);
  return clean || "LOCAL";
}

function sanitizeRoomVisibility(value) {
  return roomVisibilities.has(value) ? value : "private";
}

function signSessionId(id) {
  return createHmac("sha256", config.sessionSecret).update(id).digest("base64url");
}

function createSessionId() {
  const id = randomUUID();
  return `${id}.${signSessionId(id)}`;
}

function validSessionId(value) {
  const clean = String(value ?? "").trim();
  const match = clean.match(/^([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/i);
  return Boolean(match && signSessionId(match[1]) === match[2]);
}

function sanitizeSessionId(value) {
  const clean = String(value ?? "").trim().slice(0, 128);
  return validSessionId(clean) ? clean : createSessionId();
}

function generateRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let code = "";
    for (let i = 0; i < 4; i += 1) code += alphabet[Math.floor(Math.random() * alphabet.length)];
    if (!rooms.has(code)) return code;
  }
  return randomUUID().slice(0, 6).toUpperCase();
}

function validOrigin(origin) {
  if (config.allowedOrigins.length === 0) return true;
  if (!origin) return false;
  return config.allowedOrigins.includes(origin);
}

function contentTypeFor(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".webp")) return "image/webp";
  if (filePath.endsWith(".ico")) return "image/x-icon";
  return "application/octet-stream";
}

function secureHeaders(extra = {}) {
  if (!config.secureHeaders) return extra;
  return {
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
    ...extra,
  };
}

function collectHealth() {
  const roomList = [...rooms.values()];
  const activeRooms = roomList.filter((room) => room.activeRound).length;
  return {
    ok: true,
    uptimeSeconds: Math.round((nowMs() - serverStartedAt) / 1000),
    rooms: roomList.length,
    clients: clients.size,
    activeRounds: activeRooms,
    config: {
      profile: config.profile,
      host: config.host,
      port: config.port,
      protocolVersion,
      maxCars: config.maxCars,
      maxRooms: config.maxRooms,
      maxActiveRooms: config.maxActiveRooms,
      maxClientsPerRoom: config.maxClientsPerRoom,
      tickRate: config.tickRate,
      snapshotRate: config.snapshotRate,
    },
  };
}

function collectMetrics() {
  const eventLoop = {
    meanMs: eventLoopDelay.mean / 1e6,
    maxMs: eventLoopDelay.max / 1e6,
    p95Ms: eventLoopDelay.percentile(95) / 1e6,
    p99Ms: eventLoopDelay.percentile(99) / 1e6,
  };
  return {
    ...collectHealth(),
    eventLoop,
    metrics: {
      ...metrics,
      simTickMsAvg: metrics.simTickMsTotal / Math.max(1, metrics.simTicks),
    },
    rooms: [...rooms.values()].map((room) => ({
      code: room.code,
      visibility: room.visibility,
      clients: room.clients.size,
      phase: room.activeRound ? "round" : "lobby",
      controllerId: room.controllerId,
      roundsStarted: room.roundsStarted,
      snapshots: room.snapshots,
      simTicks: room.simTicks,
      simTickMsAvg: room.simTickMsTotal / Math.max(1, room.simTicks),
      simTickMsMax: room.simTickMsMax,
      clientsDetail: [...room.clients.values()].map((client) => ({
        id: client.id,
        bufferedAmount: client.ws.bufferedAmount,
        skippedSnapshots: client.skippedSnapshots,
        droppedMessages: client.droppedMessages,
        pendingReliableEvents: client.pendingReliableEvents.size,
      })),
    })),
  };
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (url.pathname === "/healthz") {
    response.writeHead(200, secureHeaders({ "content-type": "application/json; charset=utf-8" }));
    response.end(JSON.stringify(collectHealth()));
    return;
  }
  if (url.pathname === "/metrics") {
    response.writeHead(200, secureHeaders({ "content-type": "application/json; charset=utf-8" }));
    response.end(JSON.stringify(collectMetrics()));
    return;
  }
  if (url.pathname === "/router-state") {
    response.writeHead(200, secureHeaders({ "content-type": "application/json; charset=utf-8" }));
    response.end(JSON.stringify({
      ok: true,
      roomCount: rooms.size,
      maxRooms: config.maxRooms,
      maxPlayers: config.maxClientsPerRoom,
      activeRounds: [...rooms.values()].filter((room) => room.activeRound).length,
      rooms: publicRoomList(),
    }));
    return;
  }

  const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const requested = path.resolve(distDir, relative);
  if (!requested.startsWith(distDir) || !fs.existsSync(requested) || !fs.statSync(requested).isFile()) {
    if (fs.existsSync(path.join(distDir, "index.html"))) {
      response.writeHead(200, secureHeaders({ "content-type": "text/html; charset=utf-8" }));
      response.end(fs.readFileSync(path.join(distDir, "index.html")));
      return;
    }
    response.writeHead(200, secureHeaders({ "content-type": "text/plain; charset=utf-8" }));
    response.end("Car Tag game server is running. Build the client with npm run build to serve it here.\n");
    return;
  }

  response.writeHead(200, secureHeaders({
    "content-type": contentTypeFor(requested),
    "cache-control": requested.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
  }));
  fs.createReadStream(requested).pipe(response);
});

const wss = new WebSocketServer({
  server,
  maxPayload: 2048,
  verifyClient(info, done) {
    if (!validOrigin(info.origin)) {
      metrics.rejectedConnections += 1;
      metrics.rejections.origin_not_allowed = (metrics.rejections.origin_not_allowed ?? 0) + 1;
      done(false, 403, "Origin not allowed");
      return;
    }
    done(true);
  },
});

function createRoom(code, visibility = "private") {
  const room = {
    code,
    visibility: sanitizeRoomVisibility(visibility),
    clients: new Map(),
    sessions: new Map(),
    controllerId: null,
    settings: {
      roundTime: 120,
      carCount: 4,
      arena: "orange",
      aiDifficulty: "medium",
    },
    activeRound: null,
    roundTimer: null,
    simTimer: null,
    createdAt: nowMs(),
    lastActiveAt: nowMs(),
    roundsStarted: 0,
    snapshots: 0,
    simTicks: 0,
    simTickMsTotal: 0,
    simTickMsMax: 0,
    nextEventId: 1,
  };
  rooms.set(code, room);
  return room;
}

function destroyRoomIfEmpty(room) {
  if (!room || room.clients.size > 0) return false;
  clearTimeout(room.roundTimer);
  room.roundTimer = null;
  room.simTimer = null;
  room.activeRound = null;
  rooms.delete(room.code);
  stopSimTimerIfIdle();
  return true;
}

function getOrCreateRoom(requestedCode, createIfMissing = true, visibility = "private") {
  const hasRequestedCode = String(requestedCode ?? "").trim().length > 0;
  const code = hasRequestedCode ? sanitizeRoomCode(requestedCode) : generateRoomCode();
  if (hasRequestedCode && rooms.has(code)) return rooms.get(code);
  if (!createIfMissing) return null;
  if (rooms.size >= config.maxRooms) return null;
  return createRoom(code, visibility);
}

function getPlayerMinimum(room) {
  return Math.max(1, Math.min(config.maxCars, room.clients.size));
}

function normalizeSettings(room, nextSettings) {
  const nextAiDifficulty = Object.prototype.hasOwnProperty.call(nextSettings, "aiDifficulty")
    ? normalizeAiDifficulty(nextSettings.aiDifficulty)
    : normalizeAiDifficulty(room.settings.aiDifficulty);
  return {
    roundTime: clamp(Number(nextSettings.roundTime) || room.settings.roundTime, config.minRoundTime, config.maxRoundTime),
    carCount: clamp(Number(nextSettings.carCount) || room.settings.carCount, getPlayerMinimum(room), config.maxCars),
    arena: validArenas.has(nextSettings.arena) ? nextSettings.arena : room.settings.arena,
    aiDifficulty: validAiDifficulties.has(nextAiDifficulty) ? nextAiDifficulty : "medium",
  };
}

function firstAvailableColor(room, exceptSessionId = null) {
  const used = new Set(
    [...room.clients.values()]
      .filter((client) => client.sessionId !== exceptSessionId)
      .map((client) => client.color),
  );
  return colors.find((color) => !used.has(color)) ?? colors[0];
}

function colorTakenByOther(room, color, sessionId) {
  return [...room.clients.values()].some((client) => client.sessionId !== sessionId && client.color === color);
}

function assignController(room) {
  if (room.controllerId && room.clients.has(room.controllerId)) return;
  room.controllerId = room.clients.keys().next().value ?? null;
}

function roundPlayerSessions(room) {
  if (!room.activeRound) return new Set();
  return new Set(room.activeRound.slots
    .filter((slot) => slot.type === "player" && slot.clientId)
    .map((slot) => slot.sessionId));
}

function publicSlot(slot, selfSessionId = null) {
  return {
    ...slot,
    sessionId: slot.sessionId && slot.sessionId === selfSessionId ? slot.sessionId : null,
  };
}

function publicRound(round, selfSessionId = null) {
  if (!round) return null;
  return {
    id: round.id,
    startedAt: round.startedAt,
    playStartsAt: round.playStartsAt,
    endsAt: round.endsAt,
    settings: round.settings,
    slots: round.slots.map((slot) => publicSlot(slot, selfSessionId)),
  };
}

function publicRoomList() {
  return [...rooms.values()]
    .filter((room) => room.visibility === "public" && (room.clients.size > 0 || room.activeRound))
    .map((room) => {
      const controller = room.controllerId ? room.clients.get(room.controllerId) : null;
      return {
        code: room.code,
        visibility: room.visibility,
        phase: room.activeRound ? "round" : "lobby",
        playerCount: room.clients.size,
        maxPlayers: config.maxClientsPerRoom,
        controllerName: controller?.name ?? "Host",
        settings: room.settings,
        roundEndsAt: room.activeRound?.endsAt ?? null,
        createdAt: room.createdAt,
      };
    })
    .sort((a, b) => {
      if (a.phase !== b.phase) return a.phase === "lobby" ? -1 : 1;
      return b.playerCount - a.playerCount || a.code.localeCompare(b.code);
    });
}

function sendRoomList(client) {
  send(client, {
    type: "roomList",
    rooms: publicRoomList(),
    roomCount: rooms.size,
    maxRooms: config.maxRooms,
    maxPlayers: config.maxClientsPerRoom,
  });
}

function publicState(room, selfId = null) {
  const inRound = roundPlayerSessions(room);
  const selfClient = selfId ? room.clients.get(selfId) : null;
  return {
    type: "state",
    protocolVersion,
    serverTime: nowMs(),
    selfId,
    roomCode: room.code,
    roomVisibility: room.visibility,
    roomCount: rooms.size,
    maxRooms: config.maxRooms,
    maxPlayers: config.maxClientsPerRoom,
    controllerId: room.controllerId,
    phase: room.activeRound ? "round" : "lobby",
    settings: room.settings,
    colors,
    clients: [...room.clients.values()].map((client) => ({
      id: client.id,
      publicId: client.publicId,
      sessionId: client.id === selfId ? client.sessionId : null,
      name: client.name,
      color: client.color,
      isController: client.id === room.controllerId,
      inRound: inRound.has(client.sessionId),
    })),
    round: publicRound(room.activeRound, selfClient?.sessionId),
  };
}

function send(client, payload) {
  if (client.ws.readyState !== client.ws.OPEN) return;
  client.ws.send(JSON.stringify(payload));
}

function sendRaw(client, payloadJson) {
  if (client.ws.readyState !== client.ws.OPEN) return;
  client.ws.send(payloadJson);
}

function closeIfBadlyBackpressured(client) {
  if (client.ws.bufferedAmount <= disconnectBackpressureBytes) return false;
  metrics.terminatedConnections += 1;
  client.ws.close(4002, "Client is too far behind.");
  return true;
}

function sendSnapshot(client, payload) {
  if (client.ws.readyState !== client.ws.OPEN) return false;
  if (closeIfBadlyBackpressured(client)) return false;
  if (client.ws.bufferedAmount > snapshotBackpressureBytes) {
    client.skippedSnapshots += 1;
    metrics.skippedSnapshots += 1;
    return false;
  }
  client.ws.send(JSON.stringify(payload));
  return true;
}

function flushReliableEvents(client, now = nowMs()) {
  if (!client.pendingReliableEvents?.size || client.ws.readyState !== client.ws.OPEN) return;
  if (closeIfBadlyBackpressured(client)) return;
  for (const [eventId, pending] of client.pendingReliableEvents) {
    if (now - pending.createdAt > reliableEventTtlMs) {
      client.pendingReliableEvents.delete(eventId);
      metrics.reliableEventsExpired += 1;
      continue;
    }
    if (now - pending.lastSentAt < reliableResendMs) continue;
    if (client.ws.bufferedAmount > reliableBackpressureBytes) {
      metrics.reliableEventsBackpressured += 1;
      break;
    }
    pending.lastSentAt = now;
    sendRaw(client, pending.payloadJson);
    metrics.reliableEventsSent += 1;
  }
}

function enqueueReliableEvent(client, event, now = nowMs()) {
  if (client.ws.readyState !== client.ws.OPEN) return;
  client.pendingReliableEvents.set(event.eventId, {
    payloadJson: JSON.stringify(event),
    createdAt: now,
    lastSentAt: 0,
  });
  metrics.reliableEventsQueued += 1;
  flushReliableEvents(client, now);
}

function broadcastReliableEvent(room, event) {
  const now = nowMs();
  const eventWithId = {
    ...event,
    roomCode: room.code,
    eventId: room.nextEventId,
    serverTime: now,
  };
  room.nextEventId += 1;
  for (const client of room.clients.values()) enqueueReliableEvent(client, eventWithId, now);
  return eventWithId;
}

function broadcast(room, payloadFactory = publicState) {
  if (typeof payloadFactory !== "function") {
    const payloadJson = JSON.stringify(payloadFactory);
    for (const client of room.clients.values()) sendRaw(client, payloadJson);
    return;
  }
  for (const client of room.clients.values()) {
    send(client, payloadFactory(client.id));
  }
}

function broadcastState(room) {
  broadcast(room, (selfId) => publicState(room, selfId));
}

function publicSnapshotForClient(snapshot, client) {
  if (!snapshot || !client) return snapshot;
  return {
    ...snapshot,
    cars: snapshot.cars.map((car) => {
      const isSelf = car.sessionId === client.sessionId;
      return {
        key: car.key,
        position: car.position,
        quaternion: car.quaternion,
        velocity: car.velocity,
        angularVelocity: car.angularVelocity,
        score: car.score,
        isIt: car.isIt,
        immunityRemaining: car.immunityRemaining,
        boostTimeRemaining: car.boostTimeRemaining,
        boostCooldownRemaining: car.boostCooldownRemaining,
        input: car.input,
        ...(isSelf ? {
          sessionId: car.sessionId,
          inputSequence: car.inputSequence,
        } : {}),
      };
    }),
  };
}

function compactSnapshotForClient(snapshot, client) {
  if (!snapshot || !client) return snapshot;
  return {
    type: "snapshot",
    roomCode: snapshot.roomCode,
    roundId: snapshot.roundId,
    serverTime: snapshot.serverTime,
    simLastTick: snapshot.simLastTick,
    simAccumulator: snapshot.simAccumulator,
    remainingMs: snapshot.remainingMs,
    compact: 1,
    cars: snapshot.cars.map((car) => {
      const entry = [
        car.key,
        car.position,
        car.quaternion,
        car.velocity,
        car.angularVelocity,
        car.score,
        car.isIt ? 1 : 0,
        car.immunityRemaining,
        car.boostTimeRemaining,
        car.boostCooldownRemaining,
        car.input,
      ];
      if (car.sessionId === client.sessionId) {
        entry.push(car.inputSequence, car.sessionId);
      }
      return entry;
    }),
  };
}

function rankRoundResults(round, snapshot, room) {
  const carsByKey = new Map((snapshot?.cars ?? []).map((car) => [car.key, car]));
  const entries = round.slots.map((slot, index) => {
    const car = carsByKey.get(slot.key);
    return {
      key: slot.key,
      type: slot.type,
      id: slot.id ?? null,
      publicId: slot.publicId ?? null,
      clientId: slot.clientId ?? null,
      sessionId: slot.sessionId ?? null,
      name: slot.name ?? slot.color ?? slot.key,
      color: slot.color,
      connected: Boolean(slot.clientId && room.clients.has(slot.clientId)),
      scoreMs: Math.round((car?.score ?? 0) * 1000),
      slotIndex: index,
    };
  }).sort((a, b) => (b.scoreMs - a.scoreMs) || (a.slotIndex - b.slotIndex));

  let previousScoreMs = null;
  let previousRank = 0;
  let tieGroup = 0;
  return entries.map((entry, index) => {
    const tied = entry.scoreMs === previousScoreMs;
    if (!tied) tieGroup += 1;
    const rank = tied ? previousRank : index + 1;
    previousScoreMs = entry.scoreMs;
    previousRank = rank;
    return {
      key: entry.key,
      type: entry.type,
      id: entry.id,
      publicId: entry.publicId,
      clientId: entry.clientId,
      sessionId: entry.sessionId,
      name: entry.name,
      color: entry.color,
      connected: entry.connected,
      scoreMs: entry.scoreMs,
      rank,
      tieGroup,
    };
  });
}

function publicResultsForClient(results, client) {
  return results.map((result) => ({
    ...result,
    sessionId: result.sessionId && result.sessionId === client.sessionId ? result.sessionId : null,
  }));
}

function broadcastSnapshot(room, snapshot) {
  for (const client of room.clients.values()) {
    flushReliableEvents(client);
    sendSnapshot(client, compactSnapshotForClient(snapshot, client));
  }
}

function detachRoundPlayerSlot(room, slot) {
  if (!room.activeRound || !slot) return false;
  const previousClientId = slot.clientId;
  slot.clientId = null;
  if (slot.sessionId) {
    room.activeRound.sim?.inputs.delete(slot.sessionId);
    room.activeRound.sim?.inputSequences.delete(slot.sessionId);
    room.activeRound.sim?.inputTimes.delete(slot.sessionId);
  }

  return Boolean(previousClientId);
}

function buildRoundSlots(room, roundSettings) {
  const players = [...room.clients.values()];
  const usedColors = new Set();
  const usedSessions = new Set();
  const slots = players.flatMap((client) => {
    if (usedSessions.has(client.sessionId)) return [];
    usedSessions.add(client.sessionId);
    usedColors.add(client.color);
    const publicId = client.publicId ?? randomUUID();
    client.publicId = publicId;
    return [{
      key: `player:${publicId}`,
      type: "player",
      clientId: client.id,
      sessionId: client.sessionId,
      publicId,
      name: client.name,
      color: client.color,
    }];
  });

  let aiIndex = 1;
  while (slots.length < roundSettings.carCount) {
    const color = colors.find((entry) => !usedColors.has(entry)) ?? colors[slots.length % colors.length];
    usedColors.add(color);
    slots.push({
      key: `ai:${aiIndex}`,
      type: "ai",
      id: `ai-${aiIndex}`,
      name: `AI ${aiIndex}`,
      color,
    });
    aiIndex += 1;
  }
  return slots;
}

function tickRoom(room) {
  const round = room.activeRound;
  if (!round?.sim) return;
  const tickStart = performance.now();
  const now = nowMs();
  const result = tickSim(round, now);
  const tickMs = performance.now() - tickStart;
  metrics.simTicks += 1;
  metrics.simTickMsTotal += tickMs;
  metrics.simTickMsMax = Math.max(metrics.simTickMsMax, tickMs);
  room.simTicks += 1;
  room.simTickMsTotal += tickMs;
  room.simTickMsMax = Math.max(room.simTickMsMax, tickMs);
  if (result.events?.length) {
    for (const event of result.events) {
      if (event.type === "tagConfirmed") metrics.tagEvents += 1;
      broadcastReliableEvent(room, {
        ...event,
        roundId: round.id,
      });
    }
  }
  if (result.tagChanged) room.lastActiveAt = now;
  maybeBroadcastSnapshot(room, round, now);
}

function maybeBroadcastSnapshot(room, round, now) {
  const snapshotIntervalMs = 1000 / config.snapshotRate;
  round.sim.nextSnapshotAt ??= now;
  if (now + 1 < round.sim.nextSnapshotAt) return;
  if (now - round.sim.nextSnapshotAt > snapshotIntervalMs * 4) {
    round.sim.nextSnapshotAt = now + snapshotIntervalMs;
  } else {
    round.sim.nextSnapshotAt += snapshotIntervalMs;
  }
  round.sim.lastSnapshot = now;
  const snapshot = makeSimSnapshot(room.code, round, now);
  if (snapshot) {
    room.snapshots += 1;
    metrics.snapshots += 1;
    broadcastSnapshot(room, snapshot);
  }
}

function endRound(room, reason = "timer") {
  if (!room.activeRound) return;
  clearTimeout(room.roundTimer);
  room.roundTimer = null;
  room.simTimer = null;
  const endedRound = room.activeRound;
  const finalSnapshot = makeSimSnapshot(room.code, endedRound, nowMs());
  const finalResults = rankRoundResults(endedRound, finalSnapshot, room);
  room.activeRound = null;
  room.settings = normalizeSettings(room, room.settings);
  metrics.roundsEnded += 1;
  broadcast(room, (selfId) => {
    const client = room.clients.get(selfId);
    return {
      type: "roundEnded",
      roomCode: room.code,
      roundId: endedRound.id,
      reason,
      snapshot: publicSnapshotForClient(finalSnapshot, client),
      results: publicResultsForClient(finalResults, client),
    };
  });
  broadcastState(room);
  destroyRoomIfEmpty(room);
  stopSimTimerIfIdle();
}

function startRound(room, client) {
  if (!client || client.id !== room.controllerId || room.activeRound) return;
  const activeRounds = [...rooms.values()].filter((entry) => entry.activeRound).length;
  if (activeRounds >= config.maxActiveRooms) {
    send(client, {
      type: "error",
      code: "active_round_limit",
      message: "All active round slots are in use. Try again after a round ends.",
      maxActiveRooms: config.maxActiveRooms,
    });
    return;
  }
  const roundSettings = normalizeSettings(room, room.settings);
  room.settings = roundSettings;
  const startedAt = nowMs();
  const playStartsAt = startedAt + config.countdownMs;
  room.activeRound = {
    id: randomUUID(),
    startedAt,
    playStartsAt,
    endsAt: playStartsAt + roundSettings.roundTime * 1000,
    settings: roundSettings,
    slots: buildRoundSlots(room, roundSettings),
  };
  room.activeRound.sim = createSimState(room.activeRound, { now: nowMs() });
  clearTimeout(room.roundTimer);
  room.roundTimer = setTimeout(() => endRound(room, "timer"), config.countdownMs + roundSettings.roundTime * 1000 + 150);
  room.simTimer = null;
  ensureSimTimer();
  room.lastActiveAt = nowMs();
  room.roundsStarted += 1;
  metrics.roundsStarted += 1;
  broadcast(room, (selfId) => ({
    type: "roundStarted",
    roomCode: room.code,
    serverTime: nowMs(),
    round: publicRound(room.activeRound, room.clients.get(selfId)?.sessionId),
  }));
  broadcastState(room);
}

function rateLimit(client, bucketName, maxPerSecond) {
  const now = nowMs();
  const bucket = client.rate[bucketName] ?? { count: 0, resetAt: now + 1000 };
  if (now >= bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + 1000;
  }
  bucket.count += 1;
  client.rate[bucketName] = bucket;
  return bucket.count <= maxPerSecond;
}

function rejectMessage(client, reason = "unknown") {
  recordRejection(reason);
  client.droppedMessages += 1;
}

function leaveRoom(client) {
  const room = client.room;
  if (!room) return;
  client.pendingReliableEvents.clear();
  room.clients.delete(client.id);
  room.sessions.set(client.sessionId, {
    publicId: client.publicId,
    name: client.name,
    color: client.color,
    lastSeenAt: nowMs(),
  });
  if (room.controllerId === client.id) room.controllerId = null;
  assignController(room);
  room.settings = normalizeSettings(room, room.settings);
  if (room.activeRound) {
    const slot = room.activeRound.slots.find((entry) => entry.sessionId === client.sessionId);
    if (slot) detachRoundPlayerSlot(room, slot);
  }
  client.room = null;
  if (!destroyRoomIfEmpty(room)) broadcastState(room);
}

function joinRoom(client, room, requestedName) {
  if (client.room && client.room !== room) leaveRoom(client);
  for (const existing of clients.values()) {
    if (existing.id === client.id || existing.sessionId !== client.sessionId || existing.room === room) continue;
    leaveRoom(existing);
    existing.ws.close(4001, "Session continued in another connection.");
  }
  const existingSessionClient = [...room.clients.values()]
    .find((entry) => entry.id !== client.id && entry.sessionId === client.sessionId);
  const roomSizeAfterHandoff = room.clients.size - (existingSessionClient ? 1 : 0);
  if (roomSizeAfterHandoff >= config.maxClientsPerRoom && !room.clients.has(client.id)) {
    send(client, { type: "error", code: "room_full", message: "Room is full." });
    return false;
  }
  if (existingSessionClient) {
    leaveRoom(existingSessionClient);
    existingSessionClient.ws.close(4001, "Session continued in another connection.");
  }

  const session = room.sessions.get(client.sessionId);
  client.publicId = session?.publicId ?? client.publicId ?? randomUUID();
  client.name = sanitizeName(requestedName ?? session?.name ?? client.name);
  client.color = session?.color && !colorTakenByOther(room, session.color, client.sessionId)
    ? session.color
    : firstAvailableColor(room, client.sessionId);
  client.room = room;
  room.clients.set(client.id, client);
  room.sessions.set(client.sessionId, {
    publicId: client.publicId,
    name: client.name,
    color: client.color,
    lastSeenAt: nowMs(),
  });

  if (room.activeRound) {
    const slot = room.activeRound.slots.find((entry) => entry.sessionId === client.sessionId);
    if (slot) {
      slot.type = "player";
      slot.clientId = client.id;
      slot.publicId = client.publicId;
      slot.name = client.name;
      slot.color = client.color;
    }
  }

  assignController(room);
  room.settings = normalizeSettings(room, room.settings);
  room.lastActiveAt = nowMs();
  send(client, { type: "joined", roomCode: room.code, sessionId: client.sessionId });
  broadcastState(room);
  return true;
}

function joinRequestedRoom(client, message) {
  const hasRequestedCode = String(message.roomCode ?? "").trim().length > 0;
  const requestedCode = sanitizeRoomCode(message.roomCode);
  const creatingRoom = !hasRequestedCode || !rooms.has(requestedCode);
  const room = getOrCreateRoom(message.roomCode, true, sanitizeRoomVisibility(message.visibility));
  if (!room) {
    const maxRoomsReached = creatingRoom && rooms.size >= config.maxRooms;
    send(client, {
      type: "error",
      code: maxRoomsReached ? "max_rooms" : "room_unavailable",
      message: maxRoomsReached
        ? `All ${config.maxRooms} rooms are live. Join an existing room.`
        : "Room unavailable.",
      maxRooms: config.maxRooms,
      roomCount: rooms.size,
    });
    return false;
  }
  if (!room.clients.size && message.visibility) room.visibility = sanitizeRoomVisibility(message.visibility);
  return joinRoom(client, room, message.name);
}

function handleMessage(client, raw) {
  metrics.messages += 1;
  if (raw.length > 2048 || !rateLimit(client, "messages", 80)) {
    rejectMessage(client, raw.length > 2048 ? "message_too_large" : "message_rate_limit");
    return;
  }

  let message;
  try {
    message = JSON.parse(raw.toString());
  } catch {
    rejectMessage(client, "invalid_json");
    return;
  }
  if (!message || typeof message.type !== "string") {
    rejectMessage(client, "invalid_message");
    return;
  }

  if (message.type === "hello") {
    if (!rateLimit(client, "lobby", 8)) return rejectMessage(client, "lobby_rate_limit");
    if (message.protocolVersion !== protocolVersion) {
      send(client, {
        type: "error",
        code: "protocol_mismatch",
        message: "Client/server version mismatch. Refresh the page.",
        protocolVersion,
      });
      return;
    }
    client.sessionId = sanitizeSessionId(message.sessionId ?? client.sessionId);
    send(client, { type: "welcome", id: client.id, sessionId: client.sessionId, protocolVersion, colors });
    if (!message.lobbyOnly) joinRequestedRoom(client, message);
    sendRoomList(client);
    return;
  }

  if (message.type === "listRooms") {
    if (!rateLimit(client, "lobby", 8)) return rejectMessage(client, "lobby_rate_limit");
    sendRoomList(client);
    return;
  }

  if (message.type === "ping") {
    if (!rateLimit(client, "ping", 4)) return rejectMessage(client, "ping_rate_limit");
    send(client, {
      type: "pong",
      clientTime: Number(message.clientTime) || 0,
      sequence: Math.max(0, Math.floor(Number(message.sequence) || 0)),
      serverTime: nowMs(),
    });
    return;
  }

  if (message.type === "ackEvent") {
    if (!rateLimit(client, "events", 40)) return rejectMessage(client, "event_ack_rate_limit");
    const eventId = Math.max(0, Math.floor(Number(message.eventId) || 0));
    if (client.pendingReliableEvents.delete(eventId)) metrics.reliableEventsAcked += 1;
    return;
  }

  if (message.type === "joinRoom") {
    if (!rateLimit(client, "lobby", 6)) return rejectMessage(client, "lobby_rate_limit");
    joinRequestedRoom(client, {
      ...message,
      name: message.name ?? client.name,
    });
    sendRoomList(client);
    return;
  }

  if (message.type === "leaveRoom") {
    if (!rateLimit(client, "lobby", 6)) return rejectMessage(client, "lobby_rate_limit");
    leaveRoom(client);
    sendRoomList(client);
    return;
  }

  const room = client.room;
  if (!room) {
    rejectMessage(client, "not_in_room");
    return;
  }
  room.lastActiveAt = nowMs();

  if (message.type === "setRoomVisibility") {
    if (!rateLimit(client, "lobby", 8)) return rejectMessage(client, "lobby_rate_limit");
    if (client.id !== room.controllerId || room.activeRound) return;
    room.visibility = sanitizeRoomVisibility(message.visibility);
    broadcastState(room);
    sendRoomList(client);
    return;
  }

  if (message.type === "setName") {
    if (!rateLimit(client, "lobby", 8)) return rejectMessage(client, "lobby_rate_limit");
    client.name = sanitizeName(message.name);
    room.sessions.set(client.sessionId, { name: client.name, color: client.color, lastSeenAt: nowMs() });
    broadcastState(room);
    return;
  }

  if (message.type === "setColor") {
    if (!rateLimit(client, "lobby", 8)) return rejectMessage(client, "lobby_rate_limit");
    const nextColor = colors.includes(message.color) ? message.color : client.color;
    if (!colorTakenByOther(room, nextColor, client.sessionId)) {
      client.color = nextColor;
      room.sessions.set(client.sessionId, { name: client.name, color: client.color, lastSeenAt: nowMs() });
    }
    broadcastState(room);
    return;
  }

  if (message.type === "updateSettings") {
    if (!rateLimit(client, "lobby", 12)) return rejectMessage(client, "lobby_rate_limit");
    if (client.id !== room.controllerId || room.activeRound) return;
    room.settings = normalizeSettings(room, { ...room.settings, ...message.settings });
    broadcastState(room);
    return;
  }

  if (message.type === "startRound") {
    if (!rateLimit(client, "lobby", 8)) return rejectMessage(client, "lobby_rate_limit");
    startRound(room, client);
    return;
  }

  if (message.type === "input") {
    if (!rateLimit(client, "inputs", 75)) return rejectMessage(client, "input_rate_limit");
    const round = room.activeRound;
    if (!round?.sim || !round.slots.some((slot) => (
      slot.type === "player" &&
      slot.sessionId === client.sessionId &&
      slot.clientId === client.id
    ))) {
      metrics.ignoredInputs += 1;
      return;
    }
    if (message.roundId !== round.id) {
      metrics.ignoredInputs += 1;
      return;
    }
    const sequence = Math.max(0, Math.floor(Number(message.sequence) || 0));
    const previousSequence = round.sim.inputSequences.get(client.sessionId) ?? 0;
    if (sequence < previousSequence) {
      metrics.staleInputs += 1;
      return;
    }
    if (sequence > previousSequence + maxInputSequenceJump) {
      metrics.suspiciousInputs += 1;
      rejectMessage(client, "input_sequence_jump");
      return;
    }
    metrics.inputs += 1;
    round.sim.inputs.set(client.sessionId, mergeInput(round.sim.inputs.get(client.sessionId), message.input));
    round.sim.inputSequences.set(client.sessionId, sequence);
    round.sim.inputTimes.set(client.sessionId, nowMs());
    return;
  }

  if (message.type === "leaveRound") {
    if (!room.activeRound) return;
    const slot = room.activeRound.slots.find((entry) => entry.sessionId === client.sessionId);
    if (slot) detachRoundPlayerSlot(room, slot);
    broadcastState(room);
    return;
  }

  rejectMessage(client, "unknown_type");
}

wss.on("connection", (ws) => {
  metrics.totalConnections += 1;
  const client = {
    id: randomUUID(),
    sessionId: createSessionId(),
    publicId: randomUUID(),
    ws,
    room: null,
    name: "Player",
    color: colors[0],
    alive: true,
    rate: {},
    droppedMessages: 0,
    skippedSnapshots: 0,
    pendingReliableEvents: new Map(),
  };
  clients.set(client.id, client);

  ws.on("message", (raw) => handleMessage(client, raw));
  ws.on("pong", () => {
    client.alive = true;
  });
  ws.on("close", () => {
    metrics.closedConnections += 1;
    clients.delete(client.id);
    leaveRoom(client);
  });
});

let heartbeatTimer = null;
let cleanupTimer = null;
let simTimer = null;

function stopSimTimerIfIdle() {
  if (!simTimer) return;
  for (const room of rooms.values()) {
    if (room.activeRound) return;
  }
  clearInterval(simTimer);
  simTimer = null;
}

function tickActiveRooms() {
  for (const room of rooms.values()) {
    if (room.activeRound) tickRoom(room);
  }
  stopSimTimerIfIdle();
}

function ensureSimTimer() {
  if (simTimer) return;
  simTimer = setInterval(tickActiveRooms, 1000 / config.tickRate);
  simTimer.unref();
}

function startMaintenanceTimers() {
  heartbeatTimer ??= setInterval(() => {
    for (const client of clients.values()) {
      if (!client.alive) {
        metrics.terminatedConnections += 1;
        client.ws.terminate();
        continue;
      }
      client.alive = false;
      client.ws.ping();
      flushReliableEvents(client);
    }
  }, 15000);
  heartbeatTimer.unref();

  cleanupTimer ??= setInterval(() => {
    const now = nowMs();
    for (const room of rooms.values()) {
      for (const [sessionId, session] of room.sessions) {
        if (room.clients.size > 0 && now - session.lastSeenAt <= config.reconnectGraceMs) continue;
        if (![...room.clients.values()].some((client) => client.sessionId === sessionId)) {
          room.sessions.delete(sessionId);
        }
      }
      if (room.clients.size === 0 && !room.activeRound) {
        rooms.delete(room.code);
        continue;
      }
      if (now - room.lastActiveAt < config.inactiveRoomMs) continue;
      if (room.clients.size === 0 && !room.activeRound) rooms.delete(room.code);
    }
  }, 30000);
  cleanupTimer.unref();
}

function shutdown() {
  clearInterval(heartbeatTimer);
  clearInterval(cleanupTimer);
  clearInterval(simTimer);
  for (const room of rooms.values()) {
    clearTimeout(room.roundTimer);
  }
  wss.close();
  server.close(() => process.exit(0));
}

export function startGameServer() {
  startMaintenanceTimers();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  server.listen(config.port, config.host, () => {
    const hostLabel = config.host === "0.0.0.0" ? "0.0.0.0" : config.host;
    console.log(`Car Tag server listening on http://${hostLabel}:${config.port}`);
    console.log(`WebSocket endpoint ws://${hostLabel}:${config.port}`);
    console.log(`Profile ${config.profile}; origins ${config.allowedOrigins.length ? config.allowedOrigins.join(",") : "open"}`);
  });
  return { server, wss, config, rooms, clients };
}
