import * as THREE from "three";
import { arenaDefinitions, worldSpec } from "./arena.js";

const tmpVec3A = new THREE.Vector3();
const tmpVec3B = new THREE.Vector3();
const tmpVec3C = new THREE.Vector3();
const tmpVec3D = new THREE.Vector3();
const tmpVec3E = new THREE.Vector3();
const tmpVec3F = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();

export const aiDifficultyPresets = {
  easy: {
    decisionScale: 1.55,
    chaseSkill: 0.62,
    escapeSkill: 0.66,
    predictionScale: 0.56,
    boostDiscipline: 0.48,
    tacticalSkill: 0.5,
    mistakeChance: 0.36,
    mistakeDuration: [0.28, 0.68],
  },
  medium: {
    decisionScale: 1,
    chaseSkill: 1,
    escapeSkill: 1,
    predictionScale: 1,
    boostDiscipline: 1,
    tacticalSkill: 1,
    mistakeChance: 0.08,
    mistakeDuration: [0.12, 0.28],
  },
  hard: {
    decisionScale: 0.68,
    chaseSkill: 1.3,
    escapeSkill: 1.23,
    predictionScale: 1.24,
    boostDiscipline: 1.32,
    tacticalSkill: 1.25,
    mistakeChance: 0.024,
    mistakeDuration: [0.08, 0.18],
  },
  extreme: {
    decisionScale: 0.38,
    chaseSkill: 1.85,
    escapeSkill: 1.68,
    predictionScale: 1.72,
    boostDiscipline: 1.9,
    tacticalSkill: 1.65,
    mistakeChance: 0.001,
    mistakeDuration: [0.03, 0.06],
  },
};

export const aiDifficultyIds = ["easy", "medium", "hard", "extreme"];

const aiPersonalities = [
  {
    key: "hunter",
    weight: 1.15,
    chaseAggression: 1.16,
    escapeAggression: 0.86,
    targetScoreBias: 1.1,
    targetWallBias: 1.0,
    targetAirBias: 0.95,
    shieldAffinity: 0.38,
    openSpaceBias: 0.9,
    feintChance: 0.06,
    boostAsIt: 1.2,
    boostAsRunner: 0.72,
    jumpNearThreat: 0.82,
    persistence: 1.15,
    sabotage: 0.68,
    featureAwareness: 0.86,
  },
  {
    key: "survivor",
    weight: 1.05,
    chaseAggression: 0.9,
    escapeAggression: 1.2,
    targetScoreBias: 0.65,
    targetWallBias: 0.7,
    targetAirBias: 0.72,
    shieldAffinity: 0.58,
    openSpaceBias: 1.28,
    feintChance: 0.04,
    boostAsIt: 0.82,
    boostAsRunner: 1.22,
    jumpNearThreat: 1.18,
    persistence: 0.88,
    sabotage: 0.22,
    featureAwareness: 0.72,
  },
  {
    key: "baiter",
    weight: 0.95,
    chaseAggression: 0.98,
    escapeAggression: 1.05,
    targetScoreBias: 0.86,
    targetWallBias: 0.86,
    targetAirBias: 0.8,
    shieldAffinity: 1.32,
    openSpaceBias: 0.72,
    feintChance: 0.2,
    boostAsIt: 0.92,
    boostAsRunner: 0.95,
    jumpNearThreat: 0.98,
    persistence: 1.02,
    sabotage: 1.32,
    featureAwareness: 1.18,
  },
  {
    key: "opportunist",
    weight: 1.1,
    chaseAggression: 1.02,
    escapeAggression: 0.96,
    targetScoreBias: 1.45,
    targetWallBias: 1.18,
    targetAirBias: 1.24,
    shieldAffinity: 0.78,
    openSpaceBias: 0.95,
    feintChance: 0.1,
    boostAsIt: 1.08,
    boostAsRunner: 1.0,
    jumpNearThreat: 1.0,
    persistence: 0.82,
    sabotage: 1.08,
    featureAwareness: 1.04,
  },
  {
    key: "drifter",
    weight: 0.9,
    chaseAggression: 0.92,
    escapeAggression: 0.92,
    targetScoreBias: 0.72,
    targetWallBias: 1.38,
    targetAirBias: 0.78,
    shieldAffinity: 0.5,
    openSpaceBias: 0.62,
    feintChance: 0.16,
    boostAsIt: 0.98,
    boostAsRunner: 0.88,
    jumpNearThreat: 0.72,
    persistence: 1.28,
    sabotage: 0.9,
    featureAwareness: 1.38,
  },
  {
    key: "scrambler",
    weight: 0.85,
    chaseAggression: 1.0,
    escapeAggression: 1.0,
    targetScoreBias: 0.7,
    targetWallBias: 0.9,
    targetAirBias: 0.9,
    shieldAffinity: 0.7,
    openSpaceBias: 1.0,
    feintChance: 0.24,
    boostAsIt: 1.0,
    boostAsRunner: 1.08,
    jumpNearThreat: 1.35,
    persistence: 0.72,
    sabotage: 1.18,
    featureAwareness: 0.95,
  },
];

