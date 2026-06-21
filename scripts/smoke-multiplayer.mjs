import http from "node:http";
import WebSocket from "ws";
import { protocolVersion } from "../server/shared/protocol.js";

const serverUrl = process.env.SMOKE_SERVER_URL ?? "ws://127.0.0.1:8787";
const httpUrl = serverUrl.replace(/^ws/, "http");

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

function makeClient() {
  const ws = new WebSocket(serverUrl);
  const queue = [];
  const waiters = [];
  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    const index = waiters.findIndex((entry) => entry.predicate(message));
    if (index >= 0) {
      const [entry] = waiters.splice(index, 1);
      clearTimeout(entry.timeout);
      entry.resolve(message);
    } else {
      queue.push(message);
    }
  });

  function waitFor(predicate, timeoutMs = 8000) {
    const index = queue.findIndex(predicate);
    if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const waiterIndex = waiters.findIndex((entry) => entry.resolve === resolve);
        if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
        reject(new Error("timeout"));
      }, timeoutMs);
      waiters.push({ predicate, resolve, timeout });
    });
  }

  return { ws, waitFor };
}

async function connect({ name, roomCode, sessionId = "" }) {
  const client = makeClient();
  await new Promise((resolve, reject) => {
    client.ws.once("open", resolve);
    client.ws.once("error", reject);
  });
  const welcome = await client.waitFor((message) => message.type === "welcome");
  client.ws.send(JSON.stringify({
    type: "hello",
    protocolVersion,
    name,
    roomCode,
    sessionId: sessionId || welcome.sessionId,
  }));
  const joined = await client.waitFor((message) => message.type === "joined");
  const state = await client.waitFor((message) => message.type === "state" && message.roomCode === joined.roomCode);
  return { ...client, welcome, joined, state, sessionId: joined.sessionId };
}

const health = await httpGet(`${httpUrl}/healthz`);
if (health.status !== 200 || !JSON.parse(health.body).ok) {
  throw new Error(`health check failed: ${health.status}`);
}

const roomOne = `T${Math.floor(Math.random() * 900 + 100)}`;
const roomTwo = `U${Math.floor(Math.random() * 900 + 100)}`;
const alice = await connect({ name: "Alice", roomCode: roomOne });
const bob = await connect({ name: "Bob", roomCode: roomOne });
const casey = await connect({ name: "Casey", roomCode: roomTwo });

alice.ws.send(JSON.stringify({
  type: "updateSettings",
  settings: { roundTime: 60, carCount: 4, arena: "purple" },
}));
alice.ws.send(JSON.stringify({ type: "startRound" }));
const started = await alice.waitFor((message) => message.type === "roundStarted" && message.roomCode === roomOne);
const aliceSlotKey = started.round.slots.find((slot) => slot.sessionId === alice.sessionId)?.key;
if (!aliceSlotKey) throw new Error("Alice round slot not found");

for (let sequence = 1; sequence <= 4; sequence += 1) {
  alice.ws.send(JSON.stringify({
    type: "input",
    roundId: started.round.id,
    sequence,
    input: { throttle: 1, steer: sequence % 2 ? 0.25 : -0.2, boost: false },
  }));
}

const snapshot = await alice.waitFor((message) => {
  if (message.type !== "snapshot" || message.roundId !== started.round.id) return false;
  const car = message.cars.find((entry) => entry.sessionId === alice.sessionId);
  return car && car.inputSequence >= 4;
});
alice.ws.close();
const detachedState = await bob.waitFor((message) => (
  message.type === "state" &&
  message.roomCode === roomOne &&
  message.phase === "round" &&
  message.round?.slots?.some((slot) => slot.key === aliceSlotKey && slot.type === "player" && slot.clientId === null)
));

const reconnect = await connect({ name: "AliceAgain", roomCode: roomOne, sessionId: alice.sessionId });
const reattachedSlot = reconnect.state.round?.slots?.find((slot) => slot.sessionId === alice.sessionId);
const acknowledged = snapshot.cars.find((entry) => entry.sessionId === alice.sessionId).inputSequence;

const duplicateOne = await connect({ name: "DuplicateOne", roomCode: `D${roomOne.slice(1)}` });
const duplicateTwo = await connect({ name: "DuplicateTwo", roomCode: `D${roomOne.slice(1)}`, sessionId: duplicateOne.sessionId });
const duplicateState = duplicateTwo.state;
duplicateTwo.ws.send(JSON.stringify({
  type: "updateSettings",
  settings: { roundTime: 30, carCount: 1, arena: "orange" },
}));
duplicateTwo.ws.send(JSON.stringify({ type: "startRound" }));
const duplicateStarted = await duplicateTwo.waitFor((message) => (
  message.type === "roundStarted" &&
  message.roomCode === duplicateTwo.joined.roomCode
));
const duplicateSlotKeys = duplicateStarted.round.slots.map((slot) => slot.key);
const duplicateSlotKeysUnique = new Set(duplicateSlotKeys).size === duplicateSlotKeys.length;
const disconnectedSlotStayedPlayer = detachedState.round.slots.find((slot) => slot.key === aliceSlotKey)?.type === "player";
const disconnectedSlotDetached = detachedState.round.slots.find((slot) => slot.key === aliceSlotKey)?.clientId === null;
const reconnectedSameSession = reconnect.sessionId === alice.sessionId;
const reconnectedSameSlot = reattachedSlot?.key === aliceSlotKey && reattachedSlot.clientId === reconnect.state.selfId;
const result = {
  ok: duplicateState.clients.length === 1 &&
    duplicateSlotKeysUnique &&
    disconnectedSlotStayedPlayer &&
    disconnectedSlotDetached &&
    reconnectedSameSession &&
    reconnectedSameSlot,
  roomOne,
  roomTwo,
  roomOnePlayers: bob.state.clients.length,
  roomTwoPlayers: casey.state.clients.length,
  roomOneSlots: started.round.slots.length,
  snapshotCars: snapshot.cars.length,
  acknowledged,
  disconnectedSlotStayedPlayer,
  disconnectedSlotDetached,
  reconnectedSameSession,
  reconnectedSameSlot,
  duplicateSessionClients: duplicateState.clients.length,
  duplicateSlotKeysUnique,
};

bob.ws.close();
casey.ws.close();
reconnect.ws.close();
duplicateTwo.ws.close();

console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exit(1);
