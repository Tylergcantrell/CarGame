import * as THREE from "three";
import { arenaDefinitions, worldSpec } from "./arena.js";
import { vehicleTuning } from "./vehicle-config.js";

const EPS = 1e-6;
const TAG_RANGE = 6.4;
const WORLD_UP = new THREE.Vector3(0, 1, 0);

const tmpVec3A = new THREE.Vector3();
const tmpVec3B = new THREE.Vector3();
const tmpVec3C = new THREE.Vector3();
const tmpVec3D = new THREE.Vector3();
const tmpVec3E = new THREE.Vector3();
const tmpVec3F = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const featureDescriptorCache = new Map();
const MAX_TACTIC_MEMORY = 18;

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
  { key: "hunter", weight: 1.1, chase: 1.18, survive: 0.9, rank: 1.05, space: 0.95, risk: 1.08 },
  { key: "survivor", weight: 1.05, chase: 0.9, survive: 1.2, rank: 0.9, space: 1.15, risk: 0.82 },
  { key: "opportunist", weight: 1.1, chase: 1.02, survive: 1, rank: 1.25, space: 1, risk: 0.96 },
  { key: "baiter", weight: 0.8, chase: 0.92, survive: 1.12, rank: 1.18, space: 1.08, risk: 0.92 },
  { key: "drifter", weight: 0.75, chase: 0.98, survive: 1.05, rank: 0.9, space: 1.2, risk: 1.06 },
  { key: "scrambler", weight: 0.75, chase: 1.04, survive: 1.08, rank: 0.86, space: 1.12, risk: 1.1 },
  { key: "bully", weight: 0.9, chase: 1.1, survive: 0.94, rank: 1.18, space: 0.9, risk: 1.12 },
  { key: "skater", weight: 0.9, chase: 0.96, survive: 1.06, rank: 0.92, space: 1.24, risk: 1.04 },
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

function projectOntoPlane(vec, normal, fallback = null) {
  vec.addScaledVector(normal, -vec.dot(normal));
  return safeNormalize(vec, fallback);
}

