import assert from "node:assert/strict";
import * as CANNON from "cannon-es";
import {
  getAiProfile,
  resetAiProfile,
  setAiProfilingEnabled,
  updateAiCar,
} from "../server/shared/ai.js";
import { worldSpec } from "../server/shared/arena.js";
import {
  createSimState,
  tickSim,
} from "../server/shared/cannon-multiplayer-sim.js";
import { spawnHeight } from "../server/shared/vehicle-config.js";

const fixedMs = 1000 / 60;

function makeRound({
  id = "ai-bench",
  seed = id,
  arena = "orange",
  count = 2,
  difficulty = "extreme",
} = {}) {
  return {
    id,
    seed,
    startedAt: 0,
    playStartsAt: 0,
    endsAt: 120000,
    settings: {
      roundTime: 120,
      carCount: count,
      arena,
      aiDifficulty: difficulty,
    },
    slots: Array.from({ length: count }, (_, index) => ({
      key: `ai:${index + 1}`,
      type: "ai",
      id: `ai-${index + 1}`,
      name: `AI ${index + 1}`,
      color: String(index),
    })),
  };
}

function syncBodyHistory(car) {
  car.body.previousPosition.copy(car.body.position);
  car.body.interpolatedPosition.copy(car.body.position);
  car.body.previousQuaternion.copy(car.body.quaternion);
  car.body.interpolatedQuaternion.copy(car.body.quaternion);
}

function pose(car, x, z, yaw = 0, y = spawnHeight) {
  car.body.position.set(x, y, z);
  car.body.velocity.set(0, 0, 0);
  car.body.angularVelocity.set(0, 0, 0);
  car.body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 1, 0), yaw);
  car.vehicle.numWheelsOnGround = 4;
  syncBodyHistory(car);
}

function arenaSurfaceYAtRadius(radius) {
  const localX = Math.max(0, Math.min(worldSpec.curveRadius, radius - worldSpec.floorRadius));
  const theta = Math.asin(Math.max(0, Math.min(1, localX / worldSpec.curveRadius)));
  return worldSpec.curveRadius * (1 - Math.cos(theta)) + spawnHeight;
}

function velocity(car, x, y, z) {
  car.body.velocity.set(x, y, z);
  syncBodyHistory(car);
}

function angularVelocity(car, x, y, z) {
  car.body.angularVelocity.set(x, y, z);
  syncBodyHistory(car);
}

function forceIt(cars, itCar) {
  for (const car of cars) car.isIt = car === itCar;
}

function gameState(cars, itCar, timeRemaining = 90) {
  return {
    phase: "playing",
    cars,
    itCar,
    timeRemaining,
  };
}

function runTicks(round, seconds) {
  let tags = 0;
  let dodges = 0;
  let recoverFrames = 0;
  let taggerWallFrames = 0;
  let runnerWallFrames = 0;
  let taggerFrames = 0;
  let runnerFrames = 0;
  let nearFrames = 0;
  let finishFrames = 0;
  let bestDistance = Infinity;
  const steps = Math.ceil(seconds * 60);
  const cars = [...round.sim.cars.values()];
  const lastPositions = cars.map((car) => [car.body.position.x, car.body.position.z]);
  const travel = cars.map(() => 0);
  for (let i = 1; i <= steps; i += 1) {
    const result = tickSim(round, i * fixedMs);
    tags += result.events.filter((event) => event.type === "tagConfirmed").length;
    dodges += cars.filter((car) => car.ai?.dodgeWindow != null && car.input?.jumpQueued).length;
    recoverFrames += cars.filter((car) => car.ai?.mode === "recover").length;
    const itCar = cars.find((car) => car.isIt) ?? null;
    let nearest = Infinity;
    cars.forEach((car, index) => {
      const last = lastPositions[index];
      const dx = car.body.position.x - last[0];
      const dz = car.body.position.z - last[1];
      travel[index] += Math.hypot(dx, dz);
      last[0] = car.body.position.x;
      last[1] = car.body.position.z;
      const onCurve = Math.hypot(car.body.position.x, car.body.position.z) > worldSpec.floorRadius - 2;
      if (car.isIt) {
        taggerFrames += 1;
        if (onCurve) taggerWallFrames += 1;
      } else {
        runnerFrames += 1;
        if (onCurve) runnerWallFrames += 1;
      }
      if (itCar && car !== itCar && car.immunityRemaining <= 0) {
        nearest = Math.min(
          nearest,
          Math.hypot(car.body.position.x - itCar.body.position.x, car.body.position.z - itCar.body.position.z),
        );
      }
    });
    if (nearest < Infinity) {
      bestDistance = Math.min(bestDistance, nearest);
      if (nearest < 12) nearFrames += 1;
      if (nearest < 7) finishFrames += 1;
    }
  }
  return {
    tags,
    dodges,
    travel,
    recoverShare: recoverFrames / Math.max(1, steps * cars.length),
    taggerWallShare: taggerWallFrames / Math.max(1, taggerFrames),
    runnerWallShare: runnerWallFrames / Math.max(1, runnerFrames),
    nearShare: nearFrames / Math.max(1, steps),
    finishShare: finishFrames / Math.max(1, steps),
    bestDistance,
  };
}

