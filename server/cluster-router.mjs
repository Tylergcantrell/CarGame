import http from "node:http";
import os from "node:os";
import { spawn } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { loadServerConfig } from "./config.mjs";
import { protocolVersion } from "./shared/protocol.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = loadServerConfig();
const availableWorkers = Math.max(1, Math.floor(os.availableParallelism?.() ?? os.cpus()?.length ?? 1));
const workerCount = Math.max(1, Math.min(
  config.maxActiveRooms,
  Math.floor(Number(process.env.WORKER_COUNT) || availableWorkers),
));
const workerActiveRoomLimit = Math.max(1, Math.ceil(config.maxActiveRooms / workerCount));
const workerPortBase = Math.floor(Number(process.env.WORKER_PORT_BASE) || (config.port + 100));
const colors = ["red", "teal", "yellow", "blue", "purple", "green", "orange", "pink"];
const workers = [];
const roomWorker = new Map();
const routerClients = new Map();

function nowMs() {
  return Date.now();
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

function sanitizeRoomCode(value) {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);
}

function generateRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let code = "";
    for (let i = 0; i < 4; i += 1) code += alphabet[Math.floor(Math.random() * alphabet.length)];
    if (!roomWorker.has(code)) return code;
  }
  return randomUUID().slice(0, 6).toUpperCase();
}

function jsonResponse(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function workerUrl(worker, pathname = "") {
  return `http://127.0.0.1:${worker.port}${pathname}`;
}

function workerWsUrl(worker) {
  return `ws://127.0.0.1:${worker.port}`;
}

function workerWebSocketOptions() {
  const origin = config.allowedOrigins[0];
  return origin ? { headers: { Origin: origin } } : null;
}

function spawnWorker(index) {
  const port = workerPortBase + index;
  const child = spawn(process.execPath, [path.join(__dirname, "game-server.mjs")], {
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      CARTAG_WORKER: "1",
      HOST: "127.0.0.1",
      PORT: String(port),
      MAX_ACTIVE_ROOMS: process.env.WORKER_MAX_ACTIVE_ROOMS ?? String(workerActiveRoomLimit),
    },
  });
  const worker = {
    index,
    port,
    child,
    startedAt: nowMs(),
    lastState: null,
    lastMetrics: null,
  };
  child.on("exit", (code, signal) => {
    worker.child = null;
    for (const [roomCode, assignedIndex] of roomWorker) {
      if (assignedIndex === worker.index) roomWorker.delete(roomCode);
    }
    if (!shuttingDown) {
      setTimeout(() => {
        const replacement = spawnWorker(index);
        workers[index] = replacement;
      }, 800);
    }
    console.warn(`Car Tag worker ${index} exited (${code ?? signal ?? "unknown"}).`);
  });
  return worker;
}

function httpGetJson(url, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const request = http.get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    request.on("error", () => resolve(null));
    request.setTimeout(timeoutMs, () => {
      request.destroy();
      resolve(null);
    });
  });
}

async function refreshWorkerStates() {
  const results = await Promise.all(workers.map(async (worker) => {
    const state = await httpGetJson(workerUrl(worker, "/router-state"));
    if (state?.ok) {
      worker.lastState = state;
      return { worker, rooms: state.rooms ?? [] };
    }
    return { worker, rooms: null };
  }));
  for (const result of results) {
    if (!result.rooms) continue;
    const liveRoomCodes = new Set(result.rooms.map((room) => room?.code).filter(Boolean));
    for (const [roomCode, assignedIndex] of roomWorker) {
      if (assignedIndex === result.worker.index && !liveRoomCodes.has(roomCode)) roomWorker.delete(roomCode);
    }
    for (const roomCode of liveRoomCodes) roomWorker.set(roomCode, result.worker.index);
  }
}

function workersReady() {
  return workers.length === workerCount && workers.every((worker) => worker.child && worker.lastState?.ok);
}

async function refreshWorkerMetrics() {
  await Promise.all(workers.map(async (worker) => {
    const metrics = await httpGetJson(workerUrl(worker, "/metrics"));
    if (metrics?.ok) worker.lastMetrics = metrics;
  }));
}

