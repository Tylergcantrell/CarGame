import * as THREE from "three";
import { arenaDefinitions, worldSpec } from "./arena.js";

const EPS = 1e-6;
const TAG_RANGE = 6.4;
const CENTER = new THREE.Vector3(0, 0, 0);
const WORLD_UP = new THREE.Vector3(0, 1, 0);

const tmpVec3A = new THREE.Vector3();
const tmpVec3B = new THREE.Vector3();
const tmpVec3C = new THREE.Vector3();
const tmpVec3D = new THREE.Vector3();
const tmpVec3E = new THREE.Vector3();
const tmpVec3F = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();

export const aiDifficultyPresets = {
  easy: {
    thinkInterval: 0.34,
    reactionDelay: 0.24,
    steeringSkill: 0.58,
    planningSkill: 0.48,
    rankAwareness: 0.36,
    recoverySkill: 0.42,
    boostSkill: 0.42,
    aggression: 0.72,
    riskTolerance: 0.7,
    noise: 0.22,
    mistakeChance: 0.18,
  },
  medium: {
    thinkInterval: 0.2,
    reactionDelay: 0.12,
    steeringSkill: 0.82,
    planningSkill: 0.78,
    rankAwareness: 0.72,
    recoverySkill: 0.72,
    boostSkill: 0.78,
    aggression: 1,
    riskTolerance: 0.9,
    noise: 0.08,
    mistakeChance: 0.06,
  },
  hard: {
    thinkInterval: 0.13,
    reactionDelay: 0.05,
    steeringSkill: 1.08,
    planningSkill: 1.08,
    rankAwareness: 1.08,
    recoverySkill: 1.05,
    boostSkill: 1.12,
    aggression: 1.14,
    riskTolerance: 1.02,
    noise: 0.025,
    mistakeChance: 0.018,
  },
  extreme: {
    thinkInterval: 0.08,
    reactionDelay: 0.02,
    steeringSkill: 1.32,
    planningSkill: 1.35,
    rankAwareness: 1.42,
    recoverySkill: 1.35,
    boostSkill: 1.42,
    aggression: 1.24,
    riskTolerance: 1.12,
    noise: 0.006,
    mistakeChance: 0.002,
  },
};

export const aiDifficultyIds = ["easy", "medium", "hard", "extreme"];

const aiPersonalities = [
  { key: "hunter", weight: 1.15, chase: 1.24, survive: 0.84, rank: 1.08, space: 0.9, risk: 1.08 },
  { key: "survivor", weight: 1.05, chase: 0.82, survive: 1.28, rank: 0.82, space: 1.18, risk: 0.72 },
  { key: "opportunist", weight: 1.1, chase: 1.02, survive: 0.96, rank: 1.36, space: 1, risk: 0.94 },
  { key: "bully", weight: 0.9, chase: 1.12, survive: 0.92, rank: 1.22, space: 0.82, risk: 1.18 },
  { key: "skater", weight: 0.9, chase: 0.92, survive: 1.04, rank: 0.9, space: 1.34, risk: 1.06 },
];

export const aiPersonalityKeys = aiPersonalities.map((personality) => personality.key);

export function normalizeAiDifficulty(value = "medium") {
  const key = String(value ?? "medium").trim().toLowerCase();
  return aiDifficultyIds.includes(key) ? key : "medium";
}

function difficultyConfig(difficulty = "medium") {
  if (typeof difficulty === "string") return aiDifficultyPresets[normalizeAiDifficulty(difficulty)];
  return { ...aiDifficultyPresets.medium, ...(difficulty ?? {}) };
}