function closeReverseTagScenario() {
  const round = makeRound({ id: "close-reverse-tag", count: 2 });
  round.sim = createSimState(round, { now: 0 });
  const cars = [...round.sim.cars.values()];
  const [tagger, target] = cars;
  forceIt(cars, tagger);
  pose(tagger, 52, 0, Math.PI / 2);
  pose(target, 43.8, 0, Math.PI / 2);

  const state = gameState(cars, tagger);
  updateAiCar(tagger, 1 / 60, { gameState: state, difficulty: "extreme", arenaId: "orange", rng: () => 0.42 });
  const firstInput = {
    targetId: tagger.ai.targetId,
    plan: tagger.ai.plan,
    maneuver: tagger.ai.maneuver,
    throttle: Number(tagger.input.throttle.toFixed(3)),
    steer: Number(tagger.input.steer.toFixed(3)),
  };

  let tagTime = null;
  for (let i = 1; i <= 180; i += 1) {
    const result = tickSim(round, i * fixedMs);
    if (tagTime == null && result.events.some((event) => event.type === "tagConfirmed")) {
      tagTime = i / 60;
      break;
    }
  }

  assert.equal(firstInput.targetId, target.id, "close target behind tagger should be selected");
  assert(firstInput.throttle < 0, "tagger should reverse toward a close target behind it");
  assert(tagTime != null && tagTime < 2.4, "tagger should convert a clean close reverse target quickly");
  return { firstInput, tagTime };
}

function headOnDodgeScenario() {
  const round = makeRound({ id: "head-on-dodge", count: 2 });
  round.sim = createSimState(round, { now: 0 });
  const cars = [...round.sim.cars.values()];
  const [runner, tagger] = cars;
  forceIt(cars, tagger);
  pose(runner, 0, 0, 0);
  pose(tagger, 0, 12, Math.PI);
  velocity(runner, 0, 0, 2);
  velocity(tagger, 0, 0, -34);

  updateAiCar(runner, 1 / 60, {
    gameState: gameState(cars, tagger),
    difficulty: "extreme",
    arenaId: "orange",
    rng: () => 0.42,
  });

  const result = {
    mode: runner.ai.mode,
    plan: runner.ai.plan,
    maneuver: runner.ai.maneuver,
    jumpQueued: Boolean(runner.input.jumpQueued),
    dodgeWindow: Number((runner.ai.dodgeWindow ?? Infinity).toFixed(3)),
    approachSpeed: Number((runner.ai.dodgeApproachSpeed ?? 0).toFixed(3)),
  };
  assert(result.dodgeWindow < 1, "runner should recognize a projected head-on tag window");
  assert.equal(result.jumpQueued, false, "runner should not force an unsimulated jump dodge outside an action plan");
  return result;
}

function runnerTrafficAvoidanceScenario() {
  const round = makeRound({ id: "runner-traffic-avoidance", count: 3 });
  round.sim = createSimState(round, { now: 0 });
  const cars = [...round.sim.cars.values()];
  const [runner, oncomingRunner, tagger] = cars;
  forceIt(cars, tagger);
  pose(runner, 0, 0, 0);
  velocity(runner, 0, 0, 18);
  pose(oncomingRunner, 0, 24, Math.PI);
  velocity(oncomingRunner, 0, 0, -22);
  pose(tagger, -54, -48, 0);

  updateAiCar(runner, 1 / 60, {
    gameState: gameState(cars, tagger),
    difficulty: "extreme",
    arenaId: "orange",
    rng: () => 0.42,
  });

  const result = {
    mode: runner.ai.mode,
    plan: runner.ai.plan,
    throttle: Number(runner.input.throttle.toFixed(3)),
    steer: Number(runner.input.steer.toFixed(3)),
  };
  assert.notEqual(result.plan, "carry_speed", "runner should not keep a route that crosses another runner head-on");
  assert(Math.abs(result.steer) > 0.12, "runner should steer around traffic instead of driving straight into it");
  return result;
}

function taggerCutoffScenario() {
  const round = makeRound({ id: "tagger-cutoff", count: 2 });
  round.sim = createSimState(round, { now: 0 });
  const cars = [...round.sim.cars.values()];
  const [tagger, runner] = cars;
  forceIt(cars, tagger);
  pose(tagger, 0, 0, 0);
  velocity(tagger, 0, 0, 18);
  pose(runner, 24, 34, Math.PI / 2);
  velocity(runner, 28, 0, 0);

  updateAiCar(tagger, 1 / 60, {
    gameState: gameState(cars, tagger),
    difficulty: "extreme",
    arenaId: "orange",
    rng: () => 0.42,
  });

  const result = {
    targetId: tagger.ai.targetId,
    plan: tagger.ai.plan,
    throttle: Number(tagger.input.throttle.toFixed(3)),
    steer: Number(tagger.input.steer.toFixed(3)),
  };
  assert.equal(result.targetId, runner.id, "moving runner should be selected");
  assert(
    result.plan === "lead_tag" ||
      result.plan === "cutoff_tag" ||
      result.plan === "angle_tag" ||
      result.plan === "cross_tag" ||
      result.plan === "orbit_cutoff_tag" ||
      result.plan === "deep_cutoff_tag" ||
      result.plan === "arc_pinch_tag" ||
      result.plan.startsWith("search_"),
    "tagger should use a predictive intercept against a moving non-immediate target",
  );
  assert(result.throttle > 0.3, "tagger should commit throttle to the intercept");
  return result;
}

