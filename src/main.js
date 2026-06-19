import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import * as CANNON from "cannon-es";
import { pickWaypoint, updateAiCar } from "./ai.js";
import {
  arenaDefinitions,
  worldSpec,
} from "./arena.js";
import {
  clampPlayerInput,
  input,
  installInputControls,
  keyboardAxes,
  touchInput,
} from "./input.js";
import { createPhysicsWorld } from "./physics.js";
import {
  carPalette,
  rearWheelOptions,
  spawnHeight,
  stabilitySamplePoints,
  vehicleTuning,
  wheelOptions,
  wheelPositions,
} from "./vehicle-config.js";
import galaxySkyboxUrl from "./assets/sky/galaxy-skybox.webp";
import "./styles.css";

const canvas = document.querySelector("#game");
const speedEl = document.querySelector("#speed");
const boostHudEl = document.querySelector("#boost");
const boostValueEl = document.querySelector("#boost-value");
const jumpButtonEl = document.querySelector("#jump-button");
const joystickEl = document.querySelector("#joystick");
const joystickKnobEl = document.querySelector("#joystick-knob");
const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
const maxPixelRatio = 1;

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxPixelRatio));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = false;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.28;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x030305);
scene.fog = new THREE.Fog(0x080604, 210, 430);

const camera = new THREE.PerspectiveCamera(
  64,
  window.innerWidth / window.innerHeight,
  0.1,
  700,
);

const tmpVec3A = new THREE.Vector3();
const tmpVec3B = new THREE.Vector3();
const tmpVec3C = new THREE.Vector3();
const tmpVec3D = new THREE.Vector3();
const tmpMatrix = new THREE.Matrix4();
const tmpQuat = new THREE.Quaternion();
const tmpQuatB = new THREE.Quaternion();
const carBodyVisualMatrix = new THREE.Matrix4();
const wheelMatrix = new THREE.Matrix4();
const wheelVisualPosition = new THREE.Vector3();
const wheelVisualQuaternion = new THREE.Quaternion();
const wheelVisualScale = new THREE.Vector3(1, 1, 1);
const minWheelVisualSurfaceClearance = wheelOptions.radius + 0.02;
const rightingClearanceOffset = new THREE.Vector3();
const rightingSampleWorld = new THREE.Vector3();
const upAxis = new THREE.Vector3(0, 1, 0);
const airControlTorque = new CANNON.Vec3();
const worldAirControlTorque = new CANNON.Vec3();
const boostForce = new CANNON.Vec3();
const boostPoint = new CANNON.Vec3();
const wheelRayVector = new CANNON.Vec3();
const wheelRayBestPoint = new CANNON.Vec3();
const wheelRayContactVelocity = new CANNON.Vec3();
const wheelLocalChassisUp = new CANNON.Vec3(0, 1, 0);
const wheelChassisUp = new CANNON.Vec3();
const arenaSurfaceRayHit = {
  hasHit: false,
  distance: 0,
  point: new THREE.Vector3(),
  normal: new THREE.Vector3(0, 1, 0),
};
const arenaRayBounds = {
  minX: 0,
  maxX: 0,
  minY: 0,
  maxY: 0,
  minZ: 0,
  maxZ: 0,
};
const savedChassisPosition = new CANNON.Vec3();
const savedChassisQuaternion = new CANNON.Quaternion();
const cameraToCandidate = new THREE.Vector3();
const cameraSafeOffset = new THREE.Vector3();
const cameraRawForward = new THREE.Vector3();
const cameraRawUp = new THREE.Vector3();
const cameraRawRight = new THREE.Vector3();
const countdownCameraStart = new THREE.Vector3();
const countdownCameraEnd = new THREE.Vector3();
const countdownCameraTargetStart = new THREE.Vector3();
const countdownCameraTargetEnd = new THREE.Vector3();
const arenaContactResult = {
  point: new THREE.Vector3(),
  normal: new THREE.Vector3(),
  distance: 0,
};
const stabilityContactResult = {
  normal: new THREE.Vector3(0, 1, 0),
  distance: 0,
};
const wheelSupportContactResult = {
  normal: new THREE.Vector3(0, 1, 0),
  distance: 0,
};
const stabilitySampleWorld = new THREE.Vector3();
const contactSurfaceNormal = new THREE.Vector3();
const arenaWallPoint = new THREE.Vector3();
const tagBursts = [];
const minWheelSupportDot = -0.34;
const collisionGroups = {
  arena: 1,
  car: 2,
};

let profilePhase = "idle";
const profileSampleLimit = 30000;
const detailedProfile = {};

function resetDetailedProfile(enabled = detailedProfile.enabled ?? false) {
  detailedProfile.enabled = enabled;
  detailedProfile.startedAt = performance.now();
  detailedProfile.frames = 0;
  detailedProfile.steps = 0;
  detailedProfile.cappedFrames = 0;
  detailedProfile.buckets = Object.create(null);
  detailedProfile.samples = Object.create(null);
  detailedProfile.raycasts = {
    count: 0,
    timeMs: 0,
    byPhase: Object.create(null),
  };
}

function recordProfileBucket(name, ms) {
  if (!detailedProfile.enabled) return;
  let bucket = detailedProfile.buckets[name];
  if (!bucket) {
    bucket = { count: 0, totalMs: 0, maxMs: 0 };
    detailedProfile.buckets[name] = bucket;
  }
  bucket.count += 1;
  bucket.totalMs += ms;
  bucket.maxMs = Math.max(bucket.maxMs, ms);
}

function recordProfileSample(name, value) {
  if (!detailedProfile.enabled) return;
  let samples = detailedProfile.samples[name];
  if (!samples) {
    samples = [];
    detailedProfile.samples[name] = samples;
  }
  if (samples.length < profileSampleLimit) samples.push(value);
}

function addProfileRaycast(ms) {
  if (!detailedProfile.enabled) return;
  detailedProfile.raycasts.count += 1;
  detailedProfile.raycasts.timeMs += ms;
  let phase = detailedProfile.raycasts.byPhase[profilePhase];
  if (!phase) {
    phase = { count: 0, totalMs: 0 };
    detailedProfile.raycasts.byPhase[profilePhase] = phase;
  }
  phase.count += 1;
  phase.totalMs += ms;
}

function setProfilePhase(phase) {
  const previous = profilePhase;
  profilePhase = phase;
  return previous;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return THREE.MathUtils.lerp(sorted[lower], sorted[upper], index - lower);
}

function summarizeDetailedProfile() {
  const elapsedMs = Math.max(0.001, performance.now() - detailedProfile.startedAt);
  const buckets = {};
  for (const [name, bucket] of Object.entries(detailedProfile.buckets)) {
    buckets[name] = {
      count: bucket.count,
      totalMs: bucket.totalMs,
      avgMs: bucket.totalMs / Math.max(1, bucket.count),
      maxMs: bucket.maxMs,
      msPerSecond: bucket.totalMs / elapsedMs * 1000,
      msPerStep: bucket.totalMs / Math.max(1, detailedProfile.steps),
    };
  }

  const samples = {};
  for (const [name, values] of Object.entries(detailedProfile.samples)) {
    const sorted = [...values].sort((a, b) => a - b);
    samples[name] = {
      count: values.length,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      max: sorted[sorted.length - 1] ?? 0,
    };
  }

  const raycastByPhase = {};
  for (const [phase, data] of Object.entries(detailedProfile.raycasts.byPhase)) {
    raycastByPhase[phase] = {
      count: data.count,
      totalMs: data.totalMs,
      avgMs: data.totalMs / Math.max(1, data.count),
      perStep: data.count / Math.max(1, detailedProfile.steps),
    };
  }

  return {
    elapsedMs,
    frames: detailedProfile.frames,
    steps: detailedProfile.steps,
    cappedFrames: detailedProfile.cappedFrames,
    stepsPerSecond: detailedProfile.steps / elapsedMs * 1000,
    buckets,
    samples,
    raycasts: {
      count: detailedProfile.raycasts.count,
      totalMs: detailedProfile.raycasts.timeMs,
      avgMs: detailedProfile.raycasts.timeMs / Math.max(1, detailedProfile.raycasts.count),
      perStep: detailedProfile.raycasts.count / Math.max(1, detailedProfile.steps),
      byPhase: raycastByPhase,
    },
  };
}

resetDetailedProfile();

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

const {
  physics,
  groundMaterial,
  obstacleMaterial,
  chassisMaterial,
  roofMaterial,
} = createPhysicsWorld();

const arenaWallSegments = 24;
const arenaWallRings = 6;
const arenaWallColliderThickness = 4.5;
const arenaFeatureGridCellSize = 12;
const arenaFeatureGridMin = -worldSpec.outerRadius;
const arenaFeatureGridCells = Math.ceil((worldSpec.outerRadius * 2) / arenaFeatureGridCellSize);
const arenaWallSegmentAngle = (Math.PI * 2) / arenaWallSegments;

function setArenaWallGridPoint(target, normalTarget, theta, phi) {
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  const ringRadius = worldSpec.floorRadius + worldSpec.curveRadius * Math.sin(theta);
  target.set(c * ringRadius, worldSpec.curveRadius * (1 - Math.cos(theta)), s * ringRadius);
  normalTarget.set(-Math.sin(theta) * c, Math.cos(theta), -Math.sin(theta) * s).normalize();
  return target;
}

