import http from "node:http";
import WebSocket from "ws";
import { protocolVersion } from "../server/shared/protocol.js";

const serverUrl = process.env.STRESS_SERVER_URL ?? "ws://127.0.0.1:8787";
const httpUrl = serverUrl.replace(/^ws/, "http");
const roomCount = Number(process.env.STRESS_ROOMS ?? 6);
const playersPerRoom = Number(process.env.STRESS_PLAYERS_PER_ROOM ?? 4);
const durationMs = Number(process.env.STRESS_DURATION_MS ?? 10000);
const inputHz = Number(process.env.STRESS_INPUT_HZ ?? 60);
const connectTimeoutMs = Number(process.env.STRESS_CONNECT_TIMEOUT_MS ?? 20000);
const expectedSnapshotHz = Number(process.env.STRESS_MIN_SNAPSHOT_HZ ?? 8);
const countdownMs = Number(process.env.STRESS_COUNTDOWN_MS ?? 3000);
const ackGraceSequences = Number(process.env.STRESS_ACK_GRACE_SEQUENCES ?? Math.ceil(inputHz * 1.5));
const roomPrefix = process.env.STRESS_ROOM_PREFIX ?? `S${Math.floor(Math.random() * 900 + 100)}`;
const colors = ["red", "teal", "yellow", "blue", "purple", "green", "orange", "pink"];

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => resolve({ status: response.statusCode, body }));
    }).on("error", reject);
  });
}

async function jsonGet(path) {
  const response = await httpGet(`${httpUrl}${path}`);
  if (response.status !== 200) throw new Error(`${path} failed with ${response.status}`);
  return JSON.parse(response.body);
}

function makeClient({ roomCode, index }) {
  const ws = new WebSocket(serverUrl);
  const queue = [];
  const waiters = [];
  const stats = {
    roomCode,
    index,
    sessionId: "",
    clientId: "",
    snapshots: 0,
    snapshotIntervals: [],
    lastSnapshotAt: 0,
    lastAck: 0,
    errors: [],
    roundStarted: null,
    isController: false,
  };

  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === "snapshot") {
      const now = performance.now();
      if (stats.lastSnapshotAt) stats.snapshotIntervals.push(now - stats.lastSnapshotAt);
      stats.lastSnapshotAt = now;
      stats.snapshots += 1;
      const cars = message.compact
        ? message.cars.map((entry) => ({ sessionId: entry[12] ?? null, inputSequence: entry[11] ?? 0 }))
        : message.cars;
      const car = cars.find((entry) => entry.sessionId === stats.sessionId);
      if (car) stats.lastAck = Math.max(stats.lastAck, car.inputSequence ?? 0);
    } else if (message.type === "error") {
      stats.errors.push(message);
    } else if (message.type === "roundStarted") {
      stats.roundStarted = message.round;
    } else if (message.type === "state" && message.phase === "round" && message.round) {
      stats.roundStarted = message.round;
      stats.isController = message.controllerId === message.selfId;
    } else if (message.type === "state") {
      stats.isController = message.controllerId === message.selfId;
    }

    const waiterIndex = waiters.findIndex((entry) => entry.predicate(message));
    if (waiterIndex >= 0) {
      const [entry] = waiters.splice(waiterIndex, 1);
      clearTimeout(entry.timeout);
      entry.resolve(message);
    } else {
      queue.push(message);
    }
  });

  function waitFor(predicate, timeoutMs = connectTimeoutMs) {
    const queuedIndex = queue.findIndex(predicate);
    if (queuedIndex >= 0) return Promise.resolve(queue.splice(queuedIndex, 1)[0]);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const waiterIndex = waiters.findIndex((entry) => entry.resolve === resolve);
        if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
        const queuedSummary = queue
          .slice(0, 8)
          .map((message) => `${message.type}:${message.roomCode ?? message.code ?? ""}:${message.phase ?? ""}:${message.round ? "round" : ""}`)
          .join(",");
        reject(new Error(`timeout waiting in ${roomCode}/${index}; queued=${queue.length}; readyState=${ws.readyState}; queued=${queuedSummary}`));
      }, timeoutMs);
      const entry = { predicate, resolve, timeout };
      waiters.push(entry);
      const lateQueuedIndex = queue.findIndex(predicate);
      if (lateQueuedIndex >= 0) {
        const waiterIndex = waiters.indexOf(entry);
        if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
        clearTimeout(timeout);
        resolve(queue.splice(lateQueuedIndex, 1)[0]);
      }
    });
  }

  return { ws, waitFor, stats };
}