function orbitRunnerCutoffScenario() {
  const round = makeRound({ id: "orbit-runner-cutoff", count: 2 });
  round.sim = createSimState(round, { now: 0 });
  const cars = [...round.sim.cars.values()];
  const [tagger, runner] = cars;
  forceIt(cars, tagger);
  pose(tagger, 0, 0, 0);
  velocity(tagger, 0, 0, 20);
  pose(runner, 60, 0, Math.PI / 2);
  velocity(runner, 0, 0, 34);

  updateAiCar(tagger, 1 / 60, {
    gameState: gameState(cars, tagger),
    difficulty: "extreme",
    arenaId: "orange",
    rng: () => 0.42,
  });

  const result = {
    targetId: tagger.ai.targetId,
    plan: tagger.ai.plan,
    throttle: Number(tagger.input.throttle.toFixed(3)),
    steer: Number(tagger.input.steer.toFixed(3)),
    objectiveRadius: Number(Math.hypot(tagger.ai.objective.x, tagger.ai.objective.z).toFixed(2)),
  };
  assert.equal(result.targetId, runner.id, "orbiting runner should be selected");
  assert(
    result.plan === "orbit_cutoff_tag" ||
      result.plan === "deep_cutoff_tag" ||
      result.plan === "arc_pinch_tag" ||
      result.plan.startsWith("search_"),
    "extreme tagger should cut off an orbiting runner instead of trailing the circle",
  );
  assert(result.throttle > 0.7, "orbit cutoff should be a committed pursuit plan");
  return result;
}

function gradedActionPlanningScenario() {
  function sample(difficulty) {
    const round = makeRound({ id: `graded-action-${difficulty}`, count: 2 });
    round.sim = createSimState(round, { now: 0 });
    const cars = [...round.sim.cars.values()];
    const [tagger, runner] = cars;
    forceIt(cars, tagger);
    pose(tagger, 0, 0, 0);
    velocity(tagger, 0, 0, 28);
    pose(runner, -18, 24, Math.PI / 2);
    velocity(runner, 25, 0, 0);

    updateAiCar(tagger, 1 / 60, {
      gameState: gameState(cars, tagger),
      difficulty,
      arenaId: "orange",
      rng: () => 0.42,
    });

    return {
      plan: tagger.ai.plan,
      throttle: Number(tagger.input.throttle.toFixed(3)),
      steer: Number(tagger.input.steer.toFixed(3)),
    };
  }

  const medium = sample("medium");
  const hard = sample("hard");
  const extreme = sample("extreme");
  assert(!medium.plan.startsWith("search_pivot"), "medium should not use the deepest pivot action set");
  assert(
    hard.plan.startsWith("search_") || extreme.plan.startsWith("search_"),
    "hard/extreme should have access to action-sequence search intelligence",
  );
  assert(hard.throttle > 0.7 || extreme.throttle > 0.7, "selected action search should execute its first action input");
  return { medium, hard, extreme };
}

function difficultyReactionDelayScenario() {
  function sample(difficulty) {
    const round = makeRound({ id: `difficulty-reaction-${difficulty}`, count: 2 });
    round.sim = createSimState(round, { now: 0 });
    const cars = [...round.sim.cars.values()];
    const [tagger, runner] = cars;
    forceIt(cars, tagger);
    pose(tagger, 0, 0, 0);
    pose(runner, -24, 30, 0);
    const state = gameState(cars, tagger);
    for (let i = 0; i < 18; i += 1) {
      updateAiCar(tagger, 1 / 60, { gameState: state, difficulty, arenaId: "orange", rng: () => 0.42 });
    }
    pose(runner, 24, 30, 0);
    let result = null;
    for (let i = 0; i < 5; i += 1) {
      tagger.ai.decisionTimer = 0;
      tagger.ai.stuckTimer = 0;
      tagger.ai.lastPosition.copy(tagger.body.position);
      updateAiCar(tagger, 1 / 60, { gameState: state, difficulty, arenaId: "orange", rng: () => 0.42 });
      result = {
        plan: tagger.ai.plan,
        steer: Number(tagger.input.steer.toFixed(3)),
        targetId: tagger.ai.targetId,
      };
    }
    return result;
  }

  const easy = sample("easy");
  const extreme = sample("extreme");
  assert(easy.steer < -0.1, "easy tagger should still react to delayed target position");
  assert(extreme.steer > 0.1, "extreme tagger should react to the newer target position");
  return { easy, extreme };
}