function tangentDirection(from, to, normal, fallback, out = new THREE.Vector3()) {
  out.copy(to).sub(from);
  return projectOntoPlane(out, normal, fallback);
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
  ai.unstickTimer = finite(ai.unstickTimer);
  ai.unstickSteer = finite(ai.unstickSteer, 1);
  ai.mistakeTimer = finite(ai.mistakeTimer);
  ai.mistakeSteer = finite(ai.mistakeSteer);
  ai.lateralSign = ai.lateralSign === -1 ? -1 : 1;
  ai.lateralTimer = finite(ai.lateralTimer, 1 + rng() * 2);
  ai.perceptionClock = finite(ai.perceptionClock);
  ai.perceptionSampleClock = finite(ai.perceptionSampleClock);
  ai.memorySampleClock = finite(ai.memorySampleClock);
  ai.finishPressureTargetId ??= null;
  ai.finishPressureTimer = finite(ai.finishPressureTimer);
  ai.finishPressureMinDistance = finite(ai.finishPressureMinDistance, Infinity);
  ai.perceptionHistory ??= [];
  ai.opponentMemory ??= new Map();
  ai.tacticMemory ??= new Map();
  ai.tacticPending ??= null;
  ai.threatDistanceHistory ??= [];
  ai.threatPattern = ai.threatPattern ?? {
    closingRate: 0,
    acceleration: 0,
    volatility: 0,
    minDistance: Infinity,
    samples: 0,
  };
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

function surfaceSpeed(car, surfaceNormal = WORLD_UP) {
  const velocity = carVelocity(car, tmpVec3B);
  velocity.addScaledVector(surfaceNormal, -velocity.dot(surfaceNormal));
  return velocity.length();
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

function forwardOnPlane(car, normal, out = new THREE.Vector3()) {
  out.set(0, 0, 1).applyQuaternion(carQuaternion(car));
  out.addScaledVector(normal, -out.dot(normal));
  if (out.lengthSq() > EPS) return out.normalize();
  out.set(1, 0, 0).applyQuaternion(carQuaternion(car));
  out.addScaledVector(normal, -out.dot(normal));
  if (out.lengthSq() > EPS) return out.normalize();
  return flatForward(car, out);
}

function carUp(car, out = new THREE.Vector3()) {
  return out.set(0, 1, 0).applyQuaternion(carQuaternion(car)).normalize();
}

function localAngularVelocity(car, out = new THREE.Vector3()) {
  out.set(
    finite(car.body?.angularVelocity?.x),
    finite(car.body?.angularVelocity?.y),
    finite(car.body?.angularVelocity?.z),
  );
  return out.applyQuaternion(carQuaternion(car).invert());
}

function arenaLimit(margin = 10) {
  return Math.max(finite(worldSpec?.floorRadius, 68), finite(worldSpec?.outerRadius, 98) - margin);
}

function curveStartRadius() {
  return finite(worldSpec?.floorRadius, 68) - 6;
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

function arenaSurfaceYAt(point) {
  const radius = Math.hypot(point.x, point.z);
  const floorRadius = finite(worldSpec?.floorRadius, 68);
  const curveRadius = Math.max(1, finite(worldSpec?.curveRadius, 30));
  if (radius <= floorRadius) return 0;
  const localX = THREE.MathUtils.clamp(radius - floorRadius, 0, curveRadius);
  const theta = Math.asin(THREE.MathUtils.clamp(localX / curveRadius, 0, 1));
  return curveRadius * (1 - Math.cos(theta));
}

function clampArenaSurfacePoint(point, margin = 10) {
  clampArenaPoint(point, margin);
  point.y = arenaSurfaceYAt(point);
  return point;
}

function surfaceNormalAtPoint(point, out = new THREE.Vector3()) {
  const radius = Math.hypot(point.x, point.z);
  const floorRadius = finite(worldSpec?.floorRadius, 68);
  const curveRadius = Math.max(1, finite(worldSpec?.curveRadius, 30));
  if (radius <= floorRadius || radius <= EPS) return out.set(0, 1, 0);
  const t = clamp01((radius - floorRadius) / curveRadius);
  const angle = Math.asin(t);
  const horizontal = Math.sin(angle);
  const invRadius = 1 / radius;
  return out.set(
    -point.x * invRadius * horizontal,
    Math.cos(angle),
    -point.z * invRadius * horizontal,
  ).normalize();
}

function surfaceContactForPosition(point, resolver, outNormal = new THREE.Vector3()) {
  if (typeof resolver === "function") {
    try {
      const contact = resolver(point);
      if (contact?.normal?.isVector3) {
        return {
          point: contact.point?.isVector3 ? contact.point.clone() : point.clone().addScaledVector(contact.normal, -finite(contact.distance, 0)),
          normal: outNormal.copy(contact.normal).normalize(),
          distance: finite(contact.distance, 0),
        };
      }
    } catch {
      // The geometry fallback is deterministic and enough for AI planning.
    }
  }
  const surfacePoint = point.clone();
  surfacePoint.y = arenaSurfaceYAt(surfacePoint);
  return {
    point: surfacePoint,
    normal: surfaceNormalAtPoint(point, outNormal),
    distance: point.y - surfacePoint.y,
  };
}

function surfaceContactAt(point, facts, outNormal = new THREE.Vector3()) {
  return surfaceContactForPosition(point, facts?.surfaceResolver, outNormal);
}

function projectArenaSurfacePoint(point, facts, margin = 10) {
  clampArenaPoint(point, margin);
  const contact = surfaceContactAt(point, facts, tmpVec3C);
  if (contact.point?.isVector3 && Number.isFinite(contact.point.y)) point.y = contact.point.y;
  else point.y = arenaSurfaceYAt(point);
  return point;
}

function arenaFeatures(arenaId) {
  return (arenaDefinitions[arenaId] ?? arenaDefinitions.orange).mounds ?? [];
}

function arenaFeatureDescriptors(arenaId) {
  const id = arenaDefinitions[arenaId] ? arenaId : "orange";
  if (featureDescriptorCache.has(id)) return featureDescriptorCache.get(id);
  const descriptors = arenaFeatures(id).map((feature) => {
    const width = finite(feature.width, 12);
    const length = finite(feature.length, 12);
    const yaw = finite(feature.yaw);
    const point = new THREE.Vector3(finite(feature.x), 0, finite(feature.z));
    const along = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)).normalize();
    const radius = Math.max(width, length) * 0.55 + 4;
    const heightValue = clamp01((finite(feature.height, 2) - 1) / 6);
    const tacticalHeight = clamp01((finite(feature.height, 2) - 1.2) / 6);
    const broadness = clamp01(Math.max(width, length) / 42);
    const narrowness = clamp01(Math.min(width, length) / Math.max(1, Math.max(width, length)));
    return {
      ...feature,
      point,
      along,
      width,
      length,
      radius,
      clearance: Math.max(width, length) * 0.55 + 12,
      heightValue,
      tacticalHeight,
      blockValue: clamp01(tacticalHeight * 0.62 + broadness * 0.32 + narrowness * 0.16),
      launchValue: clamp01(heightValue * 0.74 + (1 - narrowness) * 0.18),
      bypassValue: clamp01(broadness * 0.58 + (1 - heightValue) * 0.22 + narrowness * 0.2),
      trapRisk: clamp01(heightValue * 0.48 + broadness * 0.24),
    };
  });
  featureDescriptorCache.set(id, descriptors);
  return descriptors;
}

function rankCars(cars) {
  const sorted = [...cars].sort((a, b) => finite(b.score) - finite(a.score));
  const ranks = new Map();
  sorted.forEach((car, index) => ranks.set(car, index + 1));
  return ranks;
}

function mobility(car, surfaceNormal = WORLD_UP) {
  const wheels = finite(car.vehicle?.numWheelsOnGround);
  const upDot = carUp(car, tmpVec3A).dot(surfaceNormal);
  const tangentVelocity = carVelocity(car, tmpVec3B);
  tangentVelocity.addScaledVector(surfaceNormal, -tangentVelocity.dot(surfaceNormal));
  const wheelScore = wheels >= 3 ? 1 : wheels >= 2 ? 0.74 : wheels >= 1 ? 0.36 : 0.12;
  const speedScore = 0.25 + 0.75 * clamp01(tangentVelocity.length() / 30);
  const uprightScore = clamp01((upDot + 0.15) / 1.15);
  return clamp01(wheelScore * 0.5 + speedScore * 0.2 + uprightScore * 0.3);
}

function relativeCar(self, other, ranks, config, rng, arenaContactForPoint, memory = null) {
  const selfPos = carPosition(self, tmpVec3A);
  const otherPos = carPosition(other, tmpVec3B);
  const delta = tmpVec3C.copy(otherPos).sub(selfPos);
  const flatDistance = Math.hypot(delta.x, delta.z);
  const verticalGap = Math.abs(delta.y);
  const contactDistance = Math.hypot(flatDistance, Math.max(0, verticalGap - 1.5) * 1.4);
  const selfContact = surfaceContactForPosition(selfPos, arenaContactForPoint, new THREE.Vector3());
  const selfForward = forwardOnPlane(self, selfContact.normal, tmpVec3D);
  tangentDirection(selfPos, otherPos, selfContact.normal, selfForward, delta);

  const selfVelocity = carVelocity(self, tmpVec3D);
  const otherVelocity = carVelocity(other, tmpVec3A);
  const closing = selfVelocity.sub(otherVelocity).dot(delta);
  const local = delta.applyQuaternion(carQuaternion(self).invert());
  const otherContact = surfaceContactForPosition(otherPos, arenaContactForPoint, new THREE.Vector3());
  const surfaceUpDot = carUp(other, tmpVec3D).dot(otherContact.normal);
  const noise = finite(config.noise) * (rng() - 0.5) * 2;
  return {
    car: other,
    id: other.id,
    rank: ranks.get(other) ?? 99,
    score: finite(other.score),
    scoreGap: finite(other.score) - finite(self.score),
    distance: flatDistance * (1 + noise * 0.1),
    verticalGap,
    contactDistance,
    angle: Math.atan2(local.x, local.z) + noise * 0.25,
    closing,
    speed: surfaceSpeed(other, otherContact.normal),
    mobility: mobility(other, otherContact.normal),
    upDot: surfaceUpDot,
    worldUpDot: carUp(other, tmpVec3D).dot(WORLD_UP),
    surfaceNormal: otherContact.normal,
    surfaceDistance: otherContact.distance,
    surfaceResolver: arenaContactForPoint,
    hypothesisCache: new Map(),
    memory,
    wheels: finite(other.vehicle?.numWheelsOnGround),
    immunity: Math.max(0, finite(other.immunityRemaining)),
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
    if (distance > 24) continue;
    const away = tmpVec3C.copy(pos).sub(otherPos);
    away.y = 0;
    safeNormalize(away, pos.lengthSq() > EPS ? pos : new THREE.Vector3(0, 0, 1));
    const weight = (1 - distance / 24) ** 2;
    escape.addScaledVector(away, weight);
    pressure += weight;
  }
  safeNormalize(escape, pos.lengthSq() > EPS ? pos : new THREE.Vector3(0, 0, 1));
  return { escape, pressure: clamp01(pressure / 1.8), nearest };
}

function observe(car, gameState, config, rng, arenaId, arenaContactForPoint, ai = car.ai) {
  const cars = Array.isArray(gameState.cars) ? gameState.cars.filter(Boolean) : [car];
  const ranks = rankCars(cars);
  const memories = ai?.opponentMemory;
  const others = cars.filter((other) => other !== car).map((other) =>
    relativeCar(car, other, ranks, config, rng, arenaContactForPoint, memories?.get(other.id) ?? null)
  );
  const position = carPosition(car, new THREE.Vector3());
  const velocity = carVelocity(car, new THREE.Vector3());
  const forward = flatForward(car, new THREE.Vector3());
  const up = carUp(car, new THREE.Vector3());
  const contact = surfaceContactForPosition(position, arenaContactForPoint, new THREE.Vector3());
  forwardOnPlane(car, contact.normal, forward);
  const tangentVelocity = velocity.clone().addScaledVector(contact.normal, -velocity.dot(contact.normal));
  const threat = others.find((entry) => entry.car === gameState.itCar) ?? null;
  const crowd = crowdVector(car, others);
  const angularSpeed = Math.hypot(
    finite(car.body?.angularVelocity?.x),
    finite(car.body?.angularVelocity?.y),
    finite(car.body?.angularVelocity?.z),
  );
  const forwardY = tmpVec3A.set(0, 0, 1).applyQuaternion(carQuaternion(car)).y;
  let threatRisk = 0;
  if (threat) {
    const threatPosition = carPosition(threat.car, tmpVec3B);
    const fromThreat = tangentDirection(threatPosition, position, contact.normal, forward, tmpVec3A);
    const approach = carVelocity(threat.car, tmpVec3B).sub(velocity).dot(fromThreat);
    threatRisk = clamp01((30 - threat.contactDistance) / 30 * 0.72 + clamp01(approach / 24) * 0.28);
  }
  return {
    cars,
    ranks,
    others,
    runners: others.filter((entry) => !entry.car.isIt),
    threat,
    crowd,
    position,
    velocity,
    forward,
    speed: tangentVelocity.length(),
    tangentVelocity,
    angularSpeed,
    wheels: finite(car.vehicle?.numWheelsOnGround),
    boostReady: finite(car.boostCooldownRemaining) <= 0,
    jumpReady: finite(car.ai?.jumpCooldown) <= 0,
    upDot: up.dot(WORLD_UP),
    surfaceUpDot: up.dot(contact.normal),
    surfaceNormal: contact.normal,
    surfaceDistance: finite(contact.distance, 0),
    surfaceResolver: arenaContactForPoint,
    forwardY,
    selfRank: ranks.get(car) ?? 99,
    selfScore: finite(car.score),
    timeRemaining: Math.max(0, finite(gameState.timeRemaining, 120)),
    threatRisk,
    arenaId,
    features: arenaFeatureDescriptors(arenaId),
  };
}

function snapshotCar(car) {
  return {
    id: car.id,
    slot: car.slot,
    isIt: Boolean(car.isIt),
    score: finite(car.score),
    immunityRemaining: finite(car.immunityRemaining),
    boostCooldownRemaining: finite(car.boostCooldownRemaining),
    body: {
      position: carPosition(car, new THREE.Vector3()),
      velocity: carVelocity(car, new THREE.Vector3()),
      angularVelocity: new THREE.Vector3(
        finite(car.body?.angularVelocity?.x),
        finite(car.body?.angularVelocity?.y),
        finite(car.body?.angularVelocity?.z),
      ),
      quaternion: carQuaternion(car).clone(),
    },
    vehicle: {
      numWheelsOnGround: finite(car.vehicle?.numWheelsOnGround),
    },
  };
}

function rememberPerception(ai, gameState, now) {
  const cars = Array.isArray(gameState.cars) ? gameState.cars.filter(Boolean) : [];
  ai.perceptionHistory.push({
    time: now,
    phase: gameState.phase,
    timeRemaining: finite(gameState.timeRemaining, 120),
    itId: gameState.itCar?.id ?? null,
    cars: cars.map(snapshotCar),
  });
  while (ai.perceptionHistory.length > 1 && now - ai.perceptionHistory[0].time > 0.7) {
    ai.perceptionHistory.shift();
  }
}

function perceivedGameState(car, gameState, ai, config) {
  const delay = Math.max(0, finite(config.reactionDelay));
  if (delay <= 0.001 || !ai.perceptionHistory.length) return gameState;
  const targetTime = ai.perceptionClock - delay;
  let snapshot = ai.perceptionHistory[0];
  for (const entry of ai.perceptionHistory) {
    if (entry.time <= targetTime) snapshot = entry;
    else break;
  }
  const cars = snapshot.cars.map((entry) => (entry.id === car.id ? car : entry));
  return {
    phase: snapshot.phase,
    cars,
    itCar: cars.find((entry) => entry.id === snapshot.itId) ?? gameState.itCar,
    timeRemaining: snapshot.timeRemaining,
  };
}

function ensureOpponentMemory(ai, id) {
  ai.opponentMemory ??= new Map();
  let memory = ai.opponentMemory.get(id);
  if (!memory) {
    memory = {
      samples: 0,
      wallBias: 0,
      turnBias: 0,
      brakeBias: 0,
      baitBias: 0,
      overcommitBias: 0,
      escapeSideBias: 0,
      lateralJukeBias: 0,
      jumpBias: 0,
      vulnerableBias: 0,
      confidence: 0,
      recentness: 0,
      lastPosition: new THREE.Vector3(),
      lastVelocity: new THREE.Vector3(),
      lastSpeed: 0,
      lastWheels: 4,
    };
    ai.opponentMemory.set(id, memory);
  }
  return memory;
}

function updateOpponentMemory(car, ai, gameState, dt, arenaContactForPoint, arenaId = "orange") {
  const cars = Array.isArray(gameState.cars) ? gameState.cars.filter(Boolean) : [];
  const seen = new Set();
  const alpha = clamp01(dt * 1.8);
  const floorRadius = finite(worldSpec?.floorRadius, 68);
  const curveRadius = Math.max(1, finite(worldSpec?.curveRadius, 30));
  const featureDescriptors = arenaFeatureDescriptors(arenaId);

  for (const other of cars) {
    if (other === car || other.id == null) continue;
    seen.add(other.id);
    const memory = ensureOpponentMemory(ai, other.id);
    const position = carPosition(other, tmpVec3A);
    const contact = surfaceContactForPosition(position, arenaContactForPoint, tmpVec3D);
    const velocity = carVelocity(other, tmpVec3B);
    velocity.addScaledVector(contact.normal, -velocity.dot(contact.normal));
    const speed = velocity.length();
    const radius = Math.hypot(position.x, position.z);
    const wallSample = clamp01((radius - floorRadius + 2) / curveRadius);
    const wheels = finite(other.vehicle?.numWheelsOnGround);
    const upDot = carUp(other, tmpVec3C).dot(contact.normal);
    const vulnerableSample = clamp01(
      (wheels <= 1 ? 0.5 : wheels <= 2 ? 0.25 : 0) +
      (1 - clamp01((upDot + 0.1) / 1.1)) * 0.45 +
      (speed < 6 ? 0.18 : 0)
    );
    const jumpSample = wheels <= 1 && memory.lastWheels >= 3 ? 1 : 0;
    let turnSample = 0;
    let brakeSample = 0;
    let baitSample = 0;
    let overcommitSample = 0;
    let escapeSideSample = 0;
    let lateralJukeSample = 0;
    if (memory.samples > 0 && speed > 4 && memory.lastSpeed > 4) {
      const previous = tmpVec3C.copy(memory.lastVelocity);
      previous.addScaledVector(contact.normal, -previous.dot(contact.normal));
      if (previous.lengthSq() > EPS) {
        previous.normalize();
        const current = tmpVec3A.copy(velocity).normalize();
        turnSample = THREE.MathUtils.clamp(previous.cross(current).dot(contact.normal) * 3.2, -1, 1);
        brakeSample = clamp01((memory.lastSpeed - speed) / Math.max(8, memory.lastSpeed * 0.45));
        if (previous.dot(current) < -0.15) brakeSample = Math.max(brakeSample, 0.65);
      }
    }
    if (speed > 5) {
      const selfPosition = carPosition(car, tmpVec3C);
      const awayFromSelf = tmpVec3F.copy(position).sub(selfPosition);
      projectOntoPlane(awayFromSelf, contact.normal, velocity.lengthSq() > EPS ? velocity : tmpVec3B.set(0, 0, 1));
      const lateralVelocity = tmpVec3A.copy(velocity).addScaledVector(awayFromSelf, -velocity.dot(awayFromSelf));
      const lateralSpeed = lateralVelocity.length();
      if (lateralSpeed > 2.5) {
        escapeSideSample = THREE.MathUtils.clamp(Math.sign(awayFromSelf.clone().cross(lateralVelocity).dot(contact.normal)) * clamp01(lateralSpeed / 22), -1, 1);
        lateralJukeSample = clamp01((lateralSpeed - Math.abs(velocity.dot(awayFromSelf)) * 0.28) / 18);
      }
    }
    if (memory.samples > 0 && speed < Math.max(8, memory.lastSpeed * 0.42) && memory.lastSpeed > 14) {
      for (const feature of featureDescriptors) {
        const featurePoint = feature.point ?? tmpVec3A.set(finite(feature.x), 0, finite(feature.z));
        const dx = position.x - featurePoint.x;
        const dz = position.z - featurePoint.z;
        const nearFeature = dx * dx + dz * dz < finite(feature.clearance, 24) ** 2;
        const blocksApproach = segmentDistanceToPoint(memory.lastPosition, position, featurePoint) < finite(feature.radius, 14) + 6;
        if (nearFeature && blocksApproach) {
          baitSample = 1;
          break;
        }
      }
    }
    if (speed > 24) {
      for (const feature of featureDescriptors) {
        const featurePoint = feature.point ?? tmpVec3A.set(finite(feature.x), 0, finite(feature.z));
        const dx = position.x - featurePoint.x;
        const dz = position.z - featurePoint.z;
        const clearance = finite(feature.clearance, 24) + 4;
        const nearFeature = dx * dx + dz * dz < clearance * clearance;
        const approachFeature = velocity.lengthSq() > EPS && tmpVec3C.copy(featurePoint).sub(position).normalize().dot(tmpVec3F.copy(velocity).normalize()) > 0.35;
        if (nearFeature && approachFeature) {
          overcommitSample = clamp01((speed - 20) / 28);
          break;
        }
      }
    }
    memory.wallBias = THREE.MathUtils.lerp(memory.wallBias, wallSample, alpha);
    memory.turnBias = THREE.MathUtils.lerp(memory.turnBias, turnSample, alpha);
    memory.brakeBias = THREE.MathUtils.lerp(memory.brakeBias, brakeSample, alpha);
    memory.baitBias = THREE.MathUtils.lerp(memory.baitBias, baitSample, alpha);
    memory.overcommitBias = THREE.MathUtils.lerp(memory.overcommitBias, overcommitSample, alpha);
    memory.escapeSideBias = THREE.MathUtils.lerp(memory.escapeSideBias, escapeSideSample, alpha);
    memory.lateralJukeBias = THREE.MathUtils.lerp(memory.lateralJukeBias, lateralJukeSample, alpha);
    memory.jumpBias = THREE.MathUtils.lerp(memory.jumpBias, jumpSample, alpha);
    memory.vulnerableBias = THREE.MathUtils.lerp(memory.vulnerableBias, vulnerableSample, alpha);
    memory.confidence = clamp01(memory.confidence + alpha * 0.42);
    memory.recentness = 1;
    memory.lastPosition.copy(position);
    memory.lastVelocity.copy(velocity);
    memory.lastSpeed = speed;
    memory.lastWheels = wheels;
    memory.samples += 1;
  }

  for (const [id, memory] of ai.opponentMemory ?? []) {
    if (seen.has(id)) continue;
    memory.recentness = Math.max(0, finite(memory.recentness) - dt * 0.8);
    memory.confidence *= THREE.MathUtils.lerp(0.92, 1, memory.recentness);
  }

  if (ai.opponentMemory?.size > cars.length + 2) {
    for (const id of ai.opponentMemory.keys()) {
      if (!seen.has(id)) ai.opponentMemory.delete(id);
    }
  }
}

function updateThreatPattern(ai, facts, dt) {
  const history = ai.threatDistanceHistory;
  const now = finite(ai.threatPatternTime) + Math.max(0.001, dt);
  ai.threatPatternTime = now;
  if (!facts.threat) {
    history.length = 0;
    ai.threatPattern = {
      closingRate: 0,
      acceleration: 0,
      volatility: 0,
      minDistance: Infinity,
      samples: 0,
    };
    return ai.threatPattern;
  }

  const distance = finite(facts.threat.contactDistance, 999);
  history.push({ time: now, distance });
  while (history.length > 1 && now - history[0].time > 1.8) history.shift();

  let closingRate = 0;
  let acceleration = 0;
  let volatility = 0;
  let minDistance = distance;
  if (history.length >= 2) {
    const first = history[0];
    const last = history[history.length - 1];
    const elapsed = Math.max(0.001, last.time - first.time);
    closingRate = (first.distance - last.distance) / elapsed;
    let previousRate = null;
    let rateDelta = 0;
    let rateSamples = 0;
    for (let i = 1; i < history.length; i += 1) {
      const a = history[i - 1];
      const b = history[i];
      minDistance = Math.min(minDistance, b.distance);
      const segmentDt = Math.max(0.001, b.time - a.time);
      const rate = (a.distance - b.distance) / segmentDt;
      if (previousRate != null) {
        rateDelta += Math.abs(rate - previousRate);
        rateSamples += 1;
      }
      previousRate = rate;
    }
    volatility = clamp01((rateDelta / Math.max(1, rateSamples)) / 36);
    if (history.length >= 4) {
      const mid = history[Math.floor(history.length * 0.5)];
      const earlyRate = (first.distance - mid.distance) / Math.max(0.001, mid.time - first.time);
      const lateRate = (mid.distance - last.distance) / Math.max(0.001, last.time - mid.time);
      acceleration = lateRate - earlyRate;
    }
  }

  ai.threatPattern = {
    closingRate,
    acceleration,
    volatility,
    minDistance,
    samples: history.length,
  };
  return ai.threatPattern;
}

function tacticMemoryFor(ai, plan) {
  if (!plan) return null;
  ai.tacticMemory ??= new Map();
  let entry = ai.tacticMemory.get(plan);
  if (!entry) {
    entry = { samples: 0, value: 0, success: 0, crash: 0, overshoot: 0 };
    ai.tacticMemory.set(plan, entry);
  }
  return entry;
}

function tacticBias(ai, plan) {
  const entry = ai?.tacticMemory?.get(plan);
  if (!entry || finite(entry.samples) <= 2) return 0;
  const confidence = clamp01(finite(entry.samples) / 14);
  return THREE.MathUtils.clamp(finite(entry.value) / 32, -1, 1) * confidence;
}

function beginTacticSample(car, facts, job) {
  const ai = car.ai;
  const targetDistance = car.isIt
    ? finite(job?.target?.contactDistance, Infinity)
    : finite(facts.threat?.contactDistance, Infinity);
  ai.tacticPending = {
    plan: job?.plan ?? "unknown",
    role: car.isIt ? "tagger" : "runner",
    targetId: car.isIt ? job?.target?.id ?? null : facts.threat?.id ?? null,
    startDistance: targetDistance,
    startSpeed: finite(facts.speed),
    startWheels: finite(facts.wheels),
    startSurfaceUpDot: finite(facts.surfaceUpDot, 1),
    elapsed: 0,
  };
}

function updateTacticMemory(car, facts, dt) {
  const ai = car.ai;
  const pending = ai.tacticPending;
  if (!pending) return;
  pending.elapsed += dt;
  const roleChanged = (pending.role === "tagger") !== Boolean(car.isIt);
  const targetInvalid =
    pending.role === "tagger"
      ? !facts.runners.some((runner) => runner.id === pending.targetId)
      : facts.threat?.id !== pending.targetId;
  if (roleChanged || targetInvalid || pending.elapsed < 0.85) {
    if (roleChanged || targetInvalid) ai.tacticPending = null;
    return;
  }

  const currentDistance = pending.role === "tagger"
    ? finite(facts.runners.find((runner) => runner.id === pending.targetId)?.contactDistance, pending.startDistance)
    : finite(facts.threat?.contactDistance, pending.startDistance);
  const distanceDelta = pending.role === "tagger"
    ? pending.startDistance - currentDistance
    : currentDistance - pending.startDistance;
  const speedDelta = finite(facts.speed) - pending.startSpeed;
  const crash = facts.wheels <= 1 || facts.surfaceUpDot < 0.42 || (pending.startSpeed > 12 && facts.speed < 4);
  const value = distanceDelta + speedDelta * 0.28 - (crash ? 18 : 0);
  const entry = tacticMemoryFor(ai, pending.plan);
  if (entry) {
    const samples = Math.min(MAX_TACTIC_MEMORY, finite(entry.samples) + 1);
    const alpha = 1 / Math.max(3, samples);
    entry.samples = samples;
    entry.value = THREE.MathUtils.lerp(finite(entry.value), value, alpha);
    entry.success = THREE.MathUtils.lerp(finite(entry.success), value > 4 ? 1 : 0, alpha);
    entry.crash = THREE.MathUtils.lerp(finite(entry.crash), crash ? 1 : 0, alpha);
  }
  ai.tacticPending = null;
}

function updateMotionAwareness(car, ai, facts, dt) {
  const moved = facts.position.distanceTo(ai.lastPosition ?? facts.position);
  const effort =
    Math.abs(finite(car.input?.throttle)) +
    Math.abs(finite(car.input?.steer)) * 0.35 +
    Math.abs(finite(car.input?.airRoll)) * 0.25;
  const badOrientation = facts.surfaceUpDot < 0.3 || (facts.wheels <= 1 && facts.speed < 4);
  const stalled = effort > 0.35 && facts.speed < 2.6 && moved < 0.08;
  if (badOrientation || stalled) ai.stuckTimer += dt * (badOrientation ? 1.8 : 1);
  else ai.stuckTimer = Math.max(0, ai.stuckTimer - dt * 2.4);
  ai.lastPosition.copy(facts.position);
}

function predictPosition(car, seconds, out = new THREE.Vector3()) {
  out.set(
    finite(car.body?.position?.x) + finite(car.body?.velocity?.x) * seconds,
    finite(car.body?.position?.y) + finite(car.body?.velocity?.y) * seconds,
    finite(car.body?.position?.z) + finite(car.body?.velocity?.z) * seconds,
  );
  return out;
}

function targetForward(entry, out = new THREE.Vector3()) {
  const velocity = carVelocity(entry.car, out);
  const normal = entry.surfaceNormal?.isVector3 ? entry.surfaceNormal : WORLD_UP;
  projectOntoPlane(velocity, normal, forwardOnPlane(entry.car, normal, tmpVec3C));
  if (velocity.lengthSq() > EPS) return velocity.normalize();
  return flatForward(entry.car, out);
}

function inwardDirection(point, out = new THREE.Vector3(), normal = WORLD_UP) {
  out.set(-point.x, 0, -point.z);
  return projectOntoPlane(out, normal, tmpVec3C.set(0, 0, 1));
}

function perpendicular(direction, sign, out = new THREE.Vector3(), normal = WORLD_UP) {
  out.crossVectors(direction, normal).multiplyScalar(sign);
  if (out.lengthSq() > EPS) return out.normalize();
  out.crossVectors(tmpVec3C.set(0, 0, 1), normal).multiplyScalar(sign);
  if (out.lengthSq() > EPS) return out.normalize();
  return out.set(sign, 0, 0);
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

function segmentDistanceToPoint3D(start, end, point) {
  const sx = start.x;
  const sy = start.y;
  const sz = start.z;
  const ex = end.x;
  const ey = end.y;
  const ez = end.z;
  const px = point.x;
  const py = point.y;
  const pz = point.z;
  const dx = ex - sx;
  const dy = ey - sy;
  const dz = ez - sz;
  const lengthSq = dx * dx + dy * dy + dz * dz;
  if (lengthSq <= EPS) return Math.hypot(px - sx, py - sy, pz - sz);
  const t = THREE.MathUtils.clamp(((px - sx) * dx + (py - sy) * dy + (pz - sz) * dz) / lengthSq, 0, 1);
  return Math.hypot(px - (sx + dx * t), py - (sy + dy * t), pz - (sz + dz * t));
}

function pointCrowding(point, facts, range = 24) {
  let score = 0;
  const rangeSq = range * range;
  for (const other of facts.others) {
    const pos = carPosition(other.car, tmpVec3A);
    const dx = point.x - pos.x;
    const dz = point.z - pos.z;
    const distanceSq = dx * dx + dz * dz;
    if (distanceSq >= rangeSq) continue;
    const distance = Math.sqrt(distanceSq);
    score += (1 - distance / range) ** 2;
  }
  return score;
}

function runnerTrafficCost(car, rollout, facts, horizon) {
  let cost = 0;
  for (const other of facts.others) {
    if (other.car === car || other.car.isIt) continue;
    const otherNow = carPosition(other.car, tmpVec3A);
    const otherFuture = predictPosition(other.car, horizon, tmpVec3B);
    const otherMid = tmpVec3C.copy(otherNow).lerp(otherFuture, 0.5);
    const routeCrossing = segmentDistanceToPoint3D(facts.position, rollout.position, otherMid);
    const finalSpacing = rollout.position.distanceTo(otherFuture);
    const otherVelocity = carVelocity(other.car, tmpVec3D);
    otherVelocity.addScaledVector(other.surfaceNormal, -otherVelocity.dot(other.surfaceNormal));
    const relativeVelocity = tmpVec3E.copy(facts.velocity).sub(otherVelocity);
    relativeVelocity.addScaledVector(facts.surfaceNormal, -relativeVelocity.dot(facts.surfaceNormal));
    const toOther = tangentDirection(facts.position, otherNow, facts.surfaceNormal, facts.forward, tmpVec3F);
    const closing = Math.max(0, relativeVelocity.dot(toOther));
    const crossingRisk = 1 - clamp01((routeCrossing - 7.5) / 18);
    const finalRisk = 1 - clamp01((finalSpacing - 8) / 18);
    cost += crossingRisk * (70 + closing * 2.2) + finalRisk * 42;
  }
  return cost;
}

function featureRiskAlong(from, to, facts) {
  let risk = 0;
  for (const feature of facts.features ?? []) {
    const point = feature.point ?? tmpVec3A.set(finite(feature.x), 0, finite(feature.z));
    const radius = finite(feature.radius, Math.max(finite(feature.width, 12), finite(feature.length, 12)) * 0.55 + 4);
    const distance = segmentDistanceToPoint(from, to, point);
    if (distance > radius) continue;
    const height = finite(feature.heightValue, clamp01((finite(feature.height, 2) - 1) / 6));
    risk = Math.max(risk, (1 - distance / radius) * (0.35 + height * 0.65));
  }
  return risk;
}

function featureEscapeJobs(car, facts, config) {
  if (!facts.threat || facts.threatRisk < 0.16) return [];
  const jobs = [];
  const planning = clamp01(finite(config.planningSkill) / 1.35);
  if (planning < 0.58) return jobs;
  const threatPos = carPosition(facts.threat.car, tmpVec3E);
  const openEscape = tmpVec3F.copy(facts.position).sub(threatPos);
  projectOntoPlane(openEscape, facts.surfaceNormal, facts.forward);
  const escapeLineEnd = facts.position.clone().addScaledVector(openEscape, 56);
  let bestFeature = null;
  let bestScore = -Infinity;
  let bestBypassScore = -Infinity;
  let bestBypassPoint = null;
  for (const feature of facts.features ?? []) {
    const featurePoint = feature.point ?? tmpVec3A.set(finite(feature.x), 0, finite(feature.z));
    const distance = segmentDistanceToPoint(facts.position, threatPos, featurePoint);
    const toFeature = tmpVec3B.copy(featurePoint).sub(facts.position);
    const featureDistance = Math.hypot(toFeature.x, toFeature.z);
    if (featureDistance < 10 || featureDistance > THREE.MathUtils.lerp(46, 72, planning)) continue;
    const awayFromThreat = tmpVec3C.copy(featurePoint).sub(threatPos);
    safeNormalize(awayFromThreat, facts.forward);
    const routeDirection = projectOntoPlane(toFeature, facts.surfaceNormal, facts.forward);
    const escapeDot = routeDirection.dot(awayFromThreat);
    const heightValue = finite(feature.tacticalHeight, clamp01((finite(feature.height, 2) - 1.2) / 6));
    const bypassValue = finite(feature.bypassValue, 0.5);
    const blockValue = finite(feature.blockValue, heightValue);
    const trapRisk = finite(feature.trapRisk, heightValue);
    const routeBlock = 1 - clamp01((segmentDistanceToPoint(facts.position, escapeLineEnd, featurePoint) - 4) / 22);
    const airTimeCost = trapRisk * THREE.MathUtils.lerp(12, 38, clamp01(facts.speed / 42)) * THREE.MathUtils.lerp(0.5, 1.1, clamp01((facts.threat.contactDistance - TAG_RANGE) / 30));
    const momentumNeed = clamp01(facts.speed / 38) * clamp01((facts.threat.contactDistance - TAG_RANGE) / 28);
    const score =
      (1 - clamp01((distance - 8) / 34)) * 34 +
      escapeDot * 42 +
      blockValue * 30 -
      airTimeCost -
      clamp01((featureDistance - 22) / 52) * 18;
    if (score > bestScore) {
      bestScore = score;
      bestFeature = feature;
    }
    const bypassScore = routeBlock * 38 + momentumNeed * 26 + bypassValue * 24 + escapeDot * 10 - trapRisk * 8;
    if (bypassScore > bestBypassScore && routeBlock > 0.18) {
      const around = perpendicular(routeDirection, Math.sign(tmpVec3D.copy(routeDirection).cross(awayFromThreat).dot(facts.surfaceNormal)) || car.ai.lateralSign || 1, tmpVec3C, facts.surfaceNormal);
      const clearance = finite(feature.clearance, Math.max(finite(feature.width, 16), finite(feature.length, 16)) * 0.55 + 12);
      bestBypassPoint = featurePoint.clone().addScaledVector(around, clearance).addScaledVector(openEscape, 18 + momentumNeed * 18);
      bestBypassScore = bypassScore;
    }
  }
  if (bestBypassPoint && bestBypassScore > 18) {
    jobs.push(makeJob({
      type: "run",
      point: bestBypassPoint,
      threat: facts.threat,
      desiredSpeed: 45,
      urgency: Math.max(0.22, facts.threatRisk),
      plan: "feature_bypass",
      score: bestBypassScore * 0.82,
    }));
  }
  if (!bestFeature || bestScore < 14) return jobs;

  const center = tmpVec3A.copy(bestFeature.point ?? tmpVec3A.set(finite(bestFeature.x), 0, finite(bestFeature.z)));
  const threatAway = tmpVec3B.copy(center).sub(threatPos);
  projectOntoPlane(threatAway, facts.surfaceNormal, facts.forward);
  const along = tmpVec3C.copy(bestFeature.along ?? tmpVec3C.set(Math.sin(finite(bestFeature.yaw)), 0, Math.cos(finite(bestFeature.yaw))));
  projectOntoPlane(along, facts.surfaceNormal, facts.forward);
  const side = Math.sign(along.dot(threatAway)) || car.ai.lateralSign || 1;
  const featureSize = Math.max(finite(bestFeature.width, 16), finite(bestFeature.length, 16));
  const crestDistance = featureSize * 0.28;
  const exitDistance = featureSize * 0.42;

  const crest = center.clone().addScaledVector(along, side * crestDistance).addScaledVector(threatAway, 8);
  const exit = center.clone().addScaledVector(along, side * exitDistance).addScaledVector(threatAway, 24);
  jobs.push(makeJob({
    type: "run",
    point: crest,
    threat: facts.threat,
    desiredSpeed: 42,
    urgency: Math.max(0.24, facts.threatRisk),
    plan: "feature_cut",
    score: bestScore * 0.62,
  }));
  jobs.push(makeJob({
    type: "run",
    point: exit,
    threat: facts.threat,
    desiredSpeed: 44,
    urgency: Math.max(0.28, facts.threatRisk),
    plan: "feature_escape",
    score: bestScore * 0.86,
  }));
  return jobs;
}

function runnerBaitJobs(car, facts, config) {
  if (!facts.threat || facts.threatRisk < 0.24) return [];
  const planning = clamp01(finite(config.planningSkill) / 1.35);
  if (planning < 0.92) return [];
  const jobs = [];
  const threatPos = carPosition(facts.threat.car, tmpVec3E);
  const threatVelocity = carVelocity(facts.threat.car, tmpVec3F);
  const threatToRunner = tmpVec3A.copy(facts.position).sub(threatPos);
  projectOntoPlane(threatToRunner, facts.surfaceNormal, facts.forward);
  const approach = threatVelocity.dot(threatToRunner);
  const threatMemoryConfidence = facts.threat.memory
    ? clamp01(finite(facts.threat.memory.confidence) * finite(facts.threat.memory.recentness, 1))
    : 0;
  const overcommit = facts.threat.memory ? clamp01(finite(facts.threat.memory.overcommitBias) * threatMemoryConfidence) : 0;
  if (approach < THREE.MathUtils.lerp(22, 14, planning) && overcommit < 0.18) return jobs;

  let bestPoint = null;
  let bestScore = -Infinity;
  for (const feature of facts.features ?? []) {
    const featurePoint = feature.point ?? tmpVec3B.set(finite(feature.x), 0, finite(feature.z));
    const block = 1 - clamp01((segmentDistanceToPoint(threatPos, facts.position, featurePoint) - finite(feature.radius, 14)) / 18);
    if (block <= 0) continue;
    const fromThreat = tmpVec3C.copy(featurePoint).sub(threatPos);
    projectOntoPlane(fromThreat, facts.surfaceNormal, facts.forward);
    const hidePoint = featurePoint.clone()
      .addScaledVector(fromThreat, finite(feature.clearance, 22) * 0.42)
      .addScaledVector(perpendicular(fromThreat, car.ai.lateralSign || 1, tmpVec3D, facts.surfaceNormal), 7);
    const routeDistance = facts.position.distanceTo(hidePoint);
    if (routeDistance > 34) continue;
    const speedPenalty = clamp01(facts.speed / 34) * 18;
    const score =
      block * 54 +
      clamp01((approach - 10) / 32) * 38 +
      overcommit * 36 +
      finite(feature.blockValue, finite(feature.tacticalHeight, 0.3)) * 22 -
      routeDistance * 0.45 -
      speedPenalty -
      (overcommit < 0.12 ? 18 : 0);
    if (score > bestScore) {
      bestScore = score;
      bestPoint = hidePoint;
    }
  }

  if (bestPoint && bestScore > 34) {
    jobs.push(makeJob({
      type: "run",
      point: bestPoint,
      threat: facts.threat,
      desiredSpeed: 12,
      urgency: Math.max(0.38, facts.threatRisk),
      plan: "feature_bait_stop",
      score: bestScore,
      horizon: THREE.MathUtils.lerp(0.52, 0.86, planning),
    }));
  }
  return jobs;
}

function surfaceRisk(point, facts, direction = null) {
  const radius = Math.hypot(point.x, point.z);
  const floorRadius = finite(worldSpec?.floorRadius, 68);
  const curveRadius = Math.max(1, finite(worldSpec?.curveRadius, 30));
  const curve = clamp01((radius - curveStartRadius()) / Math.max(1, curveRadius * 0.75));
  if (curve <= 0) return 0;
  if (!direction) return curve * 0.35;
  const outward = tmpVec3A.set(point.x, 0, point.z);
  safeNormalize(outward, facts.forward);
  const radial = direction.dot(outward);
  const slope = clamp01((radius - floorRadius) / curveRadius);
  const straightClimb = clamp01((radial - 0.08) / 0.68);
  const speedRisk = clamp01((facts.speed - 12) / 26);
  const tractionLoss = straightClimb * slope * (0.82 + speedRisk * 0.82);
  const crossSlopeLoad = clamp01(Math.abs(radial) * slope * 0.28);
  return clamp01(curve * (tractionLoss + crossSlopeLoad + 0.08));
}

function uphillClimbLoad(point, facts, direction, speed) {
  const radius = Math.hypot(point.x, point.z);
  const floorRadius = finite(worldSpec?.floorRadius, 68);
  const curveRadius = Math.max(1, finite(worldSpec?.curveRadius, 30));
  if (radius <= floorRadius - 2) return 0;
  const outward = tmpVec3B.set(point.x, 0, point.z);
  safeNormalize(outward, facts.forward);
  const radial = direction.dot(outward);
  const slope = clamp01((radius - floorRadius) / curveRadius);
  const speedLoad = clamp01((Math.abs(speed) - 10) / 32);
  return clamp01(clamp01((radial - 0.04) / 0.7) * slope * (0.7 + speedLoad * 0.8));
}

function surfaceDirectionToPoint(from, to, facts, out = new THREE.Vector3()) {
  return tangentDirection(from, to, facts.surfaceNormal, facts.forward, out);
}

function boostClimbLoadForSteer(facts, steer, out = tmpVec3D) {
  out.copy(facts.forward).applyAxisAngle(facts.surfaceNormal, THREE.MathUtils.clamp(steer, -1, 1) * 0.48);
  projectOntoPlane(out, facts.surfaceNormal, facts.forward);
  return uphillClimbLoad(facts.position, facts, out, facts.speed);
}

function canJumpNow(facts) {
  return Boolean(facts.jumpReady && facts.wheels >= 3 && facts.surfaceUpDot > 0.72);
}

function canBoostNow(facts, config, steer = 0) {
  return Boolean(
    facts.boostReady &&
    facts.wheels >= 3 &&
    finite(config?.boostSkill, 1) > 0.72 &&
    boostClimbLoadForSteer(facts, steer) < 0.22
  );
}

function canBoostSegmentNow(facts, config, segment) {
  return Boolean(segment?.boost && canBoostNow(facts, config, finite(segment.steer)));
}

function rolloutDrive(facts, point, config, {
  desiredSpeed = 38,
  horizon = 1,
  boost = false,
} = {}) {
  const position = facts.position.clone();
  const forward = facts.forward.clone();
  const target = point.clone();
  projectArenaSurfacePoint(target, facts, 4);
  let speed = Math.max(0, facts.speed);
  let turnLoad = 0;
  let surfaceLoad = 0;
  const steps = 6;
  const stepTime = horizon / steps;
  void config;
  const turnRate = 4.15;
  const accel = 27 + (boost ? 12 : 0);
  const brake = 38;

  for (let i = 0; i < steps; i += 1) {
    const surfaceContact = surfaceContactAt(position, facts, tmpVec3D);
    const surfaceNormal = surfaceContact.normal;
    projectOntoPlane(forward, surfaceNormal, facts.forward);
    const desired = tangentDirection(position, target, surfaceNormal, forward, tmpVec3B);
    const signedAngle = Math.atan2(tmpVec3C.copy(forward).cross(desired).dot(surfaceNormal), THREE.MathUtils.clamp(forward.dot(desired), -1, 1));
    const yaw = THREE.MathUtils.clamp(signedAngle, -turnRate * stepTime, turnRate * stepTime);
    turnLoad = Math.max(turnLoad, clamp01(Math.abs(signedAngle) / 1.35));
    forward.applyAxisAngle(surfaceNormal, yaw);
    projectOntoPlane(forward, surfaceNormal, facts.forward);
    const risk = surfaceRisk(position, facts, forward);
    const climbLoad = uphillClimbLoad(position, facts, forward, speed);
    surfaceLoad = Math.max(surfaceLoad, risk, climbLoad);
    const speedTarget = desiredSpeed * THREE.MathUtils.lerp(1, 0.54, Math.max(risk, climbLoad));
    const error = speedTarget - speed;
    speed += error > 0
      ? Math.min(error, accel * stepTime)
      : Math.max(error, -brake * stepTime);
    speed -= climbLoad * (8 + Math.max(0, speed) * 0.28) * stepTime;
    speed *= THREE.MathUtils.lerp(1, 0.9, clamp01((Math.abs(signedAngle) - 0.7) / 1.4) * clamp01(speed / 42));
    speed = Math.max(0, speed);
    position.addScaledVector(forward, speed * stepTime);
    projectArenaSurfacePoint(position, facts, 4);
  }
  return { position, forward, speed, turnLoad, surfaceLoad };
}

function rolloutActionSequence(facts, action, horizon, target = null) {
  const position = facts.position.clone();
  const forward = facts.forward.clone();
  const initialContact = surfaceContactAt(position, facts, new THREE.Vector3());
  projectOntoPlane(forward, initialContact.normal, facts.forward);
  let speed = finite(facts.velocity?.dot?.(facts.forward), facts.speed);
  let turnLoad = 0;
  let surfaceLoad = 0;
  let tagWindow = Infinity;
  let closestTime = 0;
  let exitAlignment = 0;
  let heightOffset = Math.max(0, position.y - finite(initialContact.point?.y, arenaSurfaceYAt(position)));
  let verticalSpeed = 0;
  let jumpStarted = false;
  const sequence = Array.isArray(action.sequence) && action.sequence.length ? action.sequence : [action];
  const steps = Math.max(6, Math.min(12, Math.ceil(horizon * 10)));
  const stepTime = horizon / steps;
  const turnRate = 4.15;
  const brake = 38;
  let elapsed = 0;
  let segmentIndex = 0;
  let segmentEnd = finite(sequence[0]?.duration, horizon);

  for (let i = 0; i < steps; i += 1) {
    const sampleTime = (i + 1) * stepTime;
    while (segmentIndex < sequence.length - 1 && elapsed >= segmentEnd - EPS) {
      segmentIndex += 1;
      segmentEnd += finite(sequence[segmentIndex]?.duration, horizon);
    }
    const segment = sequence[segmentIndex] ?? action;
    const steer = THREE.MathUtils.clamp(finite(segment.steer), -1, 1);
    const throttle = THREE.MathUtils.clamp(finite(segment.throttle, 1), -1, 1);
    const accel = 27 + (segment.boost ? 12 : 0);
    const surfaceContact = surfaceContactAt(position, facts, tmpVec3D);
    const surfaceNormal = surfaceContact.normal;
    const movementSign = Math.sign(speed) || 1;
    const yaw = steer * movementSign * turnRate * stepTime;
    forward.applyAxisAngle(surfaceNormal, yaw);
    projectOntoPlane(forward, surfaceNormal, facts.forward);
    turnLoad = Math.max(turnLoad, Math.abs(steer));
    const risk = surfaceRisk(position, facts, forward);
    const climbLoad = uphillClimbLoad(position, facts, forward, speed);
    surfaceLoad = Math.max(surfaceLoad, risk, climbLoad);
    if (throttle >= 0) speed += accel * throttle * stepTime;
    else speed += throttle * brake * stepTime;
    speed = THREE.MathUtils.clamp(speed, -18, action.boost ? 52 : 44);
    speed -= climbLoad * (8 + Math.max(0, speed) * 0.28) * stepTime;
    speed *= THREE.MathUtils.lerp(1, 0.9, Math.max(risk, climbLoad));
    speed = THREE.MathUtils.clamp(speed, -18, action.boost ? 52 : 44);
    position.addScaledVector(forward, speed * stepTime);
    clampArenaPoint(position, 4);
    if ((segment.jump || action.jump) && !jumpStarted) {
      jumpStarted = true;
      verticalSpeed = Math.max(verticalSpeed, finite(vehicleTuning.jumpVelocity, 11.5));
    }
    if (jumpStarted || heightOffset > 0) {
      verticalSpeed -= 19.6 * stepTime;
      heightOffset += verticalSpeed * stepTime;
      if (heightOffset <= 0) {
        heightOffset = 0;
        verticalSpeed = 0;
      }
    }
    const groundY = finite(surfaceContactAt(position, facts, tmpVec3D).point?.y, arenaSurfaceYAt(position));
    position.y = groundY + heightOffset;
    if (target) {
      const targetPos = predictPosition(target.car, sampleTime, tmpVec3B);
      const distance = Math.hypot(
        position.x - targetPos.x,
        position.z - targetPos.z,
        (position.y - targetPos.y) * 1.35,
      );
      if (distance < tagWindow) {
        tagWindow = distance;
        closestTime = sampleTime;
      }
    }
    elapsed += stepTime;
  }
  if (target) {
    const targetFuture = predictPosition(target.car, horizon, tmpVec3B);
    const toTarget = tangentDirection(position, targetFuture, surfaceContactAt(position, facts, tmpVec3D).normal, forward, tmpVec3B);
    exitAlignment = forward.dot(toTarget);
  }
  return { position, forward, speed, turnLoad, surfaceLoad, tagWindow, closestTime, exitAlignment };
}

function makeJob({ type, point, target = null, threat = null, desiredSpeed = 38, score = 0, urgency = 0.2, plan = type, horizon = null, action = null, rollout = null }) {
  return {
    type,
    point: point.clone(),
    target,
    threat,
    desiredSpeed,
    score,
    urgency,
    plan,
    maneuver: plan,
    rolloutScore: score,
    horizon,
    action,
    rollout,
  };
}

function riskAppetite(config, personality) {
  return clamp01((finite(config.riskTolerance, 0.9) * finite(personality.risk, 1)) / 1.25);
}

function tagStrategicValue(target, facts, config, personality) {
  const rankGain = Math.max(0, facts.selfRank - target.rank);
  const scoreGap = Math.max(0, target.scoreGap);
  return (rankGain * 9 + scoreGap * 0.22 + (target.rank === 1 ? 18 : 0)) *
    finite(config.rankAwareness) *
    personality.rank;
}

function tagEaseValue(target) {
  const contact = finite(target.contactDistance, target.distance);
  const memory = target.memory;
  const learnedVulnerability = memory && finite(memory.samples) > 8
    ? clamp01(finite(memory.vulnerableBias)) * 48 + clamp01(finite(memory.brakeBias)) * 18
    : 0;
  const reach = (1 - clamp01((contact - TAG_RANGE) / 54)) * 130;
  const immediate = contact < TAG_RANGE + 8 ? (TAG_RANGE + 8 - contact) * 30 : 0;
  const closing = THREE.MathUtils.clamp(finite(target.closing), -20, 36) * 1.5;
  const weakState =
    (1 - finite(target.mobility, 1)) * 72 +
    (finite(target.wheels, 4) <= 1 ? 34 : finite(target.wheels, 4) <= 2 ? 16 : 0) +
    (finite(target.upDot, 1) < 0.55 ? 24 : 0) +
    (finite(target.speed) < 7 ? 18 : 0);
  return reach + immediate + closing + weakState + learnedVulnerability;
}

function tagMultiAgentOpportunity(target, job, facts, horizon) {
  if (!Array.isArray(facts.runners) || facts.runners.length <= 1) return 0;
  let opportunity = 0;
  for (const other of facts.runners) {
    if (other.id === target.id || other.immunity > 0) continue;
    const otherFuture = opponentHypothesisPositions(other, horizon)[0];
    const routeDistance = segmentDistanceToPoint3D(facts.position, job.point, otherFuture);
    const finishDistance = job.point.distanceTo(otherFuture);
    const nearRoute = 1 - clamp01((routeDistance - TAG_RANGE) / 22);
    const nearFinish = 1 - clamp01((finishDistance - TAG_RANGE) / 24);
    const mobilityBonus = 1 - finite(other.mobility, 1);
    const rankPressure = clamp01((facts.selfRank - other.rank + 2) / 5);
    opportunity = Math.max(
      opportunity,
      nearRoute * 18 + nearFinish * 28 + mobilityBonus * 18 + rankPressure * 10,
    );
  }
  return opportunity;
}

function overshootRisk(target, facts, horizon = 0.65) {
  if (!target?.car) return 0;
  const targetPosition = carPosition(target.car, tmpVec3A);
  const targetVelocity = carVelocity(target.car, tmpVec3B);
  const relativePosition = tmpVec3C.copy(targetPosition).sub(facts.position);
  const relativeVelocity = tmpVec3D.copy(targetVelocity).sub(facts.velocity);
  const relativeSpeedSq = Math.max(EPS, relativeVelocity.lengthSq());
  const closestT = THREE.MathUtils.clamp(-relativePosition.dot(relativeVelocity) / relativeSpeedSq, 0, horizon);
  const closest = relativePosition.addScaledVector(relativeVelocity, closestT).length();
  const currentClosing = finite(target.closing);
  const highSpeed = clamp01((facts.speed - 20) / 32);
  return clamp01((TAG_RANGE + 5 - closest) / 12) * clamp01(currentClosing / 24) * (0.45 + highSpeed * 0.55);
}

function closeEscapeCoverage(job, target, facts, horizon) {
  if (!target?.car || target.contactDistance > TAG_RANGE + 24) return 0;
  const targetPos = carPosition(target.car, tmpVec3A);
  const away = tangentDirection(facts.position, targetPos, facts.surfaceNormal, facts.forward, tmpVec3B);
  const lateral = perpendicular(away, Math.sign(finite(target.angle)) || 1, tmpVec3C, facts.surfaceNormal);
  const distance = THREE.MathUtils.clamp(target.speed * horizon * 0.45 + 8, 7, 18);
  const laneWeight = clamp01((TAG_RANGE + 24 - target.contactDistance) / 24);
  let coverage = 0;
  for (let i = 0; i < 3; i += 1) {
    const lane = i === 0
      ? tmpVec3D.copy(away)
      : tmpVec3D.copy(away).addScaledVector(lateral, i === 1 ? 0.82 : -0.82);
    projectOntoPlane(lane, facts.surfaceNormal, away);
    const escapePoint = targetPos.clone().addScaledVector(lane, distance);
    projectArenaSurfacePoint(escapePoint, facts, 4);
    const endDistance = job.rollout.position.distanceTo(escapePoint);
    const pathDistance = segmentDistanceToPoint3D(facts.position, job.rollout.position, escapePoint);
    coverage += 1 - clamp01((Math.min(endDistance, pathDistance) - TAG_RANGE) / 18);
  }
  return (coverage / 3) * laneWeight;
}

function runnerCrossingPressure(target, facts) {
  if (!target?.car) return 0;
  const targetPos = carPosition(target.car, tmpVec3A);
  const away = tangentDirection(facts.position, targetPos, facts.surfaceNormal, facts.forward, tmpVec3B);
  const targetVelocity = carVelocity(target.car, tmpVec3C);
  targetVelocity.addScaledVector(facts.surfaceNormal, -targetVelocity.dot(facts.surfaceNormal));
  const forwardSpeed = Math.abs(targetVelocity.dot(away));
  const lateralVelocity = targetVelocity.addScaledVector(away, -targetVelocity.dot(away));
  const lateralSpeed = lateralVelocity.length();
  return clamp01((lateralSpeed - forwardSpeed * 0.35 - 4) / 22) * clamp01((TAG_RANGE + 24 - target.contactDistance) / 24);
}

function tagFeatureInterceptJobs(target, facts, config, future, forward, side) {
  const planning = clamp01(finite(config.planningSkill) / 1.35);
  if (planning < 0.64 || target.contactDistance < TAG_RANGE + 8) return [];
  const jobs = [];
  let bestBypassPoint = null;
  let bestBypassScore = -Infinity;
  let bestCutPoint = null;
  let bestCutScore = -Infinity;
  const directDirection = tmpVec3F.copy(future).sub(facts.position);
  projectOntoPlane(directDirection, facts.surfaceNormal, facts.forward);

  for (const feature of facts.features ?? []) {
    const featurePoint = feature.point ?? tmpVec3A.set(finite(feature.x), 0, finite(feature.z));
    const featureDistance = segmentDistanceToPoint(facts.position, future, featurePoint);
    const influence = 1 - clamp01((featureDistance - 5) / 24);
    if (influence <= 0) continue;

    const heightValue = finite(feature.tacticalHeight, clamp01((finite(feature.height, 2) - 1.2) / 6));
    const bypassValue = finite(feature.bypassValue, 0.5);
    const blockValue = finite(feature.blockValue, heightValue);
    const trapRisk = finite(feature.trapRisk, heightValue);
    const aroundSign = Math.sign(tmpVec3E.copy(directDirection).cross(tmpVec3B.copy(future).sub(featurePoint)).dot(facts.surfaceNormal)) || side || 1;
    const around = perpendicular(directDirection, aroundSign, tmpVec3C, facts.surfaceNormal);
    const clearance = finite(feature.clearance, Math.max(finite(feature.width, 16), finite(feature.length, 16)) * 0.55 + 12) - 2;
    const bypass = featurePoint.clone().addScaledVector(around, clearance).addScaledVector(forward, 10);
    const bypassDistance = facts.position.distanceTo(bypass) + bypass.distanceTo(future);
    const directDistance = facts.position.distanceTo(future);
    const targetSpeed = clamp01(target.speed / 36);
    const bypassScore =
      influence * 50 +
      bypassValue * 24 +
      targetSpeed * 24 -
      clamp01((bypassDistance - directDistance - 8) / 38) * 36;
    if (bypassScore > bestBypassScore) {
      bestBypassScore = bypassScore;
      bestBypassPoint = bypass;
    }

    const along = tmpVec3D.copy(feature.along ?? tmpVec3D.set(Math.sin(finite(feature.yaw)), 0, Math.cos(finite(feature.yaw))));
    projectOntoPlane(along, facts.surfaceNormal, facts.forward);
    const cutPoint = featurePoint.clone()
      .addScaledVector(along, aroundSign * Math.max(finite(feature.length, 18), finite(feature.width, 18)) * 0.32)
      .addScaledVector(forward, 12);
    const cutScore =
      influence * 30 +
      blockValue * 20 +
      clamp01((target.contactDistance - 18) / 34) * 20 -
      clamp01(facts.speed / 44) * trapRisk * 24;
    if (cutScore > bestCutScore) {
      bestCutScore = cutScore;
      bestCutPoint = cutPoint;
    }
  }

  if (bestBypassPoint && bestBypassScore > 14) {
    jobs.push(makeJob({
      type: "tag",
      point: bestBypassPoint,
      target,
      desiredSpeed: 44,
      urgency: 0.72,
      plan: "tag_feature_bypass",
      score: bestBypassScore * 0.75,
      horizon: THREE.MathUtils.lerp(0.9, 1.45, planning),
    }));
  }
  if (bestCutPoint && bestCutScore > 16) {
    jobs.push(makeJob({
      type: "tag",
      point: bestCutPoint,
      target,
      desiredSpeed: 42,
      urgency: 0.68,
      plan: "tag_feature_cut",
      score: bestCutScore * 0.7,
      horizon: THREE.MathUtils.lerp(0.82, 1.25, planning),
    }));
  }
  return jobs;
}

function tagTargetPriority(target, facts, config, personality) {
  if (target.immunity > 0) return -Infinity;
  const distanceValue = (1 - clamp01((target.contactDistance - TAG_RANGE) / 70)) * 120;
  const mobilityValue = (1 - finite(target.mobility, 1)) * 50;
  const learnedValue = target.memory && finite(target.memory.samples) > 8
    ? clamp01(finite(target.memory.vulnerableBias)) * 38 + clamp01(finite(target.memory.brakeBias)) * 16
    : 0;
  const strategicValue = tagStrategicValue(target, facts, config, personality) * 0.72;
  const closingValue = THREE.MathUtils.clamp(finite(target.closing), -18, 30) * 1.1;
  return distanceValue + mobilityValue + learnedValue + strategicValue + closingValue;
}

function predictOrbitPosition(position, velocity, seconds, out = new THREE.Vector3()) {
  const radius = Math.hypot(position.x, position.z);
  if (radius < 8 || velocity.lengthSq() <= EPS) {
    return out.copy(position).addScaledVector(velocity, seconds);
  }
  const angle = Math.atan2(position.z, position.x);
  const radial = tmpVec3A.set(position.x / radius, 0, position.z / radius);
  const tangent = tmpVec3B.set(-radial.z, 0, radial.x);
  const tangentSpeed = velocity.dot(tangent);
  const radialSpeed = velocity.dot(radial);
  const angularSpeed = tangentSpeed / Math.max(1, radius);
  const futureRadius = THREE.MathUtils.clamp(radius + radialSpeed * seconds * 0.35, 8, arenaLimit(4));
  const futureAngle = angle + angularSpeed * seconds;
  return out.set(Math.cos(futureAngle) * futureRadius, position.y + finite(velocity.y) * seconds, Math.sin(futureAngle) * futureRadius);
}

function predictOpponentHypothesis(entry, seconds, kind, out = new THREE.Vector3()) {
  const pos = carPosition(entry.car, out);
  const velocity = carVelocity(entry.car, new THREE.Vector3());
  const resolver = entry.surfaceResolver;
  let normal = entry.surfaceNormal?.isVector3 ? entry.surfaceNormal : WORLD_UP;
  const steps = Math.max(2, Math.min(6, Math.ceil(seconds * 3)));
  const dt = seconds / steps;
  const initialSpeed = velocity.length();
  const turnSign = kind === "turn_left" ? 1 : kind === "turn_right" ? -1 : 0;

  for (let i = 0; i < steps; i += 1) {
    velocity.addScaledVector(normal, -velocity.dot(normal));
    if (turnSign) velocity.applyAxisAngle(normal, turnSign * 1.15 * dt);
    else if (kind === "brake_reverse") {
      const currentSpeed = velocity.length();
      const targetSpeed = -initialSpeed * 0.28;
      const nextSpeed = THREE.MathUtils.lerp(currentSpeed, targetSpeed, clamp01(dt / 0.9));
      if (currentSpeed > EPS) velocity.multiplyScalar(nextSpeed / currentSpeed);
    }
    pos.addScaledVector(velocity, dt);
    clampArenaPoint(pos, 4);
    const projected = surfaceContactForPosition(pos, resolver, tmpVec3D);
    normal = projected.normal;
    if (Math.abs(projected.distance) < 3) {
      pos.y = finite(projected.point?.y, arenaSurfaceYAt(pos));
    }
  }
  return pos;
}

function opponentHypothesisPositions(entry, seconds) {
  const key = Math.round(seconds * 1000);
  const cache = entry.hypothesisCache;
  if (cache?.has(key)) return cache.get(key);
  const positions = ["continue", "turn_left", "turn_right", "brake_reverse"].map((kind) =>
    predictOpponentHypothesis(entry, seconds, kind, new THREE.Vector3())
  );
  cache?.set(key, positions);
  return positions;
}

function opponentHypothesisWeights(entry) {
  if (entry.hypothesisWeights) return entry.hypothesisWeights;
  const memory = entry.memory;
  const confidence = memory
    ? clamp01(finite(memory.confidence) * finite(memory.recentness, 1) * clamp01(finite(memory.samples) / 32))
    : 0;
  if (!memory || finite(memory.samples) < 8 || confidence <= 0.08) {
    entry.hypothesisWeights = [1, 1, 1, 1];
    return entry.hypothesisWeights;
  }
  const turnBias = THREE.MathUtils.clamp(finite(memory.turnBias), -1, 1);
  const brakeBias = clamp01(finite(memory.brakeBias));
  const jumpBias = clamp01(finite(memory.jumpBias));
  const wallBias = clamp01(finite(memory.wallBias));
  const escapeSide = THREE.MathUtils.clamp(finite(memory.escapeSideBias), -1, 1);
  const lateralJuke = clamp01(finite(memory.lateralJukeBias));
  const combinedTurn = THREE.MathUtils.clamp(turnBias * 0.7 + escapeSide * 0.9, -1, 1);
  const left = 1 + Math.max(0, combinedTurn) * (1.25 + lateralJuke * 0.75) * confidence;
  const right = 1 + Math.max(0, -combinedTurn) * (1.25 + lateralJuke * 0.75) * confidence;
  const reverse = 0.82 + (brakeBias * 1.45 + jumpBias * 0.45) * confidence;
  const carry = 1.18 + clamp01(entry.speed / 32) * 0.35 + wallBias * 0.18 * confidence - brakeBias * 0.45 * confidence;
  entry.hypothesisWeights = [
    Math.max(0.32, carry),
    Math.max(0.28, left),
    Math.max(0.28, right),
    Math.max(0.28, reverse),
  ];
  return entry.hypothesisWeights;
}

function tagControlSearchTemplates(config, target, facts) {
  const planning = clamp01(finite(config.planningSkill) / 1.35);
  if (planning < 0.5) return [];
  const baseSteer = THREE.MathUtils.clamp(finite(target.angle) / 0.95, -1, 1);
  const side = Math.sign(baseSteer) || 1;
  const turnIn = side;
  const turnOut = -side;
  const close = target.contactDistance < 20;
  const canBoost = (steer = baseSteer) => canBoostNow(facts, config, steer);
  const templates = [
    { label: "search_commit", horizon: 0.44, sequence: [{ duration: 0.44, steer: baseSteer, throttle: 1 }] },
    { label: "search_turn_in", horizon: 0.52, sequence: [{ duration: 0.52, steer: turnIn, throttle: close ? 0.68 : 0.84 }] },
    { label: "search_cut_out", horizon: 0.58, sequence: [{ duration: 0.22, steer: turnOut, throttle: 0.72 }, { duration: 0.36, steer: baseSteer, throttle: 1 }] },
  ];
  if (planning >= 0.72) {
    templates.push(
      { label: "search_brake_in", horizon: 0.68, sequence: [{ duration: 0.2, steer: turnIn, throttle: -0.32 }, { duration: 0.48, steer: turnIn * 0.86, throttle: 1 }] },
      { label: "search_hook_in", horizon: 0.76, sequence: [{ duration: 0.28, steer: turnIn, throttle: 0.42 }, { duration: 0.48, steer: baseSteer * 0.65, throttle: 1 }] },
      ...(canBoost(baseSteer * 0.7) ? [{ label: "search_boost_commit", horizon: 0.62, sequence: [{ duration: 0.62, steer: baseSteer * 0.7, throttle: 1, boost: true }] }] : []),
    );
  }
  if (planning >= 0.92) {
    templates.push(
      { label: "search_pivot_in", horizon: 0.86, sequence: [{ duration: 0.26, steer: turnIn, throttle: -0.64 }, { duration: 0.6, steer: turnIn * 0.72, throttle: 1 }] },
      { label: "search_pivot_out", horizon: 0.8, sequence: [{ duration: 0.22, steer: turnOut, throttle: -0.58 }, { duration: 0.58, steer: baseSteer, throttle: 1 }] },
      ...(canBoost(THREE.MathUtils.clamp(baseSteer + side * 0.42, -1, 1)) ? [
        { label: "search_boost_cut_in", horizon: 0.9, sequence: [{ duration: 0.32, steer: THREE.MathUtils.clamp(baseSteer + side * 0.42, -1, 1), throttle: 1, boost: true }, { duration: 0.58, steer: baseSteer * 0.62, throttle: 1 }] },
      ] : []),
      ...(canBoost(THREE.MathUtils.clamp(baseSteer - side * 0.5, -1, 1)) ? [
        { label: "search_boost_cut_out", horizon: 0.84, sequence: [{ duration: 0.28, steer: THREE.MathUtils.clamp(baseSteer - side * 0.5, -1, 1), throttle: 1, boost: true }, { duration: 0.56, steer: baseSteer, throttle: 1 }] },
      ] : []),
    );
    if (canJumpNow(facts) && target.contactDistance < TAG_RANGE + 12 && (finite(target.wheels, 4) <= 1 || finite(target.verticalGap) > 2.2)) {
      templates.push({ label: "search_jump_contest", horizon: 0.56, sequence: [{ duration: 0.56, steer: baseSteer, throttle: 1, jump: true }] });
    }
  }
  return templates;
}

function finishActionTemplates(config, target, facts) {
  const planning = clamp01(finite(config.planningSkill) / 1.35);
  if (target.contactDistance > TAG_RANGE + 13 || planning < 0.58) return [];
  const baseSteer = THREE.MathUtils.clamp(finite(target.angle) / 0.82, -1, 1);
  const side = Math.sign(baseSteer) || 1;
  const templates = [
    { label: "finish_commit", horizon: 0.34, sequence: [{ duration: 0.34, steer: baseSteer, throttle: 1 }] },
    { label: "finish_brake_turn", horizon: 0.48, sequence: [{ duration: 0.14, steer: side, throttle: -0.42 }, { duration: 0.34, steer: side * 0.92, throttle: 1 }] },
    { label: "finish_side_swipe", horizon: 0.46, sequence: [{ duration: 0.18, steer: -side * 0.45, throttle: 0.75 }, { duration: 0.28, steer: side, throttle: 1 }] },
  ];
  if (planning >= 0.82 && canBoostNow(facts, config, baseSteer * 0.45) && target.contactDistance > TAG_RANGE + 4) {
    templates.push({ label: "finish_boost_tap", horizon: 0.38, sequence: [{ duration: 0.18, steer: baseSteer * 0.45, throttle: 1, boost: true }, { duration: 0.2, steer: baseSteer, throttle: 1 }] });
  }
  if (planning >= 0.92 && canJumpNow(facts) && (finite(target.wheels, 4) <= 1 || target.verticalGap > 1.4)) {
    templates.push({ label: "finish_jump_contest", horizon: 0.44, sequence: [{ duration: 0.44, steer: baseSteer * 0.62, throttle: 1, jump: true }] });
  }
  return templates;
}

function closeCounterFinishJobs(target, facts, config, forward, lateral) {
  const planning = clamp01(finite(config.planningSkill) / 1.35);
  if (planning < 0.72 || target.contactDistance > TAG_RANGE + 22) return [];
  const jobs = [];
  const targetPos = carPosition(target.car, tmpVec3A);
  const fromTagger = tangentDirection(facts.position, targetPos, facts.surfaceNormal, facts.forward, tmpVec3B);
  const targetVel = carVelocity(target.car, tmpVec3C);
  targetVel.addScaledVector(facts.surfaceNormal, -targetVel.dot(facts.surfaceNormal));
  const runnerForward = target.speed > 5 ? safeNormalize(targetVel, forward) : targetForward(target, tmpVec3D);
  const learnedSide = target.memory && Math.abs(finite(target.memory.escapeSideBias)) > 0.12
    ? Math.sign(finite(target.memory.escapeSideBias))
    : 0;
  const escapeSideSign = learnedSide || Math.sign(runnerForward.clone().cross(fromTagger).dot(facts.surfaceNormal)) || 1;
  const escapeLane = tmpVec3E.copy(fromTagger)
    .multiplyScalar(0.62)
    .addScaledVector(lateral, escapeSideSign * 0.72);
  projectOntoPlane(escapeLane, facts.surfaceNormal, fromTagger);
  const closeScale = 1 - clamp01((target.contactDistance - TAG_RANGE) / 22);
  const runnerSpeedScale = clamp01(target.speed / 34);
  const crossingSignal = runnerCrossingPressure(target, facts);
  if (crossingSignal > 0.16 && target.contactDistance < TAG_RANGE + 16 && target.speed > 8) {
    const contactLeadTime = THREE.MathUtils.clamp(
      target.contactDistance / Math.max(24, facts.speed + target.speed),
      0.08,
      THREE.MathUtils.lerp(0.18, 0.28, planning)
    );
    const contactPoint = targetPos.clone()
      .addScaledVector(targetVel, contactLeadTime)
      .addScaledVector(escapeLane, THREE.MathUtils.lerp(0.5, 1.8, planning))
      .addScaledVector(lateral, -escapeSideSign * THREE.MathUtils.lerp(1.2, 2.8, closeScale + runnerSpeedScale * 0.35));
    projectArenaSurfacePoint(contactPoint, facts, 4);
    jobs.push(makeJob({
      type: "tag",
      point: contactPoint,
      target,
      desiredSpeed: THREE.MathUtils.lerp(28, 37, planning),
      urgency: 1,
      plan: "finish_contact_patch",
      horizon: THREE.MathUtils.lerp(0.26, 0.46, planning),
      score: 26 + closeScale * 38 + crossingSignal * 36,
    }));
  }
  const escapePoint = targetPos.clone()
    .addScaledVector(escapeLane, THREE.MathUtils.lerp(7, 15, planning))
    .addScaledVector(runnerForward, THREE.MathUtils.lerp(2, 8, runnerSpeedScale));
  projectArenaSurfacePoint(escapePoint, facts, 4);
  jobs.push(makeJob({
    type: "tag",
    point: escapePoint,
    target,
    desiredSpeed: THREE.MathUtils.lerp(30, 42, planning),
    urgency: 0.94,
    plan: "finish_escape_block",
    horizon: THREE.MathUtils.lerp(0.42, 0.66, planning),
    score: 42 + closeScale * 48,
  }));

  const counterPoint = targetPos.clone()
    .addScaledVector(escapeLane, THREE.MathUtils.lerp(3, 6, planning))
    .addScaledVector(lateral, -escapeSideSign * THREE.MathUtils.lerp(3, 6, planning));
  projectArenaSurfacePoint(counterPoint, facts, 4);
  jobs.push(makeJob({
    type: "tag",
    point: counterPoint,
    target,
    desiredSpeed: 34,
    urgency: 0.9,
    plan: "finish_counter_juke",
    horizon: THREE.MathUtils.lerp(0.38, 0.58, planning),
    score: 34 + closeScale * 38,
  }));
  return jobs;
}

function containmentTagJobs(target, facts, config, future, forward, lateral, inward) {
  const planning = clamp01(finite(config.planningSkill) / 1.35);
  if (planning < 0.72 || target.contactDistance < TAG_RANGE + 24 || target.contactDistance > 58) return [];
  const targetPos = carPosition(target.car, tmpVec3A);
  const awayFromTagger = tangentDirection(facts.position, targetPos, facts.surfaceNormal, facts.forward, tmpVec3B);
  const speedT = clamp01(target.speed / 34);
  const sideSign = Math.sign(finite(target.angle)) || 1;
  const escapeDeny = future.clone()
    .addScaledVector(awayFromTagger, THREE.MathUtils.lerp(8, 18, planning))
    .addScaledVector(lateral, sideSign * THREE.MathUtils.lerp(8, 18, speedT))
    .addScaledVector(inward, THREE.MathUtils.lerp(4, 14, clamp01((Math.hypot(targetPos.x, targetPos.z) - curveStartRadius()) / 32)));
  projectArenaSurfacePoint(escapeDeny, facts, 4);
  const routeRisk = featureRiskAlong(facts.position, escapeDeny, facts) + surfaceRisk(escapeDeny, facts, surfaceDirectionToPoint(facts.position, escapeDeny, facts, tmpVec3C));
  if (routeRisk > THREE.MathUtils.lerp(0.72, 0.96, planning)) return [];
  const jobs = [makeJob({
    type: "tag",
    point: escapeDeny,
    target,
    desiredSpeed: THREE.MathUtils.lerp(38, 46, planning),
    urgency: 0.74,
    plan: "contain_escape_lane",
    horizon: THREE.MathUtils.lerp(0.88, 1.28, planning),
    score: 28 + clamp01((target.contactDistance - 20) / 38) * 32 + speedT * 24,
  })];
  if (planning > 0.9 && target.contactDistance > TAG_RANGE + 32) {
    const radius = Math.hypot(targetPos.x, targetPos.z);
    const boundary = clamp01((radius - curveStartRadius()) / 34);
    const herdPoint = future.clone()
      .addScaledVector(lateral, -sideSign * THREE.MathUtils.lerp(18, 30, speedT))
      .addScaledVector(inward, THREE.MathUtils.lerp(14, 34, boundary))
      .addScaledVector(forward, THREE.MathUtils.lerp(10, 20, speedT));
    projectArenaSurfacePoint(herdPoint, facts, 4);
    const herdRisk = featureRiskAlong(facts.position, herdPoint, facts) * 0.7 + surfaceRisk(herdPoint, facts, surfaceDirectionToPoint(facts.position, herdPoint, facts, tmpVec3C));
    if (herdRisk < 0.86) {
      jobs.push(makeJob({
        type: "tag",
        point: herdPoint,
        target,
        desiredSpeed: 44,
        urgency: 0.68,
        plan: "herd_escape_lane",
        horizon: THREE.MathUtils.lerp(1.32, 1.85, planning),
        score: 26 + speedT * 30 + boundary * 18,
      }));
    }
  }
  return jobs;
}

function runnerControlSearchTemplates(car, config, facts) {
  if (!facts.threat) return [];
  const planning = clamp01(finite(config.planningSkill) / 1.35);
  if (planning < 0.5) return [];
  if (facts.threatRisk < 0.12 && facts.threat.contactDistance > 34) return [];
  const threatPos = carPosition(facts.threat.car, tmpVec3A);
  const threatLocal = tangentDirection(facts.position, threatPos, facts.surfaceNormal, facts.forward, tmpVec3C);
  threatLocal.applyQuaternion(carQuaternion(car).invert());
  const steerAway = THREE.MathUtils.clamp(-Math.atan2(threatLocal.x, threatLocal.z) / 0.95, -1, 1);
  const side = Math.sign(steerAway) || 1;
  const canBoost = (steer = steerAway) => canBoostNow(facts, config, steer);
  const elevatedThreat = facts.threat.verticalGap > 1.5 || finite(facts.threat.wheels, 4) <= 1;
  const templates = [
    { label: "evade_commit", horizon: 0.56, sequence: [{ duration: 0.56, steer: steerAway, throttle: 1 }] },
    { label: "evade_cut_left", horizon: 0.62, sequence: [{ duration: 0.2, steer: side, throttle: 0.78 }, { duration: 0.42, steer: -side * 0.65, throttle: 1 }] },
    { label: "evade_cut_right", horizon: 0.62, sequence: [{ duration: 0.2, steer: -side, throttle: 0.78 }, { duration: 0.42, steer: side * 0.65, throttle: 1 }] },
  ];
  if (planning >= 0.72) {
    templates.push(
      { label: "evade_late_hook", horizon: 0.68, sequence: [{ duration: 0.16, steer: steerAway * 0.3, throttle: 1 }, { duration: 0.22, steer: -side, throttle: 0.82 }, { duration: 0.3, steer: side * 0.9, throttle: 1 }] },
      { label: "evade_brake_juke", horizon: 0.72, sequence: [{ duration: 0.18, steer: -side, throttle: -0.35 }, { duration: 0.54, steer: side, throttle: 1 }] },
      { label: "evade_snapback", horizon: 0.66, sequence: [{ duration: 0.18, steer: side, throttle: 1 }, { duration: 0.16, steer: -side, throttle: -0.18 }, { duration: 0.32, steer: -side * 0.85, throttle: 1 }] },
      ...(canBoost(steerAway * 0.74) && facts.threatRisk > 0.18 ? [{ label: "evade_boost_escape", horizon: 0.7, sequence: [{ duration: 0.7, steer: steerAway * 0.74, throttle: 1, boost: true }] }] : []),
    );
  }
  if (planning >= 0.92) {
    templates.push(
      { label: "evade_pivot", horizon: 0.82, sequence: [{ duration: 0.22, steer: -side, throttle: -0.55 }, { duration: 0.6, steer: side, throttle: 1 }] },
      ...(canJumpNow(facts) && facts.threat.contactDistance < TAG_RANGE + 9 && facts.threatRisk > 0.32 && !elevatedThreat
        ? [{ label: "evade_jump_over", horizon: 0.58, sequence: [{ duration: 0.58, steer: steerAway * 0.5, throttle: 1, jump: true }] }]
        : []),
    );
  }
  return templates;
}

function tagCandidatesForTarget(car, target, facts, config, options = {}) {
  const jobs = [];
  const pos = carPosition(target.car, new THREE.Vector3());
  const velocity = carVelocity(target.car, new THREE.Vector3());
  const targetNormal = target.surfaceNormal?.isVector3 ? target.surfaceNormal : WORLD_UP;
  velocity.addScaledVector(targetNormal, -velocity.dot(targetNormal));
  const speed = velocity.length();
  const forward = speed > EPS ? velocity.clone().normalize() : targetForward(target, new THREE.Vector3());
  const planning = clamp01(finite(config.planningSkill) / 1.35);
  const leadTime = THREE.MathUtils.clamp(target.contactDistance / Math.max(18, facts.speed + speed * 0.7), 0.12, THREE.MathUtils.lerp(1.05, 1.55, planning));
  const future = pos.clone().addScaledVector(velocity, leadTime);
  projectArenaSurfacePoint(future, facts, 4);
  const inward = inwardDirection(future, new THREE.Vector3(), facts.surfaceNormal);
  const side = Math.sign(future.clone().sub(facts.position).cross(forward).dot(facts.surfaceNormal)) || car.ai.lateralSign || 1;
  const lateral = perpendicular(forward, side, new THREE.Vector3(), facts.surfaceNormal);
  const actualLocal = tangentDirection(facts.position, pos, facts.surfaceNormal, facts.forward, new THREE.Vector3());
  actualLocal.applyQuaternion(carQuaternion(car).invert());
  const behind = actualLocal.z < -0.1 && target.contactDistance < 24;

  jobs.push(makeJob({
    type: "tag",
    point: pos,
    target,
    desiredSpeed: target.contactDistance < TAG_RANGE + 6 ? 32 : behind ? 18 : 36,
    urgency: 1,
    plan: behind ? "reverse_tag" : "direct_tag",
  }));
  jobs.push(makeJob({
    type: "tag",
    point: future.clone().addScaledVector(forward, 6 + speed * 0.18),
    target,
    desiredSpeed: 42,
    urgency: 0.72,
    plan: "lead_tag",
  }));
  jobs.push(makeJob({
    type: "tag",
    point: future.clone().addScaledVector(inward, 14).addScaledVector(forward, 10),
    target,
    desiredSpeed: 40,
    urgency: 0.66,
    plan: "cutoff_tag",
  }));
  jobs.push(makeJob({
    type: "tag",
    point: future.clone().addScaledVector(lateral, 13).addScaledVector(forward, 7),
    target,
    desiredSpeed: 38,
    urgency: 0.56,
    plan: "angle_tag",
  }));
  jobs.push(makeJob({
    type: "tag",
    point: future.clone().addScaledVector(lateral, -13).addScaledVector(forward, 7),
    target,
    desiredSpeed: 38,
    urgency: 0.56,
    plan: "cross_tag",
  }));
  if (!behind) jobs.push(...closeCounterFinishJobs(target, facts, config, forward, lateral));
  jobs.push(...containmentTagJobs(target, facts, config, future, forward, lateral, inward));
  const actionSearch = options.actionSearch !== false;
  const deepPredict = options.deepPredict !== false;
  const adaptivePredict = options.adaptivePredict !== false;

  for (const template of finishActionTemplates(config, target, facts)) {
    const first = template.sequence[0] ?? { steer: 0, throttle: 1 };
    const action = {
      steer: first.steer,
      throttle: first.throttle,
      boost: template.sequence.some((segment) => segment.boost),
      jump: template.sequence.some((segment) => segment.jump),
      sequence: template.sequence,
    };
    const rollout = rolloutActionSequence(facts, action, template.horizon, target);
    jobs.push(makeJob({
      type: "tag",
      point: rollout.position.clone(),
      target,
      desiredSpeed: Math.max(24, rollout.speed),
      urgency: 1,
      plan: template.label,
      horizon: template.horizon,
      action,
      rollout,
      score: 38,
    }));
  }
  jobs.push(...tagFeatureInterceptJobs(target, facts, config, future, forward, side));
  if (planning > 0.72 && target.contactDistance > TAG_RANGE + 14 && canBoostNow(facts, config, 0)) {
    const boostPoint = future.clone().addScaledVector(forward, 10 + speed * 0.12);
    projectArenaSurfacePoint(boostPoint, facts, 4);
    const boostDirection = surfaceDirectionToPoint(facts.position, boostPoint, facts, tmpVec3D);
    const boostRouteRisk =
      featureRiskAlong(facts.position, boostPoint, facts) * 0.7 +
      surfaceRisk(boostPoint, facts, boostDirection);
    if (boostRouteRisk < THREE.MathUtils.lerp(0.38, 0.64, planning)) {
      jobs.push(makeJob({
        type: "tag",
        point: boostPoint,
        target,
        desiredSpeed: 52,
        urgency: 0.84,
        plan: "tag_boost_lane",
        horizon: THREE.MathUtils.lerp(0.72, 1.08, planning),
        score: 28 + clamp01((target.contactDistance - TAG_RANGE - 12) / 44) * 34,
      }));
    }
  }
  if (target.contactDistance > 22 && speed > 8 && planning > 0.62) {
    const longHorizons = deepPredict ? [
      THREE.MathUtils.lerp(1.25, 1.65, planning),
      THREE.MathUtils.lerp(1.7, 2.35, planning),
      THREE.MathUtils.lerp(2.15, 3.05, planning),
    ] : [THREE.MathUtils.lerp(1.25, 1.65, planning)];
    for (const [index, horizon] of longHorizons.entries()) {
      const orbitFuture = predictOrbitPosition(pos, velocity, horizon, new THREE.Vector3());
      projectArenaSurfacePoint(orbitFuture, facts, 4);
      const orbitForward = targetForward(target, new THREE.Vector3());
      const orbitInward = inwardDirection(orbitFuture, new THREE.Vector3(), facts.surfaceNormal);
      const toFuture = tangentDirection(facts.position, orbitFuture, facts.surfaceNormal, facts.forward, new THREE.Vector3());
      const orbitSide = Math.sign(toFuture.cross(orbitForward).dot(facts.surfaceNormal)) || side;
      const orbitLateral = perpendicular(orbitForward, orbitSide, new THREE.Vector3(), facts.surfaceNormal);
      jobs.push(makeJob({
        type: "tag",
        point: orbitFuture.clone().addScaledVector(orbitInward, 20 + index * 8).addScaledVector(orbitForward, 8 + index * 7),
        target,
        desiredSpeed: 42 + index * 2,
        urgency: 0.7 + index * 0.06,
        plan: index >= 1 ? "deep_cutoff_tag" : "orbit_cutoff_tag",
        horizon,
      }));
      jobs.push(makeJob({
        type: "tag",
        point: orbitFuture.clone().addScaledVector(orbitLateral, (index + 1) * 12).addScaledVector(orbitForward, 8),
        target,
        desiredSpeed: 40 + index * 2,
        urgency: 0.62,
        plan: "arc_pinch_tag",
        horizon,
      }));
    }
  }
  const adaptiveSignal = target.memory
    ? Math.max(Math.abs(finite(target.memory.turnBias)), finite(target.memory.brakeBias), finite(target.memory.vulnerableBias))
    : 0;
  if (adaptivePredict && target.contactDistance > 20 && planning > 0.72 && finite(target.memory?.samples) > 12 && adaptiveSignal > 0.18) {
    const adaptiveHorizons = planning > 0.9
      ? [1.15, 1.8, 2.55]
      : planning > 0.75
        ? [1.0, 1.55]
        : [1.1];
    const maxFutures = planning > 0.9 ? 2 : 1;
    for (const horizon of adaptiveHorizons) {
      const futures = opponentHypothesisPositions(target, horizon);
      const weights = opponentHypothesisWeights(target);
      const chosen = [-1, -1, -1];
      for (let pick = 0; pick < maxFutures; pick += 1) {
        let bestIndex = -1;
        let bestWeight = -Infinity;
        for (let i = 0; i < futures.length; i += 1) {
          if (chosen.includes(i)) continue;
          const weight = finite(weights[i], 1);
          if (weight > bestWeight) {
            bestWeight = weight;
            bestIndex = i;
          }
        }
        chosen[pick] = bestIndex;
        if (bestIndex < 0) continue;
        const adaptiveFuture = tmpVec3E.copy(futures[bestIndex]);
        projectArenaSurfacePoint(adaptiveFuture, facts, 4);
        const futureForward = targetForward(target, tmpVec3F);
        const adaptiveInward = inwardDirection(adaptiveFuture, new THREE.Vector3(), facts.surfaceNormal);
        const toAdaptive = tangentDirection(facts.position, adaptiveFuture, facts.surfaceNormal, facts.forward, new THREE.Vector3());
        const adaptiveSide = Math.sign(toAdaptive.cross(futureForward).dot(facts.surfaceNormal)) || side;
        const adaptiveLateral = perpendicular(futureForward, adaptiveSide, new THREE.Vector3(), facts.surfaceNormal);
        const pressure = clamp01(bestWeight / 2.4);
        jobs.push(makeJob({
          type: "tag",
          point: adaptiveFuture
            .addScaledVector(adaptiveInward, 10 + horizon * 4 + pressure * 8)
            .addScaledVector(adaptiveLateral, (6 + horizon * 3) * (bestIndex === 3 ? -1 : 1))
            .addScaledVector(futureForward, 5 + horizon * 2),
          target,
          desiredSpeed: 40 + horizon * 2,
          urgency: 0.68 + pressure * 0.18,
          plan: "adaptive_intercept_tag",
          horizon,
        }));
      }
    }
  }
  if (actionSearch) {
    for (const template of tagControlSearchTemplates(config, target, facts)) {
      const first = template.sequence[0] ?? { steer: 0, throttle: 1 };
      const action = {
        steer: first.steer,
        throttle: first.throttle,
        boost: template.sequence.some((segment) => segment.boost),
        jump: template.sequence.some((segment) => segment.jump),
        sequence: template.sequence,
      };
      const horizon = template.horizon;
      const rollout = rolloutActionSequence(facts, action, horizon, target);
      const point = rollout.position.clone();
      jobs.push(makeJob({
        type: "tag",
        point,
        target,
        desiredSpeed: Math.max(30, rollout.speed),
        urgency: 0.72,
        plan: template.label,
        horizon,
        action,
        rollout,
      }));
    }
  }
  return jobs;
}

function scoreTagJob(car, job, facts, config, personality) {
  const target = job.target;
  if (!target || target.immunity > 0) return -100000;
  const risk = riskAppetite(config, personality);
  const horizon = finite(job.horizon, THREE.MathUtils.lerp(0.62, 1.18, clamp01(finite(config.planningSkill) / 1.35)));
  const rollout = job.rollout ?? rolloutDrive(facts, job.point, config, {
    desiredSpeed: job.desiredSpeed,
    horizon,
    boost: canBoostNow(facts, config, 0) && finite(config.boostSkill) > 1.05 && target.contactDistance > TAG_RANGE + 8,
  });
  job.rollout = rollout;
  const targetFutures = opponentHypothesisPositions(target, horizon);
  const targetMids = opponentHypothesisPositions(target, horizon * 0.5);
  const targetWeights = opponentHypothesisWeights(target);
  let finalSum = 0;
  let windowSum = 0;
  let worstWindow = 0;
  let bestWindow = Infinity;
  let interceptSum = 0;
  let hypothesisWeight = 0;
  for (let i = 0; i < targetFutures.length; i += 1) {
    const weight = finite(targetWeights[i], 1);
    const final = rollout.position.distanceTo(targetFutures[i]);
    const path = segmentDistanceToPoint3D(facts.position, rollout.position, targetMids[i]);
    const window = Math.min(final, path);
    finalSum += final * weight;
    windowSum += window * weight;
    interceptSum += job.point.distanceTo(targetFutures[i]) * weight;
    hypothesisWeight += weight;
    worstWindow = Math.max(worstWindow, window);
    bestWindow = Math.min(bestWindow, window);
  }
  const hypothesisCount = Math.max(1, hypothesisWeight);
  const finalDistance = finalSum / hypothesisCount;
  const tagWindow = windowSum / hypothesisCount * 0.65 + worstWindow * 0.25 + bestWindow * 0.1;
  const tagChance = (1 - clamp01((tagWindow - TAG_RANGE) / 25)) * 265;
  const crossingPressure = runnerCrossingPressure(target, facts);
  const conversionReadiness = clamp01(
    0.22 +
    (1 - finite(target.mobility, 1)) * 0.9 +
    (finite(target.wheels, 4) <= 1 ? 0.34 : finite(target.wheels, 4) <= 2 ? 0.18 : 0) +
    (target.contactDistance < TAG_RANGE + 6 ? 0.22 : 0)
  );
  const conversionValue =
    target.contactDistance < TAG_RANGE + 18
      ? (
        (1 - clamp01((tagWindow - TAG_RANGE) / 11)) * 126 +
        (1 - clamp01((finalDistance - TAG_RANGE) / 16)) * 68
      ) * conversionReadiness
      : 0;
  const progress = THREE.MathUtils.clamp(target.contactDistance - finalDistance, -28, 52) * 1.7;
  const directFinish = target.contactDistance < TAG_RANGE + 8 && job.plan === "direct_tag"
    ? (TAG_RANGE + 8 - target.contactDistance) * 40
    : 0;
  const closeDirectBias = target.contactDistance < 18
    ? (job.plan === "direct_tag" || job.plan === "reverse_tag" ? 148 : job.plan.startsWith?.("finish_") ? 46 : job.action ? 6 : -28)
    : 0;
  const closeConversionDiscipline = target.contactDistance < TAG_RANGE + 11
    ? (
      job.plan === "direct_tag" || job.plan === "reverse_tag"
        ? 120
        : job.plan.startsWith?.("finish_")
          ? 92
          : job.plan === "search_brake_in" || job.plan === "search_hook_in" || job.plan === "search_commit"
            ? 48
            : job.plan.startsWith?.("search_")
              ? 12
              : -96
    )
    : target.contactDistance < TAG_RANGE + 18 &&
      (job.plan === "orbit_cutoff_tag" || job.plan === "deep_cutoff_tag" || job.plan === "arc_pinch_tag" || job.plan === "tag_feature_cut" || job.plan === "tag_feature_bypass")
      ? -42
      : 0;
  const sealWindow = target.contactDistance < TAG_RANGE + 2.5;
  const sealValue = sealWindow
    ? (
      (job.plan === "direct_tag" || job.plan === "reverse_tag" ? 96 : 0) +
      (job.plan === "finish_commit" || job.plan === "finish_side_swipe" || job.plan === "finish_brake_turn" ? 74 : 0) +
      (job.plan === "search_hook_in" || job.plan === "search_brake_in" ? 38 : 0) -
      (job.plan === "finish_escape_block" || job.plan === "finish_counter_juke" || job.plan === "contain_escape_lane" || job.plan === "herd_escape_lane" ? 118 : 0)
    ) * (1 - clamp01((target.contactDistance - TAG_RANGE) / 2.5))
    : 0;
  const interceptDistance = interceptSum / hypothesisCount;
  const predictivePlan =
    job.plan === "lead_tag" ||
    job.plan === "cutoff_tag" ||
    job.plan === "angle_tag" ||
    job.plan === "cross_tag" ||
    job.plan === "orbit_cutoff_tag" ||
    job.plan === "deep_cutoff_tag" ||
    job.plan === "arc_pinch_tag" ||
    job.plan === "contain_escape_lane" ||
    job.plan === "herd_escape_lane" ||
    job.plan === "adaptive_intercept_tag" ||
    job.plan === "tag_feature_bypass" ||
    job.plan === "tag_feature_cut" ||
    job.plan === "tag_boost_lane" ||
    job.plan === "finish_escape_block" ||
    job.plan === "finish_counter_juke" ||
    job.plan.startsWith?.("finish_") ||
    job.plan.startsWith?.("search_");
  const predictiveValue =
    predictivePlan && target.contactDistance > 18
      ? (1 - clamp01((interceptDistance - 10) / 30)) * (36 + risk * 18 + clamp01(target.speed / 32) * (42 + risk * 20))
      : 0;
  const longCutoffValue =
    (job.plan === "orbit_cutoff_tag" || job.plan === "deep_cutoff_tag" || job.plan === "arc_pinch_tag" || job.plan === "contain_escape_lane" || job.plan === "herd_escape_lane") && target.contactDistance > 26
      ? clamp01((horizon - 1.1) / 1.8) * clamp01(target.speed / 26) * (52 + risk * 44)
      : 0;
  const containmentValue =
    job.plan === "contain_escape_lane" || job.plan === "herd_escape_lane"
      ? clamp01((target.contactDistance - TAG_RANGE - 10) / 38) * (
        (job.plan === "herd_escape_lane" ? 38 : 48) +
        clamp01(target.speed / 32) * 42 +
        clamp01((target.contactDistance - finalDistance) / 26) * 38
      )
      : 0;
  const multiAgentValue =
    finite(config.planningSkill) > 0.9 && predictivePlan && target.contactDistance > 24 && facts.runners.length > 2
      ? Math.min(18, tagMultiAgentOpportunity(target, job, facts, horizon) * THREE.MathUtils.lerp(0.12, 0.28, risk))
      : 0;
  const tagRouteValue =
    job.plan === "tag_feature_bypass"
      ? clamp01((target.speed + facts.speed) / 70) * 28 + clamp01((target.contactDistance - 18) / 42) * 24
      : job.plan === "tag_feature_cut"
        ? clamp01((target.contactDistance - TAG_RANGE - 8) / 34) * 32 + clamp01((1 - target.mobility) * 1.4) * 20
        : job.plan === "tag_boost_lane"
          ? clamp01((target.contactDistance - TAG_RANGE - 12) / 44) * 46 + clamp01(target.speed / 36) * 24
          : 0;
  const contactPatchPlan = job.plan === "finish_contact_patch";
  const counterFinishValue =
    job.plan === "finish_escape_block" || job.plan === "finish_counter_juke" || contactPatchPlan
      ? clamp01((TAG_RANGE + 22 - target.contactDistance) / 22) * (
        (contactPatchPlan ? 64 : 74) +
        clamp01(target.speed / 34) * 34 +
        clamp01(Math.abs(finite(target.angle)) / 1.2) * 22 +
        (job.plan === "finish_escape_block" || contactPatchPlan ? crossingPressure * 88 : 0) +
        (target.memory ? clamp01(Math.abs(finite(target.memory.turnBias)) * finite(target.memory.confidence, 1)) * 18 : 0)
      )
      : 0;
  const lateralFinishValue =
    crossingPressure > 0.08 && target.contactDistance < TAG_RANGE + 20
      ? (
        (job.plan === "finish_escape_block" || job.plan === "finish_side_swipe" || contactPatchPlan ? 88 : 0) +
        (job.plan === "finish_counter_juke" ? 22 : 0) +
        (job.plan === "search_hook_in" || job.plan === "search_cut_out" || job.plan === "search_boost_cut_out" ? 46 : 0) -
        (job.plan === "finish_commit" || job.plan === "direct_tag" || job.plan === "search_commit" ? 64 : 0)
      ) * crossingPressure
      : 0;
  const escapeCoverage = closeEscapeCoverage(job, target, facts, horizon);
  const escapeCoverageValue = escapeCoverage * (
    job.plan === "finish_escape_block" || job.plan === "finish_counter_juke" || contactPatchPlan
      ? contactPatchPlan ? 96 : 118
      : job.plan.startsWith?.("finish_")
        ? 76
        : job.plan.startsWith?.("search_")
          ? 42
          : 24
  );
  const targetMemoryConfidence = target.memory
    ? clamp01(finite(target.memory.confidence) * finite(target.memory.recentness, 1))
    : 0;
  const targetBait = target.memory ? clamp01(finite(target.memory.baitBias) * targetMemoryConfidence) : 0;
  const baitCounterValue = targetBait > 0.05
    ? (
      (job.plan === "tag_feature_bypass" || job.plan === "tag_feature_cut" || job.plan === "finish_brake_turn" ? 44 : 0) -
      (job.plan === "direct_tag" || job.plan === "tag_boost_lane" || job.plan === "search_boost_commit" ? 58 : 0)
    ) * targetBait * clamp01((target.contactDistance - TAG_RANGE) / 24)
    : 0;
  const actionValue =
    job.action && target.contactDistance > TAG_RANGE + 5
      ? (1 - clamp01((tagWindow - TAG_RANGE) / 28)) * (64 + risk * 42) +
        clamp01((target.contactDistance - finalDistance) / 36) * 54 +
        clamp01((Math.abs(target.angle) - 0.45) / 1.35) * clamp01(facts.speed / 30) * (58 + risk * 28) +
        clamp01((finite(rollout.exitAlignment) + 0.25) / 1.25) * (12 + risk * 22) +
        (job.action.boost ? clamp01((target.contactDistance - 18) / 34) * (18 + risk * 18) : 0)
      : 0;
  const overshoot = overshootRisk(target, facts, Math.min(0.9, horizon));
  const overshootValue = overshoot > 0.05
    ? (
      (job.plan === "finish_brake_turn" || job.plan === "finish_side_swipe" || job.plan === "search_brake_in" || job.plan === "search_hook_in" || job.plan === "reverse_tag" ? 58 : 0) -
      (job.plan === "direct_tag" || job.plan === "lead_tag" || job.plan === "search_boost_commit" || job.plan === "tag_boost_lane" ? 52 : 0)
    ) * overshoot
    : 0;
  const directFollowCost =
    job.plan === "direct_tag" && target.contactDistance > 26 && target.speed > 10
      ? clamp01((target.contactDistance - 26) / 36) * clamp01(target.speed / 32) * 70
      : 0;
  const detachedTargetCost =
    Math.abs(finite(target.surfaceDistance)) > 8 && target.contactDistance > TAG_RANGE + 12
      ? clamp01((Math.abs(finite(target.surfaceDistance)) - 8) / 28) * clamp01((target.contactDistance - TAG_RANGE - 12) / 32) * 320
      : 0;
  const verticalReachCost =
    target.verticalGap > 10 && target.contactDistance > TAG_RANGE + 12
      ? clamp01((target.verticalGap - 10) / 28) * clamp01((target.contactDistance - TAG_RANGE - 12) / 32) * 420
      : 0;
  const tagFeatureRoute = job.plan === "tag_feature_bypass" || job.plan === "tag_feature_cut";
  const tagBoostLane = job.plan === "tag_boost_lane";
  const routeCost =
    featureRiskAlong(facts.position, job.point, facts) * (tagFeatureRoute ? 12 : tagBoostLane ? 18 : 34) +
    surfaceRisk(job.point, facts, surfaceDirectionToPoint(facts.position, job.point, facts, tmpVec3D)) * 34 +
    rollout.surfaceLoad * 14 +
    rollout.turnLoad * 12;
  const riskAdjustedRouteCost = routeCost * THREE.MathUtils.lerp(1.22, 0.82, risk);
  const targetStickiness = target.id === car.ai.targetId && target.contactDistance < 42 ? 6 : 0;
  const learnedTacticValue = tacticBias(car.ai, job.plan) * THREE.MathUtils.lerp(10, 34, clamp01(finite(config.planningSkill) / 1.35));
  const staleFinishPressure = target.id === car.ai.finishPressureTargetId
    ? clamp01(finite(car.ai.finishPressureTimer) / 2.4) * (1 - clamp01((finite(car.ai.finishPressureMinDistance, Infinity) - TAG_RANGE) / 14))
    : 0;
  const staleFinishValue = staleFinishPressure > 0.05
    ? (
      (job.plan === "direct_tag" || job.plan === "reverse_tag" ? 42 : 0) +
      (job.plan.startsWith?.("finish_") || job.plan.startsWith?.("search_") ? 66 : 0) +
      (job.plan === "finish_contact_patch" || job.plan === "finish_escape_block" || job.plan === "finish_counter_juke" ? 44 : 0) -
      (job.plan === "lead_tag" || job.plan === "contain_escape_lane" || job.plan === "herd_escape_lane" || job.plan === "cutoff_tag" ? 54 : 0)
    ) * staleFinishPressure
    : 0;
  return (
    tagEaseValue(target) * finite(config.aggression) * personality.chase +
    tagStrategicValue(target, facts, config, personality) +
    tagChance +
    conversionValue +
    progress +
    directFinish +
    closeDirectBias +
    closeConversionDiscipline +
    sealValue +
    predictiveValue +
    longCutoffValue +
    containmentValue +
    multiAgentValue +
    tagRouteValue +
    counterFinishValue +
    lateralFinishValue +
    escapeCoverageValue +
    baitCounterValue +
    overshootValue +
    actionValue +
    learnedTacticValue +
    staleFinishValue +
    targetStickiness -
    directFollowCost -
    detachedTargetCost -
    verticalReachCost -
    riskAdjustedRouteCost
  );
}

function deepTagJobAdjustment(job, facts, config) {
  if (!job?.target || !job.rollout) return 0;
  const planning = clamp01(finite(config.planningSkill) / 1.35);
  if (planning < 0.72) return 0;
  const horizon = THREE.MathUtils.clamp(finite(job.horizon, 1) + THREE.MathUtils.lerp(0.32, 0.82, planning), 0.7, 3.2);
  const futures = opponentHypothesisPositions(job.target, horizon);
  const weights = opponentHypothesisWeights(job.target);
  let weightedClosest = 0;
  let weightedEscape = 0;
  let worstCounter = 0;
  let totalWeight = 0;
  for (let i = 0; i < futures.length; i += 1) {
    const weight = finite(weights[i], 1);
    const distance = job.rollout.position.distanceTo(futures[i]);
    weightedClosest += distance * weight;
    weightedEscape += Math.max(0, distance - TAG_RANGE) * weight;
    worstCounter = Math.max(worstCounter, distance * THREE.MathUtils.lerp(0.82, 1.18, clamp01(weight / 2)));
    totalWeight += weight;
  }
  const averageClosest = weightedClosest / Math.max(1, totalWeight);
  const averageEscape = weightedEscape / Math.max(1, totalWeight);
  const conversion = 1 - clamp01((averageClosest - TAG_RANGE) / 24);
  const containment = 1 - clamp01(averageEscape / 42);
  const counterProof = 1 - clamp01((worstCounter - TAG_RANGE) / 32);
  const routeHealth = 1 - clamp01(finite(job.rollout.surfaceLoad) * 0.8 + finite(job.rollout.turnLoad) * 0.35);
  return conversion * (70 + planning * 48) + containment * 34 + counterProof * (14 + planning * 24) + routeHealth * 18;
}

function deepRunnerJobAdjustment(job, facts, config) {
  if (!facts.threat || !job.rollout) return 0;
  const planning = clamp01(finite(config.planningSkill) / 1.35);
  if (planning < 0.72) return 0;
  const horizon = THREE.MathUtils.clamp(finite(job.horizon, 1) + THREE.MathUtils.lerp(0.35, 0.9, planning), 0.8, 2.5);
  const threatFutures = opponentHypothesisPositions(facts.threat, horizon);
  const weights = opponentHypothesisWeights(facts.threat);
  let safety = 0;
  let totalWeight = 0;
  for (let i = 0; i < threatFutures.length; i += 1) {
    const weight = finite(weights[i], 1);
    const distance = job.rollout.position.distanceTo(threatFutures[i]);
    safety += distance * weight;
    totalWeight += weight;
  }
  const averageSafety = safety / Math.max(1, totalWeight);
  const speedValue = clamp01(finite(job.rollout.speed) / 42) * 42;
  const dangerPenalty = (1 - clamp01((averageSafety - TAG_RANGE) / 32)) * 95;
  const routeHealth = 1 - clamp01(finite(job.rollout.surfaceLoad) * 0.8 + finite(job.rollout.turnLoad) * 0.24);
  return averageSafety * 0.5 + speedValue + routeHealth * 22 - dangerPenalty;
}

function applyTopKDeepening(candidates, count, adjust) {
  if (count <= 0) return;
  const top = [];
  for (const job of candidates) {
    for (let i = 0; i < count; i += 1) {
      if (!top[i] || finite(job.score, -Infinity) > finite(top[i].score, -Infinity)) {
        top.splice(i, 0, job);
        if (top.length > count) top.length = count;
        break;
      }
    }
  }
  for (const job of top) {
    const adjustment = adjust(job);
    job.score += adjustment;
    job.rolloutScore = job.score;
  }
}

function deepSearchCount(planning) {
  if (planning > 0.9) return 3;
  if (planning > 0.78) return 2;
  return 0;
}

function chooseTagJob(car, facts, config, personality) {
  let best = null;
  let bestScore = -Infinity;
  const scoredJobs = [];
  const planning = clamp01(finite(config.planningSkill) / 1.35);
  const targetLimit = planning > 0.9 ? 4 : planning > 0.72 ? 3 : 2;
  const selectedTargets = [];
  const finishTargets = facts.runners
    .filter((target) => target.immunity <= 0 && target.contactDistance < TAG_RANGE + 12)
    .sort((a, b) =>
      a.contactDistance - b.contactDistance ||
      tagTargetPriority(b, facts, config, personality) - tagTargetPriority(a, facts, config, personality)
    );
  if (finishTargets.length) {
    selectedTargets.push(...finishTargets.slice(0, Math.min(3, finishTargets.length)));
  }
  for (const target of facts.runners) {
    if (finishTargets.length) break;
    if (target.immunity <= 0 && target.contactDistance < TAG_RANGE + 14) selectedTargets.push(target);
  }
  while (!finishTargets.length && selectedTargets.length < Math.min(targetLimit, facts.runners.length)) {
    let bestTarget = null;
    let bestPriority = -Infinity;
    for (const target of facts.runners) {
      if (target.immunity > 0 || selectedTargets.includes(target)) continue;
      const priority = tagTargetPriority(target, facts, config, personality);
      if (priority > bestPriority) {
        bestPriority = priority;
        bestTarget = target;
      }
    }
    if (!bestTarget) break;
    selectedTargets.push(bestTarget);
  }
  for (let targetIndex = 0; targetIndex < selectedTargets.length; targetIndex += 1) {
    const target = selectedTargets[targetIndex];
    if (target.immunity > 0) continue;
    const immediate = target.contactDistance < TAG_RANGE + 18;
    const finishWindow = target.contactDistance < TAG_RANGE + 12;
    const compromised = finite(target.mobility, 1) < 0.76 || finite(target.wheels, 4) <= 2 || finite(target.upDot, 1) < 0.58;
    const highPriority = targetIndex === 0 || immediate || compromised || finishWindow;
    const candidateOptions = {
      actionSearch: finishWindow || highPriority || target.contactDistance < 48,
      deepPredict: targetIndex < 2 || highPriority,
      adaptivePredict: targetIndex < 2 || compromised,
    };
    for (const job of tagCandidatesForTarget(car, target, facts, config, candidateOptions)) {
      projectArenaSurfacePoint(job.point, facts, 4);
      const score = scoreTagJob(car, job, facts, config, personality);
      job.score = score;
      job.rolloutScore = score;
      scoredJobs.push(job);
    }
  }
  applyTopKDeepening(scoredJobs, deepSearchCount(planning), (job) =>
    deepTagJobAdjustment(job, facts, config)
  );
  for (const job of scoredJobs) {
    if (job.score > bestScore) {
      bestScore = job.score;
      best = job;
    }
  }
  return best ?? makeJob({
    type: "roam",
    point: facts.position.clone().addScaledVector(facts.forward, 26),
    desiredSpeed: 34,
    plan: "roam",
  });
}

function runnerCandidates(car, facts, config) {
  const jobs = [];
  const position = facts.position;
  const threatPos = facts.threat ? carPosition(facts.threat.car, new THREE.Vector3()) : null;
  const away = threatPos ? position.clone().sub(threatPos) : facts.forward.clone();
  projectOntoPlane(away, facts.surfaceNormal, facts.forward);
  const inward = inwardDirection(position, new THREE.Vector3(), facts.surfaceNormal);
  const lateral = perpendicular(away, car.ai.lateralSign || 1, new THREE.Vector3(), facts.surfaceNormal);
  const tangent = perpendicular(inward, car.ai.lateralSign || 1, new THREE.Vector3(), facts.surfaceNormal);
  const boundary = clamp01((Math.hypot(position.x, position.z) - curveStartRadius()) / 34);

  jobs.push(makeJob({
    type: "run",
    point: position.clone().addScaledVector(facts.forward, 38),
    threat: facts.threat,
    desiredSpeed: 40,
    urgency: facts.threatRisk,
    plan: "carry_speed",
  }));
  jobs.push(makeJob({
    type: "run",
    point: position.clone().addScaledVector(away, 42).addScaledVector(lateral, 22),
    threat: facts.threat,
    desiredSpeed: 43,
    urgency: facts.threatRisk,
    plan: "escape_angle",
  }));
  jobs.push(makeJob({
    type: "run",
    point: position.clone().addScaledVector(away, 38).addScaledVector(lateral, -22),
    threat: facts.threat,
    desiredSpeed: 43,
    urgency: facts.threatRisk,
    plan: "escape_cross",
  }));
  jobs.push(makeJob({
    type: "run",
    point: position.clone().addScaledVector(tangent, 42).addScaledVector(inward, boundary * 24),
    threat: facts.threat,
    desiredSpeed: 38,
    urgency: Math.max(0.1, facts.threatRisk),
    plan: "orbit_space",
  }));
  jobs.push(makeJob({
    type: "run",
    point: position.clone().addScaledVector(inward, 34 + boundary * 24).addScaledVector(facts.crowd.escape, facts.crowd.pressure * 24),
    threat: facts.threat,
    desiredSpeed: 36,
    urgency: Math.max(0.08, facts.crowd.pressure),
    plan: "open_space",
  }));
  if (facts.threat && facts.threatRisk > 0.2 && canBoostNow(facts, config, 0)) {
    const boostLane = away.clone().multiplyScalar(54).addScaledVector(lateral, car.ai.lateralSign * 18);
    const boostPoint = position.clone().add(boostLane);
    projectArenaSurfacePoint(boostPoint, facts, 8);
    if (featureRiskAlong(position, boostPoint, facts) < 0.42 && surfaceRisk(boostPoint, facts, surfaceDirectionToPoint(position, boostPoint, facts, tmpVec3D)) < 0.42) {
      jobs.push(makeJob({
        type: "run",
        point: boostPoint,
        threat: facts.threat,
        desiredSpeed: 50,
        urgency: Math.max(0.34, facts.threatRisk),
        plan: "boost_lane_escape",
        score: 34 + facts.threatRisk * 42,
      }));
    }
  }

  if (facts.crowd.pressure > 0.06) {
    jobs.push(makeJob({
      type: "run",
      point: position.clone().addScaledVector(facts.crowd.escape, 42).addScaledVector(facts.forward, 12),
      threat: facts.threat,
      desiredSpeed: 39,
      urgency: Math.max(facts.threatRisk, facts.crowd.pressure),
      plan: "uncrowd",
    }));
  }
  jobs.push(...featureEscapeJobs(car, facts, config));
  jobs.push(...runnerBaitJobs(car, facts, config));
  for (const template of runnerControlSearchTemplates(car, config, facts)) {
    const first = template.sequence[0] ?? { steer: 0, throttle: 1 };
    const action = {
      steer: first.steer,
      throttle: first.throttle,
      boost: template.sequence.some((segment) => segment.boost),
      jump: template.sequence.some((segment) => segment.jump),
      sequence: template.sequence,
    };
    const horizon = template.horizon;
    const rollout = rolloutActionSequence(facts, action, horizon, facts.threat);
    jobs.push(makeJob({
      type: "run",
      point: rollout.position.clone(),
      threat: facts.threat,
      desiredSpeed: Math.max(34, rollout.speed),
      urgency: Math.max(0.1, facts.threatRisk),
      plan: template.label,
      horizon,
      action,
      rollout,
    }));
  }
  return jobs;
}

function scoreRunnerJob(car, job, facts, config, personality) {
  const risk = riskAppetite(config, personality);
  const planning = clamp01(finite(config.planningSkill) / 1.35);
  const horizon = finite(job.horizon, THREE.MathUtils.lerp(0.78, 1.3, clamp01(finite(config.planningSkill) / 1.35)));
  const rollout = job.rollout ?? rolloutDrive(facts, job.point, config, {
    desiredSpeed: job.desiredSpeed,
    horizon,
    boost: canBoostNow(facts, config, 0) && facts.threatRisk > 0.25 && finite(config.boostSkill) > 0.75,
  });
  job.rollout = rollout;
  const intentionalFeature = job.plan === "feature_cut" || job.plan === "feature_escape" || job.plan === "feature_bypass";
  const boostLane = job.plan === "boost_lane_escape";
  const baitStop = job.plan === "feature_bait_stop";
  const pathRisk =
    featureRiskAlong(facts.position, job.point, facts) * (intentionalFeature || baitStop ? 8 : boostLane ? 18 : 30) +
    surfaceRisk(job.point, facts, surfaceDirectionToPoint(facts.position, job.point, facts, tmpVec3D)) * 42 +
    rollout.surfaceLoad * 22;
  const projectedRadius = Math.hypot(rollout.position.x, rollout.position.z);
  const surfaceCommitment = clamp01((projectedRadius - (finite(worldSpec?.floorRadius, 68) - 2)) / 30);
  const optionCost = surfaceCommitment * THREE.MathUtils.lerp(136, 34, clamp01(facts.threatRisk * 1.6)) * THREE.MathUtils.lerp(1.28, 0.78, risk);
  const crowdCost = pointCrowding(rollout.position, facts, 22) * 28 * personality.space * THREE.MathUtils.lerp(1.2, 0.88, risk);
  const trafficCost = runnerTrafficCost(car, rollout, facts, horizon) * personality.space * THREE.MathUtils.lerp(1.32, 0.86, risk);
  const closeThreat = facts.threat && facts.threat.contactDistance < TAG_RANGE + 16;
  const speedValue = rollout.speed * (closeThreat ? 0.68 : 0.4);
  const trend = car.ai.threatPattern ?? {};
  const closingPressure = clamp01((finite(trend.closingRate) - 2) / 26);
  const acceleratingPressure = clamp01(finite(trend.acceleration) / 22);
  const meterVolatility = clamp01(finite(trend.volatility));
  const stableGap = facts.threat
    ? clamp01((facts.threat.contactDistance - 24) / 34) * (1 - closingPressure)
    : 0;
  const turnCost = rollout.turnLoad * 10;
  const freezeCost = closeThreat && !baitStop
    ? (1 - clamp01((rollout.speed - 8) / 18)) * (58 + facts.threatRisk * 80)
    : 0;
  let survival = 0;

  if (facts.threat) {
    const threatFutures = opponentHypothesisPositions(facts.threat, horizon);
    const threatMids = opponentHypothesisPositions(facts.threat, horizon * 0.5);
    const threatWeights = opponentHypothesisWeights(facts.threat);
    let finalSum = 0;
    let pathSum = 0;
    let closestSum = 0;
    let worstClosest = Infinity;
    let tagRisk = 0;
    let hypothesisWeight = 0;
    const threatNow = carPosition(facts.threat.car, tmpVec3C);
    for (let i = 0; i < threatFutures.length; i += 1) {
      const weight = finite(threatWeights[i], 1);
      const final = rollout.position.distanceTo(threatFutures[i]);
      const path = segmentDistanceToPoint3D(threatNow, threatFutures[i], rollout.position);
      const crossing = segmentDistanceToPoint3D(facts.position, rollout.position, threatMids[i]);
      const closest = Math.min(final, path, crossing);
      finalSum += final * weight;
      pathSum += path * weight;
      closestSum += closest * weight;
      hypothesisWeight += weight;
      worstClosest = Math.min(worstClosest, closest);
      tagRisk = Math.max(
        tagRisk,
        (1 - clamp01((final - TAG_RANGE) / 30)) * clamp01(weight),
        (1 - clamp01((path - TAG_RANGE) / 24)) * clamp01(weight),
        (1 - clamp01((crossing - TAG_RANGE) / 22)) * clamp01(weight),
        (1 - clamp01((closest - TAG_RANGE) / 24)) * clamp01(weight),
      );
    }
    const hypothesisCount = Math.max(1, hypothesisWeight);
    const finalDistance = finalSum / hypothesisCount;
    const pathDistance = pathSum / hypothesisCount;
    const closestDistance = closestSum / hypothesisCount * 0.65 + worstClosest * 0.35;
    const closeJukeValue = job.action && closeThreat
      ? clamp01(facts.threatRisk * 2.2) * (
        clamp01((closestDistance - TAG_RANGE) / 22) * 72 +
        clamp01(rollout.speed / 34) * 36 +
        (job.action.boost ? 18 : 0)
      )
      : 0;
    const featureValue = intentionalFeature
      ? clamp01(facts.threatRisk * 1.8) * (job.plan === "feature_bypass" ? 12 + clamp01(rollout.speed / 42) * 24 : 20 + clamp01(rollout.speed / 38) * 22)
      : 0;
    const boostLaneValue = boostLane
      ? clamp01(facts.threatRisk * 1.8) * (24 + clamp01(rollout.speed / 48) * 26)
      : 0;
    const threatMemoryConfidence = facts.threat.memory
      ? clamp01(finite(facts.threat.memory.confidence) * finite(facts.threat.memory.recentness, 1))
      : 0;
    const overcommit = facts.threat.memory ? clamp01(finite(facts.threat.memory.overcommitBias) * threatMemoryConfidence) : 0;
    const baitCounter = facts.threat.memory ? clamp01((1 - finite(facts.threat.memory.overcommitBias)) * threatMemoryConfidence * 0.35) : 0;
    const baitValue = baitStop
      ? clamp01(facts.threatRisk * 2) * (
        34 +
        clamp01(facts.threat.speed / 34) * 28 -
        baitCounter * 82 +
        overcommit * 42 +
        closingPressure * 34 +
        meterVolatility * 18
      )
      : 0;
    const meterValue =
      (job.action ? (closingPressure + acceleratingPressure) * 18 : 0) +
      (boostLane ? closingPressure * 24 : 0) +
      (intentionalFeature ? (closingPressure * 12 + meterVolatility * 8) : 0) +
      (job.plan === "carry_speed" ? stableGap * 18 - closingPressure * 24 : 0) +
      (job.plan === "orbit_space" ? stableGap * 10 + meterVolatility * 9 : 0) +
      (baitStop ? meterVolatility * 14 : 0);
    const searchValue = job.action
      ? closestDistance * THREE.MathUtils.lerp(0.28, 0.94, clamp01(facts.threatRisk * 1.8)) +
        clamp01((finite(rollout.exitAlignment) + 0.2) / 1.2) * 12 +
        closeJukeValue
      : 0;
    survival = finalDistance * 1.25 + pathDistance * 0.8 + searchValue + featureValue + boostLaneValue + baitValue + meterValue - tagRisk * 170 * personality.survive * THREE.MathUtils.lerp(1.24, 0.9, risk);
  } else {
    survival = Math.hypot(rollout.position.x, rollout.position.z) < arenaLimit(12) ? 18 : 0;
  }

  const rankComfort = facts.threatRisk < 0.18 && facts.timeRemaining > 18
    ? (facts.selfRank <= 2 ? 8 : 0)
    : 0;
  const learnedTacticValue = tacticBias(car.ai, job.plan) * THREE.MathUtils.lerp(6, 22, planning);
  return survival + speedValue + rankComfort + learnedTacticValue - pathRisk - optionCost - crowdCost - trafficCost - turnCost - freezeCost;
}

function shouldDodgeThreat(car, facts, config) {
  car.ai.dodgeWindow = null;
  if (car.isIt || !facts.threat) return false;
  if (facts.wheels < 3 || facts.upDot < 0.72 || !facts.jumpReady) return false;
  const distance = facts.threat.contactDistance;
  if (distance < 5.5 || distance > 24) return false;
  const threatPosition = carPosition(facts.threat.car, tmpVec3C);
  const threatToSelf = tangentDirection(threatPosition, facts.position, facts.surfaceNormal, facts.forward, tmpVec3D);
  const approachSpeed = carVelocity(facts.threat.car, tmpVec3A).sub(facts.velocity).dot(threatToSelf);
  if (approachSpeed < THREE.MathUtils.lerp(9, 4.5, clamp01(finite(config.recoverySkill) / 1.35))) return false;
  const horizon = THREE.MathUtils.clamp(distance / Math.max(10, facts.threat.speed + facts.speed * 0.35), 0.18, 0.62);
  const selfFuture = tmpVec3A.copy(facts.position).addScaledVector(facts.velocity, horizon * 0.55);
  const threatFuture = predictPosition(facts.threat.car, horizon, tmpVec3B);
  const window = Math.min(
    segmentDistanceToPoint3D(threatPosition, threatFuture, selfFuture),
    selfFuture.distanceTo(threatFuture),
  );
  car.ai.dodgeWindow = window;
  car.ai.dodgeApproachSpeed = approachSpeed;
  return window < TAG_RANGE + 4.4;
}

function chooseRunnerJob(car, facts, config, personality) {
  let best = null;
  let bestScore = -Infinity;
  const dodgeThreat = shouldDodgeThreat(car, facts, config);
  const scoredJobs = [];
  const planning = clamp01(finite(config.planningSkill) / 1.35);
  for (const job of runnerCandidates(car, facts, config)) {
    projectArenaSurfacePoint(job.point, facts, 4);
    if (dodgeThreat && (job.plan.startsWith("escape") || job.plan.startsWith("evade"))) job.score += 70;
    const score = job.score + scoreRunnerJob(car, job, facts, config, personality);
    job.score = score;
    job.rolloutScore = score;
    scoredJobs.push(job);
  }
  applyTopKDeepening(scoredJobs, deepSearchCount(planning), (job) =>
    deepRunnerJobAdjustment(job, facts, config)
  );
  for (const job of scoredJobs) {
    if (job.score > bestScore) {
      bestScore = job.score;
      best = job;
    }
  }
  return best ?? makeJob({
    type: "run",
    point: facts.position.clone().addScaledVector(facts.forward, 28),
    desiredSpeed: 36,
    plan: "carry_speed",
  });
}

function shouldRecover(facts) {
  const supportDot = finite(facts.surfaceUpDot, facts.upDot);
  if (supportDot < 0.18) return true;
  if (Math.abs(facts.forwardY) > 0.84 && supportDot < 0.5) return true;
  if (facts.wheels <= 0 && facts.speed < 2.2 && Math.abs(finite(facts.surfaceDistance)) > 0.35) return true;
  if (facts.wheels <= 1 && supportDot < 0.58) return true;
  return facts.wheels <= 1 && facts.speed < 3.5 && supportDot < 0.72;
}

function shouldUnstick(facts, stuckTimer) {
  if (shouldRecover(facts)) return false;
  if (facts.speed > 3.2) return false;
  if (facts.wheels <= 0 && stuckTimer > 0.22) return true;
  if (stuckTimer > 0.72) return true;
  return facts.wheels >= 1 && facts.speed < 1.8 && stuckTimer > 0.3;
}

function chooseJob(car, facts, config, personality, canRight) {
  if (canRight && facts.surfaceUpDot < 0.58 && facts.speed < 5 && car.ai.jumpCooldown <= 0) {
    const job = makeJob({
      type: "recover",
      point: facts.position.clone().addScaledVector(facts.forward, 20),
      desiredSpeed: 12,
      urgency: 1,
      plan: "recover_jump",
      score: 999,
    });
    job.jump = true;
    return job;
  }
  if (shouldRecover(facts)) {
    return makeJob({
      type: "recover",
      point: facts.position.clone().addScaledVector(facts.forward, 20),
      desiredSpeed: 12,
      urgency: 1,
      plan: "recover",
      score: 999,
    });
  }
  if (shouldUnstick(facts, car.ai.stuckTimer)) {
    return makeJob({
      type: "unstick",
      point: facts.position.clone().addScaledVector(facts.forward, 20).addScaledVector(facts.crowd.escape, 18),
      desiredSpeed: 18,
      urgency: 1,
      plan: "unstick",
      score: 700,
    });
  }
  return car.isIt
    ? chooseTagJob(car, facts, config, personality)
    : chooseRunnerJob(car, facts, config, personality);
}

function hasImmediateTagOpportunity(facts) {
  return facts.runners.some((target) => target.immunity <= 0 && target.contactDistance < TAG_RANGE + 8);
}

function hasContactTagOpportunity(facts) {
  return facts.runners.some((target) => target.immunity <= 0 && target.contactDistance < TAG_RANGE + 1.5);
}

function hasFinishTagOpportunity(facts) {
  return facts.runners.some((target) => target.immunity <= 0 && target.contactDistance < TAG_RANGE + 5);
}

function localDirectionToPoint(car, point, fallback, normal = WORLD_UP) {
  const direction = tangentDirection(carPosition(car, tmpVec3B), point, normal, fallback, tmpVec3A);
  return direction.applyQuaternion(carQuaternion(car).invert());
}

function alignmentToPoint(car, point, normal = WORLD_UP) {
  const fallback = forwardOnPlane(car, normal, tmpVec3C);
  const toPoint = tangentDirection(carPosition(car, tmpVec3B), point, normal, fallback, tmpVec3A);
  const forward = forwardOnPlane(car, normal, tmpVec3D);
  return toPoint.dot(forward);
}

function speedThrottle(base, desiredSpeed, steer, facts) {
  const target = finite(desiredSpeed, 36);
  const error = target - facts.speed;
  let throttle = base;
  if (error < -6) throttle *= Math.abs(steer) > 0.65 ? 0.36 : 0.58;
  else if (error < 0) throttle *= THREE.MathUtils.lerp(0.65, 1, clamp01((error + 6) / 6));
  const steerRisk = clamp01((Math.abs(steer) - 0.7) / 0.3) * clamp01((facts.speed - 26) / 24);
  const uprightRisk = clamp01((0.9 - facts.surfaceUpDot) / 0.36);
  return throttle * THREE.MathUtils.lerp(1, 0.58, Math.max(steerRisk, uprightRisk));
}

function tractionLimitedThrottle(throttle, steer, facts) {
  if (throttle <= 0) return throttle;
  const driveDirection = tmpVec3D.copy(facts.forward).applyAxisAngle(facts.surfaceNormal, THREE.MathUtils.clamp(steer, -1, 1) * 0.48);
  projectOntoPlane(driveDirection, facts.surfaceNormal, facts.forward);
  const climbLoad = uphillClimbLoad(facts.position, facts, driveDirection, facts.speed);
  return throttle * THREE.MathUtils.lerp(1, 0.55, climbLoad);
}

function actionSegmentAtTime(sequence, time) {
  if (!Array.isArray(sequence) || !sequence.length) return null;
  let cursor = 0;
  for (const segment of sequence) {
    cursor += Math.max(0.001, finite(segment.duration, 0.001));
    if (time < cursor) return segment;
  }
  return sequence[sequence.length - 1];
}

function actionSequenceDuration(action) {
  const sequence = action?.sequence;
  if (!Array.isArray(sequence) || !sequence.length) return finite(action?.duration, 0);
  return sequence.reduce((sum, segment) => sum + Math.max(0.001, finite(segment.duration, 0.001)), 0);
}

function actionSequencesEqual(a, b) {
  const left = Array.isArray(a?.sequence) && a.sequence.length ? a.sequence : (a ? [a] : []);
  const right = Array.isArray(b?.sequence) && b.sequence.length ? b.sequence : (b ? [b] : []);
  if (left.length !== right.length || left.length <= 0) return false;
  for (let i = 0; i < left.length; i += 1) {
    const l = left[i];
    const r = right[i];
    if (Math.abs(finite(l.duration, 0) - finite(r.duration, 0)) > 0.001) return false;
    if (Math.abs(finite(l.steer, 0) - finite(r.steer, 0)) > 0.001) return false;
    if (Math.abs(finite(l.throttle, 0) - finite(r.throttle, 0)) > 0.001) return false;
    if (Boolean(l.boost) !== Boolean(r.boost)) return false;
    if (Boolean(l.jump) !== Boolean(r.jump)) return false;
  }
  return true;
}

function intentTargetValid(intent, facts, role) {
  if (!intent) return false;
  if (role === "tagger" && intent.target) {
    return facts.runners.some((entry) => entry.id === intent.target.id && entry.immunity <= 0);
  }
  if (role === "runner" && intent.threat) {
    return facts.threat?.id === intent.threat.id;
  }
  return true;
}

function intentHealthFailed(intent, facts, role, elapsed) {
  if (!intent || elapsed < 0.28) return false;
  if (role === "runner") {
    const close = facts.threat?.contactDistance < TAG_RANGE + 12;
    const badMotion = facts.speed < 5 && intent.plan !== "feature_bait_stop";
    const badState = facts.wheels <= 1 || facts.surfaceUpDot < 0.48;
    return Boolean(close && (badMotion || badState));
  }
  if (role === "tagger" && intent.target) {
    const target = facts.runners.find((runner) => runner.id === intent.target.id);
    if (!target) return true;
    const losingFinish = target.contactDistance > finite(intent.target.contactDistance, target.contactDistance) + 18 && target.contactDistance > TAG_RANGE + 16;
    const badMotion = facts.speed < 4 && facts.surfaceUpDot < 0.7 && target.contactDistance > TAG_RANGE + 10;
    return losingFinish || badMotion;
  }
  return false;
}

function driveUnstick(car, job, facts, config, rng) {
  const ai = car.ai;
  if (ai.unstickTimer <= 0) {
    ai.unstickTimer = THREE.MathUtils.lerp(1.35, 0.88, clamp01(finite(config.recoverySkill) / 1.35));
    const local = localDirectionToPoint(car, job.point, facts.forward, facts.surfaceNormal);
    ai.unstickSteer = Math.sign(Math.atan2(local.x, local.z)) || ai.lateralSign || 1;
    if (rng() < 0.18) ai.unstickSteer *= -1;
    ai.lateralSign = ai.unstickSteer;
  }
  const total = THREE.MathUtils.lerp(1.35, 0.88, clamp01(finite(config.recoverySkill) / 1.35));
  const reversing = clamp01(ai.unstickTimer / Math.max(0.001, total)) > 0.48;
  car.input.steer = ai.unstickSteer;
  car.input.throttle = reversing ? -0.78 : 1;
  car.input.airRoll = 0;
  car.input.boostQueued = !reversing && facts.speed < 7 && finite(car.boostCooldownRemaining) <= 0;
  ai.jumpCooldown = Math.max(ai.jumpCooldown, 0.35);
}

function applyCloseTagControl(car, job, facts) {
  if (job.type !== "tag" || !job.target) return false;
  const target = job.target;
  const directPlan = job.plan === "direct_tag" || job.plan === "reverse_tag";
  const finishPlan = job.plan?.startsWith?.("finish_") || job.plan?.startsWith?.("search_");
  const counterPlan = job.plan === "finish_escape_block" || job.plan === "finish_counter_juke";
  if (counterPlan && finite(car.ai?.intentElapsed) < 0.18) return false;
  if (!directPlan && (!finishPlan || target.contactDistance > (counterPlan ? TAG_RANGE + 5 : TAG_RANGE + 7))) return false;
  if (target.contactDistance > 42 || facts.wheels < 2 || facts.surfaceUpDot < 0.58) return false;

  const targetPoint = carPosition(target.car, tmpVec3A);
  const targetVelocity = carVelocity(target.car, tmpVec3B);
  targetVelocity.addScaledVector(facts.surfaceNormal, -targetVelocity.dot(facts.surfaceNormal));
  const leadTime = THREE.MathUtils.clamp(target.contactDistance / Math.max(18, facts.speed + target.speed * 0.5), 0.08, 0.32);
  const preservePatch = job.plan === "finish_contact_patch";
  const aimPoint = preservePatch
    ? tmpVec3F.copy(job.point)
    : tmpVec3F.copy(targetPoint).addScaledVector(targetVelocity, leadTime);
  if (!preservePatch && job.plan === "finish_escape_block" && job.point?.isVector3) {
    aimPoint.lerp(job.point, 0.32);
  }
  const targetAway = tangentDirection(facts.position, targetPoint, facts.surfaceNormal, facts.forward, tmpVec3D);
  const targetLateral = tmpVec3E.copy(targetVelocity).addScaledVector(targetAway, -targetVelocity.dot(targetAway));
  const lateralSpeed = targetLateral.length();
  if (!preservePatch && lateralSpeed > 5 && target.contactDistance < TAG_RANGE + 12) {
    aimPoint.addScaledVector(targetLateral.multiplyScalar(1 / lateralSpeed), THREE.MathUtils.clamp(lateralSpeed * 0.16, 1.2, 4.8));
  }
  if (!preservePatch && target.contactDistance < TAG_RANGE + 9) {
    const sideSign = Math.sign(runnerCrossingPressure(target, facts) * (finite(target.memory?.escapeSideBias) || 0)) ||
      Math.sign(finite(target.angle)) ||
      car.ai.lateralSign ||
      1;
    const sideAxis = perpendicular(targetAway, sideSign, tmpVec3B, facts.surfaceNormal);
    const sideAmount = THREE.MathUtils.lerp(0.55, 1.45, clamp01((TAG_RANGE + 9 - target.contactDistance) / 9));
    aimPoint.addScaledVector(sideAxis, sideAmount);
  }
  projectArenaSurfacePoint(aimPoint, facts, 4);
  const local = localDirectionToPoint(car, aimPoint, facts.forward, facts.surfaceNormal);
  const angle = Math.atan2(local.x, local.z);
  const absAngle = Math.abs(angle);
  const crossing = runnerCrossingPressure(target, facts);
  const steerCap = preservePatch
    ? 0.86
    : crossing > 0.12 && target.speed > 8 && absAngle < 1.08 ? 0.64 : 1;
  const steer = THREE.MathUtils.clamp(angle / 0.82, -steerCap, steerCap);
  car.input.steer = steer;

  if (job.plan === "reverse_tag" && target.contactDistance < 26 && facts.speed < 18) {
    const rearLocal = localDirectionToPoint(car, targetPoint, facts.forward, facts.surfaceNormal);
    if (rearLocal.z < -0.18) {
      const rearAngle = Math.atan2(rearLocal.x, -rearLocal.z);
      car.input.steer = THREE.MathUtils.clamp(-rearAngle / 0.88, -1, 1);
      car.input.throttle = target.contactDistance < TAG_RANGE + 3 ? -1 : -0.92;
      car.input.boostQueued = false;
      return true;
    }
  }

  if (absAngle > 1.18 && facts.speed > 16) {
    const throttle = preservePatch
      ? (facts.speed > 34 ? 0.58 : 0.92)
      : (facts.speed > 30 ? -0.28 : 0.12);
    car.input.throttle = tractionLimitedThrottle(throttle, car.input.steer, facts);
    car.input.boostQueued = false;
    return true;
  }

  if (absAngle > 0.68) {
    const throttle = preservePatch
      ? (facts.speed > 34 ? 0.62 : 0.92)
      : crossing > 0.12 && target.speed > 8 && absAngle < 1.08
      ? (facts.speed > 34 ? 0.62 : 0.88)
      : (facts.speed > 26 ? 0.38 : 0.74);
    car.input.throttle = tractionLimitedThrottle(throttle, car.input.steer, facts);
    car.input.boostQueued = false;
    return true;
  }

  const closing = finite(target.closing);
  const finishThrottle = target.contactDistance < TAG_RANGE + 3
    ? (facts.speed > 24 && target.contactDistance < TAG_RANGE + 1.2
      ? (closing > 12 ? 0.12 : 0.42)
      : closing > 24 && absAngle > 0.32 ? 0.36 : 1)
    : target.contactDistance < TAG_RANGE + 7
      ? (closing > 28 && absAngle > 0.45 ? 0.58 : 0.92)
      : Math.max(car.input.throttle, 0.82);
  car.input.throttle = tractionLimitedThrottle(finishThrottle, car.input.steer, facts);
  return false;
}

function applyActionJobControl(car, job, facts) {
  if (!job.action) return false;
  const segment = actionSegmentAtTime(job.action.sequence, car.ai.intentElapsed) ?? job.action;
  car.input.steer = THREE.MathUtils.clamp(finite(segment.steer), -1, 1);
  let throttle = tractionLimitedThrottle(finite(segment.throttle, 1), car.input.steer, facts);
  if (throttle > 0 && Math.abs(car.input.steer) > 0.72 && facts.speed > 24) {
    throttle *= THREE.MathUtils.lerp(0.42, 0.68, clamp01((32 - facts.speed) / 8));
  }
  car.input.throttle = THREE.MathUtils.clamp(throttle, -1, 1);
  car.input.boostQueued = canBoostSegmentNow(facts, null, segment);
  if (segment.jump && canJumpNow(facts)) {
    car.input.jumpQueued = true;
    car.ai.jumpCooldown = 0.9;
  }
  return true;
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

  if (job.type === "recover") {
    car.input.throttle = facts.surfaceUpDot < -0.12 ? 0 : 0.22;
    car.input.steer = car.ai.lateralSign;
    if (job.jump) {
      car.input.jumpQueued = true;
      car.ai.jumpCooldown = THREE.MathUtils.lerp(1.25, 0.55, clamp01(finite(config.recoverySkill) / 1.35));
    }
    return;
  }

  const local = localDirectionToPoint(car, job.point, facts.forward, facts.surfaceNormal);
  const rawSteer = THREE.MathUtils.clamp(Math.atan2(local.x, local.z) / 1.05, -1, 1);
  const steeringSkill = clamp01(finite(config.steeringSkill) / 1.35);
  const noise = finite(config.noise) * (1 - steeringSkill * 0.45) * (rng() - 0.5) * 2;
  let steer = THREE.MathUtils.clamp(rawSteer + noise, -1, 1);
  let throttle = speedThrottle(1, job.desiredSpeed, steer, facts);

  if (job.plan === "reverse_tag" && job.target && job.target.contactDistance < 24 && local.z < -0.12 && facts.speed < 16 && facts.wheels >= 2) {
    const rearAngle = Math.atan2(local.x, -local.z);
    steer = THREE.MathUtils.clamp(-rearAngle / 0.95, -1, 1);
    throttle = job.target.contactDistance < TAG_RANGE + 2.5 ? -0.62 : -0.88;
  }

  car.input.steer = steer;
  car.input.throttle = THREE.MathUtils.clamp(tractionLimitedThrottle(throttle, steer, facts), -1, 1);

  if (applyCloseTagControl(car, job, facts)) return;

  if (applyActionJobControl(car, job, facts)) return;

  const alignment = alignmentToPoint(car, job.point, facts.surfaceNormal);
  const climbRisk = surfaceRisk(facts.position, facts, facts.forward);
  const risk = riskAppetite(config, personality);
  const canBoost =
    canBoostNow(facts, config, steer) &&
    facts.surfaceUpDot > 0.84 &&
    climbRisk < THREE.MathUtils.lerp(0.08, 0.2, risk) &&
    alignment > THREE.MathUtils.lerp(0.78, 0.46, clamp01(finite(config.boostSkill) / 1.4) * THREE.MathUtils.lerp(0.72, 1.08, risk)) &&
    Math.abs(steer) < THREE.MathUtils.lerp(0.44, 0.62, risk) &&
    facts.speed > 7;
  if (canBoost) {
    const need = car.isIt ? 0.38 + finite(job.urgency) * 0.44 : finite(job.urgency) * 0.5;
    if (rng() < clamp01(need * finite(config.boostSkill) * THREE.MathUtils.lerp(0.58, 1.08, risk))) car.input.boostQueued = true;
  }
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

function estimateSurfaceArrivalTime(facts) {
  const floorTime = estimateTimeToLand({
    body: { position: facts.position, velocity: facts.velocity },
    vehicle: { numWheelsOnGround: facts.wheels },
  });
  const radius = Math.hypot(facts.position.x, facts.position.z);
  const velocityRadius = radius > EPS
    ? (facts.position.x * facts.velocity.x + facts.position.z * facts.velocity.z) / radius
    : 0;
  const targetRadius = finite(worldSpec?.floorRadius, 68) + 4;
  let wallTime = Infinity;
  if (velocityRadius > 2) {
    if (radius >= targetRadius) wallTime = 0.12;
    else wallTime = (targetRadius - radius) / velocityRadius;
  }
  return THREE.MathUtils.clamp(Math.min(floorTime || Infinity, wallTime), 0.12, 1.45);
}

function predictedLandingPose(job, facts, config) {
  const time = estimateSurfaceArrivalTime(facts);
  const point = tmpVec3A.copy(facts.position).addScaledVector(facts.velocity, time);
  point.y = Math.max(0, facts.position.y + facts.velocity.y * time - 4.905 * time * time);
  const normal = surfaceNormalAtPoint(point, tmpVec3B);

  const velocityTangent = tmpVec3C.copy(facts.velocity);
  projectOntoPlane(velocityTangent, normal, facts.forward);
  const objectiveTangent = tmpVec3D.copy(job.point ?? point).sub(point);
  projectOntoPlane(objectiveTangent, normal, velocityTangent);

  const objectiveAgreement = velocityTangent.dot(objectiveTangent);
  const skill = clamp01(finite(config.planningSkill) / 1.35);
  const objectiveWeight = objectiveAgreement < -0.2
    ? THREE.MathUtils.lerp(0.24, 0.72, skill) * clamp01((time - 0.24) / 0.72)
    : THREE.MathUtils.lerp(0.18, 0.48, skill);
  const forward = velocityTangent.lerp(objectiveTangent, objectiveWeight);
  projectOntoPlane(forward, normal, objectiveTangent);

  return { point: point.clone(), normal: normal.clone(), forward: forward.clone(), time };
}

function shouldUseAerialRighting(facts, job) {
  if (job.type === "unstick") return false;
  if (job.type === "recover") return true;
  if (facts.wheels <= 0) return true;
  return facts.wheels < 2 && facts.position.y > 1.8;
}

function aerialRighting(car, job, facts, config, rng) {
  const skill = clamp01(finite(config.recoverySkill) / 1.35);
  const landing = predictedLandingPose(job, facts, config);
  const desiredForward = landing.forward;
  const desiredUp = landing.normal;
  const currentUp = carUp(car, tmpVec3B);
  const currentForward = tmpVec3A.set(0, 0, 1).applyQuaternion(carQuaternion(car));
  projectOntoPlane(currentForward, desiredUp, facts.forward);

  const uprightAxis = tmpVec3C.copy(currentUp).cross(desiredUp);
  const uprightAngle = Math.acos(THREE.MathUtils.clamp(currentUp.dot(desiredUp), -1, 1));
  if (uprightAxis.lengthSq() > EPS) uprightAxis.normalize().multiplyScalar(uprightAngle);
  else if (currentUp.dot(desiredUp) < -0.2) uprightAxis.copy(facts.forward).multiplyScalar(car.ai.lateralSign || 1);
  const forwardAxis = tmpVec3D.copy(currentForward).cross(desiredForward);
  const forwardAngle = Math.asin(THREE.MathUtils.clamp(forwardAxis.dot(desiredUp), -1, 1));
  forwardAxis.copy(desiredUp).multiplyScalar(forwardAngle);
  const combinedAxis = uprightAxis.addScaledVector(forwardAxis, THREE.MathUtils.lerp(0.32, 0.72, skill));

  const inverse = carQuaternion(car).invert();
  const localForward = tmpVec3D.copy(desiredForward).applyQuaternion(inverse);
  const localAxis = combinedAxis.applyQuaternion(inverse);
  const localAngular = localAngularVelocity(car, tmpVec3B);
  const landingSoon = clamp01((0.85 - landing.time) / 0.85);
  const poseError = clamp01(combinedAxis.length() / 1.45);
  const correction = Math.max(landingSoon, poseError) * THREE.MathUtils.lerp(0.86, 1.35, skill);
  const damping = THREE.MathUtils.lerp(0.1, 0.2, skill);
  const yaw = THREE.MathUtils.clamp(Math.atan2(localForward.x, localForward.z) / 1.2, -1, 1);
  const yawEnabled = facts.upDot > 0.32 && landing.time > 0.18 ? 1 : 0;
  const noise = finite(config.noise) * (1 - skill) * 0.25 * (rng() - 0.5);

  car.input.steer = THREE.MathUtils.clamp(yaw * 0.42 * yawEnabled + localAxis.y * correction - localAngular.y * damping + noise, -1, 1);
  car.input.throttle = THREE.MathUtils.clamp(localAxis.x * correction - localAngular.x * damping, -1, 1);
  car.input.airRoll = THREE.MathUtils.clamp(localAxis.z * correction - localAngular.z * damping, -1, 1);
  car.input.boostQueued = false;
  if (!job.jump) car.input.jumpQueued = false;
}

function neutralAirborneInputs(car, facts) {
  if (facts.wheels >= 2) return;
  if (facts.surfaceUpDot < 0.82 || facts.angularSpeed > 2.2) return;
  car.input.throttle = 0;
  car.input.steer *= 0.18;
  car.input.airRoll = 0;
  car.input.boostQueued = false;
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

function updateDebugFields(car, job, facts, canRight = false) {
  const ai = car.ai;
  if (car.isIt && job.target?.id && job.target.immunity <= 0 && job.target.contactDistance < TAG_RANGE + 18) {
    if (ai.finishPressureTargetId === job.target.id) {
      ai.finishPressureTimer = Math.min(4, finite(ai.finishPressureTimer) + 0.05);
      ai.finishPressureMinDistance = Math.min(finite(ai.finishPressureMinDistance, Infinity), finite(job.target.contactDistance, Infinity));
    } else {
      ai.finishPressureTargetId = job.target.id;
      ai.finishPressureTimer = 0.05;
      ai.finishPressureMinDistance = finite(job.target.contactDistance, Infinity);
    }
  } else if (car.isIt) {
    ai.finishPressureTimer = Math.max(0, finite(ai.finishPressureTimer) - 0.08);
    if (ai.finishPressureTimer <= 0) {
      ai.finishPressureTargetId = null;
      ai.finishPressureMinDistance = Infinity;
    }
  } else {
    ai.finishPressureTargetId = null;
    ai.finishPressureTimer = 0;
    ai.finishPressureMinDistance = Infinity;
  }
  ai.intent = job;
  ai.targetId = job.target?.id ?? null;
  ai.mode = job.type;
  ai.plan = job.plan ?? null;
  ai.maneuver = job.maneuver ?? null;
  ai.rolloutScore = finite(job.rolloutScore, 0);
  ai.modeTargetId = ai.targetId;
  ai.modeTimer = ai.decisionTimer;
  ai.lastAimAngle = car.input.steer * 1.05;
  ai.lastThreatDistance = facts.threat?.contactDistance ?? Infinity;
  ai.lastTargetDistance = job.target?.contactDistance ?? Infinity;
  ai.lastObjectiveDistance = job.point ? facts.position.distanceTo(job.point) : Infinity;
  ai.surfaceUpDot = facts.surfaceUpDot;
  ai.surfaceDistance = facts.surfaceDistance;
  ai.canRight = Boolean(canRight);
  ai.threatClosingRate = finite(ai.threatPattern?.closingRate);
  ai.threatAcceleration = finite(ai.threatPattern?.acceleration);
  ai.threatVolatility = finite(ai.threatPattern?.volatility);
  ai.pressure = car.isIt ? clamp01(1 - (job.target?.contactDistance ?? 80) / 72) : facts.threatRisk;
  if (job.point) {
    ai.objective.copy(job.point);
    ai.tacticalPoint.copy(job.point);
    ai.desired.copy(job.point).sub(facts.position);
    if (ai.desired.lengthSq() > EPS) ai.desired.normalize();
  } else {
    ai.desired.set(0, 0, 0);
  }
}

const aiProfile = {
  enabled: false,
  calls: 0,
  totalMs: 0,
  maxMs: 0,
  taggerCalls: 0,
  taggerTotalMs: 0,
  runnerCalls: 0,
  runnerTotalMs: 0,
  slow1Ms: 0,
  slow2Ms: 0,
  slow5Ms: 0,
  slow10Ms: 0,
};

function nowMs() {
  return globalThis.performance?.now?.() ?? Date.now();
}

export function setAiProfilingEnabled(enabled = true) {
  aiProfile.enabled = Boolean(enabled);
}

export function resetAiProfile() {
  aiProfile.calls = 0;
  aiProfile.totalMs = 0;
  aiProfile.maxMs = 0;
  aiProfile.taggerCalls = 0;
  aiProfile.taggerTotalMs = 0;
  aiProfile.runnerCalls = 0;
  aiProfile.runnerTotalMs = 0;
  aiProfile.slow1Ms = 0;
  aiProfile.slow2Ms = 0;
  aiProfile.slow5Ms = 0;
  aiProfile.slow10Ms = 0;
}

export function getAiProfile() {
  const calls = aiProfile.calls;
  const taggerCalls = aiProfile.taggerCalls;
  const runnerCalls = aiProfile.runnerCalls;
  return {
    enabled: aiProfile.enabled,
    calls,
    totalMs: Number(aiProfile.totalMs.toFixed(3)),
    avgMs: Number((aiProfile.totalMs / Math.max(1, calls)).toFixed(4)),
    maxMs: Number(aiProfile.maxMs.toFixed(4)),
    tagger: {
      calls: taggerCalls,
      avgMs: Number((aiProfile.taggerTotalMs / Math.max(1, taggerCalls)).toFixed(4)),
    },
    runner: {
      calls: runnerCalls,
      avgMs: Number((aiProfile.runnerTotalMs / Math.max(1, runnerCalls)).toFixed(4)),
    },
    slowCalls: {
      over1Ms: aiProfile.slow1Ms,
      over2Ms: aiProfile.slow2Ms,
      over5Ms: aiProfile.slow5Ms,
      over10Ms: aiProfile.slow10Ms,
    },
  };
}

function updateAiCarImpl(car, dt, {
  gameState,
  arenaContactForPoint,
  shouldRightWithJump,
  rng = Math.random,
  difficulty = "medium",
  arenaId = "orange",
} = {}) {
  if (!car || !gameState) return;

  const safeDt = THREE.MathUtils.clamp(finite(dt), 0, 0.25);
  const config = difficultyConfig(difficulty);
  const personality = ensureMind(car, rng);
  const ai = car.ai;

  ai.perceptionClock += safeDt;
  ai.perceptionSampleClock += safeDt;
  ai.memorySampleClock += safeDt;
  if (!ai.perceptionHistory.length || ai.perceptionSampleClock >= 0.05) {
    rememberPerception(ai, gameState, ai.perceptionClock);
    ai.perceptionSampleClock = 0;
  }
  ai.decisionTimer = Math.max(0, finite(ai.decisionTimer) - safeDt);
  ai.modeTimer = Math.max(0, finite(ai.modeTimer) - safeDt);
  ai.intentElapsed = finite(ai.intentElapsed) + safeDt;
  ai.jumpCooldown = Math.max(0, finite(ai.jumpCooldown) - safeDt);
  ai.unstickTimer = Math.max(0, finite(ai.unstickTimer) - safeDt);
  ai.lateralTimer = Math.max(0, finite(ai.lateralTimer) - safeDt);
  if (ai.lateralTimer <= 0) {
    ai.lateralSign *= -1;
    ai.lateralTimer = 1.35 + rng() * 2.4;
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

  const observedState = perceivedGameState(car, gameState, ai, config);
  if (ai.memorySampleClock >= 0.08) {
    updateOpponentMemory(car, ai, observedState, ai.memorySampleClock, arenaContactForPoint, arenaId);
    ai.memorySampleClock = 0;
  }
  const facts = observe(car, observedState, config, rng, arenaId, arenaContactForPoint, ai);
  updateThreatPattern(ai, facts, safeDt);
  updateTacticMemory(car, facts, safeDt);
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
  const intentValid = ai.intentRole === role && intentTargetValid(ai.intent, facts, role);
  const intentFailing = intentHealthFailed(ai.intent, facts, role, ai.intentElapsed);
  const activeActionRemaining =
    intentValid &&
    !intentFailing &&
    ai.intent?.action &&
    finite(ai.intentElapsed) < actionSequenceDuration(ai.intent.action) - 0.001;
  const urgentTag = role === "tagger" && (
    activeActionRemaining ? hasFinishTagOpportunity(facts) : hasImmediateTagOpportunity(facts)
  );
  const mustThink =
    (ai.decisionTimer <= 0 && !activeActionRemaining) ||
    !ai.intent ||
    ai.intentRole !== role ||
    !intentValid ||
    intentFailing ||
    urgentTag ||
    recoveryNeeded ||
    unstickNeeded;
  if (mustThink) {
    const previousIntent = ai.intent;
    const previousElapsed = finite(ai.intentElapsed);
    const nextIntent = chooseJob(car, facts, config, personality, canRight);
    const sameSequence =
      previousIntent?.action &&
      nextIntent?.action &&
      previousIntent.plan === nextIntent.plan &&
      previousIntent.target?.id === nextIntent.target?.id &&
      previousElapsed < actionSequenceDuration(previousIntent.action) - 0.001 &&
      actionSequencesEqual(previousIntent.action, nextIntent.action);
    if (!sameSequence) beginTacticSample(car, facts, nextIntent);
    ai.intent = nextIntent;
    ai.intentRole = role;
    ai.intentElapsed = sameSequence ? previousElapsed : 0;
    ai.decisionTimer = role === "tagger"
      ? Math.max(0.02, finite(config.thinkInterval) * 0.18 + finite(config.reactionDelay) * 0.2)
      : Math.max(0.04, finite(config.thinkInterval) + finite(config.reactionDelay) * 0.25);
  }

  const job = ai.intent ?? chooseJob(car, facts, config, personality, canRight);
  driveToJob(car, job, facts, config, personality, rng);
  if (shouldUseAerialRighting(facts, job)) aerialRighting(car, job, facts, config, rng);
  else neutralAirborneInputs(car, facts);
  applyMistake(car, ai, config, rng, safeDt);
  updateDebugFields(car, job, facts, canRight);
}

export function updateAiCar(car, dt, options = {}) {
  if (!aiProfile.enabled) {
    updateAiCarImpl(car, dt, options);
    return;
  }
  const isTagger = Boolean(car?.isIt);
  const start = nowMs();
  try {
    updateAiCarImpl(car, dt, options);
  } finally {
    const elapsed = nowMs() - start;
    aiProfile.calls += 1;
    aiProfile.totalMs += elapsed;
    if (elapsed > aiProfile.maxMs) aiProfile.maxMs = elapsed;
    if (isTagger) {
      aiProfile.taggerCalls += 1;
      aiProfile.taggerTotalMs += elapsed;
    } else {
      aiProfile.runnerCalls += 1;
      aiProfile.runnerTotalMs += elapsed;
    }
    if (elapsed > 1) aiProfile.slow1Ms += 1;
    if (elapsed > 2) aiProfile.slow2Ms += 1;
    if (elapsed > 5) aiProfile.slow5Ms += 1;
    if (elapsed > 10) aiProfile.slow10Ms += 1;
  }
}