function finite(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function clamp01(value) {
  return THREE.MathUtils.clamp(value, 0, 1);
}

function safeNormalize(vec, fallback = null) {
  if (vec.lengthSq() > EPS) return vec.normalize();
  return fallback ? vec.copy(fallback) : vec.set(0, 0, 1);
}

function chooseWeighted(items, rng) {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let roll = rng() * total;
  for (const item of items) {
    roll -= item.weight;
    if (roll <= 0) return item;
  }
  return items[items.length - 1];
}

function ensureVector(value) {
  return value?.isVector3 ? value : new THREE.Vector3();
}

function ensureMind(car, rng) {
  car.ai ??= {};
  car.input ??= {};
  const ai = car.ai;
  if (!ai.personalityKey) ai.personalityKey = chooseWeighted(aiPersonalities, rng).key;
  ai.objective = ensureVector(ai.objective);
  ai.desired = ensureVector(ai.desired);
  ai.tacticalPoint = ensureVector(ai.tacticalPoint);
  ai.lastPosition = ensureVector(ai.lastPosition);
  ai.decisionTimer = finite(ai.decisionTimer);
  ai.modeTimer = finite(ai.modeTimer);
  ai.jumpCooldown = finite(ai.jumpCooldown);
  ai.stuckTimer = finite(ai.stuckTimer);
  ai.reverseTimer = finite(ai.reverseTimer);
  ai.lateralSign = ai.lateralSign === -1 ? -1 : 1;
  ai.unstickTimer = finite(ai.unstickTimer);
  ai.unstickSteer = finite(ai.unstickSteer, ai.lateralSign);
  ai.mistakeTimer = finite(ai.mistakeTimer);
  ai.mistakeSteer = finite(ai.mistakeSteer);
  ai.lateralTimer = finite(ai.lateralTimer, 1 + rng() * 2);
  return aiPersonalities.find((personality) => personality.key === ai.personalityKey) ?? aiPersonalities[0];
}

function carPosition(car, out = new THREE.Vector3()) {
  return out.set(
    finite(car.body?.position?.x),
    finite(car.body?.position?.y),
    finite(car.body?.position?.z),
  );
}

function carVelocity(car, out = new THREE.Vector3()) {
  return out.set(
    finite(car.body?.velocity?.x),
    finite(car.body?.velocity?.y),
    finite(car.body?.velocity?.z),
  );
}

function flatSpeed(car) {
  return Math.hypot(finite(car.body?.velocity?.x), finite(car.body?.velocity?.z));
}

function carQuaternion(car) {
  return tmpQuat.set(
    finite(car.body?.quaternion?.x),
    finite(car.body?.quaternion?.y),
    finite(car.body?.quaternion?.z),
    finite(car.body?.quaternion?.w, 1),
  );
}

function flatForward(car, out = new THREE.Vector3()) {
  out.set(0, 0, 1).applyQuaternion(carQuaternion(car));
  out.y = 0;
  return safeNormalize(out);
}

function carUp(car, out = new THREE.Vector3()) {
  return out.set(0, 1, 0).applyQuaternion(carQuaternion(car)).normalize();
}

function flatDistanceBetween(a, b) {
  return Math.hypot(
    finite(a.body?.position?.x) - finite(b.body?.position?.x),
    finite(a.body?.position?.z) - finite(b.body?.position?.z),
  );
}

function arenaLimit(margin = 10) {
  return Math.max(finite(worldSpec?.floorRadius, 68), finite(worldSpec?.outerRadius, 98) - margin);
}

function clampArenaPoint(point, margin = 10) {
  const limit = arenaLimit(margin);
  const radius = Math.hypot(point.x, point.z);
  if (radius > limit) {
    point.x *= limit / radius;
    point.z *= limit / radius;
  }
  point.y = 0;
  return point;
}

function arenaFeatures(arenaId) {
  return (arenaDefinitions[arenaId] ?? arenaDefinitions.orange).mounds ?? [];
}

function featureLocalPoint(feature, point, out = new THREE.Vector3()) {
  const dx = point.x - finite(feature.x);
  const dz = point.z - finite(feature.z);
  const yaw = finite(feature.yaw);
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  out.set(dx * c - dz * s, 0, dx * s + dz * c);
  return out;
}

function featureWorldPoint(feature, local, out = new THREE.Vector3()) {
  const yaw = finite(feature.yaw);
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  out.set(
    finite(feature.x) + local.x * c + local.z * s,
    0,
    finite(feature.z) - local.x * s + local.z * c,
  );
  return out;
}

function featureLongAxis(feature, out = new THREE.Vector3()) {
  const yaw = finite(feature.yaw);
  return out.set(Math.sin(yaw), 0, Math.cos(yaw)).normalize();
}

function featureSideAxis(feature, out = new THREE.Vector3()) {
  const yaw = finite(feature.yaw);
  return out.set(Math.cos(yaw), 0, -Math.sin(yaw)).normalize();
}

function featureInflation(feature) {
  const height = finite(feature.height, 2);
  return 3.8 + Math.min(7, height * 0.65);
}

function featureCrossingInfo(feature, from, to) {
  const halfW = finite(feature.width, 12) * 0.5;
  const halfL = finite(feature.length, 12) * 0.5;
  const inflate = featureInflation(feature);
  const fromLocal = featureLocalPoint(feature, from, tmpVec3A);
  const toLocal = featureLocalPoint(feature, to, tmpVec3B);
  const delta = tmpVec3C.copy(toLocal).sub(fromLocal);
  let best = null;

  for (let i = 1; i <= 10; i += 1) {
    const t = i / 10;
    const sampleX = fromLocal.x + delta.x * t;
    const sampleZ = fromLocal.z + delta.z * t;
    const insideX = Math.abs(sampleX) <= halfW + inflate;
    const insideZ = Math.abs(sampleZ) <= halfL + inflate;
    if (!insideX || !insideZ) continue;

    const centerLane = Math.abs(sampleX) <= Math.max(2.2, halfW * 0.46);
    const edgeBand = Math.abs(sampleX) >= Math.max(0, halfW - 2.2);
    const along = Math.abs(delta.z);
    const across = Math.abs(delta.x);
    const lengthAligned = along > across * 1.25;
    const side = sampleX >= 0 ? 1 : -1;
    const edgeRisk = clamp01((Math.abs(sampleX) - halfW * 0.42) / Math.max(1, inflate + halfW * 0.58));
    const heightRisk = clamp01((finite(feature.height, 2) - 1.2) / 5.6);
    const typeRisk = feature.type === "ridge" ? 1 : feature.type === "peak" ? 0.85 : 0.72;
    const risk = edgeRisk * (0.55 + heightRisk * 0.65) * typeRisk + (edgeBand && !lengthAligned ? 0.35 : 0);
    if (!best || risk > best.risk) {
      best = { feature, fromLocal: fromLocal.clone(), toLocal: toLocal.clone(), sampleX, sampleZ, side, centerLane, lengthAligned, risk };
    }
  }
  return best;
}

function featureRoutePoint(from, desired, facts, config, out = new THREE.Vector3()) {
  out.copy(desired);
  const features = facts.features ?? [];
  if (!features.length) return out;

  let best = null;
  for (const feature of features) {
    const info = featureCrossingInfo(feature, from, desired);
    if (!info || info.risk < 0.22) continue;
    if (info.centerLane && info.lengthAligned && finite(config.planningSkill, 1) > 0.62) continue;
    if (!best || info.risk > best.risk) best = info;
  }
  if (!best) return out;

  const feature = best.feature;
  const halfW = finite(feature.width, 12) * 0.5;
  const halfL = finite(feature.length, 12) * 0.5;
  const side = best.side || 1;
  const clearance = featureInflation(feature) + 3.5;
  const localBypass = tmpVec3E.set(
    side * (halfW + clearance),
    0,
    THREE.MathUtils.clamp(best.fromLocal.z + Math.sign(best.toLocal.z - best.fromLocal.z || 1) * Math.min(halfL * 0.6, 16), -halfL - clearance, halfL + clearance),
  );
  featureWorldPoint(feature, localBypass, out);

  const skill = clamp01(finite(config.planningSkill, 0.8) / 1.35);
  out.lerp(desired, THREE.MathUtils.lerp(0.08, 0.24, skill));
  return clampArenaPoint(out, 8);
}

function featureTrajectoryBypass(facts, config, out = new THREE.Vector3()) {
  if (!facts.features?.length || facts.speed < 6) return null;
  const lookahead = THREE.MathUtils.clamp(facts.speed / 34, 0.28, 1.05);
  const projected = tmpVec3E.copy(facts.position).addScaledVector(facts.velocity, lookahead);
  projected.y = 0;
  const routed = featureRoutePoint(facts.position, projected, facts, config, out);
  return routed.distanceToSquared(projected) > 4 ? routed : null;
}

function flatPerpendicular(direction, sign = 1, out = new THREE.Vector3()) {
  out.set(-direction.z * sign, 0, direction.x * sign);
  return safeNormalize(out, new THREE.Vector3(sign, 0, 0));
}

function inwardDirectionFromPoint(point, out = new THREE.Vector3()) {
  out.set(-point.x, 0, -point.z);
  return safeNormalize(out, new THREE.Vector3(0, 0, 1));
}

function mobility(car) {
  const wheels = finite(car.vehicle?.numWheelsOnGround);
  const upDot = carUp(car, tmpVec3A).dot(WORLD_UP);
  const wheelScore = wheels >= 3 ? 1 : wheels >= 2 ? 0.76 : wheels >= 1 ? 0.42 : 0.18;
  const speedScore = 0.3 + 0.7 * clamp01(flatSpeed(car) / 26);
  const uprightScore = clamp01((upDot + 0.2) / 1.2);
  return clamp01(wheelScore * 0.48 + speedScore * 0.24 + uprightScore * 0.28);
}

function predictedPosition(car, seconds, out = new THREE.Vector3()) {
  return carPosition(car, out).addScaledVector(carVelocity(car, tmpVec3A), seconds);
}

function rankCars(cars) {
  const sorted = [...cars].sort((a, b) => finite(b.score) - finite(a.score));
  const ranks = new Map();
  sorted.forEach((car, index) => ranks.set(car, index + 1));
  return ranks;
}

function relativeCar(self, other, ranks, config, rng) {
  const selfPos = carPosition(self, tmpVec3A);
  const otherPos = carPosition(other, tmpVec3B);
  const toOther = tmpVec3C.copy(otherPos).sub(selfPos);
  const flatDistance = Math.hypot(toOther.x, toOther.z);
  toOther.y = 0;
  safeNormalize(toOther, flatForward(self, tmpVec3D));

  const selfVelocity = carVelocity(self, tmpVec3D);
  const otherVelocity = carVelocity(other, tmpVec3A);
  const closing = selfVelocity.sub(otherVelocity).dot(toOther);
  const local = toOther.applyQuaternion(carQuaternion(self).invert());
  const noise = finite(config.noise) * (rng() - 0.5) * 2;
  return {
    car: other,
    id: other.id,
    rank: ranks.get(other) ?? 99,
    score: finite(other.score),
    scoreGap: finite(other.score) - finite(self.score),
    distance: flatDistance * (1 + noise * 0.16),
    angle: Math.atan2(local.x, local.z) + noise * 0.34,
    closing,
    speed: flatSpeed(other),
    mobility: mobility(other),
    immunity: Math.max(0, finite(other.immunityRemaining)),
    airborne: finite(other.vehicle?.numWheelsOnGround) < 2,
  };
}

function crowdVector(car, others) {
  const pos = carPosition(car, tmpVec3A);
  const escape = new THREE.Vector3();
  let pressure = 0;
  let nearest = Infinity;
  for (const other of others) {
    const otherPos = carPosition(other.car, tmpVec3B);
    const distance = Math.hypot(pos.x - otherPos.x, pos.z - otherPos.z);
    nearest = Math.min(nearest, distance);
    if (distance > 20) continue;
    const away = tmpVec3C.copy(pos).sub(otherPos);
    away.y = 0;
    safeNormalize(away, inwardDirectionFromPoint(pos, tmpVec3D));
    const weight = (1 - distance / 20) ** 2;
    pressure += weight;
    escape.addScaledVector(away, weight);
  }
  safeNormalize(escape, inwardDirectionFromPoint(pos, tmpVec3B));
  return { escape, pressure: clamp01(pressure / 1.6), nearest };
}

function observe(car, gameState, config, rng, arenaId = "orange") {
  const cars = Array.isArray(gameState.cars) ? gameState.cars.filter(Boolean) : [car];
  const ranks = rankCars(cars);
  const others = cars.filter((other) => other !== car).map((other) => relativeCar(car, other, ranks, config, rng));
  const crowd = crowdVector(car, others);
  const threat = others.find((entry) => entry.car === gameState.itCar) ?? null;
  const position = carPosition(car, new THREE.Vector3());
  const velocity = carVelocity(car, new THREE.Vector3());
  const forward = flatForward(car, new THREE.Vector3());
  const quat = carQuaternion(car);
  const forwardY = tmpVec3A.set(0, 0, 1).applyQuaternion(quat).y;
  const upDot = carUp(car, tmpVec3A).dot(WORLD_UP);
  let threatRisk = 0;
  if (threat) {
    const threatToSelf = tmpVec3A.copy(position).sub(carPosition(threat.car, tmpVec3B));
    threatToSelf.y = 0;
    safeNormalize(threatToSelf, inwardDirectionFromPoint(position, tmpVec3C));
    const threatApproach = carVelocity(threat.car, tmpVec3B).sub(velocity).dot(threatToSelf);
    threatRisk = clamp01((32 - threat.distance) / 32 * 0.72 + clamp01(threatApproach / 22) * 0.28);
  }
  return {
    cars,
    ranks,
    others,
    runners: others.filter((entry) => !entry.car.isIt),
    threat,
    position,
    velocity,
    forward,
    speed: Math.hypot(velocity.x, velocity.z),
    wheels: finite(car.vehicle?.numWheelsOnGround),
    airborne: finite(car.vehicle?.numWheelsOnGround) < 2,
    upDot,
    forwardY,
    mobility: mobility(car),
    crowd,
    selfRank: ranks.get(car) ?? 99,
    selfScore: finite(car.score),
    timeRemaining: Math.max(0, finite(gameState.timeRemaining, 120)),
    threatRisk,
    arenaId,
    features: arenaFeatures(arenaId),
  };
}

function updateMotionAwareness(car, ai, facts, dt) {
  const moved = Math.hypot(
    facts.position.x - finite(ai.lastPosition?.x, facts.position.x),
    facts.position.z - finite(ai.lastPosition?.z, facts.position.z),
  );
  const effort =
    Math.abs(finite(car.input?.throttle)) +
    Math.abs(finite(car.input?.steer)) * 0.4 +
    Math.abs(finite(car.input?.airRoll)) * 0.25;
  const badOrientation = facts.upDot < 0.28 || (facts.wheels <= 1 && facts.mobility < 0.34);
  const tryingButNotMoving = effort > 0.35 && facts.speed < 2.4 && moved < 0.08;
  if (badOrientation || tryingButNotMoving) ai.stuckTimer += dt * (badOrientation ? 1.8 : 1);
  else ai.stuckTimer = Math.max(0, ai.stuckTimer - dt * 2.4);
  ai.lastPosition.copy(facts.position);
  return ai.stuckTimer;
}

function openSpacePoint(car, facts, out = new THREE.Vector3()) {
  out.copy(facts.position);
  if (car.isIt) {
    out.addScaledVector(facts.forward, 24);
  } else if (facts.threat) {
    const away = tmpVec3A.copy(facts.position).sub(carPosition(facts.threat.car, tmpVec3B));
    away.y = 0;
    safeNormalize(away, facts.forward);
    const lateral = flatPerpendicular(away, car.ai?.lateralSign || 1, tmpVec3C);
    out.addScaledVector(away, 30 + facts.threatRisk * 22);
    out.addScaledVector(lateral, facts.threatRisk > 0.36 ? 10 + facts.threatRisk * 16 : 0);
  } else {
    out.addScaledVector(facts.forward, 22);
  }
  out.addScaledVector(facts.crowd.escape, 12 + facts.crowd.pressure * 24);
  return clampArenaPoint(out, 14);
}

function segmentDistanceToPoint(start, end, point) {
  const sx = start.x;
  const sz = start.z;
  const ex = end.x;
  const ez = end.z;
  const px = point.x;
  const pz = point.z;
  const dx = ex - sx;
  const dz = ez - sz;
  const lengthSq = dx * dx + dz * dz;
  if (lengthSq <= EPS) return Math.hypot(px - sx, pz - sz);
  const t = THREE.MathUtils.clamp(((px - sx) * dx + (pz - sz) * dz) / lengthSq, 0, 1);
  return Math.hypot(px - (sx + dx * t), pz - (sz + dz * t));
}

function pointCrowdingScore(point, facts, range = 20) {
  let score = 0;
  for (const other of facts.others) {
    const pos = carPosition(other.car, tmpVec3A);
    const distance = Math.hypot(point.x - pos.x, point.z - pos.z);
    if (distance >= range) continue;
    score += (1 - distance / range) ** 2;
  }
  return score;
}

function boundaryPhysicsRisk(from, to, facts) {
  const fromRadius = Math.hypot(from.x, from.z);
  const toRadius = Math.hypot(to.x, to.z);
  const maxRadius = Math.max(fromRadius, toRadius);
  const wallEntry = clamp01((maxRadius - (worldSpec.floorRadius - 6)) / 22);
  if (wallEntry <= 0) return 0;

  const direction = tmpVec3A.copy(to).sub(from);
  direction.y = 0;
  safeNormalize(direction, facts.forward);
  const outward = tmpVec3B.set(from.x, 0, from.z);
  safeNormalize(outward, direction);
  const radialDrive = THREE.MathUtils.clamp(direction.dot(outward), -1, 1);
  const tangentDrive = Math.sqrt(Math.max(0, 1 - radialDrive * radialDrive));
  const straightClimb = clamp01((radialDrive - 0.18) / 0.74);
  const lowTangent = clamp01((0.54 - tangentDrive) / 0.54);
  const speedRisk = clamp01((facts.speed - 16) / 24);
  const airborneRisk = facts.wheels < 3 ? 0.32 : 0;
  return clamp01(wallEntry * (straightClimb * 0.72 + lowTangent * 0.28) * (0.65 + speedRisk * 0.75 + airborneRisk));
}

function routeRisk(from, to, facts, config) {
  const routed = featureRoutePoint(from, to, facts, config, tmpVec3F);
  return Math.sqrt(routed.distanceToSquared(to)) + boundaryPhysicsRisk(from, to, facts) * 22;
}

function candidateBoundaryRisk(point) {
  return clamp01((Math.hypot(point.x, point.z) - arenaLimit(8)) / 8);
}

function predictFlatCarPosition(car, seconds, out = new THREE.Vector3()) {
  predictedPosition(car, seconds, out);
  out.y = 0;
  return clampArenaPoint(out, 4);
}

function projectSelfToward(facts, point, config, {
  desiredSpeed = 36,
  horizon = 1.05,
  steps = 6,
  boost = false,
} = {}) {
  const position = facts.position.clone();
  const forward = facts.forward.clone();
  const target = point.clone();
  target.y = 0;
  let speed = Math.max(0, facts.speed);
  const stepTime = horizon / Math.max(1, steps);
  const turnRate = THREE.MathUtils.lerp(1.7, 4.2, clamp01(finite(config.steeringSkill, 0.8) / 1.35));
  const accel = 18 + finite(config.planningSkill, 0.8) * 6 + (boost ? 10 * finite(config.boostSkill, 1) : 0);
  const brake = 24 + finite(config.steeringSkill, 0.8) * 8;
  let turnLoad = 0;

  for (let step = 0; step < steps; step += 1) {
    const desired = target.clone().sub(position);
    desired.y = 0;
    safeNormalize(desired, forward);
    const alignment = THREE.MathUtils.clamp(forward.dot(desired), -1, 1);
    const turnNeed = Math.acos(alignment);
    turnLoad = Math.max(turnLoad, turnNeed);
    forward.lerp(desired, clamp01(turnRate * stepTime / Math.max(0.001, turnNeed))).normalize();

    const speedError = desiredSpeed - speed;
    const delta = speedError >= 0
      ? Math.min(speedError, accel * stepTime)
      : Math.max(speedError, -brake * stepTime);
    speed = Math.max(0, speed + delta);
    speed *= THREE.MathUtils.lerp(1, 0.92, clamp01((turnNeed - 0.6) / 1.4) * clamp01(speed / 42));
    position.addScaledVector(forward, speed * stepTime);
    clampArenaPoint(position, 4);
  }

  return { position, forward, speed, turnLoad };
}

function makeChaseCandidatePoints(target, facts, config) {
  const targetPosition = carPosition(target.car, new THREE.Vector3());
  const targetVelocity = carVelocity(target.car, new THREE.Vector3());
  targetVelocity.y = 0;
  const targetSpeed = Math.max(0, targetVelocity.length());
  const targetForward = targetSpeed > EPS
    ? targetVelocity.clone().normalize()
    : flatForward(target.car, new THREE.Vector3());
  const lead = THREE.MathUtils.clamp(
    target.distance / (28 + facts.speed * 0.5 + targetSpeed * 0.7),
    0.1,
    0.75 + finite(config.planningSkill, 1) * 0.38,
  );
  const predicted = targetPosition.clone().addScaledVector(targetVelocity, lead);
  predicted.y = 0;
  clampArenaPoint(predicted, 4);
  const inward = inwardDirectionFromPoint(predicted, new THREE.Vector3());
  const side = Math.sign(predicted.clone().sub(facts.position).cross(targetForward).y) || 1;
  const lateral = flatPerpendicular(targetForward, side, new THREE.Vector3());
  const boundary = candidateBoundaryRisk(predicted);
  const curveLane = clamp01((Math.hypot(predicted.x, predicted.z) - (worldSpec.floorRadius - 4)) / 26);
  const towardSelf = facts.position.clone().sub(predicted);
  towardSelf.y = 0;
  safeNormalize(towardSelf, inward);
  const selfLateral = flatPerpendicular(towardSelf, side, new THREE.Vector3());

  return [
    { label: "lead", point: predicted.clone() },
    { label: "ahead", point: predicted.clone().addScaledVector(targetForward, 8 + targetSpeed * 0.32) },
    { label: "far_ahead", point: predicted.clone().addScaledVector(targetForward, 16 + targetSpeed * 0.42) },
    { label: "side_cut", point: predicted.clone().addScaledVector(lateral, 11).addScaledVector(targetForward, 5) },
    { label: "cross_cut", point: predicted.clone().addScaledVector(lateral, -11).addScaledVector(targetForward, 5) },
    { label: "inside_cut", point: predicted.clone().addScaledVector(inward, 8 + boundary * 18).addScaledVector(targetForward, 8 + boundary * 8) },
    { label: "inside_ahead", point: predicted.clone().addScaledVector(inward, 14 + curveLane * 20).addScaledVector(targetForward, 16 + targetSpeed * 0.34) },
    { label: "deep_inside", point: predicted.clone().addScaledVector(inward, 22 + curveLane * 24).addScaledVector(targetForward, 24 + targetSpeed * 0.44) },
    { label: "pinch_left", point: predicted.clone().addScaledVector(towardSelf, 10).addScaledVector(selfLateral, 13) },
    { label: "pinch_right", point: predicted.clone().addScaledVector(towardSelf, 10).addScaledVector(selfLateral, -13) },
    { label: "close_pressure", point: targetPosition.clone().addScaledVector(targetForward, 4) },
  ].map((candidate) => {
    clampArenaPoint(candidate.point, 4);
    return candidate;
  });
}

function scoreChaseCandidate(target, facts, config, candidate) {
  const horizon = THREE.MathUtils.lerp(0.75, 1.45, clamp01(finite(config.planningSkill, 1) / 1.35));
  const desiredSpeed = target.distance < 14 ? 30 : 40 + finite(config.boostSkill, 1) * 3;
  const projected = projectSelfToward(facts, candidate.point, config, {
    desiredSpeed,
    horizon,
    steps: 6,
    boost: finite(config.boostSkill, 1) > 1.05 && target.distance > 18,
  });
  const targetFuture = predictFlatCarPosition(target.car, horizon, tmpVec3A);
  const targetMid = predictFlatCarPosition(target.car, horizon * 0.55, tmpVec3B);
  const finalDistance = Math.hypot(projected.position.x - targetFuture.x, projected.position.z - targetFuture.z);
  const pathDistance = segmentDistanceToPoint(facts.position, projected.position, targetMid);
  const tagWindow = Math.min(finalDistance, pathDistance);
  const tagChance = 1 - clamp01((tagWindow - TAG_RANGE) / 28);
  const progress = THREE.MathUtils.clamp(target.distance - finalDistance, -30, 45);
  const routePenalty = routeRisk(facts.position, candidate.point, facts, config) * 1.2;
  const boundaryPenalty = candidateBoundaryRisk(candidate.point) * 16;
  const tractionPenalty = boundaryPhysicsRisk(facts.position, candidate.point, facts) * 34;
  const speedValue = projected.speed * 0.22;
  const turnPenalty = clamp01((projected.turnLoad - 1.15) / 1.4) * 12;
  const targetPathPressure = 1 - clamp01((pathDistance - TAG_RANGE * 1.15) / 22);
  const anglePressure = 1 - clamp01(Math.abs(target.angle) / Math.PI);
  const closeFinish = target.distance < 24 ? (1 - clamp01((tagWindow - TAG_RANGE) / 16)) * 42 : 0;
  const cutoffBias =
    candidate.label === "far_ahead" || candidate.label.startsWith("pinch")
      ? 12
      : candidate.label === "inside_ahead" || candidate.label === "deep_inside"
        ? candidateBoundaryRisk(targetFuture) * 34 + 8
        : 0;
  return tagChance * 115 + targetPathPressure * 42 + closeFinish + progress * 1.55 + anglePressure * 12 + speedValue + cutoffBias - routePenalty - boundaryPenalty - tractionPenalty - turnPenalty;
}

function chooseChasePlan(target, facts, config) {
  if (target.distance < TAG_RANGE + 6) {
    const point = carPosition(target.car, new THREE.Vector3());
    point.y = 0;
    return {
      point,
      label: target.angle > 2.05 || target.angle < -2.05 ? "close_reverse" : "close_finish",
      score: 260 - target.distance * 3,
    };
  }

  let best = null;
  let bestScore = -Infinity;
  for (const candidate of makeChaseCandidatePoints(target, facts, config)) {
    const score = scoreChaseCandidate(target, facts, config, candidate);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return {
    point: (best?.point ?? forecastTarget(target, facts, config, new THREE.Vector3())).clone(),
    label: best?.label ?? "fallback",
    score: bestScore,
  };
}

function makeRunnerCandidatePoints(car, facts, config) {
  const position = facts.position;
  const threatPosition = facts.threat ? carPosition(facts.threat.car, new THREE.Vector3()) : null;
  const inward = inwardDirectionFromPoint(position, new THREE.Vector3());
  const away = threatPosition
    ? position.clone().sub(threatPosition)
    : facts.forward.clone();
  away.y = 0;
  safeNormalize(away, facts.forward);
  const lateral = flatPerpendicular(away, car.ai?.lateralSign || 1, new THREE.Vector3());
  const tangent = flatPerpendicular(inward, car.ai?.lateralSign || 1, new THREE.Vector3());
  const boundary = candidateBoundaryRisk(position);
  const threatVelocity = facts.threat ? carVelocity(facts.threat.car, new THREE.Vector3()) : null;
  if (threatVelocity) threatVelocity.y = 0;
  const threatForward = threatVelocity && threatVelocity.lengthSq() > EPS
    ? threatVelocity.clone().normalize()
    : null;
  const candidates = [
    { label: "carry_speed", point: position.clone().addScaledVector(facts.forward, 34) },
    { label: "escape_cut", point: position.clone().addScaledVector(away, 40).addScaledVector(lateral, 18) },
    { label: "cross_escape", point: position.clone().addScaledVector(away, 34).addScaledVector(lateral, -18) },
    { label: "orbit", point: position.clone().addScaledVector(tangent, 38).addScaledVector(inward, boundary * 20) },
    { label: "reverse_orbit", point: position.clone().addScaledVector(tangent, -34).addScaledVector(inward, boundary * 20) },
    { label: "recenter", point: position.clone().addScaledVector(inward, 30 + boundary * 18) },
  ];
  if (facts.threat && threatForward) {
    const threatFuture = carPosition(facts.threat.car, new THREE.Vector3()).addScaledVector(threatVelocity, 0.72);
    const slipSide = Math.sign(facts.forward.clone().cross(threatForward).y) || car.ai?.lateralSign || 1;
    const slip = flatPerpendicular(threatForward, slipSide, new THREE.Vector3());
    candidates.push(
      { label: "slip_left", point: threatFuture.clone().addScaledVector(slip, 28).addScaledVector(away, 20) },
      { label: "slip_right", point: threatFuture.clone().addScaledVector(slip, -28).addScaledVector(away, 20) },
    );
  }
  if (facts.crowd.pressure > 0.08) {
    candidates.push({
      label: "open_crowd",
      point: position.clone().addScaledVector(facts.crowd.escape, 34).addScaledVector(facts.forward, 14),
    });
  }
  return candidates.map((candidate) => {
    clampArenaPoint(candidate.point, 4);
    return candidate;
  });
}

function scoreRunnerCandidate(candidate, facts, config, personality) {
  const horizon = THREE.MathUtils.lerp(0.8, 1.5, clamp01(finite(config.planningSkill, 1) / 1.35));
  const projected = projectSelfToward(facts, candidate.point, config, {
    desiredSpeed: 36 + finite(config.boostSkill, 1) * 4,
    horizon,
    steps: 6,
    boost: facts.threatRisk > 0.35 && finite(config.boostSkill, 1) > 0.8,
  });
  const routePenalty = routeRisk(facts.position, candidate.point, facts, config) * 1.05;
  const boundaryPenalty = candidateBoundaryRisk(candidate.point) * 16;
  const tractionPenalty = boundaryPhysicsRisk(facts.position, candidate.point, facts) * 42;
  const crowdPenalty = pointCrowdingScore(projected.position, facts, 22) * 20 * personality.space;
  const speedValue = projected.speed * 0.42;
  const turnPenalty = clamp01((projected.turnLoad - 1.3) / 1.4) * 9;
  let threatScore = 0;

  if (facts.threat) {
    const threatFuture = predictFlatCarPosition(facts.threat.car, horizon, tmpVec3A);
    const threatMid = predictFlatCarPosition(facts.threat.car, horizon * 0.55, tmpVec3B);
    const finalDistance = Math.hypot(projected.position.x - threatFuture.x, projected.position.z - threatFuture.z);
    const pathDistance = segmentDistanceToPoint(facts.position, projected.position, threatMid);
    const threatToCandidateDistance = segmentDistanceToPoint(carPosition(facts.threat.car, tmpVec3C), threatFuture, projected.position);
    const tagRisk = Math.max(
      1 - clamp01((finalDistance - TAG_RANGE) / 34),
      1 - clamp01((pathDistance - TAG_RANGE) / 26),
      1 - clamp01((threatToCandidateDistance - TAG_RANGE) / 24),
    );
    threatScore = finalDistance * 1.45 + pathDistance * 0.95 - tagRisk * 145;
  }

  return threatScore + speedValue - routePenalty - boundaryPenalty - tractionPenalty - crowdPenalty - turnPenalty;
}

function chooseRunnerPlan(car, facts, config, personality) {
  let best = null;
  let bestScore = -Infinity;
  for (const candidate of makeRunnerCandidatePoints(car, facts, config)) {
    const score = scoreRunnerCandidate(candidate, facts, config, personality);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  if (best?.label === "reverse_orbit") car.ai.lateralSign *= -1;
  return {
    point: (best?.point ?? openSpacePoint(car, facts, new THREE.Vector3())).clone(),
    label: best?.label ?? "fallback",
    score: bestScore,
  };
}

function strategicLanePoint(car, facts, config, personality, out = new THREE.Vector3()) {
  const pos = facts.position;
  const threatPos = facts.threat ? carPosition(facts.threat.car, tmpVec3B) : null;
  const inward = inwardDirectionFromPoint(pos, tmpVec3C);
  const awayFromThreat = threatPos
    ? tmpVec3D.copy(pos).sub(threatPos)
    : tmpVec3D.copy(inward).multiplyScalar(-1);
  awayFromThreat.y = 0;
  safeNormalize(awayFromThreat, facts.forward);
  const tangent = flatPerpendicular(inward, car.ai?.lateralSign || 1, tmpVec3E);
  const threatLateral = flatPerpendicular(awayFromThreat, car.ai?.lateralSign || 1, tmpVec3F);
  const radius = Math.hypot(pos.x, pos.z);
  const boundary = clamp01((radius - arenaLimit(20)) / 20);
  const candidates = [
    { dir: facts.forward.clone(), weight: 24, label: "carry_speed" },
    { dir: tangent.clone(), weight: 34, label: "orbit" },
    { dir: tangent.clone().multiplyScalar(-1), weight: 30, label: "reverse_orbit" },
    { dir: awayFromThreat.clone().addScaledVector(threatLateral, 0.7).normalize(), weight: 38, label: "escape_cut" },
    { dir: awayFromThreat.clone().addScaledVector(threatLateral, -0.7).normalize(), weight: 38, label: "escape_cross" },
    { dir: inward.clone(), weight: 28 + boundary * 18, label: "recenter" },
  ];

  let best = null;
  let bestScore = -Infinity;
  for (const candidate of candidates) {
    const point = tmpVec3D.copy(pos)
      .addScaledVector(candidate.dir, candidate.weight)
      .addScaledVector(inward, boundary * 22)
      .addScaledVector(facts.crowd.escape, facts.crowd.pressure * 20);
    clampArenaPoint(point, 14);

    const forwardDot = candidate.dir.dot(facts.forward);
    const boundaryPenalty = clamp01((Math.hypot(point.x, point.z) - arenaLimit(8)) / 8) * 35;
    const crowdPenalty = pointCrowdingScore(point, facts) * 24 * personality.space;
    const speedValue = Math.max(0, forwardDot) * 12;
    let threatValue = 0;
    let threatPathPenalty = 0;
    if (threatPos) {
      const threatDistance = Math.hypot(point.x - threatPos.x, point.z - threatPos.z);
      const currentThreatDistance = Math.hypot(pos.x - threatPos.x, pos.z - threatPos.z);
      const pathDistance = segmentDistanceToPoint(pos, point, threatPos);
      const towardThreat = candidate.dir.dot(tmpVec3A.copy(threatPos).sub(pos).setY(0).normalize());
      threatValue += THREE.MathUtils.clamp(threatDistance - currentThreatDistance, -18, 28) * 1.2;
      threatPathPenalty += (1 - clamp01((pathDistance - TAG_RANGE) / 24)) * 56;
      threatPathPenalty += Math.max(0, towardThreat) * 34;
    }

    const routed = featureRoutePoint(pos, point, facts, config, tmpVec3E);
    const routePenalty = Math.sqrt(routed.distanceToSquared(point)) * 0.55;
    const score = threatValue + speedValue - boundaryPenalty - crowdPenalty - threatPathPenalty - routePenalty;
    if (score > bestScore) {
      bestScore = score;
      best = { point: routed.clone(), label: candidate.label };
    }
  }

  if (best?.label === "reverse_orbit") car.ai.lateralSign *= -1;
  return out.copy(best?.point ?? openSpacePoint(car, facts, out));
}

function chaseInterceptPoint(target, facts, config, out = new THREE.Vector3()) {
  const targetPos = carPosition(target.car, tmpVec3A);
  const targetVelocity = carVelocity(target.car, tmpVec3B);
  targetVelocity.y = 0;
  const lead = THREE.MathUtils.clamp(
    target.distance / (30 + facts.speed * 0.45 + target.speed * 0.65),
    0.12,
    0.75 + finite(config.planningSkill, 1) * 0.34,
  );
  const predicted = tmpVec3C.copy(targetPos).addScaledVector(targetVelocity, lead);
  const targetForward = targetVelocity.lengthSq() > EPS
    ? tmpVec3D.copy(targetVelocity).normalize()
    : flatForward(target.car, tmpVec3D);
  const inward = inwardDirectionFromPoint(predicted, tmpVec3E);
  const side = Math.sign(tmpVec3F.copy(predicted).sub(facts.position).cross(targetForward).y) || 1;
  const lateral = flatPerpendicular(targetForward, side, tmpVec3F);
  const radius = Math.hypot(predicted.x, predicted.z);
  const boundary = clamp01((radius - arenaLimit(14)) / 14);

  const candidates = [
    { point: predicted.clone(), label: "lead" },
    { point: predicted.clone().addScaledVector(targetForward, 8 + target.speed * 0.28), label: "ahead" },
    { point: predicted.clone().addScaledVector(lateral, 10).addScaledVector(targetForward, 5), label: "side_cut" },
    { point: predicted.clone().addScaledVector(lateral, -10).addScaledVector(targetForward, 5), label: "cross_cut" },
    { point: predicted.clone().addScaledVector(inward, 8 + boundary * 18).addScaledVector(targetForward, 9 + boundary * 8), label: "inside_cut" },
  ];

  let best = null;
  let bestScore = -Infinity;
  for (const candidate of candidates) {
    const point = candidate.point;
    clampArenaPoint(point, 6);

    const fromSelf = tmpVec3A.copy(point).sub(facts.position);
    fromSelf.y = 0;
    const distance = fromSelf.length();
    safeNormalize(fromSelf, facts.forward);
    const alignment = fromSelf.dot(facts.forward);
    const targetDistance = Math.hypot(point.x - predicted.x, point.z - predicted.z);
    const sameLaneBehind = candidate.label === "lead" && target.closing < -2 && target.distance > 22;
    const insideValue = candidate.label === "inside_cut" ? boundary * 22 : 0;
    const angleCost = (1 - alignment) * THREE.MathUtils.lerp(16, 7, clamp01(finite(config.steeringSkill, 1) / 1.35));
    const score = insideValue - distance * 0.22 - targetDistance * 0.4 - angleCost - (sameLaneBehind ? 28 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = point;
    }
  }
  return out.copy(best ?? predicted);
}

function forecastTarget(entry, facts, config, out = new THREE.Vector3()) {
  return chaseInterceptPoint(entry, facts, config, out);
}

function tagTargetScore(car, target, facts, config, personality) {
  if (target.immunity > 0) return -10000 - target.immunity * 50;
  const distanceScore = 72 * (1 - clamp01((target.distance - TAG_RANGE) / 58));
  const angleScore = 18 * (1 - clamp01(Math.abs(target.angle) / Math.PI));
  const closingScore = THREE.MathUtils.clamp(target.closing, -18, 24) * 0.7;
  const easeScore = (1 - target.mobility) * 42 + (target.airborne ? 8 : 0);
  const closeFinish = target.distance < 22
    ? (1 - clamp01((target.distance - TAG_RANGE) / 18)) ** 2 * 170
    : 0;
  const immediateTouch = target.distance < TAG_RANGE + 4 ? 220 : 0;
  const rankGain = Math.max(0, facts.selfRank - target.rank);
  const scoreGap = Math.max(0, target.scoreGap);
  const rankScore = (rankGain * 10 + scoreGap * 0.22 + (target.rank === 1 ? 16 : 0)) * finite(config.rankAwareness) * personality.rank;
  const urgency = 34 + Math.max(0, scoreGap) * 0.08;
  const crowdCost = facts.crowd.pressure * 18 * personality.space;
  const targetStickiness = target.id === car.ai.targetId && target.distance < 44 ? 5 : 0;
  return (
    urgency +
    distanceScore * finite(config.aggression) * personality.chase +
    angleScore +
    closingScore +
    easeScore +
    closeFinish +
    immediateTouch +
    rankScore +
    targetStickiness -
    crowdCost
  );
}

function chooseTagJob(car, facts, config, personality) {
  let best = null;
  let bestPlan = null;
  let bestScore = -Infinity;
  for (const target of facts.runners) {
    const plan = chooseChasePlan(target, facts, config);
    const score = tagTargetScore(car, target, facts, config, personality) + plan.score;
    if (score > bestScore) {
      bestScore = score;
      best = target;
      bestPlan = plan;
    }
  }
  if (!best) {
    return { type: "roam", point: openSpacePoint(car, facts), target: null, score: 0, throttle: 1, desiredSpeed: 32 };
  }
  return {
    type: best.distance < 20 ? "tag_direct" : "tag_intercept",
    point: bestPlan?.point ?? forecastTarget(best, facts, config, new THREE.Vector3()),
    target: best,
    score: bestScore,
    plan: bestPlan?.label ?? "fallback",
    rolloutScore: bestPlan?.score ?? 0,
    throttle: 1,
    desiredSpeed: best.distance < 12 ? 30 : 42,
    urgency: clamp01(bestScore / 130),
  };
}

function baitPointThroughRival(facts, out = new THREE.Vector3()) {
  if (!facts.threat || facts.threat.distance > 42 || facts.threatRisk < 0.28) return null;
  const candidates = facts.others
    .filter((entry) => !entry.car.isIt)
    .sort((a, b) => {
      const av = Math.max(0, a.scoreGap) + (a.rank === 1 ? 28 : 0) - a.distance * 0.18;
      const bv = Math.max(0, b.scoreGap) + (b.rank === 1 ? 28 : 0) - b.distance * 0.18;
      return bv - av;
    });
  const rival = candidates[0];
  if (!rival) return null;
  out.copy(carPosition(rival.car, out));
  const awayFromThreat = tmpVec3A.copy(out).sub(carPosition(facts.threat.car, tmpVec3B));
  awayFromThreat.y = 0;
  safeNormalize(awayFromThreat, facts.forward);
  out.addScaledVector(awayFromThreat, 10);
  return clampArenaPoint(out, 12);
}

function chooseRunnerJob(car, facts, config, personality) {
  const open = openSpacePoint(car, facts, new THREE.Vector3());
  const plan = chooseRunnerPlan(car, facts, config, personality);
  const bait = baitPointThroughRival(facts, new THREE.Vector3());
  const rankedBehind = facts.others.some((entry) => entry.scoreGap < -8);
  const threatDistance = facts.threat?.distance ?? Infinity;
  const threatClosing = facts.threat?.closing ?? 0;
  const predictedSelf = tmpVec3A.copy(facts.position).addScaledVector(facts.velocity, 0.65);
  predictedSelf.y = 0;
  const predictedThreat = facts.threat
    ? predictedPosition(facts.threat.car, 0.65, tmpVec3B)
    : null;
  const predictedThreatDistance = predictedThreat
    ? Math.hypot(predictedSelf.x - predictedThreat.x, predictedSelf.z - predictedThreat.z)
    : Infinity;
  const taggerExclusion = facts.threat && (
    threatDistance < 46 ||
    predictedThreatDistance < 34 ||
    (threatDistance < 62 && threatClosing > 1.5)
  );
  const canBait = bait && facts.crowd.pressure < 0.62 && finite(config.rankAwareness) * personality.rank > 0.55;
  if (canBait && facts.threatRisk > 0.32 && !taggerExclusion) {
    return {
      type: "bait_rival",
      point: bait,
      threat: facts.threat,
      score: 62 * facts.threatRisk + finite(config.rankAwareness) * 22,
      plan: "bait_rival",
      rolloutScore: plan.score,
      throttle: 1,
      desiredSpeed: 36,
      urgency: facts.threatRisk,
    };
  }
  if (taggerExclusion || facts.threatRisk > 0.18 || facts.crowd.pressure > 0.18) {
    return {
      type: taggerExclusion || facts.crowd.pressure > 0.26 ? "find_space" : "flee",
      point: plan.score > -Infinity ? plan.point : open,
      threat: facts.threat,
      score: 70 * facts.threatRisk + facts.crowd.pressure * 30 + (taggerExclusion ? 48 : 0) + plan.score * 0.18,
      plan: plan.label,
      rolloutScore: plan.score,
      throttle: 1,
      desiredSpeed: taggerExclusion || facts.threatRisk > 0.5 ? 44 : 38,
      urgency: Math.max(taggerExclusion ? 0.7 : 0, facts.threatRisk, facts.crowd.pressure),
    };
  }

  const point = plan.score > -Infinity ? plan.point : strategicLanePoint(car, facts, config, personality, tmpVec3A);
  if (facts.crowd.pressure > 0.08) point.addScaledVector(facts.crowd.escape, 12);
  if (rankedBehind && facts.threat?.distance > 46) point.lerp(CENTER, 0.12);
  return {
    type: "position",
    point: clampArenaPoint(point, 14).clone(),
    threat: facts.threat,
    score: 20 + plan.score * 0.12,
    plan: plan.label,
    rolloutScore: plan.score,
    throttle: 1,
    desiredSpeed: 32,
    urgency: 0.12,
  };
}

function shouldRecover(facts) {
  if (facts.upDot < 0.24) return true;
  if (Math.abs(facts.forwardY) > 0.78 && Math.abs(facts.upDot) < 0.56) return true;
  return facts.wheels <= 1 && facts.upDot < 0.46;
}

function shouldUnstick(facts, stuckTimer) {
  if (shouldRecover(facts)) return false;
  if (facts.speed > 3.2) return false;
  if (stuckTimer > 0.72) return true;
  return facts.wheels >= 1 && facts.mobility < 0.22 && facts.speed < 1.8;
}

function chooseJob(car, facts, config, personality, canRight, rng, dt) {
  if (shouldRecover(facts)) {
    return {
      type: "recover",
      point: openSpacePoint(car, facts, new THREE.Vector3()),
      score: 999,
      throttle: facts.upDot < -0.12 ? 0 : 0.35,
      jump: canRight && facts.upDot < 0.18 && car.ai.jumpCooldown <= 0,
      urgency: 1,
    };
  }
  if (shouldUnstick(facts, car.ai.stuckTimer)) {
    return {
      type: "unstick",
      point: openSpacePoint(car, facts, new THREE.Vector3()),
      score: 600 + car.ai.stuckTimer * 80,
      throttle: 1,
      urgency: 1,
    };
  }
  return car.isIt
    ? chooseTagJob(car, facts, config, personality)
    : chooseRunnerJob(car, facts, config, personality);
}

function localDirectionToPoint(car, point, fallback) {
  const direction = tmpVec3A.copy(point).sub(carPosition(car, tmpVec3B));
  direction.y = 0;
  safeNormalize(direction, fallback);
  return direction.applyQuaternion(carQuaternion(car).invert());
}

function alignmentToPoint(car, point) {
  const toPoint = tmpVec3A.copy(point).sub(carPosition(car, tmpVec3B));
  toPoint.y = 0;
  safeNormalize(toPoint, flatForward(car, tmpVec3C));
  return toPoint.dot(flatForward(car, tmpVec3D));
}

function turnStabilityThrottle(throttle, steer, facts) {
  const speedRisk = clamp01((facts.speed - 26) / 22);
  const steerRisk = clamp01((Math.abs(steer) - 0.72) / 0.28);
  const tipRisk = clamp01((0.9 - facts.upDot) / 0.34);
  const grounded = facts.wheels >= 2 ? 1 : 0.35;
  const risk = Math.max(speedRisk * steerRisk * grounded, tipRisk * steerRisk);
  return throttle * THREE.MathUtils.lerp(1, 0.64, risk);
}

function boundaryTractionThrottle(throttle, aimPoint, facts) {
  const risk = boundaryPhysicsRisk(facts.position, aimPoint, facts);
  if (risk <= 0) return throttle;
  return throttle * THREE.MathUtils.lerp(1, 0.46, risk);
}

function speedThrottle(throttle, desiredSpeed, steer, facts) {
  const target = finite(desiredSpeed, 34);
  const speedError = target - facts.speed;
  if (speedError > 2) return throttle;
  if (speedError > -4) return throttle * THREE.MathUtils.lerp(0.72, 1, clamp01(speedError / 2 + 1));
  if (Math.abs(steer) > 0.7) return throttle * 0.42;
  return throttle * 0.68;
}

function reversePursuitInput(car, local, objectiveDistance, facts, job) {
  if (!job.type?.startsWith?.("tag")) return false;
  if (objectiveDistance > 18 || local.z > -0.15 || facts.speed > 14 || facts.wheels < 2 || facts.upDot < 0.6) return false;
  const rearAngle = Math.atan2(local.x, -local.z);
  car.input.steer = THREE.MathUtils.clamp(-rearAngle / 0.95, -1, 1);
  car.input.throttle = objectiveDistance < TAG_RANGE + 2.5 ? -0.62 : -0.88;
  car.input.boostQueued = false;
  return true;
}

function aimPointForJob(car, job, facts, config, out = new THREE.Vector3()) {
  out.copy(job.point ?? facts.position);
  if (job.target && job.type.startsWith("tag")) {
    if (!job.point) chaseInterceptPoint(job.target, facts, config, out);
    return featureRoutePoint(facts.position, out, facts, config, out);
  }
  if ((job.type === "flee" || job.type === "find_space") && facts.threat) {
    return featureRoutePoint(facts.position, out, facts, config, out);
  }
  return featureRoutePoint(facts.position, out, facts, config, out);
}

function shouldDodgeThreat(car, facts, config) {
  car.ai.dodgeWindow = null;
  if (car.isIt || !facts.threat) return false;
  if (facts.wheels < 3 || facts.upDot < 0.72 || car.ai.jumpCooldown > 0) return false;
  const distance = facts.threat.distance;
  if (distance < 5.5 || distance > 24) return false;
  const threatPosition = carPosition(facts.threat.car, tmpVec3C);
  const threatToSelf = tmpVec3D.copy(facts.position).sub(threatPosition);
  threatToSelf.y = 0;
  safeNormalize(threatToSelf, facts.forward);
  const approachSpeed = carVelocity(facts.threat.car, tmpVec3E).sub(facts.velocity).dot(threatToSelf);
  if (approachSpeed < THREE.MathUtils.lerp(9, 4.5, clamp01(finite(config.recoverySkill) / 1.35))) return false;

  const horizon = THREE.MathUtils.clamp(distance / Math.max(10, facts.threat.speed + facts.speed * 0.35), 0.18, 0.62);
  const selfFuture = tmpVec3F.copy(facts.position).addScaledVector(facts.velocity, horizon * 0.55);
  selfFuture.y = 0;
  const threatFuture = predictFlatCarPosition(facts.threat.car, horizon, tmpVec3B);
  const pathDistance = segmentDistanceToPoint(threatPosition, threatFuture, selfFuture);
  const futureDistance = Math.hypot(selfFuture.x - threatFuture.x, selfFuture.z - threatFuture.z);
  const dodgeWindow = Math.min(pathDistance, futureDistance);
  car.ai.dodgeWindow = dodgeWindow;
  car.ai.dodgeApproachSpeed = approachSpeed;
  return dodgeWindow < TAG_RANGE + 4.4;
}

function applyThreatDodge(car, facts) {
  const threatVelocity = carVelocity(facts.threat.car, tmpVec3A);
  threatVelocity.y = 0;
  const threatLine = threatVelocity.lengthSq() > EPS
    ? threatVelocity.normalize()
    : tmpVec3B.copy(facts.position).sub(carPosition(facts.threat.car, tmpVec3C)).setY(0).normalize();
  const side = Math.sign(facts.forward.clone().cross(threatLine).y) || car.ai.lateralSign || 1;
  car.ai.lateralSign = side;
  car.input.jumpQueued = true;
  car.input.throttle = 1;
  car.input.steer = THREE.MathUtils.clamp(car.input.steer + side * 0.5, -1, 1);
  car.ai.jumpCooldown = 1.15;
}

function driveUnstick(car, job, facts, config, rng) {
  const ai = car.ai;
  if (ai.unstickTimer <= 0) {
    ai.unstickTimer = THREE.MathUtils.lerp(1.35, 0.86, clamp01(finite(config.recoverySkill) / 1.35));
    const local = localDirectionToPoint(car, job.point ?? CENTER, facts.forward);
    const desiredSteer = Math.sign(Math.atan2(local.x, local.z)) || ai.lateralSign || 1;
    ai.unstickSteer = rng() < 0.2 ? -desiredSteer : desiredSteer;
    ai.lateralSign = ai.unstickSteer;
  }

  const total = THREE.MathUtils.lerp(1.35, 0.86, clamp01(finite(config.recoverySkill) / 1.35));
  const remainingRatio = clamp01(ai.unstickTimer / Math.max(0.001, total));
  const reversing = remainingRatio > 0.48;
  car.input.steer = ai.unstickSteer;
  car.input.throttle = reversing ? -0.78 : 1;
  car.input.airRoll = 0;

  if (
    !reversing &&
    facts.speed < 7 &&
    finite(car.boostCooldownRemaining) <= 0 &&
    rng() < 0.16 + clamp01(finite(config.boostSkill) / 1.4) * 0.28
  ) {
    car.input.boostQueued = true;
  }

  if (
    !reversing &&
    facts.wheels >= 2 &&
    facts.upDot > 0.58 &&
    facts.speed < 1.2 &&
    ai.stuckTimer > 2.4 &&
    ai.jumpCooldown <= 0
  ) {
    car.input.jumpQueued = true;
    ai.jumpCooldown = 2.2;
  }
}

function driveToJob(car, job, facts, config, personality, rng) {
  car.input.jumpQueued = false;
  car.input.boostQueued = false;
  car.input.boost = false;
  car.input.airRoll = 0;

  if (job.type === "unstick") {
    driveUnstick(car, job, facts, config, rng);
    return;
  }

  const aimPoint = aimPointForJob(car, job, facts, config, tmpVec3D);
  const trajectoryBypass = featureTrajectoryBypass(facts, config, tmpVec3F);
  if (trajectoryBypass) aimPoint.lerp(trajectoryBypass, 0.68);
  const local = localDirectionToPoint(car, aimPoint, facts.forward);
  const rawSteer = THREE.MathUtils.clamp(Math.atan2(local.x, local.z) / 1.08, -1, 1);
  const steeringSkill = clamp01(finite(config.steeringSkill) / 1.3);
  const steerNoise = finite(config.noise) * (1 - steeringSkill * 0.45) * (rng() - 0.5) * 2;
  const steer = THREE.MathUtils.clamp(rawSteer + steerNoise, -1, 1);
  const alignment = alignmentToPoint(car, aimPoint);
  const hardTurn = Math.abs(steer);
  let throttle = speedThrottle(finite(job.throttle, 1), job.desiredSpeed, steer, facts);
  throttle = turnStabilityThrottle(throttle, steer, facts);
  throttle = boundaryTractionThrottle(throttle, aimPoint, facts);
  if (job.type === "recover") throttle = job.throttle;

  car.input.steer = steer;
  car.input.throttle = THREE.MathUtils.clamp(throttle, -1, 1);
  if (reversePursuitInput(car, local, facts.position.distanceTo(aimPoint), facts, job)) return;

  if (job.type === "recover") {
    if (job.jump) {
      car.input.jumpQueued = true;
      car.ai.jumpCooldown = THREE.MathUtils.lerp(1.25, 0.55, clamp01(finite(config.recoverySkill) / 1.35));
    }
    if (facts.upDot < 0.42) {
      car.input.steer = car.ai.lateralSign;
      car.input.airRoll = -car.ai.lateralSign * clamp01(finite(config.recoverySkill));
    }
    return;
  }

  const boostReady = finite(car.boostCooldownRemaining) <= 0;
  const boostSkill = finite(config.boostSkill) * personality.risk;
  const canBoost =
    boostReady &&
    alignment > THREE.MathUtils.lerp(0.74, 0.48, clamp01(boostSkill / 1.4)) &&
    hardTurn < 0.54 &&
    facts.speed > 7 &&
    facts.crowd.pressure < 0.62;
  const boostNeed = job.type.startsWith("tag")
    ? 0.34 + finite(job.urgency) * 0.42
    : job.type === "flee" || job.type === "find_space"
      ? finite(job.urgency) * 0.48
      : 0.12;
  if (canBoost && rng() < clamp01(boostNeed * boostSkill)) car.input.boostQueued = true;
  if (shouldDodgeThreat(car, facts, config)) applyThreatDodge(car, facts);
}

function estimateTimeToLand(car) {
  if (finite(car.vehicle?.numWheelsOnGround) >= 2) return 0;
  const y = finite(car.body?.position?.y);
  const vy = finite(car.body?.velocity?.y);
  const a = -4.905;
  const b = vy;
  const c = Math.max(0, y - 1);
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return 0.8;
  return THREE.MathUtils.clamp((-b - Math.sqrt(discriminant)) / (2 * a), 0.12, 1.6);
}

function aerialRighting(car, job, facts, config, rng) {
  const skill = clamp01(finite(config.recoverySkill) / 1.35);
  const timeToLand = estimateTimeToLand(car);
  const landingSoon = clamp01((0.75 - timeToLand) / 0.75);
  const point = job.point ?? openSpacePoint(car, facts, tmpVec3A);
  const desiredForward = tmpVec3A.copy(point).sub(facts.position);
  desiredForward.y = 0;
  safeNormalize(desiredForward, facts.forward);

  const desiredUp = tmpVec3B.set(0, 1, 0);

  const inverse = carQuaternion(car).invert();
  const localForward = tmpVec3C.copy(desiredForward).applyQuaternion(inverse);
  const localUp = tmpVec3D.copy(desiredUp).applyQuaternion(inverse);
  const yaw = THREE.MathUtils.clamp(Math.atan2(localForward.x, localForward.z) / 1.2, -1, 1);
  const pitchToUpright = THREE.MathUtils.clamp(-Math.atan2(localUp.z, localUp.y) / 1.05, -1, 1);
  const rollToUpright = THREE.MathUtils.clamp(Math.atan2(localUp.x, localUp.y) / 1.05, -1, 1);
  const uprightNeed = clamp01((0.92 - facts.upDot) / 1.12);
  const correction = Math.max(landingSoon, uprightNeed) * THREE.MathUtils.lerp(0.55, 1, skill);
  const noise = finite(config.noise) * (1 - skill) * (rng() - 0.5);

  car.input.steer = THREE.MathUtils.clamp(yaw * 0.42 + noise, -1, 1);
  car.input.throttle = THREE.MathUtils.clamp(pitchToUpright * correction, -1, 1);
  car.input.airRoll = THREE.MathUtils.clamp(rollToUpright * correction, -1, 1);
  car.input.boostQueued = false;
}

function shouldUseAerialRighting(facts, job) {
  if (job.type === "unstick") return false;
  if (job.type === "recover") return facts.upDot < 0.48 || facts.wheels <= 1;
  if (facts.wheels <= 0) return true;
  return facts.wheels < 2 && facts.position.y > 1.8 && facts.speed > 3.5;
}

function applyMistake(car, ai, config, rng, dt) {
  ai.mistakeTimer = Math.max(0, finite(ai.mistakeTimer) - dt);
  if (ai.mistakeTimer <= 0 && rng() < finite(config.mistakeChance) * dt) {
    ai.mistakeTimer = 0.16 + rng() * 0.28;
    ai.mistakeSteer = rng() < 0.5 ? -1 : 1;
  }
  if (ai.mistakeTimer > 0) {
    car.input.steer = THREE.MathUtils.clamp(car.input.steer + ai.mistakeSteer * 0.22, -1, 1);
    car.input.throttle *= 0.88;
  }
}

function updateDebugFields(car, job, facts) {
  const ai = car.ai;
  ai.intent = job;
  ai.targetId = job.target?.id ?? null;
  ai.mode = job.type;
  ai.plan = job.plan ?? null;
  ai.rolloutScore = finite(job.rolloutScore, 0);
  ai.modeTargetId = ai.targetId;
  ai.modeTimer = ai.decisionTimer;
  ai.lastAimAngle = car.input.steer * 1.1;
  ai.lastThreatDistance = facts.threat?.distance ?? Infinity;
  ai.lastTargetDistance = job.target?.distance ?? Infinity;
  ai.lastObjectiveDistance = job.point ? facts.position.distanceTo(job.point) : Infinity;
  ai.pressure = car.isIt ? clamp01(1 - (job.target?.distance ?? 80) / 72) : facts.threatRisk;
  if (job.point) {
    ai.objective.copy(job.point);
    ai.tacticalPoint.copy(job.point);
    ai.desired.copy(job.point).sub(facts.position);
    if (ai.desired.lengthSq() > EPS) ai.desired.normalize();
  } else {
    ai.desired.set(0, 0, 0);
  }
}

export function updateAiCar(car, dt, {
  gameState,
  arenaContactForPoint,
  shouldRightWithJump,
  rng = Math.random,
  difficulty = "medium",
  arenaId = "orange",
} = {}) {
  void arenaContactForPoint;
  void arenaId;
  if (!car || !gameState) return;

  const safeDt = THREE.MathUtils.clamp(finite(dt), 0, 0.25);
  const config = difficultyConfig(difficulty);
  const personality = ensureMind(car, rng);
  const ai = car.ai;

  ai.decisionTimer = Math.max(0, finite(ai.decisionTimer) - safeDt);
  ai.modeTimer = Math.max(0, finite(ai.modeTimer) - safeDt);
  ai.jumpCooldown = Math.max(0, finite(ai.jumpCooldown) - safeDt);
  ai.unstickTimer = Math.max(0, finite(ai.unstickTimer) - safeDt);
  ai.lateralTimer = Math.max(0, finite(ai.lateralTimer) - safeDt);
  if (ai.lateralTimer <= 0) {
    ai.lateralSign *= -1;
    ai.lateralTimer = 1.2 + rng() * 2.2;
  }

  car.input.boost = false;
  car.input.boostQueued = false;
  car.input.jumpQueued = false;

  if (gameState.phase !== "playing") {
    car.input.throttle = 0;
    car.input.steer = 0;
    car.input.airRoll = 0;
    ai.intent = null;
    ai.targetId = null;
    return;
  }

  const facts = observe(car, gameState, config, rng, arenaId);
  updateMotionAwareness(car, ai, facts, safeDt);

  let canRight = false;
  if (typeof shouldRightWithJump === "function") {
    try {
      canRight = Boolean(shouldRightWithJump(car));
    } catch {
      canRight = false;
    }
  }

  const role = car.isIt ? "tagger" : "runner";
  const recoveryNeeded = shouldRecover(facts);
  const unstickNeeded = shouldUnstick(facts, ai.stuckTimer);
  const recoveryFinished = ai.intent?.type === "recover" && !recoveryNeeded && facts.upDot > 0.68 && facts.wheels >= 2;
  const unstickFinished = ai.intent?.type === "unstick" && !unstickNeeded && ai.unstickTimer <= 0;
  if (ai.decisionTimer <= 0 || !ai.intent || ai.intentRole !== role || recoveryNeeded || unstickNeeded || recoveryFinished || unstickFinished) {
    const nextJob = chooseJob(car, facts, config, personality, canRight, rng, safeDt);
    ai.intent = nextJob;
    ai.intentRole = role;
    ai.decisionTimer = Math.max(0.04, finite(config.thinkInterval) + finite(config.reactionDelay) * 0.25);
  }

  const job = ai.intent ?? chooseJob(car, facts, config, personality, canRight, rng, safeDt);
  driveToJob(car, job, facts, config, personality, rng);
  if (shouldUseAerialRighting(facts, job)) aerialRighting(car, job, facts, config, rng);
  applyMistake(car, ai, config, rng, safeDt);
  updateDebugFields(car, job, facts);
}