function aggregateWorkerMetrics() {
  const totals = {
    totalConnections: 0,
    messages: 0,
    inputs: 0,
    rejectedMessages: 0,
    droppedMessages: 0,
    skippedSnapshots: 0,
    snapshots: 0,
    roomLists: 0,
    pings: 0,
    tagEvents: 0,
    reliableResends: 0,
    reliableDrops: 0,
    roundsStarted: 0,
    simTicks: 0,
    simTickMsTotal: 0,
    simTickMsMax: 0,
    simTickMsAvg: 0,
  };
  for (const worker of workers) {
    const metrics = worker.lastMetrics?.metrics;
    if (!metrics) continue;
    for (const key of Object.keys(totals)) {
      if (key === "simTickMsAvg" || key === "simTickMsMax") continue;
      totals[key] += Number(metrics[key]) || 0;
    }
    totals.simTickMsMax = Math.max(totals.simTickMsMax, Number(metrics.simTickMsMax) || 0);
  }
  totals.simTickMsAvg = totals.simTickMsTotal / Math.max(1, totals.simTicks);
  return totals;
}

async function aggregateRoomList() {
  await refreshWorkerStates();
  const rooms = workers.flatMap((worker) => worker.lastState?.rooms ?? []);
  return {
    type: "roomList",
    rooms: rooms.sort((a, b) => {
      if (a.phase !== b.phase) return a.phase === "lobby" ? -1 : 1;
      return (b.playerCount ?? 0) - (a.playerCount ?? 0) || String(a.code).localeCompare(String(b.code));
    }),
    roomCount: rooms.length,
    maxRooms: config.maxRooms,
    maxPlayers: config.maxClientsPerRoom,
  };
}

function chooseWorkerForRoom(roomCode) {
  const cleanRoomCode = sanitizeRoomCode(roomCode);
  const assigned = roomWorker.get(cleanRoomCode);
  if (assigned !== undefined && workers[assigned]?.child) return workers[assigned];
  const assignedRoomCounts = new Map(workers.map((worker) => [worker.index, 0]));
  for (const workerIndex of roomWorker.values()) {
    assignedRoomCounts.set(workerIndex, (assignedRoomCounts.get(workerIndex) ?? 0) + 1);
  }
  const ranked = [...workers]
    .filter((worker) => worker.child)
    .sort((a, b) => {
      const activeDiff = (a.lastState?.activeRounds ?? 0) - (b.lastState?.activeRounds ?? 0);
      if (activeDiff) return activeDiff;
      const assignedDiff = (assignedRoomCounts.get(a.index) ?? 0) - (assignedRoomCounts.get(b.index) ?? 0);
      if (assignedDiff) return assignedDiff;
      const clientDiff = (a.lastMetrics?.clients ?? 0) - (b.lastMetrics?.clients ?? 0);
      if (clientDiff) return clientDiff;
      return a.index - b.index;
    });
  const worker = ranked[0] ?? workers[0];
  return worker;
}

function sendClient(client, payload) {
  if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(payload));
}