export const aiPersonalityKeys = aiPersonalities.map((personality) => personality.key);

export function normalizeAiDifficulty(value = "medium") {
  const key = String(value ?? "medium").trim().toLowerCase();
  return aiDifficultyIds.includes(key) ? key : "medium";
}

function resolveDifficulty(difficulty = "medium") {
  if (typeof difficulty === "string") return aiDifficultyPresets[normalizeAiDifficulty(difficulty)] ?? aiDifficultyPresets.medium;
  return { ...aiDifficultyPresets.medium, ...(difficulty ?? {}) };
}

function chooseWeighted(items, rng = Math.random) {
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  let roll = rng() * total;
  for (const item of items) {
    roll -= item.weight;
    if (roll <= 0) return item;
  }
  return items[items.length - 1];
}

function personalityByKey(key) {
  return aiPersonalities.find((personality) => personality.key === key) ?? aiPersonalities[0];
}

function ensureAiMind(car, rng = Math.random) {
  if (!car.ai.personalityKey) car.ai.personalityKey = chooseWeighted(aiPersonalities, rng).key;
  car.ai.lastObjectiveDistance ??= Infinity;
  car.ai.objectiveProgressTimer ??= 0;
  car.ai.mistakeTimer ??= 0;
  car.ai.mistakeSteer ??= 0;
  car.ai.feintTimer ??= 0;
  car.ai.feintSign ??= rng() < 0.5 ? -1 : 1;
  return personalityByKey(car.ai.personalityKey);
}