async function connectClient({ roomCode, index }) {
  const client = makeClient({ roomCode, index });
  await new Promise((resolve, reject) => {
    client.ws.once("open", resolve);
    client.ws.once("error", reject);
  });
  client.ws.send(JSON.stringify({
    type: "hello",
    protocolVersion,
    name: `Stress ${roomCode}-${index}`,
    roomCode,
    sessionId: "",
  }));
  const welcome = await client.waitFor((message) => message.type === "welcome");
  client.stats.clientId = welcome.id;
  const joinedOrState = await client.waitFor((message) => (
    message.type === "joined" && message.roomCode === roomCode
  ) || (
    message.type === "state" && message.roomCode === roomCode
  ));
  client.stats.sessionId = welcome.sessionId;
  if (joinedOrState.type !== "state") {
    await client.waitFor((message) => message.type === "state" && message.roomCode === roomCode);
  }
  client.ws.send(JSON.stringify({ type: "setColor", color: colors[index % colors.length] }));
  return client;
}

function sendInput(client, roundId, sequence, elapsedMs) {
  const phase = elapsedMs / 1000 + client.stats.index * 0.31;
  client.ws.send(JSON.stringify({
    type: "input",
    roundId,
    sequence,
    input: {
      throttle: Math.sin(phase * 0.9) > -0.25 ? 1 : -0.35,
      steer: Math.max(-1, Math.min(1, Math.sin(phase * 1.7))),
      boost: false,
      boostQueued: sequence % 160 === 12,
      jumpQueued: sequence % 210 === 37,
    },
  }));
}

const health = await jsonGet("/healthz");
if (!health.ok || !health.config?.protocolVersion) throw new Error("server is not healthy");

const before = await jsonGet("/metrics");
const rooms = Array.from({ length: roomCount }, (_, roomIndex) => {
  const roomCode = `${roomPrefix}${roomIndex}`.replace(/[^A-Z0-9]/gi, "").slice(0, 6).toUpperCase();
  return { roomCode, clients: [] };
});

for (const room of rooms) {
  room.clients = await Promise.all(
    Array.from({ length: playersPerRoom }, (_, index) => connectClient({ roomCode: room.roomCode, index })),
  );
}

for (const room of rooms) {
  const controller = room.clients.find((client) => client.stats.isController) ?? room.clients[0];
  controller.ws.send(JSON.stringify({
    type: "updateSettings",
    settings: { roundTime: Math.max(30, Math.ceil(durationMs / 1000) + 10), carCount: Math.min(8, Math.max(playersPerRoom, 6)), arena: "purple" },
  }));
  controller.ws.send(JSON.stringify({ type: "startRound" }));
}

const roundStartRetry = setInterval(() => {
  for (const room of rooms) {
    if (room.clients.every((client) => client.stats.roundStarted)) continue;
    const controller = room.clients.find((client) => client.stats.isController) ?? room.clients[0];
    controller.ws.send(JSON.stringify({ type: "startRound" }));
  }
}, 1000);

for (const room of rooms) {
  await Promise.all(room.clients.map((client) => client.waitFor(
    (message) => (
      message.type === "roundStarted" &&
      message.roomCode === room.roomCode
    ) || (
      message.type === "state" &&
      message.roomCode === room.roomCode &&
      message.phase === "round" &&
      message.round
    ),
  )));
}
clearInterval(roundStartRetry);