async function attachToWorker(client, message) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await refreshWorkerStates();
    if (workersReady()) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const roomCode = sanitizeRoomCode(message.roomCode) || generateRoomCode();
  const worker = chooseWorkerForRoom(roomCode);
  if (!worker?.child) {
    sendClient(client, { type: "error", code: "no_worker", message: "No game worker is available." });
    return;
  }

  const upstreamOptions = workerWebSocketOptions();
  const upstream = upstreamOptions
    ? new WebSocket(workerWsUrl(worker), [], upstreamOptions)
    : new WebSocket(workerWsUrl(worker));
  client.upstream = upstream;
  client.workerIndex = worker.index;
  let upstreamReady = false;
  let upstreamAttachFailed = false;
  let joinedRoomCode = "";
  const pending = [];

  function clearClientUpstream() {
    if (client.upstream === upstream) {
      client.upstream = null;
      client.forwardToWorker = null;
      client.workerIndex = null;
      client.workerClientId = null;
      client.roomCode = "";
    }
    pending.length = 0;
  }

  async function failBeforeJoin() {
    if (upstreamAttachFailed || joinedRoomCode) return;
    upstreamAttachFailed = true;
    if (roomWorker.get(roomCode) === worker.index) roomWorker.delete(roomCode);
    clearClientUpstream();
    sendClient(client, { type: "error", code: "worker_unavailable", message: "Game worker connection failed." });
    sendClient(client, await aggregateRoomList());
  }

  upstream.on("open", () => {
    upstreamReady = true;
    upstream.send(JSON.stringify({
      type: "hello",
      protocolVersion,
      name: message.name ?? client.name,
      roomCode,
      visibility: message.visibility ?? "public",
      lobbyOnly: false,
      sessionId: client.sessionId,
    }));
    for (const queued of pending.splice(0)) upstream.send(queued);
  });

  upstream.on("message", async (raw) => {
    let payload = raw.toString();
    try {
      const parsed = JSON.parse(payload);
      if (parsed.type === "welcome") {
        client.workerClientId = parsed.id;
        client.sessionId = parsed.sessionId ?? client.sessionId;
      }
      if (parsed.type === "joined" && parsed.roomCode) {
        roomWorker.set(parsed.roomCode, worker.index);
        joinedRoomCode = parsed.roomCode;
        client.roomCode = parsed.roomCode;
      }
      if (parsed.type === "roomList") {
        payload = JSON.stringify(await aggregateRoomList());
      }
    } catch {
      payload = raw;
    }
    if (client.ws.readyState === WebSocket.OPEN) client.ws.send(payload);
  });

  upstream.on("close", () => {
    const keepClientOpen = client.keepClientAfterUpstreamClose;
    client.keepClientAfterUpstreamClose = false;
    clearClientUpstream();
    if (!joinedRoomCode && !keepClientOpen) {
      failBeforeJoin();
      return;
    }
    if (!keepClientOpen && client.ws.readyState === WebSocket.OPEN) {
      client.ws.close(4001, "Game session closed.");
    }
  });
  upstream.on("error", () => {
    failBeforeJoin();
  });

  client.forwardToWorker = (payload) => {
    if (upstreamReady && upstream.readyState === WebSocket.OPEN) upstream.send(payload);
    else pending.push(payload);
  };
}