function makeArenaWallGeometry() {
  const vertices = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  for (let j = 0; j < arenaWallRings; j += 1) {
    const theta0 = (j / arenaWallRings) * Math.PI;
    const theta1 = ((j + 1) / arenaWallRings) * Math.PI;
    for (let i = 0; i < arenaWallSegments; i += 1) {
      const phi0 = (i / arenaWallSegments) * Math.PI * 2;
      const phi1 = ((i + 1) / arenaWallSegments) * Math.PI * 2;
      const base = vertices.length / 3;

      for (const [theta, phi] of [
        [theta0, phi0],
        [theta0, phi1],
        [theta1, phi0],
        [theta1, phi1],
      ]) {
        setArenaWallGridPoint(tmpVec3A, tmpVec3B, theta, phi);
        vertices.push(tmpVec3A.x, tmpVec3A.y, tmpVec3A.z);
        normals.push(tmpVec3B.x, tmpVec3B.y, tmpVec3B.z);
      }
      uvs.push(0, 0, 1, 0, 0, 1, 1, 1);
      indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

function appendWallGridPoint(positions, theta, phi) {
  setArenaWallGridPoint(tmpVec3A, tmpVec3B, theta, phi);
  positions.push(tmpVec3A.x, tmpVec3A.y, tmpVec3A.z);
}

function makeArenaWallPanelEdgeGeometry() {
  const positions = [];

  for (let j = 0; j <= arenaWallRings; j += 1) {
    const theta = (j / arenaWallRings) * Math.PI;
    for (let i = 0; i < arenaWallSegments; i += 1) {
      appendWallGridPoint(positions, theta, (i / arenaWallSegments) * Math.PI * 2);
      appendWallGridPoint(positions, theta, ((i + 1) / arenaWallSegments) * Math.PI * 2);
    }
  }

  for (let i = 0; i < arenaWallSegments; i += 1) {
    const phi = (i / arenaWallSegments) * Math.PI * 2;
    for (let j = 0; j < arenaWallRings; j += 1) {
      appendWallGridPoint(positions, (j / arenaWallRings) * Math.PI, phi);
      appendWallGridPoint(positions, ((j + 1) / arenaWallRings) * Math.PI, phi);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

const arenaGuideRibCount = 24;

function makeArenaSurfaceGuideGeometry({ y, radiusFractions, ribCount = arenaGuideRibCount, segments = arenaWallSegments }) {
  const positions = [];
  for (const fraction of radiusFractions) {
    const radius = worldSpec.floorRadius * fraction;
    for (let i = 0; i < segments; i += 1) {
      const a = (i / segments) * Math.PI * 2;
      const b = ((i + 1) / segments) * Math.PI * 2;
      positions.push(
        Math.cos(a) * radius, y, Math.sin(a) * radius,
        Math.cos(b) * radius, y, Math.sin(b) * radius,
      );
    }
  }

  for (let i = 0; i < ribCount; i += 1) {
    const phi = (i / ribCount) * Math.PI * 2;
    positions.push(
      Math.cos(phi) * 7.5, y, Math.sin(phi) * 7.5,
      Math.cos(phi) * worldSpec.floorRadius, y, Math.sin(phi) * worldSpec.floorRadius,
    );
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

function makeArenaSurfaceAccentGeometry({ y, radiusFractions, segments = arenaWallSegments }) {
  const positions = [];
  for (const fraction of radiusFractions) {
    const radius = worldSpec.floorRadius * fraction;
    for (let i = 0; i < segments; i += 1) {
      const a = (i / segments) * Math.PI * 2;
      const b = ((i + 1) / segments) * Math.PI * 2;
      positions.push(
        Math.cos(a) * radius, y, Math.sin(a) * radius,
        Math.cos(b) * radius, y, Math.sin(b) * radius,
      );
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

function addArenaSurfaceTriangle(triangles, a, b, c) {
  const normal = new THREE.Vector3()
    .subVectors(b, a)
    .cross(new THREE.Vector3().subVectors(c, a))
    .normalize();
  const triangle = {
    a: a.clone(),
    b: b.clone(),
    c: c.clone(),
    normal,
    minX: Math.min(a.x, b.x, c.x),
    maxX: Math.max(a.x, b.x, c.x),
    minY: Math.min(a.y, b.y, c.y),
    maxY: Math.max(a.y, b.y, c.y),
    minZ: Math.min(a.z, b.z, c.z),
    maxZ: Math.max(a.z, b.z, c.z),
    queryStamp: 0,
  };
  triangles.push(triangle);
  return triangle;
}

function addArenaSurfaceGeometry(triangles, geometry, matrix) {
  const position = geometry.getAttribute("position");
  const index = geometry.getIndex();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const setVertex = (target, vertexIndex) => {
    target.fromBufferAttribute(position, vertexIndex).applyMatrix4(matrix);
  };

  if (index) {
    for (let i = 0; i < index.count; i += 3) {
      setVertex(a, index.getX(i));
      setVertex(b, index.getX(i + 1));
      setVertex(c, index.getX(i + 2));
      addArenaSurfaceTriangle(triangles, a, b, c);
    }
    return;
  }

  for (let i = 0; i < position.count; i += 3) {
    setVertex(a, i);
    setVertex(b, i + 1);
    setVertex(c, i + 2);
    addArenaSurfaceTriangle(triangles, a, b, c);
  }
}

function clampArenaFeatureGridIndex(value) {
  return THREE.MathUtils.clamp(
    Math.floor((value - arenaFeatureGridMin) / arenaFeatureGridCellSize),
    0,
    arenaFeatureGridCells - 1,
  );
}

function makeArenaFeatureGrid(triangles) {
  const cells = Array.from({ length: arenaFeatureGridCells * arenaFeatureGridCells }, () => []);
  for (const triangle of triangles) {
    const minX = clampArenaFeatureGridIndex(triangle.minX);
    const maxX = clampArenaFeatureGridIndex(triangle.maxX);
    const minZ = clampArenaFeatureGridIndex(triangle.minZ);
    const maxZ = clampArenaFeatureGridIndex(triangle.maxZ);
    for (let z = minZ; z <= maxZ; z += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        cells[z * arenaFeatureGridCells + x].push(triangle);
      }
    }
  }
  return { cells };
}

function makeArenaWallCells() {
  return Array.from({ length: arenaWallRings }, () => (
    Array.from({ length: arenaWallSegments }, () => [])
  ));
}

function makeArenaSurface(definition) {
  const surface = {
    wallTriangles: [],
    featureTriangles: [],
    wallCells: makeArenaWallCells(),
    featureGrid: null,
    queryStamp: 0,
  };

  for (let j = 0; j < arenaWallRings; j += 1) {
    const theta0 = (j / arenaWallRings) * Math.PI;
    const theta1 = ((j + 1) / arenaWallRings) * Math.PI;
    for (let i = 0; i < arenaWallSegments; i += 1) {
      const phi0 = (i / arenaWallSegments) * Math.PI * 2;
      const phi1 = ((i + 1) / arenaWallSegments) * Math.PI * 2;
      const p00 = new THREE.Vector3();
      const p01 = new THREE.Vector3();
      const p10 = new THREE.Vector3();
      const p11 = new THREE.Vector3();
      setArenaWallGridPoint(p00, tmpVec3A, theta0, phi0);
      setArenaWallGridPoint(p01, tmpVec3A, theta0, phi1);
      setArenaWallGridPoint(p10, tmpVec3A, theta1, phi0);
      setArenaWallGridPoint(p11, tmpVec3A, theta1, phi1);
      surface.wallCells[j][i].push(addArenaSurfaceTriangle(surface.wallTriangles, p00, p01, p10));
      surface.wallCells[j][i].push(addArenaSurfaceTriangle(surface.wallTriangles, p01, p11, p10));
    }
  }

  for (const feature of definition.mounds) {
    const obstacle = {
      type: feature.type,
      width: feature.width,
      length: feature.length,
      height: feature.height,
      topScale: feature.topScale,
    };
    const geometry = makeArenaObstacleGeometry(obstacle);
    tmpMatrix
      .makeRotationY(feature.yaw ?? 0)
      .setPosition(feature.x, 0, feature.z);
    addArenaSurfaceGeometry(surface.featureTriangles, geometry, tmpMatrix);
    geometry.dispose();
  }

  surface.featureGrid = makeArenaFeatureGrid(surface.featureTriangles);

  return surface;
}

function raySegmentTriangleT(from, dir, tri, bounds) {
  if (
    bounds.maxX < tri.minX ||
    bounds.minX > tri.maxX ||
    bounds.maxY < tri.minY ||
    bounds.minY > tri.maxY ||
    bounds.maxZ < tri.minZ ||
    bounds.minZ > tri.maxZ
  ) {
    return null;
  }

  const ax = tri.a.x;
  const ay = tri.a.y;
  const az = tri.a.z;
  const edge1x = tri.b.x - ax;
  const edge1y = tri.b.y - ay;
  const edge1z = tri.b.z - az;
  const edge2x = tri.c.x - ax;
  const edge2y = tri.c.y - ay;
  const edge2z = tri.c.z - az;
  const pvecX = dir.y * edge2z - dir.z * edge2y;
  const pvecY = dir.z * edge2x - dir.x * edge2z;
  const pvecZ = dir.x * edge2y - dir.y * edge2x;
  const det = edge1x * pvecX + edge1y * pvecY + edge1z * pvecZ;
  if (Math.abs(det) < 1e-8) return null;

  const invDet = 1 / det;
  const tvecX = from.x - ax;
  const tvecY = from.y - ay;
  const tvecZ = from.z - az;
  const u = (tvecX * pvecX + tvecY * pvecY + tvecZ * pvecZ) * invDet;
  if (u < -1e-5 || u > 1 + 1e-5) return null;

  const qvecX = tvecY * edge1z - tvecZ * edge1y;
  const qvecY = tvecZ * edge1x - tvecX * edge1z;
  const qvecZ = tvecX * edge1y - tvecY * edge1x;
  const v = (dir.x * qvecX + dir.y * qvecY + dir.z * qvecZ) * invDet;
  if (v < -1e-5 || u + v > 1 + 1e-5) return null;

  const t = (edge2x * qvecX + edge2y * qvecY + edge2z * qvecZ) * invDet;
  return t >= -1e-5 && t <= 1 + 1e-5 ? THREE.MathUtils.clamp(t, 0, 1) : null;
}

function forEachFeatureCandidate(surface, bounds, visit) {
  const grid = surface.featureGrid;
  if (!grid) {
    for (const triangle of surface.featureTriangles) visit(triangle);
    return;
  }

  surface.queryStamp += 1;
  const stamp = surface.queryStamp;
  const minX = clampArenaFeatureGridIndex(bounds.minX);
  const maxX = clampArenaFeatureGridIndex(bounds.maxX);
  const minZ = clampArenaFeatureGridIndex(bounds.minZ);
  const maxZ = clampArenaFeatureGridIndex(bounds.maxZ);
  for (let z = minZ; z <= maxZ; z += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const cell = grid.cells[z * arenaFeatureGridCells + x];
      for (const triangle of cell) {
        if (triangle.queryStamp === stamp) continue;
        triangle.queryStamp = stamp;
        visit(triangle);
      }
    }
  }
}

function normalizeArenaAngle(angle) {
  let normalized = angle % (Math.PI * 2);
  if (normalized < 0) normalized += Math.PI * 2;
  return normalized;
}

function signedArenaAngleDelta(from, to) {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

function wallRingIndexFromY(y, roundFn) {
  const theta = Math.acos(THREE.MathUtils.clamp(1 - y / worldSpec.curveRadius, -1, 1));
  return THREE.MathUtils.clamp(roundFn((theta / Math.PI) * arenaWallRings), 0, arenaWallRings - 1);
}

function forEachWallCandidate(surface, from, to, bounds, segmentLength, visit) {
  const minY = Math.max(0, bounds.minY - 0.25);
  const maxY = Math.min(worldSpec.ceilingY, bounds.maxY + 0.25);
  if (maxY < 0 || minY > worldSpec.ceilingY) return;

  const minRing = Math.max(0, wallRingIndexFromY(minY, Math.floor) - 1);
  const maxRing = Math.min(arenaWallRings - 1, wallRingIndexFromY(maxY, Math.ceil) + 1);
  const fromRadius = Math.hypot(from.x, from.z);
  const toRadius = Math.hypot(to.x, to.z);
  const minRadius = Math.min(fromRadius, toRadius);

  surface.queryStamp += 1;
  const stamp = surface.queryStamp;
  const visitCell = (ring, segment) => {
    const cell = surface.wallCells[ring][segment];
    for (const triangle of cell) {
      if (triangle.queryStamp === stamp) continue;
      triangle.queryStamp = stamp;
      visit(triangle);
    }
  };

  if (minRadius < worldSpec.floorRadius * 0.35) {
    for (let ring = minRing; ring <= maxRing; ring += 1) {
      for (let segment = 0; segment < arenaWallSegments; segment += 1) visitCell(ring, segment);
    }
    return;
  }

  const fromAngle = Math.atan2(from.z, from.x);
  const toAngle = Math.atan2(to.z, to.x);
  const delta = signedArenaAngleDelta(fromAngle, toAngle);
  const center = normalizeArenaAngle(fromAngle + delta * 0.5);
  const angularPadding = Math.min(
    Math.PI,
    Math.abs(delta) * 0.5 + segmentLength / Math.max(minRadius, 1) + arenaWallSegmentAngle * 1.5,
  );
  const centerSegment = Math.floor(center / arenaWallSegmentAngle);
  const segmentRadius = Math.ceil(angularPadding / arenaWallSegmentAngle);

  for (let ring = minRing; ring <= maxRing; ring += 1) {
    for (let offset = -segmentRadius; offset <= segmentRadius; offset += 1) {
      const segment = (centerSegment + offset + arenaWallSegments * 4) % arenaWallSegments;
      visitCell(ring, segment);
    }
  }
}

function raycastArenaSurface(from, to, hit = arenaSurfaceRayHit) {
  const shouldProfile = detailedProfile.enabled;
  const profileStart = shouldProfile ? performance.now() : 0;
  try {
    const surface = activeArenaRuntime?.surface;
    hit.hasHit = false;
    if (!surface) return hit;

    tmpVec3A.set(from.x, from.y, from.z);
    tmpVec3B.set(to.x, to.y, to.z);
    tmpVec3C.subVectors(tmpVec3B, tmpVec3A);
    const segmentLength = tmpVec3C.length();
    if (segmentLength <= 0.0001) return hit;
    arenaRayBounds.minX = Math.min(tmpVec3A.x, tmpVec3B.x);
    arenaRayBounds.maxX = Math.max(tmpVec3A.x, tmpVec3B.x);
    arenaRayBounds.minY = Math.min(tmpVec3A.y, tmpVec3B.y);
    arenaRayBounds.maxY = Math.max(tmpVec3A.y, tmpVec3B.y);
    arenaRayBounds.minZ = Math.min(tmpVec3A.z, tmpVec3B.z);
    arenaRayBounds.maxZ = Math.max(tmpVec3A.z, tmpVec3B.z);

    let bestT = Infinity;
    const recordHit = (t, normal) => {
      if (t < 0 || t > 1 || t >= bestT) return;
      bestT = t;
      hit.hasHit = true;
      hit.distance = segmentLength * t;
      hit.point.copy(tmpVec3A).addScaledVector(tmpVec3C, t);
      hit.normal.copy(normal);
      if (hit.normal.dot(tmpVec3C) > 0) hit.normal.multiplyScalar(-1);
    };

    if (Math.abs(tmpVec3C.y) > 1e-6) {
      const floorT = -tmpVec3A.y / tmpVec3C.y;
      const floorX = tmpVec3A.x + tmpVec3C.x * floorT;
      const floorZ = tmpVec3A.z + tmpVec3C.z * floorT;
      if (floorT >= 0 && floorT <= 1 && Math.hypot(floorX, floorZ) <= worldSpec.floorRadius + 0.01) {
        recordHit(floorT, upAxis);
      }

      const ceilingT = (worldSpec.ceilingY - tmpVec3A.y) / tmpVec3C.y;
      const ceilingX = tmpVec3A.x + tmpVec3C.x * ceilingT;
      const ceilingZ = tmpVec3A.z + tmpVec3C.z * ceilingT;
      if (ceilingT >= 0 && ceilingT <= 1 && Math.hypot(ceilingX, ceilingZ) <= worldSpec.floorRadius + 0.01) {
        recordHit(ceilingT, tmpVec3D.set(0, -1, 0));
      }
    }

    forEachFeatureCandidate(surface, arenaRayBounds, (tri) => {
      const t = raySegmentTriangleT(tmpVec3A, tmpVec3C, tri, arenaRayBounds);
      if (t !== null) recordHit(t, tri.normal);
    });

    const maxRadius = Math.max(Math.hypot(tmpVec3A.x, tmpVec3A.z), Math.hypot(tmpVec3B.x, tmpVec3B.z));
    if (maxRadius >= worldSpec.floorRadius - segmentLength - 0.5) {
      forEachWallCandidate(surface, tmpVec3A, tmpVec3B, arenaRayBounds, segmentLength, (tri) => {
        const t = raySegmentTriangleT(tmpVec3A, tmpVec3C, tri, arenaRayBounds);
        if (t !== null) recordHit(t, tri.normal);
      });
    }

    return hit;
  } finally {
    if (shouldProfile) addProfileRaycast(performance.now() - profileStart);
  }
}

function makeMoundGeometry(width, length, height, topScale = 0.36) {
  const halfWidth = width / 2;
  const halfLength = length / 2;
  const topHalfWidth = halfWidth * topScale;
  const topHalfLength = halfLength * topScale;
  const vertices = new Float32Array([
    -halfWidth, 0, -halfLength,
    halfWidth, 0, -halfLength,
    -halfWidth, 0, halfLength,
    halfWidth, 0, halfLength,
    -topHalfWidth, height, -topHalfLength,
    topHalfWidth, height, -topHalfLength,
    -topHalfWidth, height, topHalfLength,
    topHalfWidth, height, topHalfLength,
  ]);

  const indices = [
    4, 6, 7, 4, 7, 5,
    0, 4, 5, 0, 5, 1,
    1, 5, 7, 1, 7, 3,
    3, 7, 6, 3, 6, 2,
    2, 6, 4, 2, 4, 0,
    0, 1, 3, 0, 3, 2,
  ];

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
  geometry.setAttribute(
    "uv",
    new THREE.BufferAttribute(
      new Float32Array([
        0, 0,
        1, 0,
        0, 1,
        1, 1,
        0.28, 0.28,
        0.72, 0.28,
        0.28, 0.72,
        0.72, 0.72,
      ]),
      2,
    ),
  );
  geometry.setIndex(indices);
  geometry.clearGroups();
  geometry.addGroup(0, 6, 0);
  geometry.addGroup(6, 24, 1);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function makePeakGeometry(width, length, height) {
  const halfWidth = width / 2;
  const halfLength = length / 2;
  const vertices = new Float32Array([
    -halfWidth, 0, -halfLength,
    halfWidth, 0, -halfLength,
    -halfWidth, 0, halfLength,
    halfWidth, 0, halfLength,
    0, height, 0,
  ]);
  const indices = [
    0, 4, 1,
    1, 4, 3,
    3, 4, 2,
    2, 4, 0,
    0, 1, 3, 0, 3, 2,
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.clearGroups();
  geometry.addGroup(0, 12, 0);
  geometry.addGroup(12, 6, 1);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function makeWedgeGeometry(width, length, height, topScale = 0.72) {
  const halfWidth = width / 2;
  const halfLength = length / 2;
  const topHalfWidth = halfWidth * topScale;
  const vertices = new Float32Array([
    -halfWidth, 0, -halfLength,
    halfWidth, 0, -halfLength,
    -halfWidth, 0, halfLength,
    halfWidth, 0, halfLength,
    -topHalfWidth, height, halfLength,
    topHalfWidth, height, halfLength,
  ]);
  const indices = [
    0, 1, 3, 0, 3, 2,
    0, 4, 5, 0, 5, 1,
    2, 3, 5, 2, 5, 4,
    0, 2, 4,
    1, 5, 3,
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.clearGroups();
  geometry.addGroup(0, 6, 1);
  geometry.addGroup(6, 6, 0);
  geometry.addGroup(12, 15, 1);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function makeRidgeGeometry(width, length, height, ridgeScale = 0.58) {
  const halfWidth = width / 2;
  const halfLength = length / 2;
  const ridgeHalfLength = halfLength * ridgeScale;
  const vertices = new Float32Array([
    -halfWidth, 0, -halfLength,
    halfWidth, 0, -halfLength,
    -halfWidth, 0, halfLength,
    halfWidth, 0, halfLength,
    0, height, -ridgeHalfLength,
    0, height, ridgeHalfLength,
  ]);
  const indices = [
    0, 1, 3, 0, 3, 2,
    0, 2, 5, 0, 5, 4,
    1, 4, 5, 1, 5, 3,
    0, 4, 1,
    2, 3, 5,
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.clearGroups();
  geometry.addGroup(0, 6, 1);
  geometry.addGroup(6, 12, 0);
  geometry.addGroup(18, 6, 1);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function makeCockpitGeometry(width, length, height) {
  const halfWidth = width / 2;
  const halfLength = length / 2;
  const topHalfWidth = halfWidth * 0.62;
  const topHalfLength = halfLength * 0.56;
  const vertices = new Float32Array([
    -halfWidth, 0, -halfLength,
    halfWidth, 0, -halfLength,
    halfWidth, 0, halfLength,
    -halfWidth, 0, halfLength,
    -topHalfWidth, height, -topHalfLength,
    topHalfWidth, height, -topHalfLength,
    topHalfWidth, height * 0.72, topHalfLength,
    -topHalfWidth, height * 0.72, topHalfLength,
  ]);
  const indices = [
    0, 1, 2, 0, 2, 3,
    4, 7, 6, 4, 6, 5,
    0, 4, 5, 0, 5, 1,
    1, 5, 6, 1, 6, 2,
    2, 6, 7, 2, 7, 3,
    3, 7, 4, 3, 4, 0,
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
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

const stuntCarBodyVertices = [
  -1.08, -0.4, -1.58,
  1.08, -0.4, -1.58,
  0.84, 0.44, -1.52,
  -0.84, 0.44, -1.52,
  -1.02, -0.4, 0.88,
  1.02, -0.4, 0.88,
  0.66, 0.24, 0.9,
  -0.66, 0.24, 0.9,
  -0.38, -0.38, 2.16,
  0.38, -0.38, 2.16,
  0.18, 0.16, 2.08,
  -0.18, 0.16, 2.08,
];
const stuntCarBodyFaces = [
  [0, 3, 2, 1],
  [8, 9, 10, 11],
  [0, 1, 5, 4],
  [4, 5, 9, 8],
  [3, 7, 6, 2],
  [7, 11, 10, 6],
  [0, 4, 7, 3],
  [4, 8, 11, 7],
  [1, 2, 6, 5],
  [5, 6, 10, 9],
];
const stuntCarBodyEdgePairs = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [8, 9], [9, 10], [10, 11], [11, 8],
  [0, 4], [4, 8],
  [1, 5], [5, 9],
  [2, 6], [6, 10],
  [3, 7], [7, 11],
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

const chassisBodyLift = 0.26;
const sideSkidAngle = 0.52;

function liftCarVertices(verticesSource, yOffset = chassisBodyLift) {
  const vertices = [...verticesSource];
  for (let i = 1; i < vertices.length; i += 3) vertices[i] += yOffset;
  return vertices;
}

function makeConvexGeometry(vertices, faces) {
  const indices = [];
  for (const face of faces) {
    for (let i = 1; i < face.length - 1; i += 1) {
      indices.push(face[0], face[i], face[i + 1]);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(vertices), 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
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

function makeStuntCarTubGeometry() {
  return makeConvexGeometry(liftCarVertices(stuntCarTubVertices), stuntCarTubFaces);
}

function makeStuntCarNoseGeometry() {
  return makeConvexGeometry(liftCarVertices(stuntCarNoseVertices), stuntCarNoseFaces);
}

function makeStuntCarBodyGeometry() {
  return makeConvexGeometry(liftCarVertices(stuntCarBodyVertices), stuntCarBodyFaces);
}

function makeStuntCarBodyEdgeGeometry() {
  const liftedVertices = liftCarVertices(stuntCarBodyVertices);
  const positions = [];
  for (const [a, b] of stuntCarBodyEdgePairs) {
    const ai = a * 3;
    const bi = b * 3;
    positions.push(
      liftedVertices[ai], liftedVertices[ai + 1], liftedVertices[ai + 2],
      liftedVertices[bi], liftedVertices[bi + 1], liftedVertices[bi + 2],
    );
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

function makeStuntCarCanopyGeometry() {
  return makeConvexGeometry(liftCarVertices(stuntCarCanopyVertices), stuntCarCanopyFaces);
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

let sharedCarMaterials = null;

function getSharedCarMaterials() {
  if (!sharedCarMaterials) {
    sharedCarMaterials = {
      darkMaterial: new THREE.MeshStandardMaterial({
        color: 0x090807,
        roughness: 0.74,
        metalness: 0.08,
      }),
      trimMaterial: new THREE.MeshStandardMaterial({
        color: 0x18110d,
        roughness: 0.66,
        metalness: 0.18,
      }),
      exhaustMaterial: new THREE.MeshStandardMaterial({
        color: 0x120907,
        roughness: 0.72,
        metalness: 0.14,
        emissive: 0x210904,
        emissiveIntensity: 0.16,
      }),
      exhaustGlowMaterial: new THREE.MeshBasicMaterial({
        color: 0xff6a24,
        transparent: true,
        opacity: 0.72,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
      glassMaterial: new THREE.MeshStandardMaterial({
        color: 0x0b0d0c,
        roughness: 0.88,
        metalness: 0.02,
        emissive: 0x050808,
        emissiveIntensity: 0.05,
      }),
      bodyEdgeMaterial: new THREE.LineBasicMaterial({
        color: 0x090302,
        transparent: true,
        opacity: 0.86,
        depthWrite: false,
      }),
      bodyGlowMaterial: new THREE.LineBasicMaterial({
        color: 0xff6a24,
        transparent: true,
        opacity: 0.08,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
      warmEdgeMaterial: new THREE.LineBasicMaterial({
        color: 0xffc15c,
        transparent: true,
        opacity: 0.72,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    };
  }
  return sharedCarMaterials;
}

function compactStaticMeshGroup(group) {
  group.updateMatrixWorld(true);
  const buckets = new Map();

  for (const child of [...group.children]) {
    if (!child.isMesh || !child.geometry || Array.isArray(child.material)) continue;
    child.updateMatrix();
    const key = `${child.material.uuid}:${child.renderOrder}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        material: child.material,
        renderOrder: child.renderOrder,
        castShadow: false,
        receiveShadow: false,
        geometries: [],
      };
      buckets.set(key, bucket);
    }
    const geometry = child.geometry.clone();
    geometry.applyMatrix4(child.matrix);
    geometry.deleteAttribute("uv");
    bucket.geometries.push(geometry);
    bucket.castShadow ||= child.castShadow;
    bucket.receiveShadow ||= child.receiveShadow;
    group.remove(child);
    child.geometry.dispose();
  }

  for (const bucket of buckets.values()) {
    if (bucket.geometries.length === 0) continue;
    const geometry = bucket.geometries.length === 1 ? bucket.geometries[0] : mergeGeometries(bucket.geometries, false);
    if (!geometry) {
      for (const unused of bucket.geometries) unused.dispose();
      continue;
    }
    for (const unused of bucket.geometries) {
      if (unused !== geometry) unused.dispose();
    }
    const mesh = new THREE.Mesh(geometry, bucket.material);
    mesh.castShadow = bucket.castShadow;
    mesh.receiveShadow = bucket.receiveShadow;
    mesh.renderOrder = bucket.renderOrder;
    group.add(mesh);
  }
}

function createStaticCompoundBody(material = groundMaterial) {
  const body = new CANNON.Body({
    mass: 0,
    material,
  });
  physics.addBody(body);
  return body;
}

function addShapeToCompound(body, shape, position, quaternion = null, material = body.material) {
  const offset = new CANNON.Vec3(position.x, position.y, position.z);
  const orientation = quaternion
    ? new CANNON.Quaternion(quaternion.x, quaternion.y, quaternion.z, quaternion.w)
    : new CANNON.Quaternion();
  shape.material = material;
  body.addShape(shape, offset, orientation);
}

function makeArenaObstacleGeometry(obstacle) {
  if (obstacle.type === "peak") return makePeakGeometry(obstacle.width, obstacle.length, obstacle.height);
  if (obstacle.type === "wedge") return makeWedgeGeometry(obstacle.width, obstacle.length, obstacle.height, obstacle.topScale);
  if (obstacle.type === "ridge") return makeRidgeGeometry(obstacle.width, obstacle.length, obstacle.height, obstacle.topScale);
  return makeMoundGeometry(obstacle.width, obstacle.length, obstacle.height, obstacle.topScale);
}

function makePolyhedronEdgeGeometry(source, edgePairs) {
  const sourcePosition = source.getAttribute("position");
  const positions = [];
  for (const [a, b] of edgePairs) {
    positions.push(
      sourcePosition.getX(a), sourcePosition.getY(a), sourcePosition.getZ(a),
      sourcePosition.getX(b), sourcePosition.getY(b), sourcePosition.getZ(b),
    );
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

function makeArenaObstacleEdgeGeometry(obstacle, geometry) {
  if (obstacle.type === "peak") {
    return makePolyhedronEdgeGeometry(geometry, [
      [0, 1], [1, 3], [3, 2], [2, 0],
      [0, 4], [1, 4], [3, 4], [2, 4],
    ]);
  }

  if (obstacle.type === "wedge") {
    return makePolyhedronEdgeGeometry(geometry, [
      [0, 1], [1, 3], [3, 2], [2, 0],
      [0, 4], [4, 5], [5, 1],
      [2, 4], [3, 5],
    ]);
  }

  if (obstacle.type === "ridge") {
    return makePolyhedronEdgeGeometry(geometry, [
      [0, 1], [1, 3], [3, 2], [2, 0],
      [4, 5],
      [0, 4], [1, 4], [2, 5], [3, 5],
    ]);
  }

  return makePolyhedronEdgeGeometry(geometry, [
    [0, 1], [1, 3], [3, 2], [2, 0],
    [4, 5], [5, 7], [7, 6], [6, 4],
    [0, 4], [1, 5], [3, 7], [2, 6],
  ]);
}

function makeConvexShapeFromFlatVertices(flatVertices, faces) {
  const vertices = [];
  for (let i = 0; i < flatVertices.length; i += 3) {
    vertices.push(new CANNON.Vec3(flatVertices[i], flatVertices[i + 1], flatVertices[i + 2]));
  }
  return new CANNON.ConvexPolyhedron({ vertices, faces });
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

function makeWallTrianglePrismShape(a, b, c, normal) {
  const verticesWorld = [
    new CANNON.Vec3(a.x, a.y, a.z),
    new CANNON.Vec3(b.x, b.y, b.z),
    new CANNON.Vec3(c.x, c.y, c.z),
    new CANNON.Vec3(
      a.x - normal.x * arenaWallColliderThickness,
      a.y - normal.y * arenaWallColliderThickness,
      a.z - normal.z * arenaWallColliderThickness,
    ),
    new CANNON.Vec3(
      b.x - normal.x * arenaWallColliderThickness,
      b.y - normal.y * arenaWallColliderThickness,
      b.z - normal.z * arenaWallColliderThickness,
    ),
    new CANNON.Vec3(
      c.x - normal.x * arenaWallColliderThickness,
      c.y - normal.y * arenaWallColliderThickness,
      c.z - normal.z * arenaWallColliderThickness,
    ),
  ];

  const center = new CANNON.Vec3();
  for (const vertex of verticesWorld) center.vadd(vertex, center);
  center.scale(1 / verticesWorld.length, center);
  const vertices = verticesWorld.map((vertex) => new CANNON.Vec3(
    vertex.x - center.x,
    vertex.y - center.y,
    vertex.z - center.z,
  ));
  const localCenter = new CANNON.Vec3(0, 0, 0);
  const faces = [
    orderedConvexFace(vertices, [0, 1, 2], localCenter),
    orderedConvexFace(vertices, [3, 5, 4], localCenter),
    orderedConvexFace(vertices, [0, 3, 4, 1], localCenter),
    orderedConvexFace(vertices, [1, 4, 5, 2], localCenter),
    orderedConvexFace(vertices, [2, 5, 3, 0], localCenter),
  ];
  const shape = new CANNON.ConvexPolyhedron({ vertices, faces });
  shape.userData = { arenaWall: true };
  return { shape, offset: center };
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

function addArenaPhysics(runtime, materials, definition) {
  const arenaBody = createStaticCompoundBody();
  arenaBody.collisionFilterGroup = collisionGroups.arena;
  arenaBody.collisionFilterMask = collisionGroups.car;
  runtime.physicsBodies.push(arenaBody);
  runtime.surfaceBody = arenaBody;

  const floorShape = new CANNON.Plane();
  const floorQuat = new CANNON.Quaternion();
  floorQuat.setFromEuler(-Math.PI / 2, 0, 0);
  addShapeToCompound(
    arenaBody,
    floorShape,
    new CANNON.Vec3(0, 0, 0),
    floorQuat,
    groundMaterial,
  );

  for (const feature of definition.mounds) {
    const obstacle = {
      type: feature.type,
      width: feature.width,
      length: feature.length,
      height: feature.height,
      topScale: feature.topScale,
    };
    const featureQuat = new CANNON.Quaternion();
    featureQuat.setFromEuler(0, feature.yaw ?? 0, 0);
    addShapeToCompound(
      arenaBody,
      makeArenaObstacleShape(obstacle),
      new CANNON.Vec3(feature.x, 0, feature.z),
      featureQuat,
      obstacleMaterial,
    );
  }

  const ceilingQuat = new CANNON.Quaternion();
  ceilingQuat.setFromEuler(Math.PI / 2, 0, 0);
  addShapeToCompound(
    arenaBody,
    new CANNON.Plane(),
    new CANNON.Vec3(0, worldSpec.ceilingY, 0),
    ceilingQuat,
    obstacleMaterial,
  );

  for (let j = 0; j < arenaWallRings; j += 1) {
    const theta0 = (j / arenaWallRings) * Math.PI;
    const theta1 = ((j + 1) / arenaWallRings) * Math.PI;
    for (let i = 0; i < arenaWallSegments; i += 1) {
      const phi0 = (i / arenaWallSegments) * Math.PI * 2;
      const phi1 = ((i + 1) / arenaWallSegments) * Math.PI * 2;
      const p00 = new THREE.Vector3();
      const p01 = new THREE.Vector3();
      const p10 = new THREE.Vector3();
      const p11 = new THREE.Vector3();
      const n00 = new THREE.Vector3();
      const n01 = new THREE.Vector3();
      const n10 = new THREE.Vector3();
      const n11 = new THREE.Vector3();
      setArenaWallGridPoint(p00, n00, theta0, phi0);
      setArenaWallGridPoint(p01, n01, theta0, phi1);
      setArenaWallGridPoint(p10, n10, theta1, phi0);
      setArenaWallGridPoint(p11, n11, theta1, phi1);

      const firstNormal = n00.clone().add(n01).add(n10).normalize();
      const firstWall = makeWallTrianglePrismShape(p00, p01, p10, firstNormal);
      addShapeToCompound(arenaBody, firstWall.shape, firstWall.offset, null, obstacleMaterial);

      const secondNormal = n01.clone().add(n11).add(n10).normalize();
      const secondWall = makeWallTrianglePrismShape(p01, p11, p10, secondNormal);
      addShapeToCompound(arenaBody, secondWall.shape, secondWall.offset, null, obstacleMaterial);
    }
  }

  const wallEdgeGeometry = makeArenaWallPanelEdgeGeometry();
  const wallEdgeLines = new THREE.LineSegments(wallEdgeGeometry, materials.wallEdgeMaterial);
  wallEdgeLines.renderOrder = 1;
  runtime.group.add(wallEdgeLines);
}

function addStarSkybox() {
  const texture = new THREE.TextureLoader().load(galaxySkyboxUrl);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.repeat.set(2, 1);
  texture.anisotropy = 1;

  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(610, 32, 16),
    new THREE.MeshBasicMaterial({
      map: texture,
      color: 0x625978,
      side: THREE.BackSide,
      fog: false,
      depthWrite: false,
    }),
  );
  sky.renderOrder = -20;
  scene.add(sky);
}

function makeArenaMaterials(theme) {
  return {
    arenaMaterial: new THREE.MeshStandardMaterial({
      color: theme.surface,
      roughness: 0.96,
      metalness: 0.02,
      emissive: theme.surfaceEmissive,
      emissiveIntensity: 0.08,
      side: THREE.DoubleSide,
    }),
    floorLineMaterial: new THREE.LineBasicMaterial({
      color: theme.floorLine,
      transparent: true,
      opacity: 0.36,
      depthWrite: false,
    }),
    floorGlowMaterial: new THREE.LineBasicMaterial({
      color: theme.floorGlow,
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
    floorAccentMaterial: new THREE.LineBasicMaterial({
      color: theme.floorAccent,
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
    }),
    wallMaterial: new THREE.MeshBasicMaterial({
      color: theme.wallFill,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      side: THREE.FrontSide,
      fog: false,
    }),
    wallEdgeMaterial: new THREE.LineBasicMaterial({
      color: theme.wallEdge,
      transparent: true,
      opacity: 0.54,
      depthWrite: false,
    }),
    rampTopMaterial: new THREE.MeshStandardMaterial({
      color: theme.rampTop,
      roughness: 0.88,
      metalness: 0.04,
      flatShading: true,
      transparent: true,
      opacity: 0.76,
    }),
    rampSideMaterial: new THREE.MeshStandardMaterial({
      color: theme.rampSide,
      roughness: 0.78,
      metalness: 0.04,
      flatShading: true,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.58,
    }),
    rampEdgeMaterial: new THREE.LineBasicMaterial({
      color: theme.rampEdge,
      depthTest: false,
      depthWrite: false,
    }),
  };
}

function disposeArenaMaterials(materials) {
  for (const material of Object.values(materials)) material.dispose();
}

function disposeObjectTree(object) {
  const disposedGeometries = new Set();
  object.traverse((child) => {
    if (child.geometry && !disposedGeometries.has(child.geometry)) {
      child.geometry.dispose();
      disposedGeometries.add(child.geometry);
    }
  });
}

function disposeOwnedObjectTree(object) {
  const ownedMaterials = new Set();
  const disposedGeometries = new Set();
  object.traverse((child) => {
    if (child.geometry && !child.userData?.sharedGeometry && !disposedGeometries.has(child.geometry)) {
      child.geometry.dispose();
      disposedGeometries.add(child.geometry);
    }
    for (const material of child.userData?.ownedMaterials ?? []) ownedMaterials.add(material);
    const material = child.material;
    if (Array.isArray(material)) {
      for (const entry of material) {
        if (entry?.userData?.disposeWithOwner) ownedMaterials.add(entry);
      }
    } else if (material?.userData?.disposeWithOwner) {
      ownedMaterials.add(material);
    }
  });
  for (const material of object.userData?.ownedMaterials ?? []) ownedMaterials.add(material);
  for (const material of ownedMaterials) material.dispose();
}

addStarSkybox();

let activeArenaRuntime = null;
let arenaLights = null;

function extractGeometryMaterialGroup(source, materialIndex) {
  const index = source.getIndex();
  const position = source.getAttribute("position");
  const normal = source.getAttribute("normal");
  const uv = source.getAttribute("uv");
  const positions = [];
  const normals = normal ? [] : null;
  const uvs = uv ? [] : null;

  for (const group of source.groups) {
    if (group.materialIndex !== materialIndex) continue;
    const end = group.start + group.count;
    for (let i = group.start; i < end; i += 1) {
      const vertexIndex = index ? index.getX(i) : i;
      positions.push(
        position.getX(vertexIndex),
        position.getY(vertexIndex),
        position.getZ(vertexIndex),
      );
      if (normal) {
        normals.push(
          normal.getX(vertexIndex),
          normal.getY(vertexIndex),
          normal.getZ(vertexIndex),
        );
      }
      if (uv) {
        uvs.push(
          uv.getX(vertexIndex),
          uv.getY(vertexIndex),
        );
      }
    }
  }

  if (positions.length === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  if (normals) geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  if (uvs) geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeBoundingSphere();
  return geometry;
}

function mergeStaticGeometries(geometries) {
  if (geometries.length === 0) return null;
  const geometry = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries, false);
  if (!geometry) {
    for (const entry of geometries) entry.dispose();
    return null;
  }
  for (const entry of geometries) {
    if (entry !== geometry) entry.dispose();
  }
  return geometry;
}

function clearArenaRuntime() {
  if (!activeArenaRuntime) return;
  for (const body of activeArenaRuntime.physicsBodies) physics.removeBody(body);
  scene.remove(activeArenaRuntime.group);
  disposeObjectTree(activeArenaRuntime.group);
  disposeArenaMaterials(activeArenaRuntime.materials);
  activeArenaRuntime = null;
}

function addMergedLineSegments(geometries, material, runtime) {
  const geometry = mergeStaticGeometries(geometries);
  if (!geometry) return;
  runtime.group.add(new THREE.LineSegments(geometry, material));
}

function addArenaSurfaceGuides(runtime, materials) {
  const floorY = 0.045;
  const ceilingY = worldSpec.ceilingY - 0.045;
  addMergedLineSegments([
    makeArenaSurfaceGuideGeometry({
      y: floorY,
      radiusFractions: [0.12, 0.25, 0.38, 0.5, 0.62, 0.75, 0.88, 1],
    }),
    makeArenaSurfaceGuideGeometry({
      y: ceilingY,
      radiusFractions: [0.12, 0.25, 0.38, 0.5, 0.62, 0.75, 0.88, 1],
    }),
  ], materials.floorLineMaterial, runtime);
  addMergedLineSegments([
    makeArenaSurfaceGuideGeometry({
      y: floorY + 0.012,
      radiusFractions: [0.25, 0.5, 0.75, 1],
    }),
    makeArenaSurfaceGuideGeometry({
      y: ceilingY - 0.012,
      radiusFractions: [0.25, 0.5, 0.75, 1],
    }),
  ], materials.floorGlowMaterial, runtime);
  addMergedLineSegments([
    makeArenaSurfaceAccentGeometry({
      y: floorY + 0.018,
      radiusFractions: [0.16, 0.34, 0.68],
    }),
    makeArenaSurfaceAccentGeometry({
      y: ceilingY - 0.018,
      radiusFractions: [0.16, 0.34, 0.68],
    }),
  ], materials.floorAccentMaterial, runtime);
}

function addArenaLayout(definition, runtime, materials) {
  const moundY = 0;
  const topGeometries = [];
  const sideGeometries = [];
  const edgeGeometries = [];
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3(1, 1, 1);

  for (const mound of definition.mounds) {
    const obstacle = {
      type: mound.type,
      width: mound.width,
      length: mound.length,
      height: mound.height,
      topScale: mound.topScale,
      gap: mound.gap,
      endScale: mound.endScale,
    };
    position.set(mound.x, moundY, mound.z);
    quaternion.setFromAxisAngle(upAxis, mound.yaw ?? 0);
    matrix.compose(position, quaternion, scale);

    const geometry = makeArenaObstacleGeometry(obstacle);
    const topGeometry = extractGeometryMaterialGroup(geometry, 0);
    const sideGeometry = extractGeometryMaterialGroup(geometry, 1);
    if (topGeometry) {
      topGeometry.applyMatrix4(matrix);
      topGeometries.push(topGeometry);
    }
    if (sideGeometry) {
      sideGeometry.applyMatrix4(matrix);
      sideGeometries.push(sideGeometry);
    }

    const edgeGeometry = makeArenaObstacleEdgeGeometry(obstacle, geometry);
    edgeGeometry.applyMatrix4(matrix);
    edgeGeometries.push(edgeGeometry);
    geometry.dispose();
  }

  addMergedLineSegments(edgeGeometries, materials.rampEdgeMaterial, runtime);

  if (topGeometries.length > 0) {
    const geometry = mergeStaticGeometries(topGeometries);
    if (geometry) {
      const mesh = new THREE.Mesh(geometry, materials.rampTopMaterial);
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      runtime.group.add(mesh);
    }
  }

  if (sideGeometries.length > 0) {
    const geometry = mergeStaticGeometries(sideGeometries);
    if (geometry) {
      const mesh = new THREE.Mesh(geometry, materials.rampSideMaterial);
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      runtime.group.add(mesh);
    }
  }
}

function loadArena(id = "orange") {
  const definition = arenaDefinitions[id] ?? arenaDefinitions.orange;
  if (activeArenaRuntime?.id === id) return;
  clearArenaRuntime();

  const materials = makeArenaMaterials(definition.theme);
  const runtime = {
    id,
    definition,
    group: new THREE.Group(),
    physicsBodies: [],
    materials,
    surface: makeArenaSurface(definition),
  };

  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(worldSpec.floorRadius, arenaWallSegments).rotateX(-Math.PI / 2),
    materials.arenaMaterial,
  );
  floor.receiveShadow = true;
  runtime.group.add(floor);

  const ceiling = new THREE.Mesh(
    new THREE.CircleGeometry(worldSpec.floorRadius, arenaWallSegments).rotateX(Math.PI / 2),
    materials.arenaMaterial,
  );
  ceiling.position.y = worldSpec.ceilingY;
  ceiling.receiveShadow = true;
  runtime.group.add(ceiling);

  const wallShell = new THREE.Mesh(makeArenaWallGeometry(), materials.wallMaterial);
  wallShell.receiveShadow = false;
  wallShell.castShadow = false;
  runtime.group.add(wallShell);

  scene.add(runtime.group);
  activeArenaRuntime = runtime;

  addArenaPhysics(runtime, materials, definition);
  addArenaSurfaceGuides(runtime, materials);
  addArenaLayout(definition, runtime, materials);

  if (arenaLights) {
    arenaLights.fill.color.setHex(definition.theme.fillLight);
    arenaLights.wallWash.color.setHex(definition.theme.wallLight);
  }
}

function addLights() {
  scene.add(new THREE.HemisphereLight(0xf0f3ff, 0x1a1720, 2.55));
  scene.add(new THREE.AmbientLight(0xb8bac8, 0.5));

  const key = new THREE.DirectionalLight(0xf5f7ff, 2.65);
  key.position.set(-55, 92, 46);
  key.castShadow = true;
  key.shadow.mapSize.set(512, 512);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 190;
  key.shadow.camera.left = -120;
  key.shadow.camera.right = 120;
  key.shadow.camera.top = 120;
  key.shadow.camera.bottom = -120;
  scene.add(key);

  const fill = new THREE.PointLight(0xff7b32, 56, 180, 1.42);
  fill.position.set(0, 24, 0);
  scene.add(fill);

  const wallWash = new THREE.PointLight(0xff9a42, 92, 240, 1.18);
  wallWash.position.set(0, 18, 0);
  scene.add(wallWash);

  return { fill, wallWash };
}
arenaLights = addLights();
loadArena("orange");

let carBodyVisualResources = null;
let globalCarBodyVisuals = null;
const maxCarBodyVisualCars = 8;
const freeCarBodyVisualSlots = [];
const activeCarBodyVisualSlots = new Set();
let nextCarBodyVisualSlot = 0;

function makeTransformedGeometry(geometry, position, rotationZ = 0) {
  carBodyVisualMatrix.compose(
    position,
    tmpQuat.setFromAxisAngle(tmpVec3D.set(0, 0, 1), rotationZ),
    tmpVec3A.set(1, 1, 1),
  );
  geometry.applyMatrix4(carBodyVisualMatrix);
  return geometry;
}

function makeBoxFeatureGeometry(width, height, length, x, y, z, rotationZ = 0) {
  return makeTransformedGeometry(
    new THREE.BoxGeometry(width, height, length),
    tmpVec3B.set(x, y + chassisBodyLift, z),
    rotationZ,
  );
}

function mergeCarPartGeometries(geometries) {
  const geometry = mergeStaticGeometries(geometries);
  if (geometry) geometry.computeBoundingSphere();
  return geometry;
}

function getCarBodyVisualResources() {
  if (!carBodyVisualResources) {
    const {
      trimMaterial,
      exhaustMaterial,
      exhaustGlowMaterial,
      glassMaterial,
    } = getSharedCarMaterials();
    const trimGeometry = mergeCarPartGeometries([
      makeBoxFeatureGeometry(0.08, 0.06, 2.42, -1.13, -0.42, -0.08, sideSkidAngle),
      makeBoxFeatureGeometry(0.08, 0.06, 2.42, 1.13, -0.42, -0.08, -sideSkidAngle),
      makeBoxFeatureGeometry(1.34, 0.04, 0.06, 0, -0.3, 1.34),
      makeBoxFeatureGeometry(1.24, 0.04, 0.06, 0, -0.26, -1.42),
    ]);
    const pipeGeometry = new THREE.CylinderGeometry(0.105, 0.12, 0.18, 10).rotateX(Math.PI / 2);
    const pipeCoreGeometry = new THREE.CylinderGeometry(0.055, 0.065, 0.192, 8).rotateX(Math.PI / 2);
    const exhaustGeometry = mergeCarPartGeometries([
      makeBoxFeatureGeometry(0.92, 0.2, 0.16, 0, -0.08, -1.63),
      makeTransformedGeometry(pipeGeometry.clone(), tmpVec3B.set(-0.24, -0.06 + chassisBodyLift, -1.73)),
      makeTransformedGeometry(pipeGeometry.clone(), tmpVec3B.set(0.24, -0.06 + chassisBodyLift, -1.73)),
    ]);
    const exhaustGlowGeometry = mergeCarPartGeometries([
      makeTransformedGeometry(pipeCoreGeometry.clone(), tmpVec3B.set(-0.24, -0.06 + chassisBodyLift, -1.742)),
      makeTransformedGeometry(pipeCoreGeometry.clone(), tmpVec3B.set(0.24, -0.06 + chassisBodyLift, -1.742)),
    ]);
    pipeGeometry.dispose();
    pipeCoreGeometry.dispose();
    const bodyGeometry = makeStuntCarBodyGeometry();
    const canopyGeometry = makeStuntCarCanopyGeometry();

    carBodyVisualResources = {
      bodyGeometry,
      bodyEdgeGeometry: makeStuntCarBodyEdgeGeometry(),
      canopyEdgeGeometry: new THREE.EdgesGeometry(canopyGeometry, 24),
      canopyGeometry,
      trimGeometry,
      exhaustGeometry,
      exhaustGlowGeometry,
      glassMaterial,
      trimMaterial,
      exhaustMaterial,
      exhaustGlowMaterial,
    };
  }
  return carBodyVisualResources;
}

function makeCarBodyInstancedMesh(geometry, material, count) {
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  return mesh;
}

function getGlobalCarBodyVisuals() {
  if (globalCarBodyVisuals) return globalCarBodyVisuals;

  const resources = getCarBodyVisualResources();
  const group = new THREE.Group();
  const canopy = makeCarBodyInstancedMesh(resources.canopyGeometry, resources.glassMaterial, maxCarBodyVisualCars);
  const trim = makeCarBodyInstancedMesh(resources.trimGeometry, resources.trimMaterial, maxCarBodyVisualCars);
  const exhaust = makeCarBodyInstancedMesh(resources.exhaustGeometry, resources.exhaustMaterial, maxCarBodyVisualCars);
  const exhaustGlow = makeCarBodyInstancedMesh(resources.exhaustGlowGeometry, resources.exhaustGlowMaterial, maxCarBodyVisualCars);
  exhaust.castShadow = false;
  exhaustGlow.castShadow = false;

  for (let i = 0; i < maxCarBodyVisualCars; i += 1) {
    canopy.setMatrixAt(i, hiddenWheelMatrix);
    trim.setMatrixAt(i, hiddenWheelMatrix);
    exhaust.setMatrixAt(i, hiddenWheelMatrix);
    exhaustGlow.setMatrixAt(i, hiddenWheelMatrix);
  }
  canopy.instanceMatrix.needsUpdate = true;
  trim.instanceMatrix.needsUpdate = true;
  exhaust.instanceMatrix.needsUpdate = true;
  exhaustGlow.instanceMatrix.needsUpdate = true;
  canopy.count = 0;
  trim.count = 0;
  exhaust.count = 0;
  exhaustGlow.count = 0;

  group.add(canopy, trim, exhaust, exhaustGlow);
  scene.add(group);
  globalCarBodyVisuals = { group, canopy, trim, exhaust, exhaustGlow };
  return globalCarBodyVisuals;
}

function highestActiveSlot(slots) {
  let highest = -1;
  for (const slot of slots) highest = Math.max(highest, slot);
  return highest;
}

function updateCarBodyVisualCount() {
  if (!globalCarBodyVisuals) return;
  const count = highestActiveSlot(activeCarBodyVisualSlots) + 1;
  globalCarBodyVisuals.canopy.count = count;
  globalCarBodyVisuals.trim.count = count;
  globalCarBodyVisuals.exhaust.count = count;
  globalCarBodyVisuals.exhaustGlow.count = count;
}

function showCarBodyVisuals(carBodyVisuals) {
  if (!carBodyVisuals) return;
  activeCarBodyVisualSlots.add(carBodyVisuals.slot);
  updateCarBodyVisualCount();
}

function makeCarBodyVisuals(colorHex) {
  const visuals = getGlobalCarBodyVisuals();
  const slot = freeCarBodyVisualSlots.pop() ?? nextCarBodyVisualSlot;
  if (slot >= maxCarBodyVisualCars) throw new Error(`No car body visual slot available for car ${slot + 1}`);
  if (slot === nextCarBodyVisualSlot) nextCarBodyVisualSlot += 1;
  const carBodyVisuals = { slot, ...visuals };
  showCarBodyVisuals(carBodyVisuals);
  return carBodyVisuals;
}

function setCarBodyVisualMatrix(carBodyVisuals, matrix) {
  if (!carBodyVisuals) return;
  const { slot, canopy, trim, exhaust, exhaustGlow } = carBodyVisuals;
  canopy.setMatrixAt(slot, matrix);
  trim.setMatrixAt(slot, matrix);
  exhaust.setMatrixAt(slot, matrix);
  exhaustGlow.setMatrixAt(slot, matrix);
}

function hideCarBodyVisuals(carBodyVisuals) {
  setCarBodyVisualMatrix(carBodyVisuals, hiddenWheelMatrix);
  if (!carBodyVisuals) return;
  activeCarBodyVisualSlots.delete(carBodyVisuals.slot);
  updateCarBodyVisualCount();
  carBodyVisuals.canopy.instanceMatrix.needsUpdate = true;
  carBodyVisuals.trim.instanceMatrix.needsUpdate = true;
  carBodyVisuals.exhaust.instanceMatrix.needsUpdate = true;
  carBodyVisuals.exhaustGlow.instanceMatrix.needsUpdate = true;
}

function releaseCarBodyVisuals(carBodyVisuals) {
  if (!carBodyVisuals) return;
  hideCarBodyVisuals(carBodyVisuals);
  freeCarBodyVisualSlots.push(carBodyVisuals.slot);
}

function markGlobalCarBodyVisualsDirty() {
  if (!globalCarBodyVisuals) return;
  globalCarBodyVisuals.canopy.instanceMatrix.needsUpdate = true;
  globalCarBodyVisuals.trim.instanceMatrix.needsUpdate = true;
  globalCarBodyVisuals.exhaust.instanceMatrix.needsUpdate = true;
  globalCarBodyVisuals.exhaustGlow.instanceMatrix.needsUpdate = true;
}

function makeCarBodyVisual(color = 0xff512f) {
  const group = new THREE.Group();
  const {
    bodyEdgeMaterial,
    bodyGlowMaterial,
    warmEdgeMaterial,
  } = getSharedCarMaterials();
  const resources = getCarBodyVisualResources();
  const bodyMaterial = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.9,
    metalness: 0,
    flatShading: true,
  });
  bodyMaterial.userData.disposeWithOwner = true;

  const body = new THREE.Mesh(resources.bodyGeometry, bodyMaterial);
  body.castShadow = true;
  body.receiveShadow = false;
  body.userData.sharedGeometry = true;
  group.add(body);
  const bodyEdgeLines = new THREE.LineSegments(resources.bodyEdgeGeometry, bodyEdgeMaterial);
  bodyEdgeLines.renderOrder = 1;
  bodyEdgeLines.userData.sharedGeometry = true;
  group.add(bodyEdgeLines);
  const bodyGlowLines = new THREE.LineSegments(resources.bodyEdgeGeometry, bodyGlowMaterial);
  bodyGlowLines.renderOrder = 2;
  bodyGlowLines.userData.sharedGeometry = true;
  group.add(bodyGlowLines);
  const canopyEdgeLines = new THREE.LineSegments(resources.canopyEdgeGeometry, warmEdgeMaterial);
  canopyEdgeLines.renderOrder = 2;
  canopyEdgeLines.userData.sharedGeometry = true;
  group.add(canopyEdgeLines);

  group.userData.bodyVisuals = makeCarBodyVisuals(color);
  group.userData.bodyMaterial = bodyMaterial;
  group.userData.ownedMaterials = [bodyMaterial];
  group.traverse((child) => {
    if (child.isMesh || child.isLineSegments) child.renderOrder = Math.max(child.renderOrder, 2);
  });
  return group;
}

let wheelVisualResources = null;
const maxWheelVisualCars = 8;
const wheelsPerCar = 4;
let globalWheelVisuals = null;
const freeWheelVisualSlots = [];
const activeWheelVisualSlots = new Set();
let nextWheelVisualSlot = 0;
const hiddenWheelMatrix = new THREE.Matrix4().makeScale(0, 0, 0);

function getWheelVisualResources() {
  if (!wheelVisualResources) {
    wheelVisualResources = {
      tireGeometry: new THREE.CylinderGeometry(0.52, 0.52, 0.44, 14).rotateZ(Math.PI / 2),
      rimGeometry: new THREE.CylinderGeometry(0.28, 0.28, 0.48, 10).rotateZ(Math.PI / 2),
      hubGeometry: new THREE.CylinderGeometry(0.15, 0.15, 0.5, 8).rotateZ(Math.PI / 2),
      tireMaterial: new THREE.MeshStandardMaterial({
        color: 0x050403,
        roughness: 0.86,
        metalness: 0.02,
        flatShading: true,
      }),
      rimMaterial: new THREE.MeshStandardMaterial({
        color: 0x2b2926,
        roughness: 0.62,
        metalness: 0.26,
        emissive: 0x060504,
        emissiveIntensity: 0.06,
        flatShading: true,
      }),
      hubMaterial: new THREE.MeshStandardMaterial({
        color: 0x8a8275,
        roughness: 0.48,
        metalness: 0.36,
        emissive: 0x1a140e,
        emissiveIntensity: 0.08,
        flatShading: true,
      }),
    };
  }
  return wheelVisualResources;
}

function getGlobalWheelVisuals() {
  if (globalWheelVisuals) return globalWheelVisuals;

  const resources = getWheelVisualResources();
  const wheelCapacity = maxWheelVisualCars * wheelsPerCar;
  const group = new THREE.Group();
  const tires = new THREE.InstancedMesh(resources.tireGeometry, resources.tireMaterial, wheelCapacity);
  const rims = new THREE.InstancedMesh(resources.rimGeometry, resources.rimMaterial, wheelCapacity);
  const hubs = new THREE.InstancedMesh(resources.hubGeometry, resources.hubMaterial, wheelCapacity);
  tires.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  rims.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  hubs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  tires.frustumCulled = false;
  rims.frustumCulled = false;
  hubs.frustumCulled = false;
  tires.renderOrder = 2;
  rims.renderOrder = 2;
  hubs.renderOrder = 2;
  tires.castShadow = true;
  rims.castShadow = false;
  hubs.castShadow = false;

  for (let i = 0; i < wheelCapacity; i += 1) {
    tires.setMatrixAt(i, hiddenWheelMatrix);
    rims.setMatrixAt(i, hiddenWheelMatrix);
    hubs.setMatrixAt(i, hiddenWheelMatrix);
  }
  tires.instanceMatrix.needsUpdate = true;
  rims.instanceMatrix.needsUpdate = true;
  hubs.instanceMatrix.needsUpdate = true;
  tires.count = 0;
  rims.count = 0;
  hubs.count = 0;

  group.add(tires, rims, hubs);
  scene.add(group);
  globalWheelVisuals = { group, tires, rims, hubs };
  return globalWheelVisuals;
}

function updateWheelVisualCount() {
  if (!globalWheelVisuals) return;
  const count = (highestActiveSlot(activeWheelVisualSlots) + 1) * wheelsPerCar;
  globalWheelVisuals.tires.count = count;
  globalWheelVisuals.rims.count = count;
  globalWheelVisuals.hubs.count = count;
}

function showWheelVisuals(wheelVisuals) {
  if (!wheelVisuals) return;
  activeWheelVisualSlots.add(wheelVisuals.slot);
  updateWheelVisualCount();
}

function makeWheelVisuals() {
  const visuals = getGlobalWheelVisuals();
  const slot = freeWheelVisualSlots.pop() ?? nextWheelVisualSlot;
  if (slot >= maxWheelVisualCars) throw new Error(`No wheel visual slot available for car ${slot + 1}`);
  if (slot === nextWheelVisualSlot) nextWheelVisualSlot += 1;
  const wheelVisuals = { slot, tires: visuals.tires, rims: visuals.rims, hubs: visuals.hubs };
  showWheelVisuals(wheelVisuals);
  return wheelVisuals;
}

function releaseWheelVisuals(wheelVisuals) {
  if (!wheelVisuals) return;
  const baseIndex = wheelVisuals.slot * wheelsPerCar;
  for (let i = 0; i < wheelsPerCar; i += 1) {
    wheelVisuals.tires.setMatrixAt(baseIndex + i, hiddenWheelMatrix);
    wheelVisuals.rims.setMatrixAt(baseIndex + i, hiddenWheelMatrix);
    wheelVisuals.hubs.setMatrixAt(baseIndex + i, hiddenWheelMatrix);
  }
  wheelVisuals.tires.instanceMatrix.needsUpdate = true;
  wheelVisuals.rims.instanceMatrix.needsUpdate = true;
  wheelVisuals.hubs.instanceMatrix.needsUpdate = true;
  activeWheelVisualSlots.delete(wheelVisuals.slot);
  updateWheelVisualCount();
  freeWheelVisualSlots.push(wheelVisuals.slot);
}

let boostFlameResources = null;

function getBoostFlameResources() {
  if (!boostFlameResources) {
    boostFlameResources = {
      outerGeometry: new THREE.ConeGeometry(0.3, 1.55, 18).rotateX(-Math.PI / 2),
      innerGeometry: new THREE.ConeGeometry(0.19, 1.08, 16).rotateX(-Math.PI / 2),
      coreGeometry: new THREE.ConeGeometry(0.09, 0.62, 12).rotateX(-Math.PI / 2),
      outerMaterial: new THREE.MeshBasicMaterial({
        color: 0xff5a1f,
        transparent: true,
        opacity: 0.78,
        depthWrite: false,
      }),
      innerMaterial: new THREE.MeshBasicMaterial({
        color: 0xfff1a8,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      }),
      coreMaterial: new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.68,
        depthWrite: false,
      }),
    };
  }
  return boostFlameResources;
}

function makeBoostFlameMesh(geometry, material, x, z) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, 0.04, z);
  mesh.userData.sharedGeometry = true;
  return mesh;
}

function makeBoostFlame() {
  const group = new THREE.Group();
  const resources = getBoostFlameResources();
  for (const x of [-0.24, 0.24]) {
    group.add(
      makeBoostFlameMesh(resources.outerGeometry, resources.outerMaterial, x, -2.5),
      makeBoostFlameMesh(resources.innerGeometry, resources.innerMaterial, x, -2.34),
      makeBoostFlameMesh(resources.coreGeometry, resources.coreMaterial, x, -2.16),
    );
  }
  const light = new THREE.PointLight(0xff7a2b, 2.2, 6, 2.2);
  light.position.set(0, 0.04, -1.98);

  group.add(light);
  group.visible = false;
  group.userData.light = light;
  return group;
}

let tagMarkerResources = null;

function getTagMarkerResources() {
  if (!tagMarkerResources) {
    tagMarkerResources = {
      beamGeometry: new THREE.CylinderGeometry(0.024, 0.024, 2.35, 6),
      coreGeometry: new THREE.OctahedronGeometry(0.18, 0),
      innerRingGeometry: new THREE.TorusGeometry(0.72, 0.026, 6, 48),
      outerRingGeometry: new THREE.TorusGeometry(1.08, 0.02, 6, 56),
      beamMaterial: new THREE.MeshBasicMaterial({
        color: 0xff5b24,
        transparent: true,
        opacity: 0.42,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
      ringMaterial: new THREE.MeshBasicMaterial({
        color: 0xffd176,
        transparent: true,
        opacity: 0.76,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
      coreMaterial: new THREE.MeshBasicMaterial({
        color: 0xff5b24,
        transparent: true,
        opacity: 0.78,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    };
  }
  return tagMarkerResources;
}

function makeTagMarker() {
  const group = new THREE.Group();
  const resources = getTagMarkerResources();
  const beam = new THREE.Mesh(resources.beamGeometry, resources.beamMaterial);
  beam.position.y = 1.1;
  const lowerRing = new THREE.Mesh(resources.outerRingGeometry, resources.ringMaterial);
  lowerRing.rotation.x = Math.PI / 2;
  lowerRing.position.y = 0.16;
  const upperRing = new THREE.Mesh(resources.innerRingGeometry, resources.ringMaterial);
  upperRing.rotation.x = Math.PI / 2;
  upperRing.position.y = 2.1;
  const core = new THREE.Mesh(resources.coreGeometry, resources.coreMaterial);
  core.position.y = 2.1;
  group.add(beam, lowerRing, upperRing, core);
  group.userData = { beam, lowerRing, upperRing, core };
  group.visible = false;
  return group;
}

let tagBurstResources = null;

function getTagBurstResources() {
  if (!tagBurstResources) {
    tagBurstResources = {
      ringGeometry: new THREE.TorusGeometry(1, 0.026, 6, 64),
      smallRingGeometry: new THREE.TorusGeometry(0.42, 0.018, 6, 40),
      beamGeometry: new THREE.CylinderGeometry(0.018, 0.018, 1.4, 6),
      ringMaterial: new THREE.MeshBasicMaterial({
        color: 0xff6a24,
        transparent: true,
        opacity: 0.8,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
      accentMaterial: new THREE.MeshBasicMaterial({
        color: 0xffd176,
        transparent: true,
        opacity: 0.72,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    };
  }
  return tagBurstResources;
}

function spawnTagBurst(position) {
  const resources = getTagBurstResources();
  const group = new THREE.Group();
  const ringMaterial = resources.ringMaterial.clone();
  const accentMaterial = resources.accentMaterial.clone();
  const groundRing = new THREE.Mesh(resources.ringGeometry, ringMaterial);
  groundRing.rotation.x = Math.PI / 2;
  const upperRing = new THREE.Mesh(resources.smallRingGeometry, accentMaterial);
  upperRing.rotation.x = Math.PI / 2;
  upperRing.position.y = 1.15;
  const beam = new THREE.Mesh(resources.beamGeometry, ringMaterial);
  beam.position.y = 0.64;
  group.add(groundRing, upperRing, beam);
  group.position.copy(position).addScaledVector(upAxis, 0.08);
  group.userData = { age: 0, duration: 0.46, groundRing, upperRing, beam };
  scene.add(group);
  tagBursts.push(group);
}

function updateTagBursts(dt) {
  for (let i = tagBursts.length - 1; i >= 0; i -= 1) {
    const burst = tagBursts[i];
    const data = burst.userData;
    data.age += dt;
    const t = THREE.MathUtils.clamp(data.age / data.duration, 0, 1);
    const fade = 1 - t;
    data.groundRing.scale.setScalar(0.5 + t * 2.3);
    data.upperRing.scale.setScalar(0.6 + t * 1.4);
    data.upperRing.position.y = 1.15 + t * 0.58;
    data.beam.scale.set(1, 1 + t * 0.8, 1);
    data.groundRing.material.opacity = 0.74 * fade;
    data.upperRing.material.opacity = 0.66 * fade;
    data.beam.material.opacity = 0.46 * fade;
    if (data.age < data.duration) continue;
    scene.remove(burst);
    data.groundRing.material.dispose();
    data.upperRing.material.dispose();
    tagBursts.splice(i, 1);
  }
}

const startScreenEl = document.querySelector("#start-screen");
const endScreenEl = document.querySelector("#end-screen");
const startRoundButton = document.querySelector("#start-round");
const playAgainButton = document.querySelector("#play-again");
const menuReturnButton = document.querySelector("#menu-return");
const roundTimeSelect = document.querySelector("#round-time");
const playerCountSelect = document.querySelector("#player-count");
const arenaSelect = document.querySelector("#arena-select");
const colorPickerEl = document.querySelector("#color-picker");
const roundTimerEl = document.querySelector("#round-timer");
const itBannerEl = document.querySelector("#it-banner");
const leaderboardEl = document.querySelector("#leaderboard");
const resultsListEl = document.querySelector("#results-list");
const countdownEl = document.querySelector("#countdown");
const countdownValueEl = document.querySelector("#countdown-value");

installInputControls({ boostHudEl, jumpButtonEl, joystickEl, joystickKnobEl });

const gameState = {
  phase: "menu",
  selectedColor: carPalette[0],
  roundLength: 120,
  timeRemaining: 120,
  countdownRemaining: 0,
  countdownDuration: 3,
  countdownText: "",
  playerCount: 4,
  cars: [],
  aiCars: [],
  itCar: null,
  tagCooldown: 0,
  leaderboardDirty: true,
  lastLeaderboardRender: 0,
};

const hudCache = {
  speedText: "",
  boostReadyPercent: -1,
  boostValueText: "",
  boostReady: null,
  boostActive: null,
  timerText: "",
  itText: "",
  itBackground: "",
};

function getArenaSpawnPoints(id = activeArenaRuntime?.id ?? arenaSelect.value) {
  return (arenaDefinitions[id] ?? arenaDefinitions.orange).spawnPoints;
}

const perfStats = {
  lastSampleTime: performance.now(),
  frames: 0,
  steps: 0,
  frameMsTotal: 0,
  simMsTotal: 0,
  renderMsTotal: 0,
  maxFrameMs: 0,
  maxSimMs: 0,
  maxRenderMs: 0,
  fps: 0,
  avgFrameMs: 0,
  avgSimMs: 0,
  avgRenderMs: 0,
  avgSteps: 0,
};

function recordPerfSample(frameMs, simMs, renderMs, steps) {
  perfStats.frames += 1;
  perfStats.steps += steps;
  perfStats.frameMsTotal += frameMs;
  perfStats.simMsTotal += simMs;
  perfStats.renderMsTotal += renderMs;
  perfStats.maxFrameMs = Math.max(perfStats.maxFrameMs, frameMs);
  perfStats.maxSimMs = Math.max(perfStats.maxSimMs, simMs);
  perfStats.maxRenderMs = Math.max(perfStats.maxRenderMs, renderMs);

  const now = performance.now();
  const elapsed = now - perfStats.lastSampleTime;
  if (elapsed < 1000) return;

  const frameCount = Math.max(1, perfStats.frames);
  perfStats.fps = (perfStats.frames * 1000) / elapsed;
  perfStats.avgFrameMs = perfStats.frameMsTotal / frameCount;
  perfStats.avgSimMs = perfStats.simMsTotal / frameCount;
  perfStats.avgRenderMs = perfStats.renderMsTotal / frameCount;
  perfStats.avgSteps = perfStats.steps / frameCount;
  perfStats.lastSampleTime = now;
  perfStats.frames = 0;
  perfStats.steps = 0;
  perfStats.frameMsTotal = 0;
  perfStats.simMsTotal = 0;
  perfStats.renderMsTotal = 0;
  perfStats.maxFrameMs = 0;
  perfStats.maxSimMs = 0;
  perfStats.maxRenderMs = 0;
}

function setUiPhase(phase) {
  document.body.dataset.phase = phase;
}

function makeInputState() {
  return {
    throttle: 0,
    steer: 0,
    boost: false,
    boostQueued: false,
    jumpQueued: false,
  };
}

function installVehicleWheelRayFilter(vehicle) {
  vehicle.castRay = (wheel) => {
    vehicle.updateWheelTransformWorld(wheel);
    const chassisBody = vehicle.chassisBody;
    const rayLength = wheel.suspensionRestLength + wheel.radius;
    const source = wheel.chassisConnectionPointWorld;
    const raycastResult = wheel.raycastResult;
    raycastResult.reset();

    wheel.raycastResult.groundObject = 0;

    wheel.directionWorld.scale(rayLength, wheelRayVector);
    source.vadd(wheelRayVector, wheelRayBestPoint);
    const surfaceHit = raycastArenaSurface(source, wheelRayBestPoint);
    if (surfaceHit.hasHit) {
      raycastResult.hasHit = true;
      raycastResult.distance = surfaceHit.distance;
      raycastResult.hitPointWorld.set(surfaceHit.point.x, surfaceHit.point.y, surfaceHit.point.z);
      raycastResult.hitNormalWorld.set(surfaceHit.normal.x, surfaceHit.normal.y, surfaceHit.normal.z);
      raycastResult.body = activeArenaRuntime?.surfaceBody ?? null;
      raycastResult.shape = null;
    }
    chassisBody.vectorToWorldFrame(wheelLocalChassisUp, wheelChassisUp);
    const chassisSurfaceDot =
      wheelChassisUp.x * raycastResult.hitNormalWorld.x +
      wheelChassisUp.y * raycastResult.hitNormalWorld.y +
      wheelChassisUp.z * raycastResult.hitNormalWorld.z;
    const hitDistance = raycastResult.distance;

    if (
      raycastResult.hasHit &&
      !raycastResult.body?.userData?.car &&
      hitDistance >= 0 &&
      hitDistance <= rayLength &&
      chassisSurfaceDot >= vehicleTuning.wheelSupportMinUpDot
    ) {
      wheel.isInContact = true;
      wheel.suspensionLength = hitDistance - wheel.radius;

      const minSuspensionLength = wheel.suspensionRestLength - wheel.maxSuspensionTravel;
      const maxSuspensionLength = wheel.suspensionRestLength + wheel.maxSuspensionTravel;
      if (wheel.suspensionLength < minSuspensionLength) wheel.suspensionLength = minSuspensionLength;
      if (wheel.suspensionLength > maxSuspensionLength) {
        wheel.suspensionLength = maxSuspensionLength;
        raycastResult.reset();
        wheel.isInContact = false;
        wheel.suspensionRelativeVelocity = 0;
        wheel.directionWorld.scale(-1, raycastResult.hitNormalWorld);
        wheel.clippedInvContactDotSuspension = 1;
        return -1;
      }

      const denominator = raycastResult.hitNormalWorld.dot(wheel.directionWorld);
      chassisBody.getVelocityAtWorldPoint(raycastResult.hitPointWorld, wheelRayContactVelocity);
      const projVel = raycastResult.hitNormalWorld.dot(wheelRayContactVelocity);

      if (denominator >= -0.1) {
        wheel.suspensionRelativeVelocity = 0;
        wheel.clippedInvContactDotSuspension = 10;
      } else {
        const inv = -1 / denominator;
        wheel.suspensionRelativeVelocity = projVel * inv;
        wheel.clippedInvContactDotSuspension = inv;
      }
      return hitDistance;
    }

    wheel.suspensionLength = wheel.suspensionRestLength;
    wheel.suspensionRelativeVelocity = 0;
    wheel.directionWorld.scale(-1, raycastResult.hitNormalWorld);
    wheel.clippedInvContactDotSuspension = 1;
    return -1;
  };
}

function createCar({ id, name, color, isPlayer = false }) {
  const body = new CANNON.Body({
    mass: 180,
    material: chassisMaterial,
    position: new CANNON.Vec3(0, spawnHeight, 0),
    angularDamping: 0.52,
    linearDamping: 0.04,
  });
  body.collisionFilterGroup = collisionGroups.car;
  body.collisionFilterMask = collisionGroups.arena | collisionGroups.car;
  body.allowSleep = false;
  function addChassisBox(halfExtents, offset, material = chassisMaterial, orientation = null) {
    const shape = new CANNON.Box(halfExtents);
    shape.material = material;
    body.addShape(shape, offset, orientation);
  }
  function addChassisShape(shape, offset, material = chassisMaterial) {
    shape.material = material;
    body.addShape(shape, offset);
  }

  const tubCollider = makeStuntCarTubShape();
  addChassisShape(tubCollider.shape, tubCollider.offset);
  const noseCollider = makeStuntCarNoseShape();
  addChassisShape(noseCollider.shape, noseCollider.offset);
  const canopyCollider = makeStuntCarCanopyShape();
  addChassisShape(canopyCollider.shape, canopyCollider.offset, roofMaterial);
  const leftSkidQuat = new CANNON.Quaternion();
  leftSkidQuat.setFromAxisAngle(new CANNON.Vec3(0, 0, 1), sideSkidAngle);
  const rightSkidQuat = new CANNON.Quaternion();
  rightSkidQuat.setFromAxisAngle(new CANNON.Vec3(0, 0, 1), -sideSkidAngle);
  addChassisBox(new CANNON.Vec3(0.1, 0.08, 1.58), new CANNON.Vec3(-1.22, -0.38 + chassisBodyLift, -0.02), chassisMaterial, leftSkidQuat);
  addChassisBox(new CANNON.Vec3(0.1, 0.08, 1.58), new CANNON.Vec3(1.22, -0.38 + chassisBodyLift, -0.02), chassisMaterial, rightSkidQuat);
  addChassisBox(new CANNON.Vec3(1.05, 0.05, 0.08), new CANNON.Vec3(0, -0.28 + chassisBodyLift, 1.44));
  addChassisBox(new CANNON.Vec3(1.02, 0.05, 0.08), new CANNON.Vec3(0, -0.24 + chassisBodyLift, -1.5));
  const vehicle = new CANNON.RaycastVehicle({
    chassisBody: body,
    indexRightAxis: 0,
    indexUpAxis: 1,
    indexForwardAxis: 2,
  });
  installVehicleWheelRayFilter(vehicle);
  for (let i = 0; i < wheelPositions.length; i += 1) {
    const point = wheelPositions[i];
    const wheelSetup = i < 2 ? wheelOptions : rearWheelOptions;
    vehicle.addWheel({
      ...wheelSetup,
      chassisConnectionPointLocal: point,
    });
  }

  const visual = makeCarBodyVisual(color.hex);
  const boostFlame = makeBoostFlame();
  const tagMarker = makeTagMarker();
  visual.add(boostFlame);
  scene.add(visual);
  scene.add(tagMarker);

  const wheelVisuals = makeWheelVisuals();

  const car = {
    id,
    name,
    color,
    isPlayer,
    body,
    vehicle,
    visual,
    bodyVisuals: visual.userData.bodyVisuals,
    boostFlame,
    tagMarker,
    wheelVisuals,
    input: makeInputState(),
    activeInWorld: true,
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
      lateralSign: Math.random() < 0.5 ? -1 : 1,
      lateralTimer: 1 + Math.random() * 2,
      targetBiasTimer: 0,
      targetId: null,
      objective: new THREE.Vector3(),
      desired: new THREE.Vector3(),
      tacticalPoint: new THREE.Vector3(),
      lastPosition: new THREE.Vector3(),
      decisionTimer: Math.random() * 0.16,
      decisionInterval: 0.16 + Math.random() * 0.08,
      objectiveTimer: 0,
      jumpCooldown: 0,
    },
  };
  body.userData = { car };
  body.addEventListener("collide", (event) => {
    if (!event.body?.userData?.car) {
      car.surfaceContactGrace = vehicleTuning.contactAssistSurfaceGrace;
    }
    onCarBodyCollide(car, event.body);
  });
  vehicle.addToWorld(physics);
  return car;
}

function hideWheelVisuals(wheelVisuals) {
  if (!wheelVisuals) return;
  const baseIndex = wheelVisuals.slot * wheelsPerCar;
  for (let i = 0; i < wheelsPerCar; i += 1) {
    wheelVisuals.tires.setMatrixAt(baseIndex + i, hiddenWheelMatrix);
    wheelVisuals.rims.setMatrixAt(baseIndex + i, hiddenWheelMatrix);
    wheelVisuals.hubs.setMatrixAt(baseIndex + i, hiddenWheelMatrix);
  }
  wheelVisuals.tires.instanceMatrix.needsUpdate = true;
  wheelVisuals.rims.instanceMatrix.needsUpdate = true;
  wheelVisuals.hubs.instanceMatrix.needsUpdate = true;
  activeWheelVisualSlots.delete(wheelVisuals.slot);
  updateWheelVisualCount();
}

function deactivateCar(car) {
  clearVehicleInputs(car);
  if (car.activeInWorld) {
    car.vehicle.removeFromWorld(physics);
    if (physics.bodies.includes(car.body)) physics.removeBody(car.body);
    car.activeInWorld = false;
  }
  car.visual.visible = false;
  car.boostFlame.visible = false;
  car.tagMarker.visible = false;
  hideCarBodyVisuals(car.bodyVisuals);
  car.input = makeInputState();
  car.boostTimeRemaining = 0;
  car.boostCooldownRemaining = 0;
  car.manualRightingActive = false;
  car.manualRightingElapsed = 0;
  car.isIt = false;
  car.immunityRemaining = 0;
  hideWheelVisuals(car.wheelVisuals);
}

function activateCar(car) {
  if (!car.activeInWorld) {
    car.vehicle.addToWorld(physics);
    car.activeInWorld = true;
  }
  car.visual.visible = true;
  showCarBodyVisuals(car.bodyVisuals);
  showWheelVisuals(car.wheelVisuals);
}

function destroyCar(car) {
  deactivateCar(car);
  scene.remove(car.visual);
  scene.remove(car.tagMarker);
  disposeOwnedObjectTree(car.visual);
  releaseCarBodyVisuals(car.bodyVisuals);
  releaseWheelVisuals(car.wheelVisuals);
}

function setCarColor(car, color) {
  car.color = color;
  car.visual.userData.bodyMaterial.color.setHex(color.hex);
}

function syncChassisHistory(car) {
  car.body.previousPosition.copy(car.body.position);
  car.body.interpolatedPosition.copy(car.body.position);
  car.body.previousQuaternion.copy(car.body.quaternion);
  car.body.interpolatedQuaternion.copy(car.body.quaternion);
}

function transferItTo(car) {
  if (
    gameState.phase !== "playing" ||
    gameState.tagCooldown > 0 ||
    !car ||
    car.isIt ||
    car.immunityRemaining > 0
  ) {
    return false;
  }
  const tagger = gameState.itCar;
  const tagSite = new THREE.Vector3(car.body.position.x, car.body.position.y, car.body.position.z);
  if (tagger) {
    tagSite
      .add(new THREE.Vector3(tagger.body.position.x, tagger.body.position.y, tagger.body.position.z))
      .multiplyScalar(0.5);
    tagger.isIt = false;
    tagger.immunityRemaining = vehicleTuning.tagImmunityDuration;
  }
  gameState.itCar = car;
  car.isIt = true;
  car.ai.targetId = null;
  car.immunityRemaining = 0;
  gameState.tagCooldown = 0.28;
  gameState.leaderboardDirty = true;
  spawnTagBurst(tagSite);
  return true;
}

function resolveCarTagPair(car, otherCar) {
  if (!otherCar || otherCar === car || gameState.phase !== "playing" || gameState.tagCooldown > 0) return false;
  if (car.isIt && !otherCar.isIt) return transferItTo(otherCar);
  if (otherCar.isIt && !car.isIt) return transferItTo(car);
  return false;
}

function onCarBodyCollide(car, otherBody) {
  resolveCarTagPair(car, otherBody?.userData?.car);
}

function clearCarSurfaceContacts() {
  for (const car of gameState.cars) {
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

function finalizeCarSurfaceContacts() {
  for (const car of gameState.cars) {
    if (car.surfaceContactCount > 0 && car.surfaceContactNormal.lengthSq() > 0.0001) {
      car.surfaceContactNormal.normalize();
    } else {
      car.surfaceContactNormal.copy(upAxis);
    }
  }
}

function processPhysicsContacts() {
  clearCarSurfaceContacts();
  if (gameState.phase !== "playing") return;

  for (const contact of physics.contacts) {
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
    if (!carA || !carB || carA === carB) continue;

    resolveCarTagPair(carA, carB);
  }
  finalizeCarSurfaceContacts();
}

function clearVehicleInputs(car) {
  car.currentSteering = 0;
  for (let i = 0; i < car.vehicle.wheelInfos.length; i += 1) {
    car.vehicle.setBrake(0, i);
    car.vehicle.applyEngineForce(0, i);
    car.vehicle.setSteeringValue(0, i);
  }
}

function spawnCarAt(car, spawn) {
  car.body.position.set(spawn.x, spawnHeight, spawn.z);
  car.body.velocity.set(0, 0, 0);
  car.body.angularVelocity.set(0, 0, 0);
  car.body.force.set(0, 0, 0);
  car.body.torque.set(0, 0, 0);
  car.body.quaternion.setFromEuler(0, spawn.yaw, 0);
  car.input = makeInputState();
  car.boostTimeRemaining = 0;
  car.boostCooldownRemaining = 0;
  car.surfaceContactGrace = 0;
  car.surfaceContactNormal.set(0, 1, 0);
  car.surfaceContactCount = 0;
  car.manualRightingActive = false;
  car.manualRightingElapsed = 0;
  car.ai.stuckTimer = 0;
  car.ai.unstickTimer = 0;
  car.ai.targetId = null;
  car.ai.decisionTimer = Math.random() * car.ai.decisionInterval;
  car.ai.objectiveTimer = 0;
  car.ai.desired.set(0, 0, 0);
  car.ai.tacticalPoint.set(spawn.x, 0, spawn.z);
  car.ai.lastPosition.set(spawn.x, 0, spawn.z);
  car.score = 0;
  car.isIt = false;
  car.immunityRemaining = 0;
  syncChassisHistory(car);
  clearVehicleInputs(car);
  car.body.wakeUp();
}

function settleSpawnedCars() {
  const settleStep = 1 / 60;
  for (let step = 0; step < 42; step += 1) {
    for (const car of gameState.cars) clearVehicleInputs(car);
    physics.step(settleStep);
  }

  for (const car of gameState.cars) {
    car.body.velocity.set(0, 0, 0);
    car.body.angularVelocity.set(0, 0, 0);
    car.body.force.set(0, 0, 0);
    car.body.torque.set(0, 0, 0);
    car.manualRightingActive = false;
    car.manualRightingElapsed = 0;
    clearVehicleInputs(car);
    syncChassisHistory(car);
    car.body.wakeUp();
  }
}

function shuffle(array) {
  const next = [...array];
  for (let i = next.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [next[i], next[j]] = [next[j], next[i]];
  }
  return next;
}

const playerCar = createCar({ id: "player", name: "you", color: carPalette[0], isPlayer: true });
gameState.cars = [playerCar];
const aiCarPool = [];

function getPooledAiCar(index, color) {
  let car = aiCarPool[index];
  if (!car) {
    car = createCar({ id: `ai-${index + 1}`, name: color.name, color, isPlayer: false });
    deactivateCar(car);
    aiCarPool[index] = car;
  }
  car.name = color.name;
  setCarColor(car, color);
  activateCar(car);
  pickWaypoint(car);
  return car;
}

function deactivateUnusedAiCars(activeCount) {
  for (let i = activeCount; i < aiCarPool.length; i += 1) deactivateCar(aiCarPool[i]);
}

function renderColorPicker() {
  colorPickerEl.innerHTML = "";
  for (const color of carPalette) {
    const button = document.createElement("button");
    button.className = `color-swatch${color === gameState.selectedColor ? " selected" : ""}`;
    button.type = "button";
    button.style.setProperty("--swatch", color.css);
    button.title = color.name;
    button.addEventListener("click", () => {
      gameState.selectedColor = color;
      setCarColor(playerCar, color);
      renderColorPicker();
    });
    colorPickerEl.append(button);
  }
}

function formatTime(seconds) {
  const clamped = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(clamped / 60);
  const secs = clamped % 60;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function updatePlayerInput() {
  if (gameState.phase !== "playing") {
    clearVehicleInputs(playerCar);
    input.jumpQueued = false;
    input.boostQueued = false;
    return;
  }

  const playerInput = clampPlayerInput(keyboardAxes());
  playerCar.input.throttle = playerInput.throttle;
  playerCar.input.steer = playerInput.steer;
  playerCar.input.boost = playerInput.boost;
  playerCar.input.jumpQueued = playerCar.input.jumpQueued || input.jumpQueued;
  playerCar.input.boostQueued = playerCar.input.boostQueued || input.boostQueued;
  input.jumpQueued = false;
  input.boostQueued = false;
}

function driveCar(car) {
  if (gameState.phase !== "playing" || car.manualRightingActive) {
    clearVehicleInputs(car);
    return;
  }

  const speedKmh = car.vehicle.currentVehicleSpeedKmHour;
  const itBoost = car.isIt ? vehicleTuning.itSpeedMultiplier : 1;
  const engine =
    car.input.throttle > 0 && speedKmh < vehicleTuning.maxForwardKmh * itBoost
      ? -vehicleTuning.engineForce * itBoost
      : car.input.throttle < 0 && speedKmh < 5
        ? vehicleTuning.reverseForce
        : 0;
  const brake = car.input.throttle < 0 && speedKmh > 5 ? vehicleTuning.brakeForce : 0;
  const speedSteerT = THREE.MathUtils.clamp((Math.abs(speedKmh) - 24) / 72, 0, 1);
  const steeringScale = THREE.MathUtils.lerp(1, vehicleTuning.highSpeedSteerScale, speedSteerT);
  const targetSteering = car.input.steer * vehicleTuning.steerAngle * steeringScale;
  const steeringStep = vehicleTuning.steerResponse * fixedStep;
  car.currentSteering += THREE.MathUtils.clamp(targetSteering - car.currentSteering, -steeringStep, steeringStep);

  car.vehicle.setSteeringValue(car.currentSteering, 0);
  car.vehicle.setSteeringValue(car.currentSteering, 1);
  car.vehicle.applyEngineForce(engine * 0.28, 0);
  car.vehicle.applyEngineForce(engine * 0.28, 1);
  car.vehicle.applyEngineForce(engine * 0.72, 2);
  car.vehicle.applyEngineForce(engine * 0.72, 3);

  for (let i = 0; i < 4; i += 1) car.vehicle.setBrake(brake, i);
}

function closestStabilityContactForCar(car) {
  if (car.surfaceContactCount > 0) {
    stabilityContactResult.distance = 0;
    stabilityContactResult.normal.copy(car.surfaceContactNormal);
    return stabilityContactResult;
  }

  if (wheelSupportContactForCar(car, stabilityContactResult)) {
    return stabilityContactResult;
  }

  tmpQuat.set(car.body.quaternion.x, car.body.quaternion.y, car.body.quaternion.z, car.body.quaternion.w);
  stabilityContactResult.distance = Infinity;
  stabilityContactResult.normal.copy(upAxis);

  for (const sample of stabilitySamplePoints) {
    stabilitySampleWorld
      .copy(sample)
      .applyQuaternion(tmpQuat)
      .add(car.body.position);
    const contact = arenaContactForPoint(stabilitySampleWorld);
    if (contact.distance < stabilityContactResult.distance) {
      stabilityContactResult.distance = contact.distance;
      stabilityContactResult.normal.copy(contact.normal);
    }
  }

  return stabilityContactResult;
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

const aiUpdateContext = {
  gameState,
  arenaContactForPoint,
  shouldRightWithJump,
};

function applyAirControls(car) {
  if (gameState.phase !== "playing") return;
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
  if (pitchInput === 0 && yawInput === 0) return;

  airControlTorque.set(
    pitchInput * vehicleTuning.airPitchTorque,
    yawInput * vehicleTuning.airYawTorque,
    0,
  );
  car.body.vectorToWorldFrame(airControlTorque, worldAirControlTorque);
  car.body.torque.vadd(worldAirControlTorque, car.body.torque);
  car.body.wakeUp();
}

function applyBoost(car, dt) {
  car.boostCooldownRemaining = Math.max(0, car.boostCooldownRemaining - dt);

  if (gameState.phase !== "playing" || car.manualRightingActive) {
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
  if (gameState.phase !== "playing") {
    car.input.jumpQueued = false;
    return;
  }

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
    const theta = THREE.MathUtils.clamp(Math.atan2(localX, -localY), 0, Math.PI);
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

function updateRound(dt) {
  if (gameState.phase !== "playing") return;

  gameState.timeRemaining = Math.max(0, gameState.timeRemaining - dt);
  for (const car of gameState.cars) {
    car.immunityRemaining = Math.max(0, car.immunityRemaining - dt);
    if (!car.isIt) car.score += dt;
  }
  gameState.tagCooldown = Math.max(0, gameState.tagCooldown - dt);

  if (gameState.timeRemaining <= 0) endRound();
}

function setCountdownText(text) {
  if (gameState.countdownText === text) return;
  gameState.countdownText = text;
  countdownValueEl.textContent = text;
  countdownValueEl.style.animation = "none";
  countdownValueEl.offsetHeight;
  countdownValueEl.style.animation = "";
}

function updateCountdown(dt) {
  if (gameState.phase !== "countdown") return;

  gameState.countdownRemaining = Math.max(0, gameState.countdownRemaining - dt);
  setCountdownText(String(Math.max(1, Math.ceil(gameState.countdownRemaining))));
  if (gameState.countdownRemaining > 0) return;

  gameState.phase = "playing";
  setUiPhase("playing");
  countdownEl.classList.add("hidden");
  gameState.countdownText = "";
}

function updateLeaderboard() {
  const timerText = formatTime(gameState.timeRemaining);
  if (hudCache.timerText !== timerText) {
    hudCache.timerText = timerText;
    roundTimerEl.textContent = timerText;
  }
  const itText = gameState.itCar ? `${gameState.itCar.color.name} is it` : "TAG";
  const itBackground = gameState.itCar ? gameState.itCar.color.css : "rgba(255, 75, 31, 0.86)";
  if (hudCache.itText !== itText) {
    hudCache.itText = itText;
    itBannerEl.textContent = itText;
  }
  if (hudCache.itBackground !== itBackground) {
    hudCache.itBackground = itBackground;
    itBannerEl.style.setProperty("--it-color", itBackground);
  }

  const now = performance.now();
  if (!gameState.leaderboardDirty && now - gameState.lastLeaderboardRender < 250) return;
  gameState.lastLeaderboardRender = now;
  gameState.leaderboardDirty = false;
  const sorted = [...gameState.cars].sort((a, b) => b.score - a.score);
  leaderboardEl.innerHTML = "";
  for (const car of sorted) {
    const row = document.createElement("div");
    row.className = `leader-row${car.isIt ? " it" : ""}${car.immunityRemaining > 0 ? " immune" : ""}`;
    row.style.setProperty("--car-color", car.color.css);
    row.innerHTML = `<span class="leader-color"></span><strong>${Math.floor(car.score)}</strong>`;
    leaderboardEl.append(row);
  }
}

function startRound() {
  clearTagBursts();
  gameState.roundLength = Number(roundTimeSelect.value);
  gameState.timeRemaining = gameState.roundLength;
  gameState.playerCount = Number(playerCountSelect.value);
  loadArena(arenaSelect.value);
  activateCar(playerCar);
  setCarColor(playerCar, gameState.selectedColor);

  const availableColors = shuffle(carPalette.filter((color) => color !== gameState.selectedColor));
  gameState.cars = [playerCar];
  gameState.aiCars = [];
  for (let i = 1; i < gameState.playerCount; i += 1) {
    const color = availableColors[(i - 1) % availableColors.length];
    const aiCar = getPooledAiCar(i - 1, color);
    gameState.aiCars.push(aiCar);
    gameState.cars.push(aiCar);
  }
  deactivateUnusedAiCars(Math.max(0, gameState.playerCount - 1));

  const spawns = shuffle(getArenaSpawnPoints());
  gameState.cars.forEach((car, index) => spawnCarAt(car, spawns[index % spawns.length]));
  settleSpawnedCars();

  gameState.itCar = gameState.cars.length > 1
    ? gameState.cars[Math.floor(Math.random() * gameState.cars.length)]
    : null;
  if (gameState.itCar) gameState.itCar.isIt = true;
  gameState.tagCooldown = 0;
  gameState.countdownRemaining = gameState.countdownDuration;
  gameState.countdownText = "";
  setCountdownText("3");
  countdownEl.classList.remove("hidden");
  gameState.phase = "countdown";
  setUiPhase("countdown");
  gameState.leaderboardDirty = true;
  accumulator = 0;
  lastTime = performance.now();
  syncVisuals(0, 1);
  renderer.render(scene, camera);
  startScreenEl.classList.add("hidden");
  endScreenEl.classList.add("hidden");
}

function endRound() {
  gameState.phase = "ended";
  setUiPhase("ended");
  countdownEl.classList.add("hidden");
  for (const car of gameState.cars) clearVehicleInputs(car);
  const sorted = [...gameState.cars].sort((a, b) => b.score - a.score);
  resultsListEl.innerHTML = "";
  sorted.forEach((car, index) => {
    const item = document.createElement("li");
    item.className = `result-row${index === 0 ? " winner" : ""}${car.isPlayer ? " player" : ""}`;
    item.style.setProperty("--car-color", car.color.css);
    const score = Math.floor(car.score);
    item.innerHTML = `
      <span class="result-rank">${index + 1}</span>
      <span class="result-chip"></span>
      <span class="result-name">
        <strong>${car.color.name}</strong>
        ${car.isPlayer ? '<em>You</em>' : ""}
      </span>
      <span class="result-score">
        <strong>${score}</strong>
        <small>sec</small>
      </span>
    `;
    resultsListEl.append(item);
  });
  endScreenEl.classList.remove("hidden");
}

function returnToMenu() {
  gameState.phase = "menu";
  setUiPhase("menu");
  clearTagBursts();
  for (const car of gameState.aiCars) deactivateCar(car);
  gameState.aiCars = [];
  gameState.cars = [playerCar];
  gameState.itCar = null;
  gameState.countdownRemaining = 0;
  gameState.countdownText = "";
  countdownEl.classList.add("hidden");
  spawnCarAt(playerCar, getArenaSpawnPoints()[0]);
  startScreenEl.classList.remove("hidden");
  endScreenEl.classList.add("hidden");
  gameState.timeRemaining = Number(roundTimeSelect.value);
  gameState.leaderboardDirty = true;
}

const cameraState = {
  position: new THREE.Vector3(0, 8, -18),
  target: new THREE.Vector3(),
  followForward: new THREE.Vector3(0, 0, 1),
  followUp: new THREE.Vector3(0, 1, 0),
  followRight: new THREE.Vector3(1, 0, 0),
  desiredPosition: new THREE.Vector3(),
  desiredTarget: new THREE.Vector3(),
  obstructionOrigin: new THREE.Vector3(),
  towardDesired: new THREE.Vector3(),
  resolvedPosition: new THREE.Vector3(),
};

function clampCameraLineOfSight(origin, position, clearance = 1.35) {
  const toCamera = cameraToCandidate.copy(position).sub(origin);
  const distance = toCamera.length();
  if (distance <= 0.001) return position;

  const hit = raycastArenaSurface(origin, position);
  if (hit.hasHit) {
    position
      .copy(origin)
      .addScaledVector(toCamera.multiplyScalar(1 / distance), Math.max(3.5, hit.distance - clearance));
  }
  return position;
}

function keepCameraInsideArena(point, clearance = 1.15) {
  const contact = arenaContactForPoint(point);
  if (contact.distance < clearance) point.addScaledVector(contact.normal, clearance - contact.distance);
  return point;
}

function syncCarVisual(car, interpolationAlpha, visualTime) {
  car.visual.position.set(
    THREE.MathUtils.lerp(car.body.previousPosition.x, car.body.position.x, interpolationAlpha),
    THREE.MathUtils.lerp(car.body.previousPosition.y, car.body.position.y, interpolationAlpha),
    THREE.MathUtils.lerp(car.body.previousPosition.z, car.body.position.z, interpolationAlpha),
  );
  tmpQuat
    .set(car.body.previousQuaternion.x, car.body.previousQuaternion.y, car.body.previousQuaternion.z, car.body.previousQuaternion.w)
    .slerp(tmpQuatB.set(car.body.quaternion.x, car.body.quaternion.y, car.body.quaternion.z, car.body.quaternion.w), interpolationAlpha);
  car.visual.quaternion.copy(tmpQuat);
  carBodyVisualMatrix.compose(car.visual.position, car.visual.quaternion, car.visual.scale);
  setCarBodyVisualMatrix(car.bodyVisuals, car.visual.visible ? carBodyVisualMatrix : hiddenWheelMatrix);

  savedChassisPosition.copy(car.body.position);
  savedChassisQuaternion.copy(car.body.quaternion);
  car.body.position.set(car.visual.position.x, car.visual.position.y, car.visual.position.z);
  car.body.quaternion.set(tmpQuat.x, tmpQuat.y, tmpQuat.z, tmpQuat.w);

  const wheelBaseIndex = car.wheelVisuals.slot * wheelsPerCar;
  for (let i = 0; i < car.vehicle.wheelInfos.length; i += 1) {
    car.vehicle.updateWheelTransform(i);
    const wheel = car.vehicle.wheelInfos[i];
    const transform = wheel.worldTransform;
    wheelVisualPosition.set(transform.position.x, transform.position.y, transform.position.z);

    const hit = wheel.raycastResult;
    if (hit?.hasHit && !hit.body?.userData?.car) {
      tmpVec3A.set(hit.hitNormalWorld.x, hit.hitNormalWorld.y, hit.hitNormalWorld.z);
      tmpVec3B.set(hit.hitPointWorld.x, hit.hitPointWorld.y, hit.hitPointWorld.z);
      const surfaceNormalDistance = tmpVec3C.copy(wheelVisualPosition).sub(tmpVec3B).dot(tmpVec3A);
      if (surfaceNormalDistance < minWheelVisualSurfaceClearance) {
        wheelVisualPosition.addScaledVector(
          tmpVec3A,
          minWheelVisualSurfaceClearance - surfaceNormalDistance,
        );
      }
    }

    wheelVisualQuaternion.set(transform.quaternion.x, transform.quaternion.y, transform.quaternion.z, transform.quaternion.w);
    wheelMatrix.compose(wheelVisualPosition, wheelVisualQuaternion, wheelVisualScale);
    car.wheelVisuals.tires.setMatrixAt(wheelBaseIndex + i, wheelMatrix);
    car.wheelVisuals.rims.setMatrixAt(wheelBaseIndex + i, wheelMatrix);
    car.wheelVisuals.hubs.setMatrixAt(wheelBaseIndex + i, wheelMatrix);
  }

  car.body.position.copy(savedChassisPosition);
  car.body.quaternion.copy(savedChassisQuaternion);

  car.boostFlame.visible = car.boostTimeRemaining > 0;
  if (car.boostFlame.visible) {
    const flicker = 0.9 + Math.sin(visualTime * 0.05 + car.id.length) * 0.11 + Math.sin(visualTime * 0.083 + car.id.length * 3.1) * 0.04;
    car.boostFlame.scale.set(1, 1, flicker);
    car.boostFlame.rotation.z = Math.sin(visualTime * 0.037 + car.id.length) * 0.08;
    car.boostFlame.userData.light.intensity = 2.05 + Math.sin(visualTime * 0.071 + car.id.length) * 0.5;
  }

  car.tagMarker.visible = car.isIt && gameState.phase === "playing";
  if (car.tagMarker.visible) {
    const pulse = 1 + Math.sin(visualTime * 0.009) * 0.07;
    const quickPulse = 1 + Math.sin(visualTime * 0.024) * 0.05;
    car.tagMarker.position.copy(car.visual.position).addScaledVector(upAxis, 1.15);
    car.tagMarker.quaternion.identity();
    car.tagMarker.scale.setScalar(pulse);
    car.tagMarker.userData.lowerRing.rotation.z += 0.036;
    car.tagMarker.userData.upperRing.rotation.z -= 0.052;
    car.tagMarker.userData.upperRing.scale.setScalar(quickPulse);
    car.tagMarker.userData.core.rotation.y += 0.06;
  }
}

function syncCountdownCamera() {
  const rawForward = cameraRawForward.set(0, 0, 1).applyQuaternion(playerCar.visual.quaternion).normalize();
  const rawUp = cameraRawUp.set(0, 1, 0).applyQuaternion(playerCar.visual.quaternion).normalize();
  const rawRight = cameraRawRight.set(1, 0, 0).applyQuaternion(playerCar.visual.quaternion).normalize();
  const progress = THREE.MathUtils.clamp(
    1 - gameState.countdownRemaining / Math.max(0.001, gameState.countdownDuration),
    0,
    1,
  );
  const descentT = progress * progress * (3 - 2 * progress);
  const flipT = THREE.MathUtils.clamp((progress - 0.18) / 0.82, 0, 1);
  const flipEase = flipT * flipT * (3 - 2 * flipT);
  const carPosition = playerCar.visual.position;

  countdownCameraStart
    .set(0, worldSpec.ceilingY - 8.5, worldSpec.floorRadius * 0.08);
  countdownCameraEnd
    .copy(carPosition)
    .addScaledVector(rawForward, -13.2)
    .addScaledVector(upAxis, 6.4);
  countdownCameraTargetStart
    .set(0, 0.8, 0);
  countdownCameraTargetEnd
    .copy(carPosition)
    .addScaledVector(rawForward, 4.2)
    .addScaledVector(rawUp, 1.15);

  cameraState.position.copy(countdownCameraStart).lerp(countdownCameraEnd, descentT);
  cameraState.target.copy(countdownCameraTargetStart).lerp(countdownCameraTargetEnd, flipEase);
  keepCameraInsideArena(cameraState.position, 0.45);
  camera.position.copy(cameraState.position);
  camera.lookAt(cameraState.target);
  cameraState.followForward.copy(rawForward);
  cameraState.followUp.copy(rawUp);
  cameraState.followRight.copy(rawRight);
}

function updateHud() {
  const speedMph = Math.abs(playerCar.vehicle.currentVehicleSpeedKmHour) * 0.621371;
  const speedText = String(Math.round(speedMph)).padStart(3, "0");
  if (hudCache.speedText !== speedText) {
    hudCache.speedText = speedText;
    speedEl.textContent = speedText;
  }

  const boostActive = playerCar.boostTimeRemaining > 0;
  const boostReady = playerCar.boostCooldownRemaining <= 0 && !boostActive;
  const boostReadyPercent = Math.round(
    boostReady
      ? 100
      : (1 - THREE.MathUtils.clamp(playerCar.boostCooldownRemaining / vehicleTuning.boostCooldown, 0, 1)) * 100,
  );
  if (hudCache.boostReadyPercent !== boostReadyPercent) {
    hudCache.boostReadyPercent = boostReadyPercent;
    boostHudEl.style.setProperty("--boost-ready", `${boostReadyPercent}%`);
  }
  if (hudCache.boostReady !== boostReady) {
    hudCache.boostReady = boostReady;
    boostHudEl.classList.toggle("ready", boostReady);
  }
  if (hudCache.boostActive !== boostActive) {
    hudCache.boostActive = boostActive;
    boostHudEl.classList.toggle("active", boostActive);
  }
  const boostValueText = boostReady || boostActive ? "" : String(Math.ceil(playerCar.boostCooldownRemaining));
  if (hudCache.boostValueText !== boostValueText) {
    hudCache.boostValueText = boostValueText;
    boostValueEl.textContent = boostValueText;
  }
  updateLeaderboard();
}

function syncVisuals(dt, interpolationAlpha) {
  const visualTime = performance.now();
  updateTagBursts(dt);
  for (const car of gameState.cars) syncCarVisual(car, interpolationAlpha, visualTime);
  if (globalWheelVisuals) {
    globalWheelVisuals.tires.instanceMatrix.needsUpdate = true;
    globalWheelVisuals.rims.instanceMatrix.needsUpdate = true;
    globalWheelVisuals.hubs.instanceMatrix.needsUpdate = true;
  }
  markGlobalCarBodyVisualsDirty();

  if (gameState.phase === "countdown") {
    syncCountdownCamera();
    updateHud();
    return;
  }

  const rawForward = cameraRawForward.set(0, 0, 1).applyQuaternion(playerCar.visual.quaternion);
  rawForward.y = 0;
  if (rawForward.lengthSq() < 0.001) rawForward.copy(cameraState.followForward);
  rawForward.normalize();

  const velocityForward = tmpVec3A.set(playerCar.body.velocity.x, 0, playerCar.body.velocity.z);
  const speed = velocityForward.length();
  if (speed > 5) rawForward.lerp(velocityForward.multiplyScalar(1 / speed), 0.42).normalize();

  cameraState.followForward.lerp(rawForward, 1 - Math.exp(-dt * 4.2)).normalize();
  const carForward = cameraState.followForward;
  const carRight = cameraRawRight.crossVectors(upAxis, carForward).normalize();
  const chaseDistance = THREE.MathUtils.lerp(13.5, 18.5, THREE.MathUtils.clamp(speed / 36, 0, 1));
  const cameraHeight = THREE.MathUtils.lerp(6.0, 8.2, THREE.MathUtils.clamp(speed / 34, 0, 1));

  const desiredTarget = cameraState.desiredTarget
    .copy(playerCar.visual.position)
    .addScaledVector(upAxis, 1.45)
    .addScaledVector(carForward, 3.2);
  const desiredPosition = cameraState.desiredPosition
    .copy(playerCar.visual.position)
    .addScaledVector(carForward, -chaseDistance)
    .addScaledVector(upAxis, cameraHeight)
    .addScaledVector(carRight, -playerCar.input.steer * 0.45);

  keepCameraInsideArena(desiredPosition, 1.25);

  const cameraObstructionOrigin = cameraState.obstructionOrigin.copy(playerCar.visual.position).addScaledVector(upAxis, 1.45);
  const toDesired = cameraToCandidate.copy(desiredPosition).sub(cameraObstructionOrigin);
  const desiredDistance = toDesired.length();
  let cameraObstructed = false;
  if (desiredDistance > 0.001) {
    const hit = raycastArenaSurface(cameraObstructionOrigin, desiredPosition);
    if (hit.hasHit) {
      cameraObstructed = true;
      desiredPosition
        .copy(cameraObstructionOrigin)
        .addScaledVector(toDesired.multiplyScalar(1 / desiredDistance), Math.max(3.5, hit.distance - 1.35));
      keepCameraInsideArena(desiredPosition, 1.25);
    }
  }

  cameraState.position.lerp(desiredPosition, 1 - Math.exp(-dt * 5.0));
  cameraState.target.lerp(desiredTarget, 1 - Math.exp(-dt * 6.6));
  clampCameraLineOfSight(cameraObstructionOrigin, cameraState.position, 1.35);
  keepCameraInsideArena(cameraState.position, 1.25);
  const minCameraDistance = cameraObstructed ? 6.8 : 9.5;
  if (cameraState.position.distanceTo(cameraState.target) < minCameraDistance) {
    cameraSafeOffset.copy(cameraState.position).sub(cameraState.target);
    if (cameraSafeOffset.lengthSq() < 0.001) cameraSafeOffset.copy(carForward).multiplyScalar(-1).addScaledVector(upAxis, 0.35);
    cameraState.position.copy(cameraState.target).addScaledVector(cameraSafeOffset.normalize(), minCameraDistance);
    clampCameraLineOfSight(cameraObstructionOrigin, cameraState.position, 1.35);
    keepCameraInsideArena(cameraState.position, 1.25);
  }
  camera.position.copy(cameraState.position);
  camera.lookAt(cameraState.target);

  updateHud();
}

function runUnprofiledPlayingStep({ scriptedPlayer = false, stepIndex = 0 } = {}) {
  if (gameState.phase === "countdown") {
    for (const car of gameState.cars) clearVehicleInputs(car);
    updateCountdown(fixedStep);
  } else if (gameState.phase === "playing") {
    if (scriptedPlayer) {
      playerCar.input.throttle = 1;
      playerCar.input.steer = Math.sin(stepIndex * 0.055);
      playerCar.input.boost = false;
      if (stepIndex % 180 === 20) playerCar.input.boostQueued = true;
      if (stepIndex % 300 === 80) playerCar.input.jumpQueued = true;
    } else {
      updatePlayerInput();
    }

    for (const car of gameState.aiCars) updateAiCar(car, fixedStep, aiUpdateContext);
    for (const car of gameState.cars) {
      driveCar(car);
      applyAirControls(car);
      applyBoost(car, fixedStep);
    }
    physics.step(fixedStep);
    processPhysicsContacts();
    for (const car of gameState.cars) applyQueuedJump(car);
    for (const car of gameState.cars) updateManualRighting(car, fixedStep);
    updateRound(fixedStep);
  } else {
    clearVehicleInputs(playerCar);
    input.jumpQueued = false;
    input.boostQueued = false;
  }
}

function clearTagBursts() {
  for (const burst of tagBursts) {
    const data = burst.userData;
    scene.remove(burst);
    data.groundRing.material.dispose();
    data.upperRing.material.dispose();
  }
  tagBursts.length = 0;
}

function runProfiledPlayingStep({ scriptedPlayer = false, stepIndex = 0 } = {}) {
  if (!detailedProfile.enabled) {
    runUnprofiledPlayingStep({ scriptedPlayer, stepIndex });
    return;
  }

  const stepStart = performance.now();

  if (gameState.phase === "countdown") {
    const previousPhase = setProfilePhase("countdown");
    const bucketStart = performance.now();
    for (const car of gameState.cars) clearVehicleInputs(car);
    updateCountdown(fixedStep);
    recordProfileBucket("countdown", performance.now() - bucketStart);
    profilePhase = previousPhase;
  } else if (gameState.phase === "playing") {
    let previousPhase = setProfilePhase("input");
    let bucketStart = performance.now();
    if (scriptedPlayer) {
      playerCar.input.throttle = 1;
      playerCar.input.steer = Math.sin(stepIndex * 0.055);
      playerCar.input.boost = false;
      if (stepIndex % 180 === 20) playerCar.input.boostQueued = true;
      if (stepIndex % 300 === 80) playerCar.input.jumpQueued = true;
    } else {
      updatePlayerInput();
    }
    recordProfileBucket("input", performance.now() - bucketStart);
    profilePhase = previousPhase;

    for (const car of gameState.aiCars) {
      previousPhase = setProfilePhase("ai");
      bucketStart = performance.now();
      updateAiCar(car, fixedStep, aiUpdateContext);
      recordProfileBucket("ai", performance.now() - bucketStart);
      profilePhase = previousPhase;
    }
    for (const car of gameState.cars) {
      previousPhase = setProfilePhase("drive");
      bucketStart = performance.now();
      driveCar(car);
      recordProfileBucket("drive", performance.now() - bucketStart);
      profilePhase = previousPhase;

      previousPhase = setProfilePhase("airControl");
      bucketStart = performance.now();
      applyAirControls(car);
      recordProfileBucket("airControl", performance.now() - bucketStart);
      profilePhase = previousPhase;

      previousPhase = setProfilePhase("boost");
      bucketStart = performance.now();
      applyBoost(car, fixedStep);
      recordProfileBucket("boost", performance.now() - bucketStart);
      profilePhase = previousPhase;
    }

    previousPhase = setProfilePhase("physicsStep");
    bucketStart = performance.now();
    physics.step(fixedStep);
    const physicsStepMs = performance.now() - bucketStart;
    recordProfileBucket("physicsStep", physicsStepMs);
    recordProfileSample("physicsStepMs", physicsStepMs);
    profilePhase = previousPhase;

    previousPhase = setProfilePhase("contacts");
    bucketStart = performance.now();
    processPhysicsContacts();
    recordProfileBucket("contacts", performance.now() - bucketStart);
    profilePhase = previousPhase;

    for (const car of gameState.cars) {
      previousPhase = setProfilePhase("jump");
      bucketStart = performance.now();
      applyQueuedJump(car);
      recordProfileBucket("jump", performance.now() - bucketStart);
      profilePhase = previousPhase;
    }
    for (const car of gameState.cars) {
      previousPhase = setProfilePhase("righting");
      bucketStart = performance.now();
      updateManualRighting(car, fixedStep);
      recordProfileBucket("righting", performance.now() - bucketStart);
      profilePhase = previousPhase;
    }

    previousPhase = setProfilePhase("round");
    bucketStart = performance.now();
    updateRound(fixedStep);
    recordProfileBucket("round", performance.now() - bucketStart);
    profilePhase = previousPhase;
  } else {
    const previousPhase = setProfilePhase("idle");
    const bucketStart = performance.now();
    clearVehicleInputs(playerCar);
    input.jumpQueued = false;
    input.boostQueued = false;
    recordProfileBucket("idle", performance.now() - bucketStart);
    profilePhase = previousPhase;
  }

  detailedProfile.steps += 1;
  recordProfileSample("stepMs", performance.now() - stepStart);
}

window.__arenaCarDebug = {
  getPerf() {
    return {
      fps: perfStats.fps,
      avgFrameMs: perfStats.avgFrameMs,
      avgSimMs: perfStats.avgSimMs,
      avgRenderMs: perfStats.avgRenderMs,
      avgSteps: perfStats.avgSteps,
      maxFrameMs: perfStats.maxFrameMs,
      maxSimMs: perfStats.maxSimMs,
      maxRenderMs: perfStats.maxRenderMs,
      pixelRatio: renderer.getPixelRatio(),
      calls: renderer.info.render.calls,
      triangles: renderer.info.render.triangles,
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
      bodies: physics.bodies.length,
      contacts: physics.contacts.length,
    };
  },
  getDetailedPerf() {
    return summarizeDetailedProfile();
  },
  resetDetailedPerf() {
    resetDetailedProfile(true);
  },
  forcePlaying() {
    gameState.phase = "playing";
    gameState.countdownRemaining = 0;
    gameState.countdownText = "";
    setUiPhase("playing");
    countdownEl.classList.add("hidden");
  },
  runHeadlessBenchmark({ steps = 3600, scriptedPlayer = true } = {}) {
    resetDetailedProfile(true);
    const startedAt = performance.now();
    for (let i = 0; i < steps; i += 1) {
      runProfiledPlayingStep({ scriptedPlayer, stepIndex: i });
    }
    const wallMs = performance.now() - startedAt;
    return {
      wallMs,
      simulatedSeconds: steps * fixedStep,
      realtimeMultiplier: (steps * fixedStep * 1000) / Math.max(0.001, wallMs),
      profile: summarizeDetailedProfile(),
    };
  },
  runBareHeadlessBenchmark({ steps = 3600, scriptedPlayer = true } = {}) {
    resetDetailedProfile(false);
    const startedAt = performance.now();
    for (let i = 0; i < steps; i += 1) {
      runUnprofiledPlayingStep({ scriptedPlayer, stepIndex: i });
    }
    const wallMs = performance.now() - startedAt;
    return {
      wallMs,
      simulatedSeconds: steps * fixedStep,
      realtimeMultiplier: (steps * fixedStep * 1000) / Math.max(0.001, wallMs),
    };
  },
  getState() {
    return {
      phase: gameState.phase,
      roundTime: gameState.timeRemaining,
      it: gameState.itCar?.id ?? null,
      scores: gameState.cars.map((car) => ({
        id: car.id,
        color: car.color.name,
        score: car.score,
        it: car.isIt,
        immunity: car.immunityRemaining,
      })),
      cars: gameState.cars.map((car) => ({
        id: car.id,
        position: [car.body.position.x, car.body.position.y, car.body.position.z],
        velocity: [car.body.velocity.x, car.body.velocity.y, car.body.velocity.z],
        wheelsOnGround: car.vehicle.numWheelsOnGround,
        surfaceContactGrace: car.surfaceContactGrace,
        manualRighting: car.manualRightingActive,
        input: { throttle: car.input.throttle, steer: car.input.steer, boostQueued: car.input.boostQueued },
        ai: car.isPlayer ? null : {
          stuckTimer: car.ai.stuckTimer,
          unstickTimer: car.ai.unstickTimer,
          reverseTimer: car.ai.reverseTimer,
          targetId: car.ai.targetId,
        },
        quaternion: [car.body.quaternion.x, car.body.quaternion.y, car.body.quaternion.z, car.body.quaternion.w],
      })),
      position: [playerCar.body.position.x, playerCar.body.position.y, playerCar.body.position.z],
      velocity: [playerCar.body.velocity.x, playerCar.body.velocity.y, playerCar.body.velocity.z],
      angularVelocity: [playerCar.body.angularVelocity.x, playerCar.body.angularVelocity.y, playerCar.body.angularVelocity.z],
      quaternion: [playerCar.body.quaternion.x, playerCar.body.quaternion.y, playerCar.body.quaternion.z, playerCar.body.quaternion.w],
      speed: Math.abs(playerCar.vehicle.currentVehicleSpeedKmHour) * 0.621371,
      boostCooldown: playerCar.boostCooldownRemaining,
      boostActive: playerCar.boostTimeRemaining,
      touchInput: { throttle: touchInput.throttle, steer: touchInput.steer, jumpQueued: input.jumpQueued },
      wheelsOnGround: playerCar.vehicle.numWheelsOnGround,
      surface: playerCar.vehicle.numWheelsOnGround > 0 ? "GRIP" : "AIR",
      camera: {
        position: [camera.position.x, camera.position.y, camera.position.z],
        target: [cameraState.target.x, cameraState.target.y, cameraState.target.z],
      },
    };
  },
  setState({ position, velocity = [0, 0, 0], quaternion = [0, 0, 0, 1] }) {
    playerCar.body.wakeUp();
    playerCar.body.position.set(position[0], position[1], position[2]);
    playerCar.body.velocity.set(velocity[0], velocity[1], velocity[2]);
    playerCar.body.angularVelocity.set(0, 0, 0);
    playerCar.body.force.set(0, 0, 0);
    playerCar.body.torque.set(0, 0, 0);
    playerCar.body.quaternion.set(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
    playerCar.manualRightingActive = false;
    playerCar.manualRightingElapsed = 0;
    syncChassisHistory(playerCar);
  },
  setCarState(id, { position, velocity = [0, 0, 0], quaternion = [0, 0, 0, 1] }) {
    const car = gameState.cars.find((entry) => entry.id === id);
    if (!car) return false;
    car.body.wakeUp();
    car.body.position.set(position[0], position[1], position[2]);
    car.body.velocity.set(velocity[0], velocity[1], velocity[2]);
    car.body.angularVelocity.set(0, 0, 0);
    car.body.force.set(0, 0, 0);
    car.body.torque.set(0, 0, 0);
    car.body.quaternion.set(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
    car.manualRightingActive = false;
    car.manualRightingElapsed = 0;
    syncChassisHistory(car);
    return true;
  },
  forceIt(id) {
    const car = gameState.cars.find((entry) => entry.id === id);
    if (!car) return false;
    if (gameState.itCar) gameState.itCar.isIt = false;
    gameState.itCar = car;
    car.isIt = true;
    gameState.tagCooldown = 0;
    gameState.leaderboardDirty = true;
    return true;
  },
  endRound() {
    endRound();
  },
  startRound(options = {}) {
    if (options.roundTime) roundTimeSelect.value = String(options.roundTime);
    if (options.playerCount) playerCountSelect.value = String(options.playerCount);
    startRound();
  },
  queueBoost() {
    playerCar.input.boostQueued = true;
  },
};

let lastTime = performance.now();
let accumulator = 0;
const fixedStep = 1 / 60;
const maxPhysicsStepsPerFrame = 3;

function animate(time) {
  const frameStart = performance.now();
  requestAnimationFrame(animate);
  const dt = Math.min(0.05, (time - lastTime) / 1000);
  lastTime = time;
  accumulator = Math.min(accumulator + dt, fixedStep * maxPhysicsStepsPerFrame);
  detailedProfile.frames += 1;

  const simStart = performance.now();
  let stepsThisFrame = 0;
  while (accumulator >= fixedStep && stepsThisFrame < maxPhysicsStepsPerFrame) {
    stepsThisFrame += 1;
    runProfiledPlayingStep();
    accumulator -= fixedStep;
  }
  if (accumulator >= fixedStep) detailedProfile.cappedFrames += 1;
  const simMs = performance.now() - simStart;
  recordProfileSample("simMs", simMs);

  let previousPhase = setProfilePhase("syncVisuals");
  let bucketStart = performance.now();
  syncVisuals(dt, accumulator / fixedStep);
  recordProfileBucket("syncVisuals", performance.now() - bucketStart);
  profilePhase = previousPhase;

  const renderStart = performance.now();
  previousPhase = setProfilePhase("render");
  renderer.render(scene, camera);
  const renderMs = performance.now() - renderStart;
  recordProfileBucket("render", renderMs);
  recordProfileSample("renderMs", renderMs);
  profilePhase = previousPhase;
  recordProfileSample("frameMs", performance.now() - frameStart);
  recordPerfSample(performance.now() - frameStart, simMs, renderMs, stepsThisFrame);
}

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxPixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight);
});

roundTimeSelect.addEventListener("change", () => {
  if (gameState.phase === "menu") gameState.timeRemaining = Number(roundTimeSelect.value);
});
startRoundButton.addEventListener("click", startRound);
playAgainButton.addEventListener("click", returnToMenu);
menuReturnButton.addEventListener("click", returnToMenu);

renderColorPicker();
setUiPhase("menu");
spawnCarAt(playerCar, getArenaSpawnPoints()[0]);
gameState.timeRemaining = Number(roundTimeSelect.value);
requestAnimationFrame(animate);
