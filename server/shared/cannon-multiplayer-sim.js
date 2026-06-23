import * as CANNON from "cannon-es";
import * as THREE from "three";
import { updateAiCar } from "./ai.js";
import { arenaDefinitions, worldSpec } from "./arena.js";
import { createPhysicsWorld } from "./physics.js";
import {
  rearWheelOptions,
  spawnHeight,
  stabilitySamplePoints,
  vehicleTuning,
  wheelOptions,
  wheelPositions,
} from "./vehicle-config.js";

export const arenaIds = Object.keys(arenaDefinitions);

export const simFixedStep = 1 / 90;
const fixedStep = simFixedStep;
const maxCatchupSteps = 8;
const maxInputBufferEntries = 48;
const collisionGroups = {
  arena: 1,
  car: 2,
};
const arenaWallSegments = 24;
const arenaWallRings = 6;
const arenaWallColliderThickness = 4.5;
const chassisBodyLift = 0.26;
const sideSkidAngle = 0.52;
const minWheelSupportDot = -0.34;
const wheelTagSkin = 0.02;
const wheelTagBounds = {
  minX: -1.05,
  maxX: 1.05,
  minY: -0.32,
  maxY: 0.88,
  minZ: -1.55,
  maxZ: 1.72,
};
const inputFreshnessTimeoutMs = 1500;
const boostForce = new CANNON.Vec3();
const boostPoint = new CANNON.Vec3(0, 0, 1.2);
const wheelTagLocalPoint = new CANNON.Vec3();
const upAxis = new THREE.Vector3(0, 1, 0);
const airControlTorque = new CANNON.Vec3();
const worldAirControlTorque = new CANNON.Vec3();
const stabilityContactResult = { normal: new THREE.Vector3(0, 1, 0), distance: Infinity };
const wheelSupportContactResult = { normal: new THREE.Vector3(0, 1, 0), distance: Infinity };
const arenaContactResult = { point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0), distance: Infinity };
const arenaWallPoint = new THREE.Vector3();
const contactSurfaceNormal = new THREE.Vector3();
const rightingClearanceOffset = new THREE.Vector3();
const rightingSampleWorld = new THREE.Vector3();
const tmpVec3A = new THREE.Vector3();
const tmpVec3B = new THREE.Vector3();
const tmpVec3C = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpQuatB = new THREE.Quaternion();
const tmpMatrix = new THREE.Matrix4();

const rightingClearanceSamplePoints = [
  new THREE.Vector3(0, -0.42, 0),
  new THREE.Vector3(-1.28, -0.42, 1.58),
  new THREE.Vector3(1.28, -0.42, 1.58),
  new THREE.Vector3(-1.28, -0.42, -1.58),
  new THREE.Vector3(1.28, -0.42, -1.58),
  new THREE.Vector3(-1.22, 0.28, 1.18),
  new THREE.Vector3(1.22, 0.28, 1.18),
  new THREE.Vector3(-1.22, 0.28, -1.36),
  new THREE.Vector3(1.22, 0.28, -1.36),
  new THREE.Vector3(0, 0.94, -0.28),
  new THREE.Vector3(0, 0.36, 2.12),
];