async function handleLobbyMessage(client, raw) {
  let message;
  try {
    message = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (!message || typeof message.type !== "string") return;

  if (message.type === "hello") {
    if (message.protocolVersion !== protocolVersion) {
      sendClient(client, {
        type: "error",
        code: "protocol_mismatch",
        message: "Client/server version mismatch. Refresh the page.",
        protocolVersion,
      });
      return;
    }
    client.name = String(message.name ?? client.name ?? "Player").slice(0, 14) || "Player";
    client.sessionId = sanitizeSessionId(message.sessionId ?? client.sessionId);
    if (!message.lobbyOnly) {
      await attachToWorker(client, message);
      return;
    }
    sendClient(client, { type: "welcome", id: client.id, sessionId: client.sessionId, protocolVersion, colors });
    sendClient(client, await aggregateRoomList());
    return;
  }

  if (message.type === "listRooms") {
    sendClient(client, await aggregateRoomList());
    return;
  }

  if (message.type === "ping") {
    sendClient(client, {
      type: "pong",
      clientTime: Number(message.clientTime) || 0,
      sequence: Math.max(0, Math.floor(Number(message.sequence) || 0)),
      serverTime: nowMs(),
    });
    return;
  }

  if (message.type === "joinRoom") {
    await attachToWorker(client, {
      ...message,
      name: message.name ?? client.name,
      roomCode: sanitizeRoomCode(message.roomCode) || generateRoomCode(),
    });
  }
}

function proxyHttpRequest(request, response, worker = workers[0]) {
  const upstream = http.request(workerUrl(worker, request.url ?? "/"), {
    method: request.method,
    headers: {
      ...request.headers,
      host: `127.0.0.1:${worker.port}`,
    },
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on("error", () => {
    response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    response.end("Car Tag worker unavailable\n");
  });
  request.pipe(upstream);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (url.pathname === "/healthz") {
    await refreshWorkerStates();
    const ready = workersReady();
    jsonResponse(response, ready ? 200 : 503, {
      ok: ready,
      uptimeSeconds: Math.round((nowMs() - startedAt) / 1000),
      router: true,
      workers: workers.length,
      rooms: workers.reduce((sum, worker) => sum + (worker.lastState?.rooms?.length ?? 0), 0),
      clients: routerClients.size,
      activeRounds: workers.reduce((sum, worker) => sum + (worker.lastState?.activeRounds ?? 0), 0),
      config: {
        profile: config.profile,
        host: config.host,
        port: config.port,
        protocolVersion,
        maxCars: config.maxCars,
        maxRooms: config.maxRooms,
        maxActiveRooms: config.maxActiveRooms,
        workerActiveRoomLimit,
        maxClientsPerRoom: config.maxClientsPerRoom,
        tickRate: config.tickRate,
        snapshotRate: config.snapshotRate,
      },
    });
    return;
  }
  if (url.pathname === "/metrics") {
    await refreshWorkerStates();
    await refreshWorkerMetrics();
    jsonResponse(response, 200, {
      ok: true,
      router: true,
      uptimeSeconds: Math.round((nowMs() - startedAt) / 1000),
      rooms: workers.reduce((sum, worker) => sum + (worker.lastState?.roomCount ?? 0), 0),
      clients: workers.reduce((sum, worker) => sum + (worker.lastMetrics?.clients ?? 0), 0),
      activeRounds: workers.reduce((sum, worker) => sum + (worker.lastState?.activeRounds ?? 0), 0),
      metrics: aggregateWorkerMetrics(),
      workers: workers.map((worker) => ({
        index: worker.index,
        port: worker.port,
        alive: Boolean(worker.child),
        state: worker.lastState,
        metrics: worker.lastMetrics,
      })),
      roomAssignments: Object.fromEntries(roomWorker),
    });
    return;
  }
  proxyHttpRequest(request, response);
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    const client = {
      id: randomUUID(),
      ws,
      upstream: null,
      forwardToWorker: null,
      sessionId: createSessionId(),
      name: "Player",
      roomCode: "",
    };
    routerClients.set(client.id, client);

    ws.on("message", async (raw) => {
      if (client.upstream && client.forwardToWorker) {
        let parsed = null;
        try {
          parsed = JSON.parse(raw.toString());
        } catch {
          // Non-JSON frames are forwarded below.
        }
        if (parsed?.type === "leaveRoom") {
          client.keepClientAfterUpstreamClose = true;
          client.forwardToWorker(raw);
          client.upstream.close();
          client.upstream = null;
          client.forwardToWorker = null;
          client.workerIndex = null;
          client.workerClientId = null;
          client.roomCode = "";
          sendClient(client, await aggregateRoomList());
          return;
        }
        client.forwardToWorker(raw);
        return;
      }
      await handleLobbyMessage(client, raw);
    });

    ws.on("close", () => {
      routerClients.delete(client.id);
      if (client.upstream?.readyState === WebSocket.OPEN) client.upstream.close();
    });
  });
});

let shuttingDown = false;
const startedAt = nowMs();

export function startClusterRouter() {
  for (let i = 0; i < workerCount; i += 1) workers.push(spawnWorker(i));
  const refreshTimer = setInterval(() => {
    refreshWorkerStates();
    refreshWorkerMetrics();
  }, 2000);
  refreshTimer.unref();

  const shutdown = () => {
    shuttingDown = true;
    clearInterval(refreshTimer);
    for (const worker of workers) worker.child?.kill("SIGTERM");
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  server.listen(config.port, config.host, () => {
    const hostLabel = config.host === "0.0.0.0" ? "0.0.0.0" : config.host;
    console.log(`Car Tag router listening on http://${hostLabel}:${config.port}`);
    console.log(`Workers: ${workerCount} on ports ${workerPortBase}-${workerPortBase + workerCount - 1}; active rooms per worker: ${workerActiveRoomLimit}`);
  });
  return { server, wss, workers };
}
