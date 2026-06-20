import * as THREE from "three";
import { worldSpec } from "./arena.js";

const tmpVec3A = new THREE.Vector3();
const tmpVec3B = new THREE.Vector3();
const tmpVec3C = new THREE.Vector3();
const tmpVec3D = new THREE.Vector3();
const tmpVec3E = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();

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

function closestTagTargetFor(car, gameState) {
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
    const scorePressure = target.score * 0.035;
    const score = distance + anglePenalty + immunityPenalty - closingSpeed * 1.2 - closeBonus - scorePressure;

    if (score < bestScore) {
      bestScore = score;
      best = target;
    }
  }

  car.ai.targetId = best?.id ?? null;
  return best;
}

function updateAiObjective(car, targetPoint, dt, refreshDistance = 10, rng = Math.random) {
  car.ai.objectiveTimer -= dt;
  const current = flatCarPosition(car, tmpVec3A);
  if (
    car.ai.objectiveTimer <= 0 ||
    current.distanceTo(car.ai.objective) < refreshDistance ||
    car.ai.objective.distanceTo(targetPoint) > 18
  ) {
    car.ai.objective.copy(targetPoint);
    car.ai.objectiveTimer = 0.75 + rng() * 0.45;
  }
}

function chooseAiChaseVector(car, target, desired, arenaContactForPoint) {
  const carPos = worldCarPosition(car, tmpVec3A);
  const targetPos = worldCarPosition(target, tmpVec3B);
  const targetVelocity = worldCarVelocity(target, tmpVec3C);
  const distance = carPos.distanceTo(targetPos);
  const targetSpeed = targetVelocity.length();
  const predictTime = THREE.MathUtils.clamp(distance / (22 + targetSpeed * 0.95), distance < 16 ? 0.06 : 0.18, 0.9);
  desired.copy(targetPos).addScaledVector(targetVelocity, predictTime).sub(carPos);

  const contact = arenaContactForPoint(carPos);
  const surfaceComponent = desired.dot(contact.normal);
  desired.addScaledVector(contact.normal, -surfaceComponent);

  if (desired.lengthSq() < 0.01) {
    desired.copy(targetPos).sub(carPos);
    desired.y = 0;
  }
}

function chooseAiEscapeVector(car, threat, desired, dt, gameState, rng = Math.random) {
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
    .addScaledVector(awayDirection, 34 + urgency * 34)
    .addScaledVector(tangent, 16 + urgency * 16);

  if (threatVelocity.lengthSq() > 0.01) {
    const closingSpeed = threatVelocity.dot(awayDirection);
    if (closingSpeed > 2) safePoint.addScaledVector(tangent, 14);
  }

  let bestShield = null;
  let bestShieldScore = Infinity;
  for (const candidate of gameState.cars) {
    if (candidate === car || candidate === threat || candidate.isIt) continue;
    const candidateDistance = Math.hypot(candidate.body.position.x - car.body.position.x, candidate.body.position.z - car.body.position.z);
    const candidateThreatDistance = Math.hypot(candidate.body.position.x - threat.body.position.x, candidate.body.position.z - threat.body.position.z);
    const candidateScore = candidateDistance + Math.abs(candidateThreatDistance - threatDistance) * 0.28 - candidate.score * 0.04;
    if (candidateDistance > 7 && candidateScore < bestShieldScore) {
      bestShieldScore = candidateScore;
      bestShield = candidate;
    }
  }

  if (bestShield && threatDistance < 78) {
    const shieldAwayX = bestShield.body.position.x - threat.body.position.x;
    const shieldAwayZ = bestShield.body.position.z - threat.body.position.z;
    const shieldAwayLength = Math.max(0.001, Math.hypot(shieldAwayX, shieldAwayZ));
    const shieldPoint = tmpVec3B.set(
      bestShield.body.position.x + (shieldAwayX / shieldAwayLength) * 9,
      0,
      bestShield.body.position.z + (shieldAwayZ / shieldAwayLength) * 9,
    );
    safePoint.lerp(shieldPoint, 0.22 + urgency * 0.36);
  }

  const radius = Math.hypot(car.body.position.x, car.body.position.z);
  if (radius > worldSpec.floorRadius - 24) {
    const center = tmpVec3B.set(-car.body.position.x, 0, -car.body.position.z).normalize();
    const wallTangent = tmpVec3C.set(-center.z, 0, center.x).multiplyScalar(car.ai.lateralSign);
    safePoint.addScaledVector(center, (radius - (worldSpec.floorRadius - 24)) * 5.5);
    safePoint.addScaledVector(wallTangent, 18);
  }

  clampArenaVector(safePoint, worldSpec.floorRadius - 7);
  updateAiObjective(car, safePoint, dt, 9, rng);
  desired.copy(car.ai.objective).sub(pos);
}

export function updateAiCar(car, dt, { gameState, arenaContactForPoint, shouldRightWithJump, rng = Math.random }) {
  car.ai.jumpCooldown = Math.max(0, car.ai.jumpCooldown - dt);
  car.ai.reverseTimer = Math.max(0, car.ai.reverseTimer - dt);
  car.ai.unstickTimer = Math.max(0, car.ai.unstickTimer - dt);
  car.ai.targetBiasTimer = Math.max(0, car.ai.targetBiasTimer - dt);
  car.ai.decisionTimer = Math.max(0, car.ai.decisionTimer - dt);
  car.ai.lateralTimer -= dt;
  if (car.ai.lateralTimer <= 0) {
    car.ai.lateralSign *= -1;
    car.ai.lateralTimer = 2.2 + rng() * 2.4;
  }

  if (gameState.phase !== "playing") return;
  if (car.ai.decisionTimer > 0) return;
  car.ai.decisionTimer = car.ai.decisionInterval;

  car.input.boost = false;
  car.input.boostQueued = false;
  car.input.jumpQueued = false;

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
    const best = closestTagTargetFor(car, gameState);
    if (best) {
      activeTarget = best;
      chooseAiChaseVector(car, best, desired, arenaContactForPoint);
    }
  } else if (itCar && itCar !== car) {
    activeTarget = itCar;
    const threatDistance = flatDistanceBetween(car, itCar);
    if (threatDistance > 0.001) {
      chooseAiEscapeVector(car, itCar, desired, dt, gameState, rng);
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
  const aiAggression = car.isIt ? 1 : 0.72;
  let aimAngle = 0;
  if (desired.lengthSq() > 0.001) aimAngle = steerToward(car, desired.normalize(), aiAggression);

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
    const boostAsIt = car.isIt && targetDistance > 8 && targetDistance < 64 && speed > 4 && moderatelyLinedUp;
    const boostAsRunner = !car.isIt && itCar && targetDistance < 44 && (linedUp || speed < 8);
    if (boostAsIt || boostAsRunner) car.input.boostQueued = true;
  }

  if (!car.isIt && itCar && flatDistanceBetween(car, itCar) < 14 && speed > 8 && car.ai.jumpCooldown <= 0 && car.vehicle.numWheelsOnGround >= 2) {
    car.input.jumpQueued = true;
    car.ai.jumpCooldown = 2.4;
  }
}
