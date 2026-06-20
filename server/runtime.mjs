import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
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
const colors = ["red", "teal", "gold", "blue", "purple", "green", "orange", "pink"];
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
  ignoredInputs: 0,
  droppedMessages: 0,
  rejections: {},
  snapshots: 0,
  roundsStarted: 0,
  roundsEnded: 0,
  simTicks: 0,
  simTickMsTotal: 0,
  simTickMsMax: 0,
};

function recordRejection(reason) {
  metrics.droppedMessages += 1;
  metrics.rejections[reason] = (metrics.rejections[reason] ?? 0) + 1;
}

function nowMs() {
  return Date.now();
}

function sanitizeName(value) {
  const clean = String(value ?? "").replace(/\s+/g, " ").trim();
  return clean.slice(0, 18) || "Player";
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

function generateRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let code = "";
    for (let i = 0; i < 4; i += 1) code += alphabet[Math.floor(Math.random() * alphabet.length)];
    if (!rooms.has(code)) return code;
  }
  return randomUUID().slice(0, 6).toUpperCase();
}

function sanitizeSessionId(value) {
  const clean = String(value ?? "").replace(/[^a-f0-9-]/gi, "").slice(0, 64);
  return clean.length >= 16 ? clean : randomUUID();
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
  return {
    ok: true,
    uptimeSeconds: Math.round((nowMs() - serverStartedAt) / 1000),
    rooms: roomList.length,
    clients: clients.size,
    activeRounds: roomList.filter((room) => room.activeRound).length,
    config: {
      profile: config.profile,
      host: config.host,
      port: config.port,
      protocolVersion,
      maxCars: config.maxCars,
      maxRooms: config.maxRooms,
      maxClientsPerRoom: config.maxClientsPerRoom,
      tickRate: config.tickRate,
      snapshotRate: config.snapshotRate,
    },
  };
}

function collectMetrics() {
  return {
    ...collectHealth(),
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
    },
    activeRound: null,
    roundTimer: null,
    simTimer: null,
    createdAt: nowMs(),
    lastActiveAt: nowMs(),
    roundsStarted: 0,
    snapshots: 0,
  };
  rooms.set(code, room);
  return room;
}