function closeTargetPriorityScenario() {
  const round = makeRound({ id: "close-target-priority", count: 3 });
  round.sim = createSimState(round, { now: 0 });
  const cars = [...round.sim.cars.values()];
  const [tagger, closeTarget, farLeader] = cars;
  forceIt(cars, tagger);
  farLeader.score = 140;
  pose(tagger, 52, 0, Math.PI / 2);
  pose(closeTarget, 45, 0, Math.PI / 2);
  pose(farLeader, -20, 48, 0);

  updateAiCar(tagger, 1 / 60, {
    gameState: gameState(cars, tagger),
    difficulty: "extreme",
    arenaId: "orange",
    rng: () => 0.42,
  });

  const result = {
    targetId: tagger.ai.targetId,
    plan: tagger.ai.plan,
    maneuver: tagger.ai.maneuver,
    throttle: Number(tagger.input.throttle.toFixed(3)),
  };
  assert.equal(result.targetId, closeTarget.id, "close tag opportunity should beat far leader chase");
  assert(result.throttle < 0, "close behind target should trigger reverse pursuit");
  return result;
}

function closeHairpinControlScenario() {
  const round = makeRound({ id: "close-hairpin-control", count: 2 });
  round.sim = createSimState(round, { now: 0 });
  const cars = [...round.sim.cars.values()];
  const [tagger, runner] = cars;
  forceIt(cars, tagger);
  pose(tagger, 0, 0, 0);
  velocity(tagger, 0, 0, 30);
  pose(runner, 13, 3, Math.PI / 2);

  updateAiCar(tagger, 1 / 60, {
    gameState: gameState(cars, tagger),
    difficulty: "extreme",
    arenaId: "orange",
    rng: () => 0.42,
  });

  const result = {
    targetId: tagger.ai.targetId,
    plan: tagger.ai.plan,
    throttle: Number(tagger.input.throttle.toFixed(3)),
    steer: Number(tagger.input.steer.toFixed(3)),
  };
  assert.equal(result.targetId, runner.id, "close side target should be selected");
  assert(Math.abs(result.steer) > 0.85, "close side target should force a tight turn");
  assert(result.throttle < 0.5, "tight close pursuit should brake/reduce throttle instead of circling at full speed");
  return result;
}

function jumpingTargetPursuitScenario() {
  const round = makeRound({ id: "jumping-target-pursuit", count: 2 });
  round.sim = createSimState(round, { now: 0 });
  const cars = [...round.sim.cars.values()];
  const [tagger, runner] = cars;
  forceIt(cars, tagger);
  pose(tagger, 0, 0, 0);
  pose(runner, 4.8, 4.2, 0, 5.2);
  runner.vehicle.numWheelsOnGround = 0;
  velocity(runner, 0, 5.5, 0);

  updateAiCar(tagger, 1 / 60, {
    gameState: gameState(cars, tagger),
    difficulty: "extreme",
    arenaId: "orange",
    rng: () => 0.42,
  });

  const result = {
    targetId: tagger.ai.targetId,
    plan: tagger.ai.plan,
    jumpQueued: Boolean(tagger.input.jumpQueued),
    throttle: Number(tagger.input.throttle.toFixed(3)),
    steer: Number(tagger.input.steer.toFixed(3)),
  };
  assert.equal(result.targetId, runner.id, "airborne close runner should be selected");
  assert(
    !result.jumpQueued || result.plan === "search_jump_contest",
    "tagger should only jump through a planned jump-contest action",
  );
  return result;
}

function reachableTargetPriorityScenario() {
  const round = makeRound({ id: "reachable-target-priority", count: 3 });
  round.sim = createSimState(round, { now: 0 });
  const cars = [...round.sim.cars.values()];
  const [tagger, reachableTarget, farLeader] = cars;
  forceIt(cars, tagger);
  farLeader.score = 220;
  tagger.ai.targetId = farLeader.id;
  tagger.ai.intent = {
    type: "tag_intercept",
    point: farLeader.body.position.clone(),
    target: farLeader,
    maneuver: "pressure_tag",
    plan: "pressure_tag",
    desiredSpeed: 40,
  };
  pose(tagger, 48, 0, Math.PI / 2);
  pose(reachableTarget, 24, 34, Math.PI / 2);
  pose(farLeader, -54, -48, 0);

  updateAiCar(tagger, 1 / 60, {
    gameState: gameState(cars, tagger),
    difficulty: "extreme",
    arenaId: "orange",
    rng: () => 0.42,
  });

  const result = {
    targetId: tagger.ai.targetId,
    plan: tagger.ai.plan,
    maneuver: tagger.ai.maneuver,
    throttle: Number(tagger.input.throttle.toFixed(3)),
  };
  assert.equal(result.targetId, reachableTarget.id, "reachable target should beat a much farther score leader");
  assert(result.throttle > 0.3, "tagger should commit throttle toward the reachable target");
  return result;
}

