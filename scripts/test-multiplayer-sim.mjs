import assert from "node:assert/strict";
import {
  createSimState,
  makeSnapshot,
  mergeInput,
  tickSim,
} from "../server/shared/cannon-multiplayer-sim.js";
import { spawnHeight, wheelPositions } from "../server/shared/vehicle-config.js";

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

function syncBodyHistory(car) {
  car.body.previousPosition.copy(car.body.position);
  car.body.interpolatedPosition.copy(car.body.position);
  car.body.previousQuaternion.copy(car.body.quaternion);
  car.body.interpolatedQuaternion.copy(car.body.quaternion);
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

const staleInput = makeRound();
staleInput.sim = createSimState(staleInput, { now: 0, rng: () => 0 });
staleInput.sim.inputs.set("a", { throttle: 1, steer: 0, boost: false });
staleInput.sim.inputTimes.set("a", 0);
tickSim(staleInput, 500);
const freshCar = staleInput.sim.cars.get("player:a");
assert.equal(freshCar.input.throttle, 1, "fresh player input should still be applied through normal jitter");
tickSim(staleInput, 2000);
const staleCar = staleInput.sim.cars.get("player:a");
assert.equal(staleCar.input.throttle, 0, "stale player input should be zeroed");
assert.equal(staleInput.sim.inputs.has("a"), false, "stale input should be removed from the sim");
assert.equal(staleInput.sim.inputTimes.has("a"), false, "stale input timestamp should be removed from the sim");

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

const wheelTagRound = makeRound();
wheelTagRound.sim = createSimState(wheelTagRound, { now: 0, rng: () => 0 });
const wheelTagger = wheelTagRound.sim.cars.get("player:a");
const wheelTarget = wheelTagRound.sim.cars.get("player:b");
const frontLeftWheel = wheelPositions[0];
wheelTagger.isIt = true;
wheelTarget.isIt = false;
wheelTarget.body.position.set(0, spawnHeight, 0);
wheelTarget.body.velocity.set(0, 0, 0);
wheelTarget.body.angularVelocity.set(0, 0, 0);
wheelTagger.body.position.set(-frontLeftWheel.x, spawnHeight + 1.3 - frontLeftWheel.y, -frontLeftWheel.z);
wheelTagger.body.velocity.set(0, 0, 0);
wheelTagger.body.angularVelocity.set(0, 0, 0);
syncBodyHistory(wheelTarget);
syncBodyHistory(wheelTagger);
tickSim(wheelTagRound, 1000 / 60);
assert.equal(wheelTarget.isIt, true, "wheel overlap should transfer tag even without chassis contact");
assert.equal(wheelTagger.isIt, false, "wheel tagger should stop being it");

const wheelNearMissRound = makeRound();
wheelNearMissRound.sim = createSimState(wheelNearMissRound, { now: 0, rng: () => 0 });
const wheelNearMissTagger = wheelNearMissRound.sim.cars.get("player:a");
const wheelNearMissTarget = wheelNearMissRound.sim.cars.get("player:b");
wheelNearMissTagger.isIt = true;
wheelNearMissTarget.isIt = false;
wheelNearMissTarget.body.position.set(0, spawnHeight, 0);
wheelNearMissTarget.body.velocity.set(0, 0, 0);
wheelNearMissTarget.body.angularVelocity.set(0, 0, 0);
wheelNearMissTagger.body.position.set(-frontLeftWheel.x, spawnHeight + 3.0 - frontLeftWheel.y, -frontLeftWheel.z);
wheelNearMissTagger.body.velocity.set(0, 0, 0);
wheelNearMissTagger.body.angularVelocity.set(0, 0, 0);
syncBodyHistory(wheelNearMissTarget);
syncBodyHistory(wheelNearMissTagger);
tickSim(wheelNearMissRound, 1000 / 60);
assert.equal(wheelNearMissTagger.isIt, true, "wheel above the car should not tag without sphere-volume overlap");
assert.equal(wheelNearMissTarget.isIt, false, "wheel near-miss target should not become it");

const sweptRound = makeRound();
sweptRound.sim = createSimState(sweptRound, { now: 0, rng: () => 0 });
const sweptTagger = sweptRound.sim.cars.get("player:a");
const sweptTarget = sweptRound.sim.cars.get("player:b");
sweptTagger.isIt = true;
sweptTarget.isIt = false;
sweptTagger.body.position.set(-8, spawnHeight, 0);
sweptTagger.body.velocity.set(960, 0, 0);
sweptTarget.body.position.set(0, spawnHeight, 0);
sweptTarget.body.velocity.set(0, 0, 0);
syncBodyHistory(sweptTagger);
syncBodyHistory(sweptTarget);
tickSim(sweptRound, 1000 / 60);
assert.equal(sweptTarget.isIt, true, "swept tag volume overlap should transfer tag during high-speed crossing");
assert.equal(sweptTagger.isIt, false, "swept tagger should stop being it");

const sweptNearMissRound = makeRound();
sweptNearMissRound.sim = createSimState(sweptNearMissRound, { now: 0, rng: () => 0 });
const nearMissTagger = sweptNearMissRound.sim.cars.get("player:a");
const nearMissTarget = sweptNearMissRound.sim.cars.get("player:b");
nearMissTagger.isIt = true;
nearMissTarget.isIt = false;
nearMissTagger.body.position.set(-8, spawnHeight + 5, 0);
nearMissTagger.body.velocity.set(960, 0, 0);
nearMissTarget.body.position.set(0, spawnHeight, 0);
nearMissTarget.body.velocity.set(0, 0, 0);
syncBodyHistory(nearMissTagger);
syncBodyHistory(nearMissTarget);
tickSim(sweptNearMissRound, 1000 / 60);
assert.equal(nearMissTagger.isIt, true, "swept tag should not fire on a near miss without volume overlap");
assert.equal(nearMissTarget.isIt, false, "near-miss target should not become it");

const disconnectedRound = makeRound();
disconnectedRound.sim = createSimState(disconnectedRound, { now: 0, rng: () => 0 });
const disconnectedSlot = disconnectedRound.slots.find((slot) => slot.sessionId === "a");
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
assert.equal(disconnectedSlot.type, "player", "disconnected player slot should not become AI");
assert.equal(disconnectedCar.input.throttle, 0, "disconnected player should run with no throttle input");
assert.equal(disconnectedCar.input.steer, 0, "disconnected player should run with no steer input");
assert.equal(disconnectedCar.isIt, true, "disconnected player slot should remain collidable");
assert.equal(activeCar.isIt, false, "tagger should transfer tag to disconnected slot car");

console.log(JSON.stringify({ ok: true, distance: Number(distance.toFixed(3)) }, null, 2));