function destroyRoomIfEmpty(room) {
  if (!room || room.clients.size > 0 || room.activeRound) return false;
  clearTimeout(room.roundTimer);
  clearInterval(room.simTimer);
  room.roundTimer = null;
  room.simTimer = null;
  rooms.delete(room.code);
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
  return {
    roundTime: clamp(Number(nextSettings.roundTime) || room.settings.roundTime, config.minRoundTime, config.maxRoundTime),
    carCount: clamp(Number(nextSettings.carCount) || room.settings.carCount, getPlayerMinimum(room), config.maxCars),
    arena: validArenas.has(nextSettings.arena) ? nextSettings.arena : room.settings.arena,
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
  return new Set(room.activeRound.slots.filter((slot) => slot.type === "player").map((slot) => slot.sessionId));
}

function publicRound(round) {
  if (!round) return null;
  return {
    id: round.id,
    startedAt: round.startedAt,
    playStartsAt: round.playStartsAt,
    endsAt: round.endsAt,
    settings: round.settings,
    slots: round.slots,
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
  send(client, { type: "roomList", rooms: publicRoomList() });
}

function publicState(room, selfId = null) {
  const inRound = roundPlayerSessions(room);
  return {
    type: "state",
    protocolVersion,
    selfId,
    roomCode: room.code,
    roomVisibility: room.visibility,
    controllerId: room.controllerId,
    phase: room.activeRound ? "round" : "lobby",
    settings: room.settings,
    colors,
    clients: [...room.clients.values()].map((client) => ({
      id: client.id,
      sessionId: client.sessionId,
      name: client.name,
      color: client.color,
      isController: client.id === room.controllerId,
      inRound: inRound.has(client.sessionId),
    })),
    round: publicRound(room.activeRound),
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

function roundCarsForSlots(round) {
  if (!round?.sim) return [];
  return round.slots
    .map((slot) => ({ slot, car: round.sim.cars.get(slot.key) }))
    .filter((entry) => entry.car);
}

function reassignItFromSlot(room, departingSlot) {
  const round = room.activeRound;
  const departingCar = departingSlot ? round?.sim?.cars.get(departingSlot.key) : null;
  if (!round?.sim || !departingCar?.isIt) return false;

  const activeSessions = new Set([...room.clients.values()].map((client) => client.sessionId));
  const entries = roundCarsForSlots(round).filter((entry) => entry.slot.key !== departingSlot.key);
  const replacement =
    entries.find((entry) => entry.slot.type === "player" && activeSessions.has(entry.slot.sessionId))?.car ??
    entries[0]?.car ??
    null;

  departingCar.isIt = false;
  departingCar.immunityRemaining = 0;
  if (!replacement) return true;
  replacement.isIt = true;
  replacement.immunityRemaining = 0;
  return true;
}

function ensureRoundHasIt(room) {
  const entries = roundCarsForSlots(room.activeRound);
  if (entries.length === 0 || entries.some((entry) => entry.car.isIt)) return false;

  const activeSessions = new Set([...room.clients.values()].map((client) => client.sessionId));
  const replacement =
    entries.find((entry) => entry.slot.type === "player" && activeSessions.has(entry.slot.sessionId))?.car ??
    entries[0].car;
  replacement.isIt = true;
  replacement.immunityRemaining = 0;
  return true;
}

function convertRoundSlotToAi(room, slot, { keepSession = true } = {}) {
  if (!room.activeRound || !slot) return false;
  const changedIt = reassignItFromSlot(room, slot);
  const previousSessionId = slot.sessionId;

  slot.type = "ai";
  slot.clientId = null;
  slot.id ??= `ai:${slot.key}`;
  if (!keepSession) slot.sessionId = null;
  if (previousSessionId) room.activeRound.sim?.inputs.delete(previousSessionId);

  return changedIt || ensureRoundHasIt(room);
}

function buildRoundSlots(room, roundSettings) {
  const players = [...room.clients.values()];
  const usedColors = new Set();
  const slots = players.map((client) => {
    usedColors.add(client.color);
    return {
      key: `player:${client.sessionId}`,
      type: "player",
      clientId: client.id,
      sessionId: client.sessionId,
      name: client.name,
      color: client.color,
    };
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
  if (result.tagChanged) room.lastActiveAt = now;
  maybeBroadcastSnapshot(room, round, now);
}

function maybeBroadcastSnapshot(room, round, now) {
  if (now - round.sim.lastSnapshot < 1000 / config.snapshotRate) return;
  round.sim.lastSnapshot = now;
  const snapshot = makeSimSnapshot(room.code, round, now);
  if (snapshot) {
    room.snapshots += 1;
    metrics.snapshots += 1;
    broadcast(room, snapshot);
  }
}

function endRound(room, reason = "timer") {
  if (!room.activeRound) return;
  clearTimeout(room.roundTimer);
  clearInterval(room.simTimer);
  room.roundTimer = null;
  room.simTimer = null;
  const endedRound = room.activeRound;
  const finalSnapshot = makeSimSnapshot(room.code, endedRound, nowMs());
  room.activeRound = null;
  room.settings = normalizeSettings(room, room.settings);
  metrics.roundsEnded += 1;
  broadcast(room, {
    type: "roundEnded",
    roomCode: room.code,
    roundId: endedRound.id,
    reason,
    snapshot: finalSnapshot,
  });
  broadcastState(room);
  destroyRoomIfEmpty(room);
}

function startRound(room, client) {
  if (!client || client.id !== room.controllerId || room.activeRound) return;
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
  clearInterval(room.simTimer);
  room.roundTimer = setTimeout(() => endRound(room, "timer"), config.countdownMs + roundSettings.roundTime * 1000 + 150);
  room.simTimer = setInterval(() => tickRoom(room), 1000 / config.tickRate);
  room.lastActiveAt = nowMs();
  room.roundsStarted += 1;
  metrics.roundsStarted += 1;
  broadcast(room, {
    type: "roundStarted",
    roomCode: room.code,
    round: publicRound(room.activeRound),
  });
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

function leaveRoom(client, { removeRoundSlot = true } = {}) {
  const room = client.room;
  if (!room) return;
  room.clients.delete(client.id);
  room.sessions.set(client.sessionId, {
    name: client.name,
    color: client.color,
    lastSeenAt: nowMs(),
  });
  if (room.controllerId === client.id) room.controllerId = null;
  assignController(room);
  room.settings = normalizeSettings(room, room.settings);
  if (room.activeRound) {
    const slot = room.activeRound.slots.find((entry) => entry.sessionId === client.sessionId);
    if (slot) convertRoundSlotToAi(room, slot, { keepSession: !removeRoundSlot });
    if (!room.activeRound.slots.some((entry) => entry.type === "player" && entry.clientId)) {
      endRound(room, "empty");
    }
  }
  client.room = null;
  if (!destroyRoomIfEmpty(room)) broadcastState(room);
}

function joinRoom(client, room, requestedName) {
  if (client.room && client.room !== room) leaveRoom(client);
  if (room.clients.size >= config.maxClientsPerRoom && !room.clients.has(client.id)) {
    send(client, { type: "error", code: "room_full", message: "Room is full." });
    return false;
  }

  const session = room.sessions.get(client.sessionId);
  client.name = sanitizeName(requestedName ?? session?.name ?? client.name);
  client.color = session?.color && !colorTakenByOther(room, session.color, client.sessionId)
    ? session.color
    : firstAvailableColor(room, client.sessionId);
  client.room = room;
  room.clients.set(client.id, client);
  room.sessions.set(client.sessionId, {
    name: client.name,
    color: client.color,
    lastSeenAt: nowMs(),
  });

  if (room.activeRound) {
    const slot = room.activeRound.slots.find((entry) => entry.sessionId === client.sessionId);
    if (slot) {
      slot.type = "player";
      slot.clientId = client.id;
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
  const room = getOrCreateRoom(message.roomCode, true, sanitizeRoomVisibility(message.visibility));
  if (!room) {
    send(client, { type: "error", code: "room_unavailable", message: "Room unavailable." });
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
    if (!rateLimit(client, "lobby", 4)) return rejectMessage(client, "lobby_rate_limit");
    startRound(room, client);
    return;
  }

  if (message.type === "input") {
    if (!rateLimit(client, "inputs", 75)) return rejectMessage(client, "input_rate_limit");
    const round = room.activeRound;
    if (!round?.sim || !round.slots.some((slot) => slot.sessionId === client.sessionId)) {
      metrics.ignoredInputs += 1;
      return;
    }
    if (message.roundId !== round.id) {
      metrics.ignoredInputs += 1;
      return;
    }
    const sequence = Math.max(0, Math.floor(Number(message.sequence) || 0));
    if (sequence < (round.sim.inputSequences.get(client.sessionId) ?? 0)) {
      metrics.staleInputs += 1;
      return;
    }
    metrics.inputs += 1;
    round.sim.inputs.set(client.sessionId, mergeInput(round.sim.inputs.get(client.sessionId), message.input));
    round.sim.inputSequences.set(client.sessionId, sequence);
    return;
  }

  if (message.type === "leaveRound") {
    if (!room.activeRound) return;
    const slot = room.activeRound.slots.find((entry) => entry.sessionId === client.sessionId);
    if (slot) convertRoundSlotToAi(room, slot, { keepSession: false });
    if (!room.activeRound.slots.some((slot) => slot.type === "player" && slot.clientId)) {
      endRound(room, "empty");
    } else {
      broadcastState(room);
    }
    return;
  }

  rejectMessage(client, "unknown_type");
}

wss.on("connection", (ws) => {
  metrics.totalConnections += 1;
  const client = {
    id: randomUUID(),
    sessionId: randomUUID(),
    ws,
    room: null,
    name: "Player",
    color: colors[0],
    alive: true,
    rate: {},
    droppedMessages: 0,
  };
  clients.set(client.id, client);
  send(client, { type: "welcome", id: client.id, sessionId: client.sessionId, protocolVersion, colors });

  ws.on("message", (raw) => handleMessage(client, raw));
  ws.on("pong", () => {
    client.alive = true;
  });
  ws.on("close", () => {
    metrics.closedConnections += 1;
    clients.delete(client.id);
    leaveRoom(client, { removeRoundSlot: false });
  });
});

let heartbeatTimer = null;
let cleanupTimer = null;

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
  for (const room of rooms.values()) {
    clearTimeout(room.roundTimer);
    clearInterval(room.simTimer);
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