function stationaryReachableTargetScenario() {
  const round = makeRound({ id: "stationary-reachable-target", count: 3 });
  round.sim = createSimState(round, { now: 0 });
  const cars = [...round.sim.cars.values()];
  const [tagger, stationaryTarget, farLeader] = cars;
  forceIt(cars, tagger);
  farLeader.score = 320;
  tagger.ai.targetId = farLeader.id;
  tagger.ai.intent = {
    type: "tag_intercept",
    point: farLeader.body.position.clone(),
    target: farLeader,
    maneuver: "pressure_tag",
    plan: "pressure_tag",
    desiredSpeed: 44,
  };
  pose(tagger, 0, 0, 0);
  pose(stationaryTarget, 0, 8, 0);
  pose(farLeader, -58, -52, 0);

  updateAiCar(tagger, 1 / 60, {
    gameState: gameState(cars, tagger),
    difficulty: "extreme",
    arenaId: "orange",
    rng: () => 0.42,
  });

  const result = {
    targetId: tagger.ai.targetId,
    plan: tagger.ai.plan,
    maneuver: tagger.ai.maneuver,
    throttle: Number(tagger.input.throttle.toFixed(3)),
    steer: Number(tagger.input.steer.toFixed(3)),
  };
  assert.equal(result.targetId, stationaryTarget.id, "stationary reachable target should override any far strategic target");
  assert(result.plan === "finish_tag" || result.plan === "direct_tag", "stationary reachable target should produce a direct finish plan");
  assert(result.throttle > 0.7, "tagger should accelerate into a stationary reachable target");
  assert(Math.abs(result.steer) < 0.35, "tagger should aim at the stationary target, not route across the arena");
  return result;
}

function compromisedTargetPriorityScenario() {
  const round = makeRound({ id: "compromised-target-priority", count: 4 });
  round.sim = createSimState(round, { now: 0 });
  const cars = [...round.sim.cars.values()];
  const [tagger, healthyTarget, compromisedTarget, farLeader] = cars;
  forceIt(cars, tagger);
  farLeader.score = 260;
  pose(tagger, 0, 0, 0);
  pose(healthyTarget, 0, 22, 0);
  pose(compromisedTarget, 10, 27, 0, 2.2);
  compromisedTarget.vehicle.numWheelsOnGround = 0;
  compromisedTarget.body.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), Math.PI * 0.72);
  velocity(compromisedTarget, 1, -1, 0);
  syncBodyHistory(compromisedTarget);
  pose(farLeader, -54, -48, 0);

  updateAiCar(tagger, 1 / 60, {
    gameState: gameState(cars, tagger),
    difficulty: "extreme",
    arenaId: "orange",
    rng: () => 0.42,
  });

  const result = {
    targetId: tagger.ai.targetId,
    plan: tagger.ai.plan,
    maneuver: tagger.ai.maneuver,
    throttle: Number(tagger.input.throttle.toFixed(3)),
  };
  assert.equal(result.targetId, compromisedTarget.id, "compromised reachable runner should be prioritized over healthy/far targets");
  assert(result.throttle > 0.3, "tagger should commit throttle toward a compromised target");
  return result;
}

function stationaryWallReachableTargetScenario() {
  const round = makeRound({ id: "stationary-wall-reachable-target", count: 3, arena: "orange" });
  round.sim = createSimState(round, { now: 0 });
  const cars = [...round.sim.cars.values()];
  const [tagger, wallTarget, farLeader] = cars;
  forceIt(cars, tagger);
  farLeader.score = 320;
  pose(tagger, 82, 0, Math.PI / 2, 9.5);
  pose(wallTarget, 86, 5, Math.PI / 2, 12);
  velocity(wallTarget, 0, 0, 0);
  pose(farLeader, -58, -52, 0);

  updateAiCar(tagger, 1 / 60, {
    gameState: gameState(cars, tagger),
    difficulty: "extreme",
    arenaId: "orange",
    rng: () => 0.42,
  });

  const result = {
    targetId: tagger.ai.targetId,
    plan: tagger.ai.plan,
    maneuver: tagger.ai.maneuver,
    throttle: Number(tagger.input.throttle.toFixed(3)),
    steer: Number(tagger.input.steer.toFixed(3)),
  };
  assert.equal(result.targetId, wallTarget.id, "stationary reachable wall target should override far targets");
  assert(
    result.plan === "finish_tag" || result.plan === "pressure_tag" || result.plan === "direct_tag",
    "reachable wall target should produce a direct tag plan",
  );
  assert(result.throttle > 0.25, "tagger should not refuse throttle toward a reachable wall target");
  return result;
}

function highWallContactValidityScenario() {
  const round = makeRound({ id: "high-wall-contact-validity", count: 3, arena: "orange" });
  round.sim = createSimState(round, { now: 0 });
  const cars = [...round.sim.cars.values()];
  const [tagger, reachableTarget, highWallTarget] = cars;
  forceIt(cars, tagger);
  highWallTarget.score = 420;
  pose(tagger, 54, 0, Math.PI / 2);
  pose(reachableTarget, 38, 0, Math.PI / 2);
  pose(highWallTarget, 72, 0, Math.PI / 2, 34);
  highWallTarget.vehicle.numWheelsOnGround = 4;
  velocity(highWallTarget, 0, 0, 0);

  updateAiCar(tagger, 1 / 60, {
    gameState: gameState(cars, tagger),
    difficulty: "extreme",
    arenaId: "orange",
    rng: () => 0.42,
  });

  const result = {
    targetId: tagger.ai.targetId,
    plan: tagger.ai.plan,
    throttle: Number(tagger.input.throttle.toFixed(3)),
    lastTargetDistance: Number(tagger.ai.lastTargetDistance.toFixed(2)),
  };
  assert.equal(result.targetId, reachableTarget.id, "3D contact scoring should reject high wall targets that are not physically taggable");
  assert(Math.abs(result.throttle) > 0.25, "reachable target should produce a committed pursuit input");
  return result;
}