function hashString(value) {
  let hash = 2166136261;
  const text = String(value ?? "round");
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function makeSeededRng(seed) {
  let state = hashString(seed) || 1;
  return () => {
    state += 0x6d2b79f5;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const stuntCarNoseVertices = [
  -1.02, -0.4, 0.88,
  1.02, -0.4, 0.88,
  0.38, -0.38, 2.16,
  -0.38, -0.38, 2.16,
  -0.66, 0.24, 0.9,
  0.66, 0.24, 0.9,
  0.18, 0.16, 2.08,
  -0.18, 0.16, 2.08,
];
const stuntCarNoseFaces = [
  [0, 1, 2, 3],
  [4, 7, 6, 5],
  [0, 4, 5, 1],
  [1, 5, 6, 2],
  [2, 6, 7, 3],
  [3, 7, 4, 0],
];
const stuntCarTubVertices = [
  -1.08, -0.4, -1.58,
  1.08, -0.4, -1.58,
  1.02, -0.4, 0.88,
  -1.02, -0.4, 0.88,
  -0.84, 0.44, -1.52,
  0.84, 0.44, -1.52,
  0.66, 0.24, 0.9,
  -0.66, 0.24, 0.9,
];
const stuntCarTubFaces = [
  [0, 1, 2, 3],
  [4, 7, 6, 5],
  [0, 4, 5, 1],
  [1, 5, 6, 2],
  [2, 6, 7, 3],
  [3, 7, 4, 0],
];
const stuntCarCanopyVertices = [
  -0.58, 0.24, -1.16,
  0.58, 0.24, -1.16,
  0.46, 0.24, 0.42,
  -0.46, 0.24, 0.42,
  -0.34, 0.86, -0.96,
  0.34, 0.86, -0.96,
  0.18, 0.48, 0.42,
  -0.18, 0.48, 0.42,
];
const stuntCarCanopyFaces = [
  [0, 1, 2, 3],
  [4, 7, 6, 5],
  [0, 4, 5, 1],
  [1, 5, 6, 2],
  [2, 6, 7, 3],
  [3, 7, 4, 0],
];

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function clampInput(input = {}) {
  return {
    throttle: clamp(Number(input.throttle) || 0, -1, 1),
    steer: clamp(Number(input.steer) || 0, -1, 1),
    boost: Boolean(input.boost),
    boostQueued: Boolean(input.boostQueued),
    jumpQueued: Boolean(input.jumpQueued),
    airRoll: clamp(Number(input.airRoll) || 0, -1, 1),
  };
}

export function mergeInput(previousInput, nextInput = {}) {
  const previous = clampInput(previousInput);
  const next = clampInput(nextInput);
  return {
    ...next,
    boostQueued: previous.boostQueued || next.boostQueued,
    jumpQueued: previous.jumpQueued || next.jumpQueued,
  };
}

function liftCarVertices(verticesSource, yOffset = chassisBodyLift) {
  const vertices = [...verticesSource];
  for (let i = 1; i < vertices.length; i += 3) vertices[i] += yOffset;
  return vertices;
}

function makeCenteredConvexShape(verticesSource, faces) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < verticesSource.length; i += 3) {
    minX = Math.min(minX, verticesSource[i]);
    maxX = Math.max(maxX, verticesSource[i]);
    minY = Math.min(minY, verticesSource[i + 1]);
    maxY = Math.max(maxY, verticesSource[i + 1]);
    minZ = Math.min(minZ, verticesSource[i + 2]);
    maxZ = Math.max(maxZ, verticesSource[i + 2]);
  }
  const offset = new CANNON.Vec3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
  const vertices = [];
  for (let i = 0; i < verticesSource.length; i += 3) {
    vertices.push(new CANNON.Vec3(
      verticesSource[i] - offset.x,
      verticesSource[i + 1] - offset.y,
      verticesSource[i + 2] - offset.z,
    ));
  }
  return {
    shape: new CANNON.ConvexPolyhedron({ vertices, faces }),
    offset,
  };
}

function makeStuntCarTubShape() {
  return makeCenteredConvexShape(liftCarVertices(stuntCarTubVertices), stuntCarTubFaces);
}

function makeStuntCarNoseShape() {
  return makeCenteredConvexShape(liftCarVertices(stuntCarNoseVertices), stuntCarNoseFaces);
}

function makeStuntCarCanopyShape() {
  return makeCenteredConvexShape(liftCarVertices(stuntCarCanopyVertices), stuntCarCanopyFaces);
}

function makeConvexShapeFromFlatVertices(flatVertices, faces) {
  const vertices = [];
  for (let i = 0; i < flatVertices.length; i += 3) {
    vertices.push(new CANNON.Vec3(flatVertices[i], flatVertices[i + 1], flatVertices[i + 2]));
  }
  return new CANNON.ConvexPolyhedron({ vertices, faces });
}

function makeMoundShape(width, length, height, topScale = 0.36) {
  const halfWidth = width / 2;
  const halfLength = length / 2;
  const topHalfWidth = halfWidth * topScale;
  const topHalfLength = halfLength * topScale;
  return makeConvexShapeFromFlatVertices([
    -halfWidth, 0, -halfLength,
    halfWidth, 0, -halfLength,
    -halfWidth, 0, halfLength,
    halfWidth, 0, halfLength,
    -topHalfWidth, height, -topHalfLength,
    topHalfWidth, height, -topHalfLength,
    -topHalfWidth, height, topHalfLength,
    topHalfWidth, height, topHalfLength,
  ], [
    [4, 6, 7, 5],
    [0, 4, 5, 1],
    [1, 5, 7, 3],
    [3, 7, 6, 2],
    [2, 6, 4, 0],
    [0, 1, 3, 2],
  ]);
}

function makePeakShape(width, length, height) {
  const halfWidth = width / 2;
  const halfLength = length / 2;
  return makeConvexShapeFromFlatVertices([
    -halfWidth, 0, -halfLength,
    halfWidth, 0, -halfLength,
    -halfWidth, 0, halfLength,
    halfWidth, 0, halfLength,
    0, height, 0,
  ], [
    [0, 4, 1],
    [1, 4, 3],
    [3, 4, 2],
    [2, 4, 0],
    [0, 1, 3, 2],
  ]);
}

function makeWedgeShape(width, length, height, topScale = 0.72) {
  const halfWidth = width / 2;
  const halfLength = length / 2;
  const topHalfWidth = halfWidth * topScale;
  return makeConvexShapeFromFlatVertices([
    -halfWidth, 0, -halfLength,
    halfWidth, 0, -halfLength,
    -halfWidth, 0, halfLength,
    halfWidth, 0, halfLength,
    -topHalfWidth, height, halfLength,
    topHalfWidth, height, halfLength,
  ], [
    [0, 1, 3, 2],
    [0, 4, 5, 1],
    [2, 3, 5, 4],
    [0, 2, 4],
    [1, 5, 3],
  ]);
}

function makeRidgeShape(width, length, height, ridgeScale = 0.58) {
  const halfWidth = width / 2;
  const halfLength = length / 2;
  const ridgeHalfLength = halfLength * ridgeScale;
  return makeConvexShapeFromFlatVertices([
    -halfWidth, 0, -halfLength,
    halfWidth, 0, -halfLength,
    -halfWidth, 0, halfLength,
    halfWidth, 0, halfLength,
    0, height, -ridgeHalfLength,
    0, height, ridgeHalfLength,
  ], [
    [0, 1, 3, 2],
    [0, 2, 5, 4],
    [1, 4, 5, 3],
    [0, 4, 1],
    [2, 3, 5],
  ]);
}

function makeArenaObstacleShape(obstacle) {
  if (obstacle.type === "peak") return makePeakShape(obstacle.width, obstacle.length, obstacle.height);
  if (obstacle.type === "wedge") return makeWedgeShape(obstacle.width, obstacle.length, obstacle.height, obstacle.topScale);
  if (obstacle.type === "ridge") return makeRidgeShape(obstacle.width, obstacle.length, obstacle.height, obstacle.topScale);
  return makeMoundShape(obstacle.width, obstacle.length, obstacle.height, obstacle.topScale);
}

function orderedConvexFace(vertices, indices, center) {
  const a = vertices[indices[0]];
  const b = vertices[indices[1]];
  const c = vertices[indices[2]];
  const ab = new CANNON.Vec3(b.x - a.x, b.y - a.y, b.z - a.z);
  const ac = new CANNON.Vec3(c.x - a.x, c.y - a.y, c.z - a.z);
  const normal = new CANNON.Vec3();
  ab.cross(ac, normal);
  const faceCenter = new CANNON.Vec3();
  for (const index of indices) faceCenter.vadd(vertices[index], faceCenter);
  faceCenter.scale(1 / indices.length, faceCenter);
  const outward = new CANNON.Vec3(faceCenter.x - center.x, faceCenter.y - center.y, faceCenter.z - center.z);
  return normal.dot(outward) >= 0 ? indices : [...indices].reverse();
}

function setArenaWallGridPoint(theta, phi) {
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  const ringRadius = worldSpec.floorRadius + worldSpec.curveRadius * Math.sin(theta);
  const point = new CANNON.Vec3(
    c * ringRadius,
    worldSpec.curveRadius * (1 - Math.cos(theta)),
    s * ringRadius,
  );
  const normal = new CANNON.Vec3(-Math.sin(theta) * c, Math.cos(theta), -Math.sin(theta) * s);
  normal.normalize();
  return { point, normal };
}

function makeWallTrianglePrismShape(a, b, c, normal) {
  const verticesWorld = [
    new CANNON.Vec3(a.x, a.y, a.z),
    new CANNON.Vec3(b.x, b.y, b.z),
    new CANNON.Vec3(c.x, c.y, c.z),
    new CANNON.Vec3(a.x - normal.x * arenaWallColliderThickness, a.y - normal.y * arenaWallColliderThickness, a.z - normal.z * arenaWallColliderThickness),
    new CANNON.Vec3(b.x - normal.x * arenaWallColliderThickness, b.y - normal.y * arenaWallColliderThickness, b.z - normal.z * arenaWallColliderThickness),
    new CANNON.Vec3(c.x - normal.x * arenaWallColliderThickness, c.y - normal.y * arenaWallColliderThickness, c.z - normal.z * arenaWallColliderThickness),
  ];
  const center = new CANNON.Vec3();
  for (const vertex of verticesWorld) center.vadd(vertex, center);
  center.scale(1 / verticesWorld.length, center);
  const vertices = verticesWorld.map((vertex) => new CANNON.Vec3(vertex.x - center.x, vertex.y - center.y, vertex.z - center.z));
  const localCenter = new CANNON.Vec3(0, 0, 0);
  const faces = [
    orderedConvexFace(vertices, [0, 1, 2], localCenter),
    orderedConvexFace(vertices, [3, 5, 4], localCenter),
    orderedConvexFace(vertices, [0, 3, 4, 1], localCenter),
    orderedConvexFace(vertices, [1, 4, 5, 2], localCenter),
    orderedConvexFace(vertices, [2, 5, 3, 0], localCenter),
  ];
  return { shape: new CANNON.ConvexPolyhedron({ vertices, faces }), offset: center };
}

function addShapeToCompound(body, shape, position, quaternion = null, material = body.material) {
  shape.material = material;
  body.addShape(
    shape,
    new CANNON.Vec3(position.x, position.y, position.z),
    quaternion ? new CANNON.Quaternion(quaternion.x, quaternion.y, quaternion.z, quaternion.w) : new CANNON.Quaternion(),
  );
}

function addArenaPhysics(world, materials, arenaId) {
  const definition = arenaDefinitions[arenaId] ?? arenaDefinitions.orange;
  const arenaBody = new CANNON.Body({ mass: 0, material: materials.groundMaterial });
  arenaBody.collisionFilterGroup = collisionGroups.arena;
  arenaBody.collisionFilterMask = collisionGroups.car;

  const floorQuat = new CANNON.Quaternion();
  floorQuat.setFromEuler(-Math.PI / 2, 0, 0);
  addShapeToCompound(arenaBody, new CANNON.Plane(), new CANNON.Vec3(0, 0, 0), floorQuat, materials.groundMaterial);

  for (const feature of definition.mounds) {
    const featureQuat = new CANNON.Quaternion();
    featureQuat.setFromEuler(0, feature.yaw ?? 0, 0);
    addShapeToCompound(
      arenaBody,
      makeArenaObstacleShape(feature),
      new CANNON.Vec3(feature.x, 0, feature.z),
      featureQuat,
      materials.obstacleMaterial,
    );
  }

  const ceilingQuat = new CANNON.Quaternion();
  ceilingQuat.setFromEuler(Math.PI / 2, 0, 0);
  addShapeToCompound(
    arenaBody,
    new CANNON.Plane(),
    new CANNON.Vec3(0, worldSpec.ceilingY, 0),
    ceilingQuat,
    materials.obstacleMaterial,
  );

  for (let j = 0; j < arenaWallRings; j += 1) {
    const theta0 = (j / arenaWallRings) * Math.PI;
    const theta1 = ((j + 1) / arenaWallRings) * Math.PI;
    for (let i = 0; i < arenaWallSegments; i += 1) {
      const phi0 = (i / arenaWallSegments) * Math.PI * 2;
      const phi1 = ((i + 1) / arenaWallSegments) * Math.PI * 2;
      const p00 = setArenaWallGridPoint(theta0, phi0);
      const p01 = setArenaWallGridPoint(theta0, phi1);
      const p10 = setArenaWallGridPoint(theta1, phi0);
      const p11 = setArenaWallGridPoint(theta1, phi1);
      const firstNormal = p00.normal.vadd(p01.normal).vadd(p10.normal);
      firstNormal.normalize();
      const firstWall = makeWallTrianglePrismShape(p00.point, p01.point, p10.point, firstNormal);
      addShapeToCompound(arenaBody, firstWall.shape, firstWall.offset, null, materials.obstacleMaterial);

      const secondNormal = p01.normal.vadd(p11.normal).vadd(p10.normal);
      secondNormal.normalize();
      const secondWall = makeWallTrianglePrismShape(p01.point, p11.point, p10.point, secondNormal);
      addShapeToCompound(arenaBody, secondWall.shape, secondWall.offset, null, materials.obstacleMaterial);
    }
  }
  world.addBody(arenaBody);
  return arenaBody;
}

function makeInputState() {
  return {
    throttle: 0,
    steer: 0,
    boost: false,
    boostQueued: false,
    jumpQueued: false,
    airRoll: 0,
  };
}

export function queueInputForSession(sim, sessionId, input, {
  sequence = 0,
  targetTick = null,
  receivedAt = Date.now(),
} = {}) {
  if (!sim || !sessionId) return false;
  const cleanSequence = Math.max(0, Math.floor(Number(sequence) || 0));
  const cleanTargetTick = Math.max(0, Math.floor(Number(targetTick) || sim.tick + 1));
  const previousSequence = sim.inputSequences.get(sessionId) ?? 0;
  if (cleanSequence < previousSequence) return false;

  const buffer = sim.inputBuffers.get(sessionId) ?? [];
  buffer.push({
    sequence: cleanSequence,
    targetTick: cleanTargetTick,
    input: clampInput(input),
  });
  buffer.sort((a, b) => a.targetTick - b.targetTick || a.sequence - b.sequence);
  while (buffer.length > maxInputBufferEntries) buffer.shift();
  sim.inputBuffers.set(sessionId, buffer);
  sim.inputTimes.set(sessionId, receivedAt);
  return true;
}

function applyBufferedInputForSession(sim, sessionId, tick) {
  const buffer = sim.inputBuffers.get(sessionId);
  if (!buffer?.length) return;
  let applied = null;
  while (buffer.length && buffer[0].targetTick <= tick) {
    const next = buffer.shift();
    const previousSequence = sim.inputSequences.get(sessionId) ?? 0;
    if (next.sequence >= previousSequence) applied = next;
  }
  if (!buffer.length) sim.inputBuffers.delete(sessionId);
  if (!applied) return;
  sim.inputs.set(sessionId, mergeInput(sim.inputs.get(sessionId), applied.input));
  sim.inputSequences.set(sessionId, applied.sequence);
  sim.inputTargetTicks.set(sessionId, applied.targetTick);
}

function createCar(world, materials, slot, rng = Math.random) {
  const body = new CANNON.Body({
    mass: 180,
    material: materials.chassisMaterial,
    position: new CANNON.Vec3(0, spawnHeight, 0),
    angularDamping: 0.52,
    linearDamping: 0.04,
  });
  body.collisionFilterGroup = collisionGroups.car;
  body.collisionFilterMask = collisionGroups.arena | collisionGroups.car;
  body.allowSleep = false;

  const addChassisBox = (halfExtents, offset, material = materials.chassisMaterial, orientation = null) => {
    const shape = new CANNON.Box(halfExtents);
    shape.material = material;
    body.addShape(shape, offset, orientation);
  };
  const addChassisShape = ({ shape, offset }, material = materials.chassisMaterial) => {
    shape.material = material;
    body.addShape(shape, offset);
  };

  addChassisShape(makeStuntCarTubShape());
  addChassisShape(makeStuntCarNoseShape());
  addChassisShape(makeStuntCarCanopyShape(), materials.roofMaterial);
  const leftSkidQuat = new CANNON.Quaternion();
  leftSkidQuat.setFromAxisAngle(new CANNON.Vec3(0, 0, 1), sideSkidAngle);
  const rightSkidQuat = new CANNON.Quaternion();
  rightSkidQuat.setFromAxisAngle(new CANNON.Vec3(0, 0, 1), -sideSkidAngle);
  addChassisBox(new CANNON.Vec3(0.1, 0.08, 1.58), new CANNON.Vec3(-1.22, -0.38 + chassisBodyLift, -0.02), materials.chassisMaterial, leftSkidQuat);
  addChassisBox(new CANNON.Vec3(0.1, 0.08, 1.58), new CANNON.Vec3(1.22, -0.38 + chassisBodyLift, -0.02), materials.chassisMaterial, rightSkidQuat);
  addChassisBox(new CANNON.Vec3(1.05, 0.05, 0.08), new CANNON.Vec3(0, -0.28 + chassisBodyLift, 1.44));
  addChassisBox(new CANNON.Vec3(1.02, 0.05, 0.08), new CANNON.Vec3(0, -0.24 + chassisBodyLift, -1.5));

  const vehicle = new CANNON.RaycastVehicle({
    chassisBody: body,
    indexRightAxis: 0,
    indexUpAxis: 1,
    indexForwardAxis: 2,
  });
  for (let i = 0; i < wheelPositions.length; i += 1) {
    const point = wheelPositions[i];
    const wheelSetup = i < 2 ? wheelOptions : rearWheelOptions;
    vehicle.addWheel({
      ...wheelSetup,
      chassisConnectionPointLocal: point,
    });
  }

  const car = {
    slot,
    key: slot.key,
    id: slot.id ?? slot.key,
    name: slot.name ?? slot.color ?? slot.key,
    isPlayer: slot.type === "player",
    body,
    vehicle,
    input: makeInputState(),
    currentSteering: 0,
    boostTimeRemaining: 0,
    boostCooldownRemaining: 0,
    surfaceContactGrace: 0,
    surfaceContactNormal: new THREE.Vector3(0, 1, 0),
    surfaceContactCount: 0,
    manualRightingActive: false,
    manualRightingElapsed: 0,
    manualRightingStartPosition: new THREE.Vector3(),
    manualRightingTargetPosition: new THREE.Vector3(),
    manualRightingStartQuaternion: new THREE.Quaternion(),
    manualRightingTargetQuaternion: new THREE.Quaternion(),
    score: 0,
    isIt: false,
    immunityRemaining: 0,
    ai: {
      waypoint: new THREE.Vector3(),
      waypointTimer: 0,
      stuckTimer: 0,
      reverseTimer: 0,
      unstickTimer: 0,
      unstickSteer: 1,
      lateralSign: rng() < 0.5 ? -1 : 1,
      lateralTimer: 1 + rng() * 2,
      personalityKey: null,
      targetBiasTimer: 0,
      targetId: null,
      objective: new THREE.Vector3(),
      desired: new THREE.Vector3(),
      tacticalPoint: new THREE.Vector3(),
      lastPosition: new THREE.Vector3(),
      lastObjectiveDistance: Infinity,
      objectiveProgressTimer: 0,
      decisionTimer: rng() * 0.16,
      decisionInterval: 0.16 + rng() * 0.08,
      objectiveTimer: 0,
      jumpCooldown: 0,
      mistakeTimer: 0,
      mistakeSteer: 0,
      feintTimer: 0,
      feintSign: rng() < 0.5 ? -1 : 1,
      mode: "wander",
      modeTimer: 0,
      modeSeed: rng(),
      modeTargetId: null,
      lastThreatDistance: Infinity,
      lastTargetDistance: Infinity,
      pressure: 0,
      trickCooldown: 0,
      lastAimAngle: 0,
    },
  };
  body.userData = { car };
  vehicle.addToWorld(world);
  return car;
}

function spawnCarAt(car, spawn) {
  car.body.position.set(spawn.x, spawnHeight, spawn.z);
  car.body.velocity.set(0, 0, 0);
  car.body.angularVelocity.set(0, 0, 0);
  car.body.force.set(0, 0, 0);
  car.body.torque.set(0, 0, 0);
  car.body.quaternion.setFromEuler(0, spawn.yaw, 0);
  car.input = makeInputState();
  car.currentSteering = 0;
  car.boostTimeRemaining = 0;
  car.boostCooldownRemaining = 0;
  car.surfaceContactGrace = 0;
  car.surfaceContactNormal.set(0, 1, 0);
  car.surfaceContactCount = 0;
  car.manualRightingActive = false;
  car.manualRightingElapsed = 0;
  car.score = 0;
  car.isIt = false;
  car.immunityRemaining = 0;
  car.ai.stuckTimer = 0;
  car.ai.unstickTimer = 0;
  car.ai.reverseTimer = 0;
  car.ai.targetId = null;
  car.ai.mode = "wander";
  car.ai.modeTimer = 0;
  car.ai.modeTargetId = null;
  car.ai.lastThreatDistance = Infinity;
  car.ai.lastTargetDistance = Infinity;
  car.ai.objectiveProgressTimer = 0;
  car.ai.trickCooldown = 0;
  car.ai.decisionTimer = 0;
  car.ai.objectiveTimer = 0;
  car.ai.desired.set(0, 0, 0);
  car.ai.tacticalPoint.set(spawn.x, 0, spawn.z);
  car.ai.lastPosition.set(spawn.x, 0, spawn.z);
  car.body.previousPosition.copy(car.body.position);
  car.body.previousQuaternion.copy(car.body.quaternion);
  car.body.interpolatedPosition.copy(car.body.position);
  car.body.interpolatedQuaternion.copy(car.body.quaternion);
  car.body.wakeUp();
}

function clearVehicleInputs(car) {
  car.currentSteering = 0;
  for (let i = 0; i < car.vehicle.wheelInfos.length; i += 1) {
    car.vehicle.wheelInfos[i].frictionSlip = i < 2 ? wheelOptions.frictionSlip : rearWheelOptions.frictionSlip;
    car.vehicle.setBrake(0, i);
    car.vehicle.applyEngineForce(0, i);
    car.vehicle.setSteeringValue(0, i);
  }
}

function resetWheelGrip(car) {
  for (let i = 0; i < car.vehicle.wheelInfos.length; i += 1) {
    car.vehicle.wheelInfos[i].frictionSlip = i < 2 ? wheelOptions.frictionSlip : rearWheelOptions.frictionSlip;
  }
}
function driveCar(car) {
  if (car.manualRightingActive) {
    clearVehicleInputs(car);
    return;
  }
  const speedKmh = car.vehicle.currentVehicleSpeedKmHour;
  const itBoost = car.isIt ? vehicleTuning.itSpeedMultiplier : 1;
  resetWheelGrip(car);
  const engine =
    car.input.throttle > 0 && speedKmh < vehicleTuning.maxForwardKmh * itBoost
      ? -vehicleTuning.engineForce * itBoost
      : car.input.throttle < 0 && speedKmh > -vehicleTuning.maxReverseKmh && speedKmh < 5
        ? vehicleTuning.reverseForce
        : 0;
  const brake = car.input.throttle < 0 && speedKmh > 5 ? vehicleTuning.brakeForce : 0;
  const speedSteerT = clamp((Math.abs(speedKmh) - 24) / 72, 0, 1);
  const steeringScale = 1 + (vehicleTuning.highSpeedSteerScale - 1) * speedSteerT;
  const targetSteering = car.input.steer * vehicleTuning.steerAngle * steeringScale;
  const steeringStep = vehicleTuning.steerResponse * fixedStep;
  car.currentSteering += clamp(targetSteering - car.currentSteering, -steeringStep, steeringStep);

  car.vehicle.setSteeringValue(car.currentSteering, 0);
  car.vehicle.setSteeringValue(car.currentSteering, 1);
  car.vehicle.applyEngineForce(engine * 0.28, 0);
  car.vehicle.applyEngineForce(engine * 0.28, 1);
  car.vehicle.applyEngineForce(engine * 0.72, 2);
  car.vehicle.applyEngineForce(engine * 0.72, 3);
  car.vehicle.setBrake(brake, 0);
  car.vehicle.setBrake(brake, 1);
  car.vehicle.setBrake(brake, 2);
  car.vehicle.setBrake(brake, 3);
}

function arenaContactForPoint(pos) {
  const xzLen = Math.hypot(pos.x, pos.z);
  const radialX = xzLen > 0.0001 ? pos.x / xzLen : 1;
  const radialZ = xzLen > 0.0001 ? pos.z / xzLen : 0;

  arenaContactResult.point.set(pos.x, 0, pos.z);
  arenaContactResult.normal.copy(upAxis);
  let bestDistance = pos.y;

  if (xzLen <= worldSpec.floorRadius + 0.6) {
    const ceilingDistance = worldSpec.ceilingY - pos.y;
    if (Math.abs(ceilingDistance) < Math.abs(bestDistance)) {
      arenaContactResult.point.set(pos.x, worldSpec.ceilingY, pos.z);
      arenaContactResult.normal.set(0, -1, 0);
      bestDistance = ceilingDistance;
    }
  }

  if (xzLen >= worldSpec.floorRadius - 0.4 || pos.y > 1.2) {
    const localX = Math.max(0, Math.min(worldSpec.curveRadius, xzLen - worldSpec.floorRadius));
    const localY = pos.y - worldSpec.curveRadius;
    const theta = clamp(Math.atan2(localX, -localY), 0, Math.PI);
    const surfaceRadius = worldSpec.floorRadius + worldSpec.curveRadius * Math.sin(theta);
    const surfaceY = worldSpec.curveRadius * (1 - Math.cos(theta));
    arenaWallPoint.set(radialX * surfaceRadius, surfaceY, radialZ * surfaceRadius);
    const wallNormal = tmpVec3C
      .set(radialX * -Math.sin(theta), Math.cos(theta), radialZ * -Math.sin(theta))
      .normalize();
    const wallDistance = tmpVec3A.copy(pos).sub(arenaWallPoint).dot(wallNormal);

    if (Math.abs(wallDistance) < Math.abs(bestDistance)) {
      arenaContactResult.point.copy(arenaWallPoint);
      arenaContactResult.normal.copy(wallNormal);
      arenaContactResult.distance = wallDistance;
      return arenaContactResult;
    }
  }

  arenaContactResult.distance = bestDistance;
  return arenaContactResult;
}

function wheelSupportContactForCar(car, out = wheelSupportContactResult) {
  out.normal.set(0, 0, 0);
  out.distance = Infinity;

  let contactCount = 0;
  for (const wheel of car.vehicle.wheelInfos) {
    const hit = wheel.raycastResult;
    if (!hit?.hasHit || hit.body?.userData?.car) continue;
    if (hit.hitNormalWorld.dot(wheel.directionWorld) > minWheelSupportDot) continue;

    out.normal.x += hit.hitNormalWorld.x;
    out.normal.y += hit.hitNormalWorld.y;
    out.normal.z += hit.hitNormalWorld.z;
    out.distance = Math.min(out.distance, Math.max(0, wheel.suspensionLength ?? hit.distance ?? 0));
    contactCount += 1;
  }

  if (contactCount <= 0 || out.normal.lengthSq() < 0.0001) {
    out.normal.copy(upAxis);
    out.distance = Infinity;
    return false;
  }

  out.normal.normalize();
  return true;
}

function closestStabilityContactForCar(car) {
  if (car.surfaceContactCount > 0) {
    stabilityContactResult.distance = 0;
    stabilityContactResult.normal.copy(car.surfaceContactNormal);
    return stabilityContactResult;
  }

  if (wheelSupportContactForCar(car, stabilityContactResult)) return stabilityContactResult;

  tmpQuat.set(car.body.quaternion.x, car.body.quaternion.y, car.body.quaternion.z, car.body.quaternion.w);
  stabilityContactResult.distance = Infinity;
  stabilityContactResult.normal.copy(upAxis);

  for (const sample of stabilitySamplePoints) {
    tmpVec3A
      .copy(sample)
      .applyQuaternion(tmpQuat)
      .add(car.body.position);
    const contact = arenaContactForPoint(tmpVec3A);
    if (contact.distance < stabilityContactResult.distance) {
      stabilityContactResult.distance = contact.distance;
      stabilityContactResult.normal.copy(contact.normal);
    }
  }

  return stabilityContactResult;
}

function rightingContactForCar(car) {
  const contact = closestStabilityContactForCar(car);
  if (
    car.vehicle.numWheelsOnGround <= 0 &&
    contact.distance > vehicleTuning.manualRightingSurfaceDistance
  ) {
    return null;
  }
  return contact;
}

function surfaceUpDotForCar(car, contact = rightingContactForCar(car)) {
  if (!contact) return 1;
  tmpQuat.set(car.body.quaternion.x, car.body.quaternion.y, car.body.quaternion.z, car.body.quaternion.w);
  return tmpVec3B.set(0, 1, 0).applyQuaternion(tmpQuat).normalize().dot(contact.normal);
}

function shouldRightWithJump(car) {
  if (car.manualRightingActive) return false;
  const contact = rightingContactForCar(car);
  return !!contact &&
    surfaceUpDotForCar(car, contact) < vehicleTuning.manualRightingDot &&
    car.body.velocity.length() <= vehicleTuning.manualRightingMaxSpeed &&
    car.body.angularVelocity.length() <= vehicleTuning.manualRightingMaxAngularSpeed;
}

function computeRightingTargetQuaternion(car, contact, out) {
  const surfaceNormal = tmpVec3A.copy(contact.normal).normalize();
  tmpQuat.set(car.body.quaternion.x, car.body.quaternion.y, car.body.quaternion.z, car.body.quaternion.w);

  const forward = tmpVec3B.set(0, 0, 1).applyQuaternion(tmpQuat);
  forward.addScaledVector(surfaceNormal, -forward.dot(surfaceNormal));

  if (forward.lengthSq() < 0.0001) {
    const currentRight = tmpVec3C.set(1, 0, 0).applyQuaternion(tmpQuat);
    currentRight.addScaledVector(surfaceNormal, -currentRight.dot(surfaceNormal));
    if (currentRight.lengthSq() < 0.0001) return false;
    currentRight.normalize();
    forward.copy(currentRight).cross(surfaceNormal);
  }

  if (forward.lengthSq() < 0.0001) {
    forward.set(1, 0, 0);
    forward.addScaledVector(surfaceNormal, -forward.dot(surfaceNormal));
  }

  forward.normalize();
  const right = tmpVec3C.copy(surfaceNormal).cross(forward);
  if (right.lengthSq() < 0.0001) return false;
  right.normalize();
  forward.copy(right).cross(surfaceNormal).normalize();

  tmpMatrix.makeBasis(right, surfaceNormal, forward);
  out.setFromRotationMatrix(tmpMatrix);
  return true;
}

function resolveRightingTargetPosition(targetPosition, targetQuaternion) {
  rightingClearanceOffset.set(0, 0, 0);

  for (let pass = 0; pass < 4; pass += 1) {
    let adjusted = false;
    for (const sample of rightingClearanceSamplePoints) {
      rightingSampleWorld
        .copy(sample)
        .applyQuaternion(targetQuaternion)
        .add(targetPosition)
        .add(rightingClearanceOffset);
      const sampleContact = arenaContactForPoint(rightingSampleWorld);
      const minClearance = sample.y < -0.2 ? 0.12 : 0.2;
      if (sampleContact.distance >= minClearance) continue;
      rightingClearanceOffset.addScaledVector(sampleContact.normal, minClearance - sampleContact.distance);
      adjusted = true;
    }
    if (!adjusted) break;
  }

  targetPosition.add(rightingClearanceOffset);
}

function startManualRighting(car, contact) {
  if (
    car.body.velocity.length() > vehicleTuning.manualRightingMaxSpeed ||
    car.body.angularVelocity.length() > vehicleTuning.manualRightingMaxAngularSpeed ||
    !computeRightingTargetQuaternion(car, contact, tmpQuatB)
  ) {
    return false;
  }

  car.manualRightingActive = true;
  car.manualRightingElapsed = 0;
  car.manualRightingStartPosition.set(car.body.position.x, car.body.position.y, car.body.position.z);
  car.manualRightingTargetPosition
    .copy(car.manualRightingStartPosition)
    .addScaledVector(contact.normal, vehicleTuning.manualRightingClearance);
  car.manualRightingStartQuaternion.set(
    car.body.quaternion.x,
    car.body.quaternion.y,
    car.body.quaternion.z,
    car.body.quaternion.w,
  );
  car.manualRightingTargetQuaternion.copy(tmpQuatB);
  resolveRightingTargetPosition(car.manualRightingTargetPosition, car.manualRightingTargetQuaternion);
  car.body.angularVelocity.set(0, 0, 0);
  car.body.torque.set(0, 0, 0);
  clearVehicleInputs(car);

  const surfaceNormal = contact.normal;
  const normalVelocity =
    car.body.velocity.x * surfaceNormal.x +
    car.body.velocity.y * surfaceNormal.y +
    car.body.velocity.z * surfaceNormal.z;
  const velocityDelta = vehicleTuning.manualRightingPopVelocity - normalVelocity;
  if (velocityDelta > 0) {
    car.body.velocity.x += surfaceNormal.x * velocityDelta;
    car.body.velocity.y += surfaceNormal.y * velocityDelta;
    car.body.velocity.z += surfaceNormal.z * velocityDelta;
  }

  car.body.wakeUp();
  return true;
}

function syncChassisHistory(car) {
  car.body.previousPosition.copy(car.body.position);
  car.body.interpolatedPosition.copy(car.body.position);
  car.body.previousQuaternion.copy(car.body.quaternion);
  car.body.interpolatedQuaternion.copy(car.body.quaternion);
}

function updateManualRighting(car, dt) {
  if (!car.manualRightingActive) return false;

  car.manualRightingElapsed = Math.min(
    vehicleTuning.manualRightingDuration,
    car.manualRightingElapsed + dt,
  );
  const t = car.manualRightingElapsed / Math.max(0.001, vehicleTuning.manualRightingDuration);
  const ease = t * t * (3 - 2 * t);

  car.body.position.set(
    THREE.MathUtils.lerp(car.manualRightingStartPosition.x, car.manualRightingTargetPosition.x, ease),
    THREE.MathUtils.lerp(car.manualRightingStartPosition.y, car.manualRightingTargetPosition.y, ease),
    THREE.MathUtils.lerp(car.manualRightingStartPosition.z, car.manualRightingTargetPosition.z, ease),
  );
  tmpQuat.copy(car.manualRightingStartQuaternion).slerp(car.manualRightingTargetQuaternion, ease);
  car.body.quaternion.set(tmpQuat.x, tmpQuat.y, tmpQuat.z, tmpQuat.w);
  car.body.angularVelocity.set(0, 0, 0);
  car.body.force.set(0, 0, 0);
  car.body.torque.set(0, 0, 0);
  clearVehicleInputs(car);
  syncChassisHistory(car);
  car.body.wakeUp();

  if (t >= 1) car.manualRightingActive = false;
  return true;
}

function applyAirControls(car) {
  if (car.manualRightingActive) return;

  car.surfaceContactGrace = Math.max(0, car.surfaceContactGrace - fixedStep);
  const contact = closestStabilityContactForCar(car);
  tmpQuat.set(car.body.quaternion.x, car.body.quaternion.y, car.body.quaternion.z, car.body.quaternion.w);
  const carUp = tmpVec3B.set(0, 1, 0).applyQuaternion(tmpQuat).normalize();
  const surfaceUpDot = carUp.dot(contact.normal);
  const tippedEnoughForAirControl = surfaceUpDot < 0.55;

  if (!car.isPlayer) return;
  if (car.vehicle.numWheelsOnGround >= 2 && !tippedEnoughForAirControl) return;

  const pitchInput = car.input.throttle;
  const yawInput = car.input.steer;
  const rollInput = car.input.airRoll;
  if (pitchInput === 0 && yawInput === 0 && rollInput === 0) return;

  airControlTorque.set(
    pitchInput * vehicleTuning.airPitchTorque,
    yawInput * vehicleTuning.airYawTorque,
    rollInput * vehicleTuning.airRollTorque,
  );
  car.body.vectorToWorldFrame(airControlTorque, worldAirControlTorque);
  car.body.torque.vadd(worldAirControlTorque, car.body.torque);
  car.body.wakeUp();
}

function applyBoost(car, dt) {
  car.boostCooldownRemaining = Math.max(0, car.boostCooldownRemaining - dt);
  if (car.manualRightingActive) {
    car.input.boostQueued = false;
    car.boostTimeRemaining = 0;
    return;
  }
  if (car.input.boostQueued) {
    if (car.boostCooldownRemaining <= 0) {
      car.boostTimeRemaining = vehicleTuning.boostDuration;
      car.boostCooldownRemaining = vehicleTuning.boostCooldown;
    }
    car.input.boostQueued = false;
  }
  if (car.boostTimeRemaining <= 0) return;
  car.boostTimeRemaining = Math.max(0, car.boostTimeRemaining - dt);
  boostForce.set(0, 0, vehicleTuning.boostForce);
  car.body.applyLocalForce(boostForce, boostPoint);
  car.body.wakeUp();
}

function applyQueuedJump(car) {
  if (!car.input.jumpQueued) return;
  const contact = rightingContactForCar(car);
  const tippedForRighting = contact && surfaceUpDotForCar(car, contact) < vehicleTuning.manualRightingDot;
  if (tippedForRighting) {
    startManualRighting(car, contact);
    car.input.jumpQueued = false;
    return;
  }

  if (car.vehicle.numWheelsOnGround >= 2) {
    car.body.wakeUp();
    car.body.position.y += 0.22;
    car.body.velocity.y = Math.max(car.body.velocity.y, vehicleTuning.jumpVelocity);
    car.body.angularVelocity.x = 0;
    car.body.angularVelocity.z = 0;
  }
  car.input.jumpQueued = false;
}

function clearCarSurfaceContacts(cars) {
  for (const car of cars) {
    car.surfaceContactNormal.set(0, 0, 0);
    car.surfaceContactCount = 0;
  }
}

function addCarSurfaceContact(car, contact, carIsBodyI) {
  contactSurfaceNormal.set(contact.ni.x, contact.ni.y, contact.ni.z);
  if (carIsBodyI) contactSurfaceNormal.multiplyScalar(-1);
  car.surfaceContactNormal.add(contactSurfaceNormal);
  car.surfaceContactCount += 1;
  car.surfaceContactGrace = vehicleTuning.contactAssistSurfaceGrace;
}

function finalizeCarSurfaceContacts(cars) {
  for (const car of cars) {
    if (car.surfaceContactCount > 0 && car.surfaceContactNormal.lengthSq() > 0.0001) {
      car.surfaceContactNormal.normalize();
    } else {
      car.surfaceContactNormal.copy(upAxis);
    }
  }
}

function makeTagEvent(sim, tagger, tagged, contactType) {
  return {
    type: "tagConfirmed",
    tick: sim.tick + 1,
    taggerKey: tagger.key,
    taggedKey: tagged.key,
    previousItKey: tagger.key,
    newItKey: tagged.key,
    contactType,
    position: [
      (tagger.body.position.x + tagged.body.position.x) / 2,
      (tagger.body.position.y + tagged.body.position.y) / 2,
      (tagger.body.position.z + tagged.body.position.z) / 2,
    ],
  };
}

function resolveTagPair(sim, carA, carB, contactType = "chassis-contact") {
  if (!carA || !carB || carA === carB || sim.tagCooldown > 0) return false;
  const itCar = carA.isIt ? carA : carB.isIt ? carB : null;
  const other = itCar === carA ? carB : itCar === carB ? carA : null;
  if (!itCar || !other || other.immunityRemaining > 0) return false;
  itCar.isIt = false;
  itCar.immunityRemaining = vehicleTuning.tagImmunityDuration;
  other.isIt = true;
  other.immunityRemaining = 0;
  sim.tagCooldown = 0.28;
  sim.pendingEvents.push(makeTagEvent(sim, itCar, other, contactType));
  return true;
}

function updateWheelTagTransforms(car) {
  for (const wheel of car.vehicle.wheelInfos) {
    car.vehicle.updateWheelTransformWorld(wheel);
  }
}

function wheelCenterTouchesCar(wheel, car) {
  car.body.pointToLocalFrame(wheel.worldTransform.position, wheelTagLocalPoint);
  const radius = (wheel.radius ?? wheelOptions.radius) + wheelTagSkin;
  const closestX = clamp(wheelTagLocalPoint.x, wheelTagBounds.minX, wheelTagBounds.maxX);
  const closestY = clamp(wheelTagLocalPoint.y, wheelTagBounds.minY, wheelTagBounds.maxY);
  const closestZ = clamp(wheelTagLocalPoint.z, wheelTagBounds.minZ, wheelTagBounds.maxZ);
  const dx = wheelTagLocalPoint.x - closestX;
  const dy = wheelTagLocalPoint.y - closestY;
  const dz = wheelTagLocalPoint.z - closestZ;
  return dx * dx + dy * dy + dz * dz <= radius * radius;
}

function playerInputIsFresh(sim, sessionId) {
  if (!sessionId || !sim.inputTimes.has(sessionId)) return true;
  return sim.lastTick - sim.inputTimes.get(sessionId) <= inputFreshnessTimeoutMs;
}

function processWheelTagContacts(sim, cars) {
  if (sim.tagCooldown > 0) return false;
  const itCar = cars.find((car) => car.isIt) ?? null;
  if (!itCar) return false;
  for (const car of cars) updateWheelTagTransforms(car);

  for (const otherCar of cars) {
    if (otherCar === itCar || otherCar.isIt) continue;
    for (const wheel of itCar.vehicle.wheelInfos) {
      if (wheelCenterTouchesCar(wheel, otherCar)) return resolveTagPair(sim, itCar, otherCar, "wheel-body");
    }
    for (const wheel of otherCar.vehicle.wheelInfos) {
      if (wheelCenterTouchesCar(wheel, itCar)) return resolveTagPair(sim, itCar, otherCar, "wheel-body");
    }
  }
  return false;
}

function processContacts(round, cars) {
  const sim = round.sim;
  sim.tagCooldown = Math.max(0, sim.tagCooldown - fixedStep);
  clearCarSurfaceContacts(cars);
  let changed = false;
  for (const contact of sim.physics.contacts) {
    if (contact.enabled === false) continue;
    const carA = contact.bi?.userData?.car;
    const carB = contact.bj?.userData?.car;
    if (carA && !carB) {
      addCarSurfaceContact(carA, contact, true);
      continue;
    }
    if (carB && !carA) {
      addCarSurfaceContact(carB, contact, false);
      continue;
    }
    if (resolveTagPair(sim, carA, carB, "chassis-contact")) {
      changed = true;
      break;
    }
  }
  if (!changed) changed = processWheelTagContacts(sim, cars);
  finalizeCarSurfaceContacts(cars);
  return changed;
}

function stepRound(round) {
  const sim = round.sim;
  const nextTick = sim.tick + 1;
  const cars = [...sim.cars.values()];
  const itCar = cars.find((car) => car.isIt) ?? null;
  const aiGameState = { phase: "playing", cars, itCar };
  for (const car of cars) {
    if (car.slot.type === "player") {
      applyBufferedInputForSession(sim, car.slot.sessionId, nextTick);
      const storedInput = playerInputIsFresh(sim, car.slot.sessionId)
        ? sim.inputs.get(car.slot.sessionId)
        : undefined;
      const input = clampInput(storedInput);
      car.input.throttle = input.throttle;
      car.input.steer = input.steer;
      car.input.boost = input.boost;
      car.input.airRoll = input.airRoll;
      car.input.boostQueued = car.input.boostQueued || input.boostQueued;
      car.input.jumpQueued = car.input.jumpQueued || input.jumpQueued;
      if (storedInput) {
        storedInput.boostQueued = false;
        storedInput.jumpQueued = false;
      } else if (car.slot.sessionId && sim.inputs.has(car.slot.sessionId)) {
        sim.inputs.delete(car.slot.sessionId);
        sim.inputTimes.delete(car.slot.sessionId);
      }
    } else {
      updateAiCar(car, fixedStep, {
        gameState: aiGameState,
        arenaContactForPoint,
        shouldRightWithJump,
        rng: sim.rng,
        difficulty: round.settings.aiDifficulty,
        arenaId: round.settings.arena,
      });
    }
    driveCar(car);
    applyAirControls(car);
    applyBoost(car, fixedStep);
  }
  sim.physics.step(fixedStep);
  const tagChanged = processContacts(round, cars);
  for (const car of cars) {
    applyQueuedJump(car);
    updateManualRighting(car, fixedStep);
    car.immunityRemaining = Math.max(0, car.immunityRemaining - fixedStep);
    if (!car.isIt) car.score += fixedStep;
  }
  return tagChanged;
}

export function createSimState(round, { now = Date.now(), rng = null } = {}) {
  const simRng = rng ?? makeSeededRng(round.seed ?? round.id ?? `${round.startedAt}:${round.settings?.arena}`);
  const {
    physics,
    groundMaterial,
    obstacleMaterial,
    chassisMaterial,
    roofMaterial,
  } = createPhysicsWorld();
  const materials = { groundMaterial, obstacleMaterial, chassisMaterial, roofMaterial };
  addArenaPhysics(physics, materials, round.settings.arena);
  const cars = new Map();
  const spawns = (arenaDefinitions[round.settings.arena] ?? arenaDefinitions.orange).spawnPoints;
  round.slots.forEach((slot, index) => {
    const car = createCar(physics, materials, slot, simRng);
    spawnCarAt(car, spawns[index % spawns.length]);
    cars.set(slot.key, car);
  });

  const carList = [...cars.values()];
  const itCar = carList[Math.floor(simRng() * Math.max(1, carList.length))];
  if (itCar) itCar.isIt = true;

  return {
    physics,
    cars,
    inputs: new Map(),
    inputBuffers: new Map(),
    inputSequences: new Map(),
    inputTargetTicks: new Map(),
    inputTimes: new Map(),
    rng: simRng,
    lastTick: now,
    tick: 0,
    lastSnapshot: 0,
    accumulator: 0,
    tagCooldown: 0,
    pendingEvents: [],
  };
}

export function tickSim(round, now) {
  if (!round?.sim) return { tagChanged: false, steps: 0, events: [] };
  const elapsed = clamp((now - round.sim.lastTick) / 1000, 0, fixedStep * maxCatchupSteps);
  round.sim.lastTick = now;
  if (now < round.playStartsAt) return { tagChanged: false, steps: 0, events: [] };
  round.sim.accumulator = Math.min(round.sim.accumulator + elapsed, fixedStep * maxCatchupSteps);
  let steps = 0;
  let tagChanged = false;
  while (round.sim.accumulator >= fixedStep && steps < maxCatchupSteps) {
    steps += 1;
    tagChanged = stepRound(round) || tagChanged;
    round.sim.tick += 1;
    round.sim.accumulator -= fixedStep;
  }
  const events = round.sim.pendingEvents.splice(0);
  return { tagChanged, steps, events };
}

export function makeSnapshot(roomCode, round, now = Date.now()) {
  if (!round?.sim) return null;
  const remainingMs = now < round.playStartsAt
    ? round.settings.roundTime * 1000
    : Math.max(0, round.endsAt - now);
  return {
    type: "snapshot",
    roomCode,
    roundId: round.id,
    serverTime: now,
    simTick: round.sim.tick,
    simLastTick: round.sim.lastTick,
    simAccumulator: round.sim.accumulator,
    remainingMs,
    cars: round.slots.map((slot) => {
      const car = round.sim.cars.get(slot.key);
      const body = car.body;
      return {
        key: slot.key,
        sessionId: slot.sessionId ?? null,
        position: [body.position.x, body.position.y, body.position.z],
        quaternion: [body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w],
        velocity: [body.velocity.x, body.velocity.y, body.velocity.z],
        angularVelocity: [body.angularVelocity.x, body.angularVelocity.y, body.angularVelocity.z],
        score: car.score,
        isIt: car.isIt,
        immunityRemaining: car.immunityRemaining,
        boostTimeRemaining: car.boostTimeRemaining,
        boostCooldownRemaining: car.boostCooldownRemaining,
        manualRightingActive: car.manualRightingActive,
        manualRightingElapsed: car.manualRightingElapsed,
        manualRightingStartPosition: [
          car.manualRightingStartPosition.x,
          car.manualRightingStartPosition.y,
          car.manualRightingStartPosition.z,
        ],
        manualRightingTargetPosition: [
          car.manualRightingTargetPosition.x,
          car.manualRightingTargetPosition.y,
          car.manualRightingTargetPosition.z,
        ],
        manualRightingStartQuaternion: [
          car.manualRightingStartQuaternion.x,
          car.manualRightingStartQuaternion.y,
          car.manualRightingStartQuaternion.z,
          car.manualRightingStartQuaternion.w,
        ],
        manualRightingTargetQuaternion: [
          car.manualRightingTargetQuaternion.x,
          car.manualRightingTargetQuaternion.y,
          car.manualRightingTargetQuaternion.z,
          car.manualRightingTargetQuaternion.w,
        ],
        inputSequence: slot.sessionId ? (round.sim.inputSequences.get(slot.sessionId) ?? 0) : 0,
        inputTick: slot.sessionId ? (round.sim.inputTargetTicks.get(slot.sessionId) ?? 0) : 0,
        input: clampInput(car.input),
      };
    }),
  };
}
