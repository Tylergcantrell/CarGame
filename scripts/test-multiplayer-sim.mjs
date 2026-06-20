import assert from "node:assert/strict";
import {
  createSimState,
  makeSnapshot,
  mergeInput,
  tickSim,
} from "../server/shared/cannon-multiplayer-sim.js";

function makeRound({ arena = "orange" } = {}) {
  return {
    id: "round-test",
    startedAt: 0,
    playStartsAt: 0,
    endsAt: 120000,
    settings: { roundTime: 120, carCount: 2, arena },
    slots: [
      {
        key: "player:a",
        type: "player",
        clientId: "client-a",
        sessionId: "a",
        name: "Alice",
        color: "red",
      },
      {
        key: "player:b",
        type: "player",
        clientId: "client-b",
        sessionId: "b",
        name: "Bob",
        color: "blue",
      },
    ],
  };
}

const round = makeRound({ arena: "purple" });
round.sim = createSimState(round, { now: 0, rng: () => 0 });
round.sim.inputs.set("a", { throttle: 1, steer: 0, boost: false });
round.sim.inputSequences.set("a", 7);

const initial = makeSnapshot("TEST", round, 0);
for (let i = 1; i <= 180; i += 1) tickSim(round, i * 1000 / 60);
const moved = makeSnapshot("TEST", round, 3000);
const initialPlayer = initial.cars.find((car) => car.sessionId === "a");
const movedPlayer = moved.cars.find((car) => car.sessionId === "a");
const distance = Math.hypot(
  movedPlayer.position[0] - initialPlayer.position[0],
  movedPlayer.position[2] - initialPlayer.position[2],
);
assert(distance > 1, "Cannon player should move after sustained throttle");
assert.equal(movedPlayer.inputSequence, 7, "snapshot should acknowledge latest input sequence");
assert(movedPlayer.position[1] > 0, "Cannon player should stay above world floor");
assert.equal(typeof moved.simLastTick, "number", "snapshot should expose the server sim tick clock");
assert.equal(typeof moved.simAccumulator, "number", "snapshot should expose the server fixed-step accumulator");
assert(moved.simAccumulator >= 0 && moved.simAccumulator < 1 / 60, "snapshot accumulator should stay within one fixed step");

const queued = makeRound();
queued.sim = createSimState(queued, { now: 0, rng: () => 0 });
queued.sim.inputs.set("a", mergeInput({ throttle: 1, jumpQueued: true }, { throttle: 1, jumpQueued: false }));
assert.equal(queued.sim.inputs.get("a").jumpQueued, true, "queued jump should merge until a sim step consumes it");
tickSim(queued, 1000 / 60);
assert.equal(queued.sim.inputs.get("a").jumpQueued, false, "queued jump should clear after a sim step");

const bounded = makeRound({ arena: "green" });
bounded.sim = createSimState(bounded, { now: 0, rng: () => 0 });
const boundedCar = bounded.sim.cars.get("player:a");
boundedCar.body.position.set(74, 3, 0);
boundedCar.body.velocity.set(80, 0, 0);
bounded.sim.inputs.set("a", { throttle: 1, steer: 0 });
for (let i = 1; i <= 240; i += 1) tickSim(bounded, i * 1000 / 60);
assert(Math.hypot(boundedCar.body.position.x, boundedCar.body.position.z) < 101, "Cannon arena wall should constrain car");

const tagRound = makeRound();
tagRound.sim = createSimState(tagRound, { now: 0, rng: () => 0 });
const tagger = tagRound.sim.cars.get("player:a");
const target = tagRound.sim.cars.get("player:b");
tagger.isIt = true;
target.isIt = false;
target.body.position.copy(tagger.body.position);
target.body.position.x += 0.8;
target.body.position.z += 0.8;
for (let i = 1; i <= 8; i += 1) tickSim(tagRound, i * 1000 / 60);
assert.equal(target.isIt, true, "Cannon contact should transfer tag");
assert.equal(tagger.isIt, false, "tagger should stop being it");

const disconnectedRound = makeRound();
disconnectedRound.sim = createSimState(disconnectedRound, { now: 0, rng: () => 0 });
const disconnectedSlot = disconnectedRound.slots.find((slot) => slot.sessionId === "a");
disconnectedSlot.type = "ai";
disconnectedSlot.clientId = null;
disconnectedRound.sim.inputs.delete("a");
const disconnectedCar = disconnectedRound.sim.cars.get("player:a");
const activeCar = disconnectedRound.sim.cars.get("player:b");
activeCar.isIt = true;
disconnectedCar.isIt = false;
disconnectedCar.body.position.copy(activeCar.body.position);
disconnectedCar.body.position.x += 0.8;
disconnectedCar.body.position.z += 0.8;
for (let i = 1; i <= 8; i += 1) tickSim(disconnectedRound, i * 1000 / 60);
assert.equal(disconnectedCar.isIt, true, "AI-controlled disconnected slot should remain collidable");
assert.equal(activeCar.isIt, false, "tagger should transfer tag to disconnected slot car");

console.log(JSON.stringify({ ok: true, distance: Number(distance.toFixed(3)) }, null, 2));