function wallCompromisedTargetScenario() {
  const round = makeRound({ id: "wall-compromised-target", count: 3, arena: "orange" });
  round.sim = createSimState(round, { now: 0 });
  const cars = [...round.sim.cars.values()];
  const [tagger, wallTarget, farTarget] = cars;
  forceIt(cars, tagger);
  farTarget.score = 240;
  pose(tagger, 82, 0, Math.PI / 2, 9.5);
  tagger.vehicle.numWheelsOnGround = 4;
  pose(wallTarget, 86, 6, Math.PI / 2, 12.5);
  wallTarget.vehicle.numWheelsOnGround = 1;
  wallTarget.body.quaternion.setFromAxisAngle(new CANNON.Vec3(0, 0, 1), Math.PI * 0.62);
  velocity(wallTarget, 0, -2, 0);
  syncBodyHistory(wallTarget);
  pose(farTarget, -46, -48, 0);

  updateAiCar(tagger, 1 / 60, {
    gameState: gameState(cars, tagger),
    difficulty: "extreme",
    arenaId: "orange",
    rng: () => 0.42,
  });

  const result = {
    targetId: tagger.ai.targetId,
    plan: tagger.ai.plan,
    maneuver: tagger.ai.maneuver,
    throttle: Number(tagger.input.throttle.toFixed(3)),
    steer: Number(tagger.input.steer.toFixed(3)),
  };
  assert.equal(result.targetId, wallTarget.id, "reachable compromised wall runner should beat far targets");
  assert(
    result.plan === "finish_tag" || result.plan === "pressure_tag" || result.plan === "direct_tag",
    "wall target in reach should produce a direct pressure/finish plan",
  );
  assert(result.throttle > 0.25, "tagger should drive toward the reachable wall target");
  return result;
}

function curvePursuitScenario() {
  const round = makeRound({ id: "curve-pursuit", count: 2, arena: "orange" });
  round.sim = createSimState(round, { now: 0 });
  const cars = [...round.sim.cars.values()];
  const [tagger, runner] = cars;
  forceIt(cars, tagger);
  pose(tagger, 72, -18, 0);
  velocity(tagger, 0, 0, 18);
  pose(runner, 82, 2, 0);
  velocity(runner, 0, 0, 22);

  updateAiCar(tagger, 1 / 60, {
    gameState: gameState(cars, tagger),
    difficulty: "extreme",
    arenaId: "orange",
    rng: () => 0.42,
  });

  const result = {
    targetId: tagger.ai.targetId,
    mode: tagger.ai.mode,
    plan: tagger.ai.plan,
    maneuver: tagger.ai.maneuver,
    throttle: Number(tagger.input.throttle.toFixed(3)),
    steer: Number(tagger.input.steer.toFixed(3)),
  };
  assert.equal(result.targetId, runner.id, "tagger should keep the curve runner as its target");
  assert(result.mode?.startsWith("tag"), "curve runner should produce a tag maneuver, not a roam or recover state");
  assert(result.throttle > 0.35, "controlled curve pursuit should not be throttled like a bad radial climb");
  return result;
}

function sidewallTractionDisciplineScenario() {
  const round = makeRound({ id: "sidewall-traction-discipline", count: 2, arena: "orange" });
  round.sim = createSimState(round, { now: 0 });
  const cars = [...round.sim.cars.values()];
  const [tagger, target] = cars;
  forceIt(cars, tagger);
  const radius = worldSpec.floorRadius + 12;
  const targetRadius = radius + 12;
  pose(tagger, radius, 0, Math.PI / 2, arenaSurfaceYAtRadius(radius));
  velocity(tagger, 26, 0, 0);
  pose(target, targetRadius, 4, Math.PI / 2, arenaSurfaceYAtRadius(targetRadius));
  velocity(target, 12, 0, 0);

  updateAiCar(tagger, 1 / 60, {
    gameState: gameState(cars, tagger),
    difficulty: "extreme",
    arenaId: "orange",
    rng: () => 0.42,
  });

  const result = {
    targetId: tagger.ai.targetId,
    plan: tagger.ai.plan,
    throttle: Number(tagger.input.throttle.toFixed(3)),
    steer: Number(tagger.input.steer.toFixed(3)),
    boostQueued: Boolean(tagger.input.boostQueued),
    surfaceUpDot: Number(tagger.ai.surfaceUpDot.toFixed(3)),
  };
  assert.equal(result.targetId, target.id, "tagger should still pursue reachable wall targets");
  assert.equal(result.boostQueued, false, "tagger should not boost into a steep outward sidewall climb");
  assert(result.throttle < 0.85, "tagger should moderate throttle on a traction-limited sidewall climb");
  return result;
}