let sequence = 0;
const startedAt = performance.now();
const inputIntervalMs = 1000 / inputHz;
const sender = setInterval(() => {
  sequence += 1;
  const elapsed = performance.now() - startedAt;
  for (const room of rooms) {
    const roundId = room.clients[0].stats.roundStarted?.id;
    if (!roundId) continue;
    for (const client of room.clients) sendInput(client, roundId, sequence, elapsed);
  }
}, inputIntervalMs);

await wait(durationMs);
clearInterval(sender);
await wait(1000);

const after = await jsonGet("/metrics");
const simTickDelta = after.metrics.simTicks - before.metrics.simTicks;
const simTickMsTotalDelta = after.metrics.simTickMsTotal - before.metrics.simTickMsTotal;

for (const room of rooms) {
  for (const client of room.clients) client.ws.close();
}

const clientStats = rooms.flatMap((room) => room.clients.map((client) => client.stats));
const snapshotCounts = clientStats.map((stats) => stats.snapshots);
const intervalSamples = clientStats.flatMap((stats) => stats.snapshotIntervals);
const expectedMinSnapshots = Math.max(1, Math.floor((Math.max(1000, durationMs - countdownMs) / 1000) * expectedSnapshotHz));
const clientsWithoutSnapshots = clientStats.filter((stats) => stats.snapshots < expectedMinSnapshots);
const erroredClients = clientStats.filter((stats) => stats.errors.length > 0);
const laggingClients = clientStats.filter((stats) => stats.lastAck < sequence - ackGraceSequences);

const result = {
  ok: clientsWithoutSnapshots.length === 0 && erroredClients.length === 0 && laggingClients.length === 0,
  serverUrl,
  roomCount,
  playersPerRoom,
  connectTimeoutMs,
  clients: clientStats.length,
  durationMs,
  inputHz,
  ackGraceSequences,
  expectedSnapshotHz,
  sentInputSequences: sequence,
  snapshots: {
    total: snapshotCounts.reduce((sum, count) => sum + count, 0),
    minPerClient: Math.min(...snapshotCounts),
    maxPerClient: Math.max(...snapshotCounts),
    avgPerClient: snapshotCounts.reduce((sum, count) => sum + count, 0) / Math.max(1, snapshotCounts.length),
    maxIntervalMs: intervalSamples.length ? Math.max(...intervalSamples) : 0,
    avgIntervalMs: intervalSamples.reduce((sum, value) => sum + value, 0) / Math.max(1, intervalSamples.length),
  },
  metricsDelta: {
    connections: after.metrics.totalConnections - before.metrics.totalConnections,
    messages: after.metrics.messages - before.metrics.messages,
    inputs: after.metrics.inputs - before.metrics.inputs,
    droppedMessages: after.metrics.droppedMessages - before.metrics.droppedMessages,
    snapshots: after.metrics.snapshots - before.metrics.snapshots,
    simTicks: after.metrics.simTicks - before.metrics.simTicks,
  },
  simTiming: {
    avgMsDuringRun: simTickMsTotalDelta / Math.max(1, simTickDelta),
    lifetimeAvgMs: after.metrics.simTickMsAvg,
    lifetimeMaxMs: after.metrics.simTickMsMax,
  },
  failures: {
    clientsWithoutSnapshots: clientsWithoutSnapshots.map((stats) => `${stats.roomCode}/${stats.index}:${stats.snapshots}`),
    erroredClients: erroredClients.map((stats) => ({ client: `${stats.roomCode}/${stats.index}`, errors: stats.errors })),
    laggingClients: laggingClients.map((stats) => `${stats.roomCode}/${stats.index}:${stats.lastAck}`),
  },
};

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exit(1);