export function pickWaypoint(car, rng = Math.random) {
  const angle = rng() * Math.PI * 2;
  const radius = 18 + rng() * 42;
  car.ai.waypoint.set(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
  car.ai.waypointTimer = 2.5 + rng() * 2.5;
}

function steerToward(car, desired, aggression = 1) {
  tmpQuat.set(car.body.quaternion.x, car.body.quaternion.y, car.body.quaternion.z, car.body.quaternion.w).invert();
  const local = tmpVec3E.copy(desired).applyQuaternion(tmpQuat);
  const angle = Math.atan2(local.x, local.z);
  const absAngle = Math.abs(angle);
  car.input.steer = THREE.MathUtils.clamp(angle / THREE.MathUtils.lerp(0.95, 0.72, aggression), -1, 1);
  const hardTurnThrottle = THREE.MathUtils.lerp(0.64, 0.82, aggression);
  const mediumTurnThrottle = THREE.MathUtils.lerp(0.82, 1, aggression);
  car.input.throttle = absAngle > 2.65 ? hardTurnThrottle : absAngle > 1.45 ? mediumTurnThrottle : 1;
  return angle;
}

function flatDistanceBetween(a, b) {
  return Math.hypot(a.body.position.x - b.body.position.x, a.body.position.z - b.body.position.z);
}

function flatCarPosition(car, out = new THREE.Vector3()) {
  return out.set(car.body.position.x, 0, car.body.position.z);
}

function flatCarVelocity(car, out = new THREE.Vector3()) {
  return out.set(car.body.velocity.x, 0, car.body.velocity.z);
}

function worldCarPosition(car, out = new THREE.Vector3()) {
  return out.set(car.body.position.x, car.body.position.y, car.body.position.z);
}

function worldCarVelocity(car, out = new THREE.Vector3()) {
  return out.set(car.body.velocity.x, car.body.velocity.y, car.body.velocity.z);
}

function clampArenaVector(vec, maxRadius = worldSpec.floorRadius - 9) {
  const radius = Math.hypot(vec.x, vec.z);
  if (radius > maxRadius) vec.multiplyScalar(maxRadius / radius);
  return vec;
}

function closestTagTargetFor(car, gameState, personality, difficulty) {
  let best = null;
  let bestScore = Infinity;
  tmpQuat.set(car.body.quaternion.x, car.body.quaternion.y, car.body.quaternion.z, car.body.quaternion.w).invert();

  for (const target of gameState.cars) {
    if (target === car || target.isIt) continue;

    const dx = target.body.position.x - car.body.position.x;
    const dy = target.body.position.y - car.body.position.y;
    const dz = target.body.position.z - car.body.position.z;
    const flatDistance = Math.hypot(dx, dz);
    const distance = Math.hypot(flatDistance, dy);
    const invDistance = flatDistance > 0.001 ? 1 / flatDistance : 0;
    const dirX = dx * invDistance;
    const dirZ = dz * invDistance;
    const closingSpeed =
      (car.body.velocity.x - target.body.velocity.x) * dirX +
      (car.body.velocity.z - target.body.velocity.z) * dirZ;
    const local = tmpVec3A.set(dx, 0, dz).applyQuaternion(tmpQuat);
    const anglePenalty = Math.abs(Math.atan2(local.x, local.z)) * 7.5;
    const immunityPenalty = target.immunityRemaining > 0 ? 48 + target.immunityRemaining * 12 : 0;
    const closeBonus = flatDistance < 18 ? 22 : 0;
    const tacticalSkill = difficulty.tacticalSkill ?? 1;
    const scorePressure = target.score * 0.035 * (personality.targetScoreBias + personality.sabotage * 0.28) * tacticalSkill;
    const targetRadius = Math.hypot(target.body.position.x, target.body.position.z);
    const wallTrapBonus = Math.max(0, targetRadius - (worldSpec.floorRadius - 22)) * 0.9 * personality.targetWallBias * tacticalSkill;
    const airborneBonus = target.vehicle?.numWheelsOnGround < 2 ? 7.5 * personality.targetAirBias * tacticalSkill : 0;
    const currentTargetBonus = target.id === car.ai.targetId ? 12 * personality.persistence : 0;
    const chaseSkill = difficulty.chaseSkill ?? 1;
    const score = distance +
      anglePenalty / chaseSkill +
      immunityPenalty +
      closingSpeed * 1.2 * chaseSkill -
      closeBonus -
      scorePressure -
      wallTrapBonus -
      airborneBonus -
      currentTargetBonus;

    if (score < bestScore) {
      bestScore = score;
      best = target;
    }
  }

  car.ai.targetId = best?.id ?? null;
  return best;
}

function updateAiObjective(car, targetPoint, dt, refreshDistance = 10, rng = Math.random, difficulty = aiDifficultyPresets.medium) {
  car.ai.objectiveTimer -= dt;
  const current = flatCarPosition(car, tmpVec3A);
  if (
    car.ai.objectiveTimer <= 0 ||
    current.distanceTo(car.ai.objective) < refreshDistance ||
    car.ai.objective.distanceTo(targetPoint) > 18
  ) {
    car.ai.objective.copy(targetPoint);
    car.ai.objectiveTimer = (0.75 + rng() * 0.45) * (difficulty.decisionScale ?? 1);
  }
}

function chooseAiChaseVector(car, target, desired, arenaContactForPoint, personality, difficulty) {
  const carPos = worldCarPosition(car, tmpVec3A);
  const targetPos = worldCarPosition(target, tmpVec3B);
  const targetVelocity = worldCarVelocity(target, tmpVec3C);
  const distance = carPos.distanceTo(targetPos);
  const targetSpeed = targetVelocity.length();
  const predictTime = THREE.MathUtils.clamp(
    distance / (22 + targetSpeed * 0.95),
    distance < 16 ? 0.06 : 0.18,
    0.9,
  ) * (difficulty.predictionScale ?? 1) * THREE.MathUtils.lerp(0.86, 1.12, personality.chaseAggression - 0.8);
  desired.copy(targetPos).addScaledVector(targetVelocity, predictTime).sub(carPos);

  const contact = arenaContactForPoint(carPos);
  const surfaceComponent = desired.dot(contact.normal);
  desired.addScaledVector(contact.normal, -surfaceComponent);

  if (desired.lengthSq() < 0.01) {
    desired.copy(targetPos).sub(carPos);
    desired.y = 0;
  }
}

function chooseAiEscapeVector(car, threat, desired, dt, gameState, rng = Math.random, personality, difficulty) {
  const pos = flatCarPosition(car, tmpVec3A);
  const threatPos = flatCarPosition(threat, tmpVec3B);
  const threatVelocity = flatCarVelocity(threat, tmpVec3C);
  const awayDirection = tmpVec3D.copy(pos).sub(threatPos);
  const threatDistance = Math.max(awayDirection.length(), 0.001);
  awayDirection.multiplyScalar(1 / threatDistance);
  const urgency = THREE.MathUtils.clamp((72 - threatDistance) / 72, 0.28, 1);
  const tangent = tmpVec3E.set(-awayDirection.z, 0, awayDirection.x).multiplyScalar(car.ai.lateralSign);

  const safePoint = car.ai.tacticalPoint
    .copy(pos)
    .addScaledVector(awayDirection, (34 + urgency * 34) * personality.escapeAggression * (difficulty.escapeSkill ?? 1))
    .addScaledVector(tangent, (16 + urgency * 16) * personality.openSpaceBias);

  if (threatVelocity.lengthSq() > 0.01) {
    const closingSpeed = threatVelocity.dot(awayDirection);
    if (closingSpeed > 2) safePoint.addScaledVector(tangent, 14 * personality.escapeAggression);
  }

  let bestShield = null;
  let bestShieldScore = Infinity;
  for (const candidate of gameState.cars) {
    if (candidate === car || candidate === threat || candidate.isIt) continue;
    const candidateDistance = Math.hypot(candidate.body.position.x - car.body.position.x, candidate.body.position.z - car.body.position.z);
    const candidateThreatDistance = Math.hypot(candidate.body.position.x - threat.body.position.x, candidate.body.position.z - threat.body.position.z);
    const candidateScore = candidateDistance +
      Math.abs(candidateThreatDistance - threatDistance) * 0.28 -
      candidate.score * 0.04 -
      personality.shieldAffinity * 7;
    if (candidateDistance > 7 && candidateScore < bestShieldScore) {
      bestShieldScore = candidateScore;
      bestShield = candidate;
    }

    if (candidateDistance < 11 && personality.shieldAffinity < 1.1) {
      safePoint.addScaledVector(
        tmpVec3D.set(pos.x - candidate.body.position.x, 0, pos.z - candidate.body.position.z).normalize(),
        (11 - candidateDistance) * 2.4 * personality.openSpaceBias,
      );
    }
  }

  if (bestShield && threatDistance < 78 && personality.shieldAffinity > 0.34) {
    const shieldAwayX = bestShield.body.position.x - threat.body.position.x;
    const shieldAwayZ = bestShield.body.position.z - threat.body.position.z;
    const shieldAwayLength = Math.max(0.001, Math.hypot(shieldAwayX, shieldAwayZ));
    const shieldPoint = tmpVec3B.set(
      bestShield.body.position.x + (shieldAwayX / shieldAwayLength) * 9,
      0,
      bestShield.body.position.z + (shieldAwayZ / shieldAwayLength) * 9,
    );
    safePoint.lerp(shieldPoint, (0.14 + urgency * 0.3) * personality.shieldAffinity);
  }

  if (car.ai.feintTimer > 0 && threatDistance < 46) {
    safePoint.addScaledVector(tangent, -24 * car.ai.feintSign);
  }

  const radius = Math.hypot(car.body.position.x, car.body.position.z);
  const wallMargin = THREE.MathUtils.lerp(18, 30, personality.openSpaceBias);
  if (radius > worldSpec.floorRadius - wallMargin) {
    const center = tmpVec3B.set(-car.body.position.x, 0, -car.body.position.z).normalize();
    const wallTangent = tmpVec3C.set(-center.z, 0, center.x).multiplyScalar(car.ai.lateralSign);
    safePoint.addScaledVector(center, (radius - (worldSpec.floorRadius - wallMargin)) * 5.5 * personality.openSpaceBias);
    safePoint.addScaledVector(wallTangent, 18 * personality.escapeAggression);
  }

  clampArenaVector(safePoint, worldSpec.floorRadius - 7);
  updateAiObjective(car, safePoint, dt, 9, rng, difficulty);
  desired.copy(car.ai.objective).sub(pos);
}

function chooseSabotageTarget(car, threat, gameState, personality, difficulty) {
  if (!threat || personality.sabotage <= 0.3) return null;
  const tacticalSkill = difficulty.tacticalSkill ?? 1;
  const threatDistance = flatDistanceBetween(car, threat);
  if (threatDistance < 18 || threatDistance > 78) return null;

  let best = null;
  let bestScore = -Infinity;
  for (const candidate of gameState.cars) {
    if (candidate === car || candidate === threat || candidate.isIt) continue;
    const candidateDistance = flatDistanceBetween(car, candidate);
    if (candidateDistance < 5 || candidateDistance > 62) continue;
    const candidateThreatDistance = flatDistanceBetween(candidate, threat);
    const scoreLead = candidate.score - car.score;
    const highScorePressure = Math.max(0, candidate.score) * 0.045;
    const closeScorePressure = Math.max(0, 18 - Math.abs(scoreLead)) * 0.32;
    const leadPressure = Math.max(0, scoreLead) * 0.18;
    const threatSetup = Math.max(0, 58 - candidateThreatDistance) * 0.1;
    const distancePenalty = candidateDistance * 0.08;
    const score = (highScorePressure + closeScorePressure + leadPressure + threatSetup) * personality.sabotage * tacticalSkill -
      distancePenalty;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return bestScore > THREE.MathUtils.lerp(3.1, 1.2, THREE.MathUtils.clamp(tacticalSkill / 1.65, 0, 1)) ? best : null;
}

function blendSabotageVector(car, threat, desired, gameState, personality, difficulty) {
  const target = chooseSabotageTarget(car, threat, gameState, personality, difficulty);
  if (!target) return;
  const pos = flatCarPosition(car, tmpVec3A);
  const targetPos = flatCarPosition(target, tmpVec3B);
  const targetVelocity = flatCarVelocity(target, tmpVec3C);
  const threatPos = flatCarPosition(threat, tmpVec3D);
  const threatToTarget = tmpVec3E.copy(targetPos).sub(threatPos);
  if (threatToTarget.lengthSq() < 0.001) return;
  threatToTarget.normalize();

  const intercept = targetPos
    .addScaledVector(targetVelocity, 0.22 * (difficulty.predictionScale ?? 1))
    .addScaledVector(threatToTarget, 5.5 + personality.sabotage * 3.5);
  const sabotage = intercept.sub(pos);
  if (sabotage.lengthSq() < 0.01) return;
  const blend = THREE.MathUtils.clamp(0.16 + personality.sabotage * 0.18 * (difficulty.tacticalSkill ?? 1), 0.08, 0.5);
  desired.lerp(sabotage.normalize(), blend);
}

function featureValue(feature) {
  const typeBonus = feature.type === "ridge" ? 5 : feature.type === "peak" ? 4 : 2;
  return typeBonus + (feature.height ?? 1) * 1.35 + Math.max(feature.width ?? 0, feature.length ?? 0) * 0.025;
}

function featurePosition(feature, out = new THREE.Vector3()) {
  return out.set(feature.x, 0, feature.z);
}

function featureTacticalVector(car, target, arenaId, mode, personality, difficulty, out) {
  if (personality.featureAwareness <= 0.35) return false;
  const tacticalSkill = difficulty.tacticalSkill ?? 1;
  const features = (arenaDefinitions[arenaId] ?? arenaDefinitions.orange).mounds ?? [];
  if (!features.length) return false;
  const carPos = flatCarPosition(car, tmpVec3A);
  const targetPos = target ? flatCarPosition(target, tmpVec3B) : null;
  let best = null;
  let bestScore = -Infinity;

  for (const feature of features) {
    const featurePos = featurePosition(feature, tmpVec3C);
    const carDistance = carPos.distanceTo(featurePos);
    if (carDistance < 7 || carDistance > 74) continue;
    const targetDistance = targetPos ? targetPos.distanceTo(featurePos) : 42;
    const radius = Math.max(feature.width ?? 10, feature.length ?? 10) * 0.5;
    const value = featureValue(feature) * personality.featureAwareness * tacticalSkill;
    let score = value - carDistance * 0.075;

    if (mode === "chase") {
      score += Math.max(0, 44 - targetDistance) * 0.12;
      if (feature.type === "ridge") score += 2.2;
      if (targetDistance < radius + 8) score += 4;
    } else {
      const threatDistance = target ? flatDistanceBetween(car, target) : 60;
      score += Math.max(0, 68 - threatDistance) * 0.08;
      score += Math.max(0, 34 - targetDistance) * 0.05 * personality.sabotage;
      if (feature.type === "peak" || feature.type === "ridge") score += 1.6 * personality.sabotage;
    }

    if (score > bestScore) {
      bestScore = score;
      best = feature;
    }
  }

  if (!best || bestScore < 1.5) return false;
  const bestPos = featurePosition(best, tmpVec3C);
  const yaw = best.yaw ?? 0;
  const along = tmpVec3F.set(Math.sin(yaw), 0, Math.cos(yaw));
  const awayFromTarget = targetPos ? tmpVec3E.copy(bestPos).sub(targetPos) : tmpVec3E.set(0, 0, 0);
  if (awayFromTarget.lengthSq() > 0.001) awayFromTarget.normalize();

  if (mode === "chase") {
    out.copy(bestPos)
      .addScaledVector(along, 4 * personality.chaseAggression)
      .sub(carPos);
  } else {
    const side = car.ai.feintSign || car.ai.lateralSign || 1;
    out.copy(bestPos)
      .addScaledVector(along, side * (5 + personality.sabotage * 4))
      .addScaledVector(awayFromTarget, 5 + personality.openSpaceBias * 4)
      .sub(carPos);
  }
  return out.lengthSq() > 0.01;
}

function blendFeatureVector(car, target, desired, arenaId, mode, personality, difficulty) {
  if (!featureTacticalVector(car, target, arenaId, mode, personality, difficulty, tmpVec3D)) return;
  const blend = mode === "chase"
    ? THREE.MathUtils.clamp(0.08 + personality.featureAwareness * 0.12 * (difficulty.tacticalSkill ?? 1), 0.04, 0.32)
    : THREE.MathUtils.clamp(0.1 + personality.featureAwareness * 0.16 * (difficulty.tacticalSkill ?? 1) + personality.sabotage * 0.06, 0.05, 0.42);
  desired.lerp(tmpVec3D.normalize(), blend);
}

export function updateAiCar(car, dt, {
  gameState,
  arenaContactForPoint,
  shouldRightWithJump,
  rng = Math.random,
  difficulty = "medium",
  arenaId = "orange",
} = {}) {
  const difficultyConfig = resolveDifficulty(difficulty);
  const personality = ensureAiMind(car, rng);
  car.ai.jumpCooldown = Math.max(0, car.ai.jumpCooldown - dt);
  car.ai.reverseTimer = Math.max(0, car.ai.reverseTimer - dt);
  car.ai.unstickTimer = Math.max(0, car.ai.unstickTimer - dt);
  car.ai.targetBiasTimer = Math.max(0, car.ai.targetBiasTimer - dt);
  car.ai.decisionTimer = Math.max(0, car.ai.decisionTimer - dt);
  car.ai.mistakeTimer = Math.max(0, car.ai.mistakeTimer - dt);
  car.ai.feintTimer = Math.max(0, car.ai.feintTimer - dt);
  car.ai.lateralTimer -= dt;
  if (car.ai.lateralTimer <= 0) {
    car.ai.lateralSign *= -1;
    car.ai.lateralTimer = 2.2 + rng() * 2.4;
  }

  if (gameState.phase !== "playing") return;
  if (car.ai.decisionTimer > 0) return;
  car.ai.decisionTimer = car.ai.decisionInterval * (difficultyConfig.decisionScale ?? 1);

  car.input.boost = false;
  car.input.boostQueued = false;
  car.input.jumpQueued = false;

  if (car.ai.mistakeTimer <= 0 && rng() < (difficultyConfig.mistakeChance ?? 0) * dt * 3.5) {
    const [minMistake, maxMistake] = difficultyConfig.mistakeDuration ?? [0.1, 0.25];
    car.ai.mistakeTimer = minMistake + rng() * (maxMistake - minMistake);
    car.ai.mistakeSteer = rng() < 0.5 ? -1 : 1;
  }
  if (car.ai.feintTimer <= 0 && rng() < personality.feintChance * dt && !car.isIt) {
    car.ai.feintTimer = 0.35 + rng() * 0.55;
    car.ai.feintSign = rng() < 0.5 ? -1 : 1;
  }

  if (shouldRightWithJump(car) && car.ai.jumpCooldown <= 0) {
    car.input.throttle = 0;
    car.input.steer = 0;
    car.input.jumpQueued = true;
    car.ai.jumpCooldown = 1.35;
    return;
  }

  const pos = car.ai.lastPosition.set(car.body.position.x, 0, car.body.position.z);
  const itCar = gameState.itCar;
  const desired = car.ai.desired.set(0, 0, 0);
  let activeTarget = null;

  if (car.isIt) {
    const best = closestTagTargetFor(car, gameState, personality, difficultyConfig);
    if (best) {
      activeTarget = best;
      chooseAiChaseVector(car, best, desired, arenaContactForPoint, personality, difficultyConfig);
      blendFeatureVector(car, best, desired, arenaId, "chase", personality, difficultyConfig);
    }
  } else if (itCar && itCar !== car) {
    activeTarget = itCar;
    const threatDistance = flatDistanceBetween(car, itCar);
    if (threatDistance > 0.001) {
      chooseAiEscapeVector(car, itCar, desired, dt, gameState, rng, personality, difficultyConfig);
      blendSabotageVector(car, itCar, desired, gameState, personality, difficultyConfig);
      blendFeatureVector(car, itCar, desired, arenaId, "escape", personality, difficultyConfig);
    } else {
      car.ai.waypointTimer -= dt;
      if (car.ai.waypointTimer <= 0 || pos.distanceTo(car.ai.waypoint) < 8) pickWaypoint(car, rng);
      desired.copy(car.ai.waypoint).sub(pos);
    }
  }

  if (desired.lengthSq() < 0.001) {
    car.ai.waypointTimer -= dt;
    if (car.ai.waypointTimer <= 0 || pos.distanceTo(car.ai.waypoint) < 8) pickWaypoint(car, rng);
    desired.copy(car.ai.waypoint).sub(pos);
  }

  const activeTargetDistance = activeTarget
    ? Math.hypot(
        activeTarget.body.position.x - car.body.position.x,
        activeTarget.body.position.y - car.body.position.y,
        activeTarget.body.position.z - car.body.position.z,
      )
    : Infinity;
  const closeTagChase = car.isIt && activeTargetDistance < 24;
  if (car.isIt && !closeTagChase && Math.hypot(car.body.position.x, car.body.position.z) > worldSpec.floorRadius - 8) {
    desired.add(tmpVec3B.set(-car.body.position.x, 0, -car.body.position.z).normalize().multiplyScalar(90));
  }
  const aiAggression = car.isIt
    ? personality.chaseAggression * (difficultyConfig.chaseSkill ?? 1)
    : 0.72 * personality.escapeAggression * (difficultyConfig.escapeSkill ?? 1);
  let aimAngle = 0;
  if (desired.lengthSq() > 0.001) aimAngle = steerToward(car, desired.normalize(), aiAggression);

  if (car.ai.mistakeTimer > 0) {
    car.input.steer = THREE.MathUtils.clamp(car.input.steer + car.ai.mistakeSteer * 0.24, -1, 1);
    car.input.throttle *= 0.88;
  }

  const speed = car.body.velocity.length();
  const absAim = Math.abs(aimAngle);
  if (car.isIt && activeTarget) {
    const targetDistance = activeTargetDistance;
    const closingSpeed =
      car.body.velocity.x * desired.x +
      car.body.velocity.y * desired.y +
      car.body.velocity.z * desired.z;
    if (targetDistance < 10 && absAim > 0.95) car.input.throttle = speed > 8 ? -0.42 : 0.42;
    else if (targetDistance < 22 && absAim > 0.8) car.input.throttle = speed > 11 ? -0.24 : 0.62;
    else if (absAim > 2.35) car.input.throttle = speed > 7 ? -0.38 : 0.48;
    else if (absAim > 1.35 && speed > 18) car.input.throttle = 0.64;
    else if (closingSpeed < -4 && targetDistance < 28) car.input.throttle = 0.46;
    else car.input.throttle = 1;
  } else if (!car.isIt && itCar) {
    if (absAim > 2.55 && speed > 14) car.input.throttle = 0.62;
    else if (absAim > 1.65 && speed > 22) car.input.throttle = 0.78;
    else car.input.throttle = 1;
  }

  if (speed < 1.35 && Math.abs(car.input.throttle) > 0.2) {
    car.ai.stuckTimer += dt;
  } else {
    car.ai.stuckTimer = 0;
  }

  if (activeTarget && car.isIt) {
    const progressDistance = activeTargetDistance;
    if (progressDistance >= car.ai.lastObjectiveDistance - 0.35) car.ai.objectiveProgressTimer += dt;
    else car.ai.objectiveProgressTimer = 0;
    car.ai.lastObjectiveDistance = progressDistance;
    if (car.ai.objectiveProgressTimer > 1.35 / Math.max(0.65, personality.persistence)) {
      car.ai.objectiveProgressTimer = 0;
      car.ai.lateralSign *= -1;
      car.ai.objectiveTimer = 0;
    }
  } else {
    car.ai.lastObjectiveDistance = Infinity;
    car.ai.objectiveProgressTimer = 0;
  }

  if (car.ai.stuckTimer > 0.55) {
    car.ai.reverseTimer = 0.34;
    car.ai.unstickTimer = car.isIt && activeTarget ? 0.42 : 0.82;
    car.ai.unstickSteer = car.isIt && activeTarget
      ? THREE.MathUtils.clamp(aimAngle / 0.72, -1, 1)
      : rng() < 0.5 ? -1 : 1;
    if (Math.abs(car.ai.unstickSteer) > 0.2) car.ai.lateralSign = Math.sign(car.ai.unstickSteer);
    car.ai.stuckTimer = 0;
    if (car.vehicle.numWheelsOnGround >= 2 && car.ai.jumpCooldown <= 0) {
      car.input.jumpQueued = true;
      car.ai.jumpCooldown = 2.4;
    }
    if (car.vehicle.numWheelsOnGround < 2 && car.boostCooldownRemaining <= 0) car.input.boostQueued = true;
  }

  if (car.ai.unstickTimer > 0) {
    car.input.throttle = 1;
    car.input.steer = car.ai.unstickSteer;
  }

  if (car.ai.reverseTimer > 0) {
    car.input.throttle = -0.64;
    car.input.steer *= -0.7;
  }

  const linedUp = Math.abs(car.input.steer) < 0.25;
  if (car.boostCooldownRemaining <= 0) {
    const target = car.isIt ? activeTarget : itCar;
    const targetDistance = target ? flatDistanceBetween(car, target) : Infinity;
    const moderatelyLinedUp = Math.abs(car.input.steer) < 0.36;
    const boostSkill = difficultyConfig.boostDiscipline ?? 1;
    const boostAsIt = car.isIt &&
      targetDistance > 8 &&
      targetDistance < 64 * personality.boostAsIt &&
      speed > 4 &&
      (moderatelyLinedUp || personality.chaseAggression > 1.12) &&
      rng() < THREE.MathUtils.clamp(0.65 * personality.boostAsIt * boostSkill, 0.18, 0.96);
    const boostAsRunner = !car.isIt &&
      itCar &&
      targetDistance < 44 * personality.boostAsRunner &&
      (linedUp || speed < 8) &&
      rng() < THREE.MathUtils.clamp(0.62 * personality.boostAsRunner * boostSkill, 0.16, 0.94);
    if (boostAsIt || boostAsRunner) car.input.boostQueued = true;
  }

  if (!car.isIt &&
    itCar &&
    flatDistanceBetween(car, itCar) < 14 * personality.jumpNearThreat &&
    speed > 8 &&
    car.ai.jumpCooldown <= 0 &&
    car.vehicle.numWheelsOnGround >= 2
  ) {
    car.input.jumpQueued = true;
    car.ai.jumpCooldown = 2.4;
  }
}