function boundaryDisciplineScenario() {
  const round = makeRound({ id: "boundary-discipline", count: 2, arena: "orange" });
  round.sim = createSimState(round, { now: 0 });
  const cars = [...round.sim.cars.values()];
  const [runner, tagger] = cars;
  forceIt(cars, tagger);
  const radius = worldSpec.floorRadius - 1;
  pose(runner, radius, 0, Math.PI / 2);
  velocity(runner, 30, 0, 0);
  pose(tagger, 0, 0, 0);

  updateAiCar(runner, 1 / 60, {
    gameState: gameState(cars, tagger),
    difficulty: "extreme",
    arenaId: "orange",
    rng: () => 0.42,
  });

  const result = {
    mode: runner.ai.mode,
    plan: runner.ai.plan,
    maneuver: runner.ai.maneuver,
    throttle: Number(runner.input.throttle.toFixed(3)),
    steer: Number(runner.input.steer.toFixed(3)),
  };
  assert(result.throttle < 0.72 || Math.abs(result.steer) > 0.45, "boundary climb should not stay full-throttle straight outward");
  return result;
}

function aerialRecoveryScenario() {
  const round = makeRound({ id: "aerial-recovery", count: 2, arena: "orange" });
  round.sim = createSimState(round, { now: 0 });
  const cars = [...round.sim.cars.values()];
  const [runner, tagger] = cars;
  forceIt(cars, tagger);
  pose(runner, 0, 0, 0, 9);
  runner.vehicle.numWheelsOnGround = 0;
  runner.body.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), Math.PI);
  velocity(runner, 10, -4, 0);
  angularVelocity(runner, 2.5, 1.2, -2.2);
  pose(tagger, 35, 0, 0);

  updateAiCar(runner, 1 / 60, {
    gameState: gameState(cars, tagger),
    difficulty: "extreme",
    arenaId: "orange",
    rng: () => 0.42,
  });

  const result = {
    mode: runner.ai.mode,
    jumpQueued: Boolean(runner.input.jumpQueued),
    boostQueued: Boolean(runner.input.boostQueued),
    throttle: Number(runner.input.throttle.toFixed(3)),
    steer: Number(runner.input.steer.toFixed(3)),
    airRoll: Number(runner.input.airRoll.toFixed(3)),
  };
  assert.equal(result.jumpQueued, false, "airborne recovery should not queue jumps");
  assert.equal(result.boostQueued, false, "airborne recovery should not boost");
  assert(Math.abs(result.throttle) + Math.abs(result.airRoll) > 0.35, "airborne recovery should produce stabilizing pitch/roll input");
  return result;
}

function aerialWallLandingScenario() {
  const round = makeRound({ id: "aerial-wall-landing", count: 2, arena: "orange" });
  round.sim = createSimState(round, { now: 0 });
  const cars = [...round.sim.cars.values()];
  const [runner, tagger] = cars;
  forceIt(cars, tagger);
  pose(runner, worldSpec.floorRadius - 8, 0, 0, 8);
  runner.vehicle.numWheelsOnGround = 0;
  velocity(runner, 34, 3, 0);
  angularVelocity(runner, 0, 0, 0);
  pose(tagger, 0, 0, 0);

  updateAiCar(runner, 1 / 60, {
    gameState: gameState(cars, tagger),
    difficulty: "extreme",
    arenaId: "orange",
    rng: () => 0.42,
  });

  const result = {
    mode: runner.ai.mode,
    plan: runner.ai.plan,
    throttle: Number(runner.input.throttle.toFixed(3)),
    steer: Number(runner.input.steer.toFixed(3)),
    airRoll: Number(runner.input.airRoll.toFixed(3)),
  };
  assert.equal(result.mode, "run", "wall landing setup should stay in tactical run mode, not generic recovery");
  assert(
    Math.abs(result.throttle) + Math.abs(result.steer) + Math.abs(result.airRoll) > 0.55,
    "airborne wall approach should actively orient for the predicted landing surface",
  );
  assert(result.airRoll > 0.05, "wall landing roll should align to the inward/up bowl normal, not the flipped outward normal");
  return result;
}

function manualRightingScenario() {
  const round = makeRound({ id: "manual-righting", count: 2, arena: "orange" });
  round.sim = createSimState(round, { now: 0 });
  const cars = [...round.sim.cars.values()];
  const [runner, tagger] = cars;
  forceIt(cars, tagger);
  pose(runner, 52, 0, 0);
  runner.vehicle.numWheelsOnGround = 0;
  runner.body.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), Math.PI);
  syncBodyHistory(runner);
  pose(tagger, 35, 0, 0);

  updateAiCar(runner, 1 / 60, {
    gameState: gameState(cars, tagger),
    difficulty: "extreme",
    arenaId: "orange",
    shouldRightWithJump: () => true,
    rng: () => 0.42,
  });

  const result = {
    mode: runner.ai.mode,
    canRight: runner.ai.canRight,
    jumpQueued: Boolean(runner.input.jumpQueued),
    boostQueued: Boolean(runner.input.boostQueued),
  };
  assert.equal(result.mode, "recover", "inverted car should enter recovery mode");
  assert.equal(result.jumpQueued, true, "manual righting should keep the queued jump through aerial stabilization");
  assert.equal(result.boostQueued, false, "manual righting recovery should not boost");
  return result;
}

function unstickNoJumpScenario() {
  const round = makeRound({ id: "unstick-no-jump", count: 2, arena: "orange" });
  round.sim = createSimState(round, { now: 0 });
  const cars = [...round.sim.cars.values()];
  const [runner, tagger] = cars;
  forceIt(cars, tagger);
  pose(runner, 0, 0, 0);
  pose(tagger, 35, 0, 0);
  runner.ai.stuckTimer = 2.8;
  runner.vehicle.numWheelsOnGround = 4;

  updateAiCar(runner, 1 / 60, {
    gameState: gameState(cars, tagger),
    difficulty: "extreme",
    arenaId: "orange",
    rng: () => 0.42,
  });

  const result = {
    mode: runner.ai.mode,
    jumpQueued: Boolean(runner.input.jumpQueued),
    throttle: Number(runner.input.throttle.toFixed(3)),
    steer: Number(runner.input.steer.toFixed(3)),
  };
  assert.equal(result.mode, "unstick", "stuck car should enter unstick mode");
  assert.equal(result.jumpQueued, false, "unstick should not use random jump hops");
  return result;
}

function purpleRoundScenario(seed) {
  const round = makeRound({ id: `purple-round-${seed}`, seed, count: 8, arena: "purple" });
  round.sim = createSimState(round, { now: 0 });
  const cars = [...round.sim.cars.values()];
  forceIt(cars, cars[0]);
  const metrics = runTicks(round, 30);
  const itCar = cars.find((car) => car.isIt);
  const result = {
    seed,
    tags: metrics.tags,
    dodges: metrics.dodges,
    recoverShare: Number(metrics.recoverShare.toFixed(3)),
    minTravel: Number(Math.min(...metrics.travel).toFixed(2)),
    it: itCar?.id,
    itPlan: itCar?.ai?.plan ?? null,
    itManeuver: itCar?.ai?.maneuver ?? null,
    itMode: itCar?.ai?.mode ?? null,
  };
  assert(result.minTravel > 8, "all AI cars should move meaningfully in the round benchmark");
  return result;
}

function fullRoundBalanceScenario() {
  const round = makeRound({ id: "full-round-balance", seed: "b", count: 8, arena: "purple" });
  round.sim = createSimState(round, { now: 0 });
  const cars = [...round.sim.cars.values()];
  forceIt(cars, cars[0]);
  const metrics = runTicks(round, 120);
  const result = {
    tags: metrics.tags,
    recoverShare: Number(metrics.recoverShare.toFixed(3)),
    taggerWallShare: Number(metrics.taggerWallShare.toFixed(3)),
    runnerWallShare: Number(metrics.runnerWallShare.toFixed(3)),
    nearShare: Number(metrics.nearShare.toFixed(3)),
    finishShare: Number(metrics.finishShare.toFixed(3)),
    bestDistance: Number(metrics.bestDistance.toFixed(2)),
    minTravel: Number(Math.min(...metrics.travel).toFixed(2)),
  };
  assert(result.tags >= 3, "extreme full round should circulate tags, not leave one tagger stuck for two minutes");
  assert(result.recoverShare < 0.08, "full round should not be dominated by recovery states");
  assert(result.nearShare > 0.035, "taggers should create sustained tag pressure over a full round");
  assert(result.finishShare > 0.008, "taggers should regularly convert pressure into real finish windows");
  assert(result.runnerWallShare < 0.62, "runners should not spend nearly the whole round committed to the curve");
  assert(result.minTravel > 100, "all AI cars should keep moving over the full round");
  return result;
}

setAiProfilingEnabled(true);
resetAiProfile();

const wallStart = performance.now();
const results = {
  focused: {
    closeReverseTag: closeReverseTagScenario(),
    headOnDodge: headOnDodgeScenario(),
    runnerTrafficAvoidance: runnerTrafficAvoidanceScenario(),
    taggerCutoff: taggerCutoffScenario(),
    orbitRunnerCutoff: orbitRunnerCutoffScenario(),
    gradedActionPlanning: gradedActionPlanningScenario(),
    difficultyReactionDelay: difficultyReactionDelayScenario(),
    closeTargetPriority: closeTargetPriorityScenario(),
    closeHairpinControl: closeHairpinControlScenario(),
    jumpingTargetPursuit: jumpingTargetPursuitScenario(),
    reachableTargetPriority: reachableTargetPriorityScenario(),
    stationaryReachableTarget: stationaryReachableTargetScenario(),
    compromisedTargetPriority: compromisedTargetPriorityScenario(),
    stationaryWallReachableTarget: stationaryWallReachableTargetScenario(),
    highWallContactValidity: highWallContactValidityScenario(),
    wallCompromisedTarget: wallCompromisedTargetScenario(),
    curvePursuit: curvePursuitScenario(),
    sidewallTractionDiscipline: sidewallTractionDisciplineScenario(),
    boundaryDiscipline: boundaryDisciplineScenario(),
    aerialRecovery: aerialRecoveryScenario(),
    aerialWallLanding: aerialWallLandingScenario(),
    manualRighting: manualRightingScenario(),
    unstickNoJump: unstickNoJumpScenario(),
  },
  fullRoundBalance: fullRoundBalanceScenario(),
  rounds: ["a", "b", "c"].map(purpleRoundScenario),
};
results.profile = {
  ai: getAiProfile(),
  benchWallMs: Number((performance.now() - wallStart).toFixed(1)),
};
setAiProfilingEnabled(false);

console.log(JSON.stringify(results, null, 2));
