import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import * as CANNON from "cannon-es";
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
scene.background = new THREE.Color(0x080909);
scene.fog = new THREE.Fog(0x080909, 180, 400);

const camera = new THREE.PerspectiveCamera(
  64,
  window.innerWidth / window.innerHeight,
  0.1,
  700,
);

const worldSpec = {
  floorRadius: 68,
  curveRadius: 30,
};
worldSpec.outerRadius = worldSpec.floorRadius + worldSpec.curveRadius;
worldSpec.ceilingY = worldSpec.curveRadius * 2;

const tmpVec3A = new THREE.Vector3();
const tmpVec3B = new THREE.Vector3();
const tmpVec3C = new THREE.Vector3();
const tmpVec3D = new THREE.Vector3();
const tmpVec3E = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpQuatB = new THREE.Quaternion();
const wheelMatrix = new THREE.Matrix4();
const wheelVisualPosition = new THREE.Vector3();
const wheelVisualQuaternion = new THREE.Quaternion();
const wheelVisualScale = new THREE.Vector3(1, 1, 1);
const upAxis = new THREE.Vector3(0, 1, 0);
const airControlTorque = new CANNON.Vec3();
const worldAirControlTorque = new CANNON.Vec3();
const boostForce = new CANNON.Vec3();
const boostPoint = new CANNON.Vec3();
const savedChassisPosition = new CANNON.Vec3();
const savedChassisQuaternion = new CANNON.Quaternion();
const aiObstacles = [];
const cameraObstacles = [];
const cameraCollisionMeshes = [];
const cameraRaycaster = new THREE.Raycaster();
const cameraRayHits = [];
const cameraCandidates = Array.from({ length: 7 }, () => new THREE.Vector3());
const cameraLocalPoint = new THREE.Vector3();
const cameraToCandidate = new THREE.Vector3();
const arenaContactResult = {
  point: new THREE.Vector3(),
  normal: new THREE.Vector3(),
  distance: 0,
};
const arenaWallPoint = new THREE.Vector3();

const physics = new CANNON.World({
  gravity: new CANNON.Vec3(0, -24, 0),
});
physics.broadphase = new CANNON.SAPBroadphase(physics);
physics.allowSleep = true;
physics.solver.iterations = 8;
physics.solver.tolerance = 0.005;
physics.defaultContactMaterial.friction = 0.55;
physics.defaultContactMaterial.restitution = 0.02;

const groundMaterial = new CANNON.Material("ground");
const obstacleMaterial = new CANNON.Material("obstacle");
const chassisMaterial = new CANNON.Material("chassis");
const roofMaterial = new CANNON.Material("slick-roof");
const wheelMaterial = new CANNON.Material("wheel");
physics.addContactMaterial(
  new CANNON.ContactMaterial(wheelMaterial, groundMaterial, {
    friction: 0.85,
    restitution: 0,
    contactEquationStiffness: 1e7,
    contactEquationRelaxation: 3,
  }),
);
physics.addContactMaterial(
  new CANNON.ContactMaterial(wheelMaterial, obstacleMaterial, {
    friction: 0.85,
    restitution: 0,
    contactEquationStiffness: 1e7,
    contactEquationRelaxation: 3,
  }),
);
physics.addContactMaterial(
  new CANNON.ContactMaterial(chassisMaterial, groundMaterial, {
    friction: 0.06,
    restitution: 0.015,
    contactEquationStiffness: 1e7,
    contactEquationRelaxation: 5,
  }),
);
physics.addContactMaterial(
  new CANNON.ContactMaterial(chassisMaterial, obstacleMaterial, {
    friction: 0.015,
    restitution: 0.01,
    contactEquationStiffness: 1e7,
    contactEquationRelaxation: 7,
  }),
);
physics.addContactMaterial(
  new CANNON.ContactMaterial(roofMaterial, groundMaterial, {
    friction: 0.05,
    restitution: 0.015,
    contactEquationStiffness: 1e7,
    contactEquationRelaxation: 6,
  }),
);
physics.addContactMaterial(
  new CANNON.ContactMaterial(roofMaterial, obstacleMaterial, {
    friction: 0.028,
    restitution: 0.01,
    contactEquationStiffness: 1e7,
    contactEquationRelaxation: 7,
  }),
);

const input = {
  throttle: 0,
  steer: 0,
  boost: false,
  boostQueued: false,
  jumpQueued: false,
};
const keys = new Set();
const touchInput = {
  throttle: 0,
  steer: 0,
  joystickPointerId: null,
};

window.addEventListener("keydown", (event) => {
  if (
    [
      "KeyW",
      "KeyA",
      "KeyS",
      "KeyD",
      "ArrowUp",
      "ArrowLeft",
      "ArrowDown",
      "ArrowRight",
      "KeyQ",
      "Space",
    ].includes(event.code)
  ) {
    event.preventDefault();
  }

  if (!keys.has(event.code) && event.code === "Space") input.jumpQueued = true;
  if (!keys.has(event.code) && event.code === "KeyQ") input.boostQueued = true;
  keys.add(event.code);
});

window.addEventListener("keyup", (event) => {
  keys.delete(event.code);
});

function updateInput() {
  const forward = keys.has("KeyW") || keys.has("ArrowUp");
  const reverse = keys.has("KeyS") || keys.has("ArrowDown");
  const left = keys.has("KeyA") || keys.has("ArrowLeft");
  const right = keys.has("KeyD") || keys.has("ArrowRight");

  const keyThrottle = (forward ? 1 : 0) + (reverse ? -1 : 0);
  const keySteer = (left ? 1 : 0) + (right ? -1 : 0);

  input.throttle = THREE.MathUtils.clamp(keyThrottle + touchInput.throttle, -1, 1);
  input.steer = THREE.MathUtils.clamp(keySteer + touchInput.steer, -1, 1);
  input.boost = keys.has("KeyQ");
}

function setJoystickInput(pointerX, pointerY) {
  const rect = joystickEl.getBoundingClientRect();
  const radius = rect.width * 0.5;
  const dx = pointerX - (rect.left + radius);
  const dy = pointerY - (rect.top + radius);
  const distance = Math.min(radius, Math.hypot(dx, dy));
  const angle = Math.atan2(dy, dx);
  const knobX = Math.cos(angle) * distance;
  const knobY = Math.sin(angle) * distance;
  const normalizedX = radius > 0 ? knobX / radius : 0;
  const normalizedY = radius > 0 ? knobY / radius : 0;
  const deadzone = 0.12;

  touchInput.steer = Math.abs(normalizedX) > deadzone ? -normalizedX : 0;
  touchInput.throttle = Math.abs(normalizedY) > deadzone ? -normalizedY : 0;
  joystickKnobEl.style.transform = `translate(calc(-50% + ${knobX}px), calc(-50% + ${knobY}px))`;
}

function resetJoystickInput() {
  touchInput.throttle = 0;
  touchInput.steer = 0;
  touchInput.joystickPointerId = null;
  joystickKnobEl.style.transform = "translate(-50%, -50%)";
}

joystickEl.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  touchInput.joystickPointerId = event.pointerId;
  joystickEl.setPointerCapture(event.pointerId);
  setJoystickInput(event.clientX, event.clientY);
});

joystickEl.addEventListener("pointermove", (event) => {
  if (touchInput.joystickPointerId !== event.pointerId) return;
  event.preventDefault();
  setJoystickInput(event.clientX, event.clientY);
});

for (const eventName of ["pointerup", "pointercancel", "lostpointercapture"]) {
  joystickEl.addEventListener(eventName, (event) => {
    if (touchInput.joystickPointerId !== event.pointerId && eventName !== "lostpointercapture") return;
    resetJoystickInput();
  });
}

boostHudEl.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  input.boostQueued = true;
});

jumpButtonEl.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  input.jumpQueued = true;
});

function makeArenaWallGeometry() {
  const segments = 80;
  const rings = 18;
  const vertices = [];
  const normals = [];
  const uvs = [];
  const indices = [];

  for (let j = 0; j <= rings; j += 1) {
    const theta = (j / rings) * Math.PI;
    const ringRadius = worldSpec.floorRadius + worldSpec.curveRadius * Math.sin(theta);
    const y = worldSpec.curveRadius * (1 - Math.cos(theta));
    const normalRadial = -Math.sin(theta);
    const normalY = Math.cos(theta);

    for (let i = 0; i <= segments; i += 1) {
      const phi = (i / segments) * Math.PI * 2;
      const c = Math.cos(phi);
      const s = Math.sin(phi);
      vertices.push(c * ringRadius, y, s * ringRadius);
      normals.push(c * normalRadial, normalY, s * normalRadial);
      uvs.push(i / segments, j / rings);
    }
  }

  for (let j = 0; j < rings; j += 1) {
    for (let i = 0; i < segments; i += 1) {
      const a = j * (segments + 1) + i;
      const b = a + 1;
      const c = a + segments + 1;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
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
  -0.76, -0.34, 0.82,
  0.76, -0.34, 0.82,
  0.34, -0.35, 2.16,
  -0.34, -0.35, 2.16,
  -0.62, 0.2, 0.84,
  0.62, 0.2, 0.84,
  0.22, -0.03, 2.08,
  -0.22, -0.03, 2.08,
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
  1.02, -0.4, 0.92,
  -1.02, -0.4, 0.92,
  -0.82, 0.2, -1.5,
  0.82, 0.2, -1.5,
  0.68, 0.32, 0.88,
  -0.68, 0.32, 0.88,
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
  -0.56, 0.16, -1.18,
  0.56, 0.16, -1.18,
  0.48, 0.16, 0.48,
  -0.48, 0.16, 0.48,
  -0.34, 0.64, -1.0,
  0.34, 0.64, -1.0,
  0.22, 0.36, 0.48,
  -0.22, 0.36, 0.48,
];
const stuntCarCanopyFaces = [
  [0, 1, 2, 3],
  [4, 7, 6, 5],
  [0, 4, 5, 1],
  [1, 5, 6, 2],
  [2, 6, 7, 3],
  [3, 7, 4, 0],
];

const chassisBodyLift = 0;

function liftCarVertices(verticesSource, yOffset = chassisBodyLift) {
  const vertices = [...verticesSource];
  for (let i = 1; i < vertices.length; i += 3) vertices[i] += yOffset;
  return vertices;
}

function makeConvexGeometry(vertices, faces) {
  const indices = [];
  for (const face of faces) {
    indices.push(face[0], face[1], face[2], face[0], face[2], face[3]);
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
        color: 0x080808,
        roughness: 0.52,
        metalness: 0.18,
      }),
      trimMaterial: new THREE.MeshStandardMaterial({
        color: 0x1a1b19,
        roughness: 0.4,
        metalness: 0.34,
      }),
      exhaustMaterial: new THREE.MeshStandardMaterial({
        color: 0xdce7ec,
        roughness: 0.16,
        metalness: 0.95,
        emissive: 0x1b2022,
        emissiveIntensity: 0.04,
      }),
      glassMaterial: new THREE.MeshStandardMaterial({
        color: 0x080b0b,
        roughness: 0.72,
        metalness: 0.04,
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

function addStaticShape(shape, position, quaternion = null, material = groundMaterial) {
  const body = new CANNON.Body({
    mass: 0,
    material,
  });
  shape.material = material;
  body.addShape(shape);
  body.position.set(position.x, position.y, position.z);
  if (quaternion) body.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
  physics.addBody(body);
  return body;
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

function makeMoundShape(width, length, height, topScale = 0.36) {
  const halfWidth = width / 2;
  const halfLength = length / 2;
  const topHalfWidth = halfWidth * topScale;
  const topHalfLength = halfLength * topScale;
  const vertices = [
    new CANNON.Vec3(-halfWidth, 0, -halfLength),
    new CANNON.Vec3(halfWidth, 0, -halfLength),
    new CANNON.Vec3(-halfWidth, 0, halfLength),
    new CANNON.Vec3(halfWidth, 0, halfLength),
    new CANNON.Vec3(-topHalfWidth, height, -topHalfLength),
    new CANNON.Vec3(topHalfWidth, height, -topHalfLength),
    new CANNON.Vec3(-topHalfWidth, height, topHalfLength),
    new CANNON.Vec3(topHalfWidth, height, topHalfLength),
  ];

  return new CANNON.ConvexPolyhedron({
    vertices,
    faces: [
      [4, 6, 7, 5],
      [0, 4, 5, 1],
      [1, 5, 7, 3],
      [3, 7, 6, 2],
      [2, 6, 4, 0],
      [0, 1, 3, 2],
    ],
  });
}

function makeArenaWallPanelSpecs(segments = 32, rings = 8, thickness = 4.25) {
  const panelSpecs = [];
  for (let j = 0; j < rings; j += 1) {
    const theta = ((j + 0.5) / rings) * Math.PI;
    const ringRadius = worldSpec.floorRadius + worldSpec.curveRadius * Math.sin(theta);
    const y = worldSpec.curveRadius * (1 - Math.cos(theta));
    const bandLength = (Math.PI * worldSpec.curveRadius) / rings * 1.88;
    const tangentLength = ((Math.PI * 2 * ringRadius) / segments) * 1.96;
    const ring = {
      tangentLength,
      bandLength,
      thickness,
      panels: [],
    };

    for (let i = 0; i < segments; i += 1) {
      const phi = ((i + 0.5) / segments) * Math.PI * 2;
      const c = Math.cos(phi);
      const s = Math.sin(phi);
      const normal = new THREE.Vector3(-Math.sin(theta) * c, Math.cos(theta), -Math.sin(theta) * s).normalize();
      const tangentAxis = new THREE.Vector3(-s, 0, c).normalize();
      const arcAxis = new THREE.Vector3(Math.cos(theta) * c, Math.sin(theta), Math.cos(theta) * s).normalize();
      const surfacePoint = new THREE.Vector3(c * ringRadius, y, s * ringRadius);
      const center = surfacePoint.clone().addScaledVector(normal, -thickness / 2);
      const basis = new THREE.Matrix4().makeBasis(tangentAxis, arcAxis, normal);
      const quat = new THREE.Quaternion().setFromRotationMatrix(basis);
      ring.panels.push({ center, quat });
    }
    panelSpecs.push(ring);
  }
  return panelSpecs;
}

function addArenaPhysics() {
  const arenaBody = createStaticCompoundBody();

  const floorQuat = new CANNON.Quaternion();
  floorQuat.setFromEuler(-Math.PI / 2, 0, 0);
  addShapeToCompound(
    arenaBody,
    new CANNON.Plane(),
    new CANNON.Vec3(0, 0, 0),
    floorQuat,
    groundMaterial,
  );

  const ceilingQuat = new CANNON.Quaternion();
  ceilingQuat.setFromEuler(Math.PI / 2, 0, 0);
  addShapeToCompound(
    arenaBody,
    new CANNON.Plane(),
    new CANNON.Vec3(0, worldSpec.ceilingY, 0),
    ceilingQuat,
    obstacleMaterial,
  );

  const wallPanelSpecs = makeArenaWallPanelSpecs();
  const panelMatrix = new THREE.Matrix4();
  const panelScale = new THREE.Vector3(1, 1, 1);

  for (const ring of wallPanelSpecs) {
    const panelGeometry = new THREE.BoxGeometry(ring.tangentLength, ring.bandLength, ring.thickness);
    const panelMesh = new THREE.InstancedMesh(panelGeometry, wallMaterial, ring.panels.length);
    panelMesh.receiveShadow = true;
    panelMesh.castShadow = false;

    for (let i = 0; i < ring.panels.length; i += 1) {
      const { center, quat } = ring.panels[i];
      panelMatrix.compose(center, quat, panelScale);
      panelMesh.setMatrixAt(i, panelMatrix);

      addShapeToCompound(
        arenaBody,
        new CANNON.Box(new CANNON.Vec3(ring.tangentLength / 2, ring.bandLength / 2, ring.thickness / 2)),
        new CANNON.Vec3(center.x, center.y, center.z),
        new CANNON.Quaternion(quat.x, quat.y, quat.z, quat.w),
        obstacleMaterial,
      );
    }

    panelMesh.instanceMatrix.needsUpdate = true;
    scene.add(panelMesh);
  }
}

function createCanvasTexture(size = 512) {
  const textureCanvas = document.createElement("canvas");
  textureCanvas.width = size;
  textureCanvas.height = size;
  const ctx = textureCanvas.getContext("2d");
  return { textureCanvas, ctx };
}

function finishCanvasTexture(textureCanvas, repeatX, repeatY) {
  const texture = new THREE.CanvasTexture(textureCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = coarsePointer ? 2 : 4;
  texture.repeat.set(repeatX, repeatY);
  return texture;
}

function makeFloorTexture(size = 512) {
  const { textureCanvas, ctx } = createCanvasTexture(size);

  ctx.fillStyle = "#171918";
  ctx.fillRect(0, 0, size, size);

  ctx.globalAlpha = 0.14;
  for (let i = 0; i < 2600; i += 1) {
    const v = 20 + Math.floor(Math.random() * 42);
    const w = Math.random() < 0.82 ? 1 : 2;
    ctx.fillStyle = `rgb(${v},${v + 1},${v})`;
    ctx.fillRect(Math.random() * size, Math.random() * size, w, 1);
  }

  ctx.globalAlpha = 0.24;
  ctx.strokeStyle = "#ff6326";
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(0, size * 0.5 + 0.5);
  ctx.lineTo(size, size * 0.5 + 0.5);
  ctx.stroke();

  ctx.globalAlpha = 0.08;
  ctx.strokeStyle = "#b7aa91";
  ctx.lineWidth = 1;
  for (let x = 0; x <= size; x += 72) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, size);
    ctx.stroke();
  }
  for (let y = 0; y <= size; y += 72) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(size, y + 0.5);
    ctx.stroke();
  }

  ctx.globalAlpha = 0.22;
  ctx.strokeStyle = "#050606";
  ctx.lineWidth = 10;
  ctx.strokeRect(7, 7, size - 14, size - 14);

  return finishCanvasTexture(textureCanvas, 16, 16);
}

function makeWallTexture(size = 512) {
  const { textureCanvas, ctx } = createCanvasTexture(size);

  ctx.fillStyle = "#1a1d1b";
  ctx.fillRect(0, 0, size, size);

  const grd = ctx.createLinearGradient(0, 0, 0, size);
  grd.addColorStop(0, "rgba(255,255,255,0.08)");
  grd.addColorStop(0.48, "rgba(255,255,255,0.01)");
  grd.addColorStop(1, "rgba(0,0,0,0.22)");
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, size, size);

  ctx.globalAlpha = 0.62;
  ctx.fillStyle = "#262b29";
  for (let y = 68; y < size - 64; y += 92) {
    ctx.fillRect(0, y, size, 30);
  }

  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = "#080909";
  ctx.lineWidth = 24;
  ctx.strokeRect(12, 12, size - 24, size - 24);

  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = "#465049";
  ctx.lineWidth = 8;
  ctx.strokeRect(36, 36, size - 72, size - 72);

  ctx.globalAlpha = 0.36;
  ctx.strokeStyle = "#8a927e";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(54, size - 58);
  ctx.lineTo(size - 58, 54);
  ctx.moveTo(54, 54);
  ctx.lineTo(size - 58, size - 58);
  ctx.stroke();

  ctx.globalAlpha = 0.95;
  ctx.fillStyle = "#ff6c2f";
  ctx.fillRect(42, 92, size - 84, 10);

  ctx.globalAlpha = 0.58;
  ctx.fillStyle = "#d8caa4";
  ctx.fillRect(42, 286, size - 84, 5);

  ctx.globalAlpha = 0.22;
  ctx.fillStyle = "#050606";
  ctx.fillRect(0, 0, size, 18);
  ctx.fillRect(0, size - 20, size, 20);

  return finishCanvasTexture(textureCanvas, 1, 1);
}

const floorTexture = makeFloorTexture(512);
const wallTexture = makeWallTexture(512);

const arenaMaterial = new THREE.MeshStandardMaterial({
  color: 0xbcb09a,
  map: floorTexture,
  roughness: 0.94,
  metalness: 0.02,
  side: THREE.DoubleSide,
});
const wallMaterial = new THREE.MeshStandardMaterial({
  color: 0xd2c6aa,
  map: wallTexture,
  roughness: 0.8,
  metalness: 0.05,
  emissive: 0x0a0705,
  emissiveIntensity: 0.035,
  side: THREE.DoubleSide,
});
const rampTopMaterial = new THREE.MeshStandardMaterial({
  color: 0x24211e,
  roughness: 0.88,
  metalness: 0.04,
  flatShading: true,
});
const rampSideMaterial = new THREE.MeshStandardMaterial({
  color: 0x120f0e,
  roughness: 0.78,
  metalness: 0.04,
  flatShading: true,
  side: THREE.DoubleSide,
});
const rampEdgeMaterial = new THREE.LineBasicMaterial({
  color: 0xff4b1f,
  transparent: true,
  opacity: 0.86,
});

const floor = new THREE.Mesh(
  new THREE.CircleGeometry(worldSpec.floorRadius, 160).rotateX(-Math.PI / 2),
  arenaMaterial,
);
floor.receiveShadow = true;
scene.add(floor);

const ceiling = new THREE.Mesh(
  new THREE.CircleGeometry(worldSpec.floorRadius, 160).rotateX(Math.PI / 2),
  wallMaterial,
);
ceiling.position.y = worldSpec.ceilingY;
ceiling.receiveShadow = true;
scene.add(ceiling);

addArenaPhysics();

function addRingMarkings() {
  const group = new THREE.Group();
  const ringMaterial = new THREE.LineBasicMaterial({
    color: 0xf2e8d0,
    transparent: true,
    opacity: 0.24,
  });
  const spokeMaterial = new THREE.LineBasicMaterial({
    color: 0xf07b2d,
    transparent: true,
    opacity: 0.22,
  });

  for (const radius of [16, 32, 48, worldSpec.floorRadius]) {
    const points = [];
    for (let i = 0; i <= 192; i += 1) {
      const a = (i / 192) * Math.PI * 2;
      points.push(new THREE.Vector3(Math.cos(a) * radius, 0.035, Math.sin(a) * radius));
    }
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), ringMaterial));
  }

  for (let i = 0; i < 16; i += 1) {
    const a = (i / 16) * Math.PI * 2;
    const points = [
      new THREE.Vector3(Math.cos(a) * 10, 0.04, Math.sin(a) * 10),
      new THREE.Vector3(Math.cos(a) * worldSpec.floorRadius, 0.04, Math.sin(a) * worldSpec.floorRadius),
    ];
    group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), spokeMaterial));
  }

  scene.add(group);
}
addRingMarkings();

function addLaunchMound({ position, yaw, width, length, height, topScale = 0.36 }) {
  const geometry = makeMoundGeometry(width, length, height, topScale);
  const mesh = new THREE.Mesh(geometry, [rampTopMaterial, rampSideMaterial]);
  mesh.position.copy(position);
  mesh.rotation.y = yaw;
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  scene.add(mesh);
  cameraCollisionMeshes.push(mesh);
  cameraObstacles.push({ position: position.clone(), yaw, width, length, height, topScale });

  const edgeLines = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), rampEdgeMaterial);
  edgeLines.position.copy(position);
  edgeLines.rotation.y = yaw;
  scene.add(edgeLines);

  const quat = new THREE.Quaternion().setFromAxisAngle(upAxis, yaw);
  addStaticShape(
    makeMoundShape(width, length, height, topScale),
    new CANNON.Vec3(position.x, position.y, position.z),
    new CANNON.Quaternion(quat.x, quat.y, quat.z, quat.w),
    obstacleMaterial,
  );
  aiObstacles.push({
    position: position.clone(),
    radius: Math.max(width, length) * 0.52,
    avoidRadius: Math.max(width, length) * 0.72,
  });
}

function addArenaLayout() {
  const moundY = 0;
  addLaunchMound({ position: new THREE.Vector3(0, moundY, 0), yaw: Math.PI / 4, width: 23, length: 23, height: 2.6, topScale: 0.42 });

  addLaunchMound({ position: new THREE.Vector3(0, moundY, -31), yaw: 0, width: 18, length: 26, height: 4.2, topScale: 0.24 });
  addLaunchMound({ position: new THREE.Vector3(0, moundY, 31), yaw: Math.PI, width: 18, length: 26, height: 4.2, topScale: 0.24 });
  addLaunchMound({ position: new THREE.Vector3(31, moundY, 0), yaw: -Math.PI / 2, width: 18, length: 26, height: 4.2, topScale: 0.24 });
  addLaunchMound({ position: new THREE.Vector3(-31, moundY, 0), yaw: Math.PI / 2, width: 18, length: 26, height: 4.2, topScale: 0.24 });

  addLaunchMound({ position: new THREE.Vector3(38, moundY, 38), yaw: -Math.PI * 0.75, width: 16, length: 24, height: 3.4, topScale: 0.26 });
  addLaunchMound({ position: new THREE.Vector3(-38, moundY, 38), yaw: Math.PI * 0.75, width: 16, length: 24, height: 3.4, topScale: 0.26 });
  addLaunchMound({ position: new THREE.Vector3(38, moundY, -38), yaw: -Math.PI * 0.25, width: 16, length: 24, height: 3.4, topScale: 0.26 });
  addLaunchMound({ position: new THREE.Vector3(-38, moundY, -38), yaw: Math.PI * 0.25, width: 16, length: 24, height: 3.4, topScale: 0.26 });
}
addArenaLayout();

function addLights() {
  scene.add(new THREE.HemisphereLight(0xffd9aa, 0x262421, 2.55));
  scene.add(new THREE.AmbientLight(0x7a7065, 0.34));

  const key = new THREE.DirectionalLight(0xffd5a1, 3.15);
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

  const fill = new THREE.PointLight(0xff7b32, 38, 170, 1.55);
  fill.position.set(0, 20, 0);
  scene.add(fill);

  const wallWash = new THREE.PointLight(0xffb36e, 48, 210, 1.25);
  wallWash.position.set(0, 7, 0);
  scene.add(wallWash);
}
addLights();

function makeCarBodyVisual(color = 0xff512f) {
  const group = new THREE.Group();
  const {
    darkMaterial,
    trimMaterial,
    exhaustMaterial,
    glassMaterial,
  } = getSharedCarMaterials();
  const bodyMaterial = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.4,
    metalness: 0.22,
  });

  function addBoxFeature(width, height, length, x, y, z, material, castShadow = true) {
    const feature = new THREE.Mesh(new THREE.BoxGeometry(width, height, length), material);
    feature.position.set(x, y + chassisBodyLift, z);
    feature.castShadow = castShadow;
    feature.receiveShadow = false;
    group.add(feature);
    return feature;
  }

  const tub = new THREE.Mesh(makeStuntCarTubGeometry(), bodyMaterial);
  tub.castShadow = true;
  tub.receiveShadow = false;
  group.add(tub);

  const nose = new THREE.Mesh(makeStuntCarNoseGeometry(), bodyMaterial);
  nose.castShadow = true;
  group.add(nose);

  const canopy = new THREE.Mesh(makeStuntCarCanopyGeometry(), glassMaterial);
  canopy.castShadow = true;
  canopy.receiveShadow = false;
  group.add(canopy);

  addBoxFeature(0.18, 0.16, 2.44, -1.08, -0.31, -0.14, trimMaterial, false);
  addBoxFeature(0.18, 0.16, 2.44, 1.08, -0.31, -0.14, trimMaterial, false);
  addBoxFeature(2.28, 0.08, 0.1, 0, -0.31, 1.46, trimMaterial, false);
  addBoxFeature(2.28, 0.08, 0.1, 0, -0.31, -1.44, trimMaterial, false);
  for (const z of [1.46, -1.44]) {
    addBoxFeature(0.1, 0.36, 0.12, -0.92, -0.16, z, darkMaterial, false);
    addBoxFeature(0.1, 0.36, 0.12, 0.92, -0.16, z, darkMaterial, false);
  }

  const pipeGeometry = new THREE.CylinderGeometry(0.115, 0.13, 0.34, 12).rotateX(Math.PI / 2);
  for (const x of [-0.24, 0.24]) {
    const pipe = new THREE.Mesh(pipeGeometry, exhaustMaterial);
    pipe.position.set(x, -0.08 + chassisBodyLift, -1.72);
    pipe.castShadow = false;
    group.add(pipe);
  }

  group.userData.bodyMaterial = bodyMaterial;
  compactStaticMeshGroup(group);
  return group;
}

let wheelVisualResources = null;
const maxWheelVisualCars = 6;
const wheelsPerCar = 4;
let globalWheelVisuals = null;
const freeWheelVisualSlots = [];
let nextWheelVisualSlot = 0;
const hiddenWheelMatrix = new THREE.Matrix4().makeScale(0, 0, 0);

function getWheelVisualResources() {
  if (!wheelVisualResources) {
    wheelVisualResources = {
      tireGeometry: new THREE.CylinderGeometry(0.52, 0.52, 0.44, 28).rotateZ(Math.PI / 2),
      rimGeometry: new THREE.CylinderGeometry(0.24, 0.24, 0.47, 18).rotateZ(Math.PI / 2),
      tireMaterial: new THREE.MeshStandardMaterial({
        color: 0x101615,
        roughness: 0.52,
      }),
      rimMaterial: new THREE.MeshStandardMaterial({
        color: 0xe8e1ce,
        roughness: 0.38,
        metalness: 0.35,
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
  tires.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  rims.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  tires.frustumCulled = false;
  rims.frustumCulled = false;
  tires.castShadow = true;
  rims.castShadow = false;

  for (let i = 0; i < wheelCapacity; i += 1) {
    tires.setMatrixAt(i, hiddenWheelMatrix);
    rims.setMatrixAt(i, hiddenWheelMatrix);
  }
  tires.instanceMatrix.needsUpdate = true;
  rims.instanceMatrix.needsUpdate = true;

  group.add(tires, rims);
  scene.add(group);
  globalWheelVisuals = { group, tires, rims };
  return globalWheelVisuals;
}

function makeWheelVisuals() {
  const visuals = getGlobalWheelVisuals();
  const slot = freeWheelVisualSlots.pop() ?? nextWheelVisualSlot;
  if (slot >= maxWheelVisualCars) throw new Error(`No wheel visual slot available for car ${slot + 1}`);
  if (slot === nextWheelVisualSlot) nextWheelVisualSlot += 1;
  return { slot, tires: visuals.tires, rims: visuals.rims };
}

function releaseWheelVisuals(wheelVisuals) {
  if (!wheelVisuals) return;
  const baseIndex = wheelVisuals.slot * wheelsPerCar;
  for (let i = 0; i < wheelsPerCar; i += 1) {
    wheelVisuals.tires.setMatrixAt(baseIndex + i, hiddenWheelMatrix);
    wheelVisuals.rims.setMatrixAt(baseIndex + i, hiddenWheelMatrix);
  }
  wheelVisuals.tires.instanceMatrix.needsUpdate = true;
  wheelVisuals.rims.instanceMatrix.needsUpdate = true;
  freeWheelVisualSlots.push(wheelVisuals.slot);
}

function makeBoostFlame() {
  const group = new THREE.Group();
  const outerMaterial = new THREE.MeshBasicMaterial({
    color: 0xff5a1f,
    transparent: true,
    opacity: 0.78,
    depthWrite: false,
  });
  const innerMaterial = new THREE.MeshBasicMaterial({
    color: 0xfff1a8,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
  });
  const coreMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.68,
    depthWrite: false,
  });

  for (const x of [-0.24, 0.24]) {
    const outer = new THREE.Mesh(new THREE.ConeGeometry(0.3, 1.55, 18).rotateX(-Math.PI / 2), outerMaterial);
    outer.position.set(x, 0.04, -2.5);
    const inner = new THREE.Mesh(new THREE.ConeGeometry(0.19, 1.08, 16).rotateX(-Math.PI / 2), innerMaterial);
    inner.position.set(x, 0.04, -2.34);
    const core = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.62, 12).rotateX(-Math.PI / 2), coreMaterial);
    core.position.set(x, 0.04, -2.16);
    group.add(outer, inner, core);
  }
  const light = new THREE.PointLight(0xff7a2b, 2.2, 6, 2.2);
  light.position.set(0, 0.04, -1.98);

  group.add(light);
  group.visible = false;
  group.userData.light = light;
  return group;
}

function makeTagMarker() {
  const group = new THREE.Group();
  const ringMaterial = new THREE.MeshBasicMaterial({
    color: 0xfff0a8,
    transparent: true,
    opacity: 0.82,
    depthWrite: false,
  });
  const coreMaterial = new THREE.MeshBasicMaterial({
    color: 0xff512f,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
  });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.72, 0.055, 8, 32), ringMaterial);
  ring.rotation.x = Math.PI / 2;
  const core = new THREE.Mesh(new THREE.SphereGeometry(0.18, 14, 8), coreMaterial);
  group.add(ring, core);
  group.position.set(0, 1.42, 0);
  group.visible = false;
  return group;
}

const wheelOptions = {
  radius: 0.52,
  directionLocal: new CANNON.Vec3(0, -1, 0),
  suspensionStiffness: 54,
  suspensionRestLength: 0.38,
  frictionSlip: 4.05,
  dampingRelaxation: 5.8,
  dampingCompression: 10.2,
  maxSuspensionForce: 95000,
  rollInfluence: 0.014,
  axleLocal: new CANNON.Vec3(1, 0, 0),
  maxSuspensionTravel: 0.34,
  customSlidingRotationalSpeed: -32,
  useCustomSlidingRotationalSpeed: true,
};

const rearWheelOptions = {
  ...wheelOptions,
  suspensionStiffness: 64,
  suspensionRestLength: 0.35,
  dampingRelaxation: 6.4,
  dampingCompression: 12.6,
  maxSuspensionTravel: 0.28,
};

const wheelPositions = [
  new CANNON.Vec3(-1.18, -0.28, 1.46),
  new CANNON.Vec3(1.18, -0.28, 1.46),
  new CANNON.Vec3(-1.18, -0.28, -1.44),
  new CANNON.Vec3(1.18, -0.28, -1.44),
];

const vehicleTuning = {
  engineForce: 1600,
  reverseForce: 900,
  brakeForce: 36,
  steerAngle: 0.48,
  highSpeedSteerScale: 0.44,
  steerResponse: 4.2,
  airPitchTorque: 1550,
  airYawTorque: 2100,
  aiAirLevelTorque: 7200,
  aiRecoveryLevelTorque: 14800,
  aiAirAngularDamping: 720,
  contactAssistMultiplier: 10.5,
  contactAssistDelay: 0.3,
  contactAssistReleaseDot: -0.35,
  contactAssistSurfaceGrace: 0.12,
  contactAssistSurfaceDistance: 1.18,
  contactAssistMaxSpeed: 16,
  sideRecoveryDelay: 0.32,
  sideRecoveryMaxSpeed: 24,
  sideRecoveryTorque: 5200,
  sideRecoveryDamping: 320,
  sideRecoveryJumpVelocity: 8.2,
  sideRecoveryJumpSpin: 4.9,
  tagImmunityDuration: 1.6,
  itSpeedMultiplier: 1.1,
  boostForce: 7000,
  boostDuration: 0.6,
  boostCooldown: 15,
  jumpVelocity: 11.5,
  maxForwardKmh: 96,
};

const carPalette = [
  { name: "red", hex: 0xe0182d, css: "#e0182d" },
  { name: "teal", hex: 0x2fd8c4, css: "#2fd8c4" },
  { name: "gold", hex: 0xffc247, css: "#ffc247" },
  { name: "blue", hex: 0x4f8cff, css: "#4f8cff" },
  { name: "violet", hex: 0xb86cff, css: "#b86cff" },
  { name: "lime", hex: 0x9fe44d, css: "#9fe44d" },
];

const spawnPoints = [
  { x: 0, z: -46, yaw: 0 },
  { x: 0, z: 46, yaw: Math.PI },
  { x: 46, z: 0, yaw: -Math.PI / 2 },
  { x: -46, z: 0, yaw: Math.PI / 2 },
  { x: 42, z: -20, yaw: -Math.PI * 0.38 },
  { x: -42, z: 20, yaw: Math.PI * 0.62 },
  { x: 42, z: 20, yaw: -Math.PI * 0.62 },
  { x: -42, z: -20, yaw: Math.PI * 0.38 },
];

const spawnHeight = 1.08;

const startScreenEl = document.querySelector("#start-screen");
const endScreenEl = document.querySelector("#end-screen");
const startRoundButton = document.querySelector("#start-round");
const playAgainButton = document.querySelector("#play-again");
const roundTimeSelect = document.querySelector("#round-time");
const playerCountSelect = document.querySelector("#player-count");
const arenaSelect = document.querySelector("#arena-select");
const colorPickerEl = document.querySelector("#color-picker");
const roundTimerEl = document.querySelector("#round-timer");
const itBannerEl = document.querySelector("#it-banner");
const leaderboardEl = document.querySelector("#leaderboard");
const resultsListEl = document.querySelector("#results-list");

const gameState = {
  phase: "menu",
  selectedColor: carPalette[0],
  roundLength: 120,
  timeRemaining: 120,
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

function createCar({ id, name, color, isPlayer = false }) {
  const body = new CANNON.Body({
    mass: 180,
    material: chassisMaterial,
    position: new CANNON.Vec3(0, spawnHeight, 0),
    angularDamping: 0.72,
    linearDamping: 0.04,
  });
  body.allowSleep = false;
  function addChassisBox(halfExtents, offset, material = chassisMaterial) {
    const shape = new CANNON.Box(halfExtents);
    shape.material = material;
    body.addShape(shape, offset);
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
  addChassisBox(new CANNON.Vec3(0.09, 0.08, 1.22), new CANNON.Vec3(-1.08, -0.31 + chassisBodyLift, -0.14));
  addChassisBox(new CANNON.Vec3(0.09, 0.08, 1.22), new CANNON.Vec3(1.08, -0.31 + chassisBodyLift, -0.14));
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

  const visual = makeCarBodyVisual(color.hex);
  const boostFlame = makeBoostFlame();
  const tagMarker = makeTagMarker();
  visual.add(boostFlame);
  visual.add(tagMarker);
  scene.add(visual);

  const wheelVisuals = makeWheelVisuals();

  const car = {
    id,
    name,
    color,
    isPlayer,
    body,
    vehicle,
    visual,
    boostFlame,
    tagMarker,
    wheelVisuals,
    input: makeInputState(),
    currentSteering: 0,
    boostTimeRemaining: 0,
    boostCooldownRemaining: 0,
    surfaceContactGrace: 0,
    surfaceContactTime: 0,
    airAssistContactTime: 0,
    sideRecoveryTime: 0,
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
      decisionTimer: Math.random() * 0.08,
      decisionInterval: 0.1 + Math.random() * 0.06,
      objectiveTimer: 0,
      jumpCooldown: 0,
      rightingTimer: 0,
      recoveryCandidateTimer: 0,
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

function destroyCar(car) {
  car.vehicle.removeFromWorld(physics);
  physics.removeBody(car.body);
  scene.remove(car.visual);
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
  if (tagger) {
    tagger.isIt = false;
    tagger.immunityRemaining = vehicleTuning.tagImmunityDuration;
  }
  gameState.itCar = car;
  car.isIt = true;
  car.ai.targetId = null;
  car.immunityRemaining = 0;
  gameState.tagCooldown = 0.28;
  gameState.leaderboardDirty = true;
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

function processPhysicsContacts() {
  if (gameState.phase !== "playing") return;

  for (const contact of physics.contacts) {
    if (contact.enabled === false) continue;
    const carA = contact.bi?.userData?.car;
    const carB = contact.bj?.userData?.car;

    if (carA && !carB) {
      carA.surfaceContactGrace = vehicleTuning.contactAssistSurfaceGrace;
      continue;
    }
    if (carB && !carA) {
      carB.surfaceContactGrace = vehicleTuning.contactAssistSurfaceGrace;
      continue;
    }
    if (!carA || !carB || carA === carB) continue;

    resolveCarTagPair(carA, carB);
  }
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
  car.surfaceContactTime = 0;
  car.airAssistContactTime = 0;
  car.sideRecoveryTime = 0;
  car.ai.stuckTimer = 0;
  car.ai.unstickTimer = 0;
  car.ai.rightingTimer = 0;
  car.ai.recoveryCandidateTimer = 0;
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
  const forward = keys.has("KeyW") || keys.has("ArrowUp");
  const reverse = keys.has("KeyS") || keys.has("ArrowDown");
  const left = keys.has("KeyA") || keys.has("ArrowLeft");
  const right = keys.has("KeyD") || keys.has("ArrowRight");

  const keyThrottle = (forward ? 1 : 0) + (reverse ? -1 : 0);
  const keySteer = (left ? 1 : 0) + (right ? -1 : 0);

  playerCar.input.throttle = THREE.MathUtils.clamp(keyThrottle + touchInput.throttle, -1, 1);
  playerCar.input.steer = THREE.MathUtils.clamp(keySteer + touchInput.steer, -1, 1);
  playerCar.input.boost = keys.has("KeyQ");
  playerCar.input.jumpQueued = playerCar.input.jumpQueued || input.jumpQueued;
  playerCar.input.boostQueued = playerCar.input.boostQueued || input.boostQueued;
  input.jumpQueued = false;
  input.boostQueued = false;
}

function driveCar(car) {
  if (gameState.phase !== "playing") {
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
  car.vehicle.applyEngineForce(engine, 2);
  car.vehicle.applyEngineForce(engine, 3);

  for (let i = 0; i < 4; i += 1) car.vehicle.setBrake(brake, i);
}

function applyAiAirStabilizer(car, surfaceNormal, carUp, surfaceUpDot) {
  if (car.vehicle.numWheelsOnGround >= 2 && surfaceUpDot > 0.55) return;

  tmpVec3C.copy(carUp).cross(surfaceNormal);
  if (tmpVec3C.lengthSq() < 0.0001) {
    if (surfaceUpDot > -0.85) return;
    tmpVec3C.set(0, 0, 1).applyQuaternion(tmpQuat).normalize();
  } else {
    tmpVec3C.normalize();
  }

  const correction = THREE.MathUtils.clamp((1 - surfaceUpDot) * 0.5, 0, 1);
  worldAirControlTorque.set(
    tmpVec3C.x * vehicleTuning.aiAirLevelTorque * correction - car.body.angularVelocity.x * vehicleTuning.aiAirAngularDamping,
    tmpVec3C.y * vehicleTuning.aiAirLevelTorque * correction - car.body.angularVelocity.y * vehicleTuning.aiAirAngularDamping,
    tmpVec3C.z * vehicleTuning.aiAirLevelTorque * correction - car.body.angularVelocity.z * vehicleTuning.aiAirAngularDamping,
  );
  car.body.torque.vadd(worldAirControlTorque, car.body.torque);
  car.body.wakeUp();
}

function applySideRecoveryAssist(car, contact, carUp, surfaceUpDot, speed) {
  tmpQuat.set(car.body.quaternion.x, car.body.quaternion.y, car.body.quaternion.z, car.body.quaternion.w);
  const carRight = tmpVec3D.set(1, 0, 0).applyQuaternion(tmpQuat).normalize();
  const sideDot = Math.abs(carRight.dot(contact.normal));
  const sideBound =
    car.vehicle.numWheelsOnGround < 2 &&
    Math.abs(surfaceUpDot) < 0.34 &&
    sideDot > 0.62 &&
    speed < vehicleTuning.sideRecoveryMaxSpeed &&
    (car.surfaceContactGrace > 0 || contact.distance < vehicleTuning.contactAssistSurfaceDistance);

  car.sideRecoveryTime = sideBound
    ? Math.min(1, car.sideRecoveryTime + fixedStep)
    : Math.max(0, car.sideRecoveryTime - fixedStep * 5);

  if (car.sideRecoveryTime < vehicleTuning.sideRecoveryDelay) return false;
  const controlIntent = !car.isPlayer || Math.abs(car.input.throttle) + Math.abs(car.input.steer) > 0.15 || car.input.jumpQueued;
  if (!controlIntent) return false;

  tmpVec3C.copy(carUp).cross(contact.normal);
  if (tmpVec3C.lengthSq() < 0.0001) return false;
  tmpVec3C.normalize();

  const strength = vehicleTuning.sideRecoveryTorque * (car.isPlayer ? 1 : 1.18);
  worldAirControlTorque.set(
    tmpVec3C.x * strength - car.body.angularVelocity.x * vehicleTuning.sideRecoveryDamping,
    tmpVec3C.y * strength - car.body.angularVelocity.y * vehicleTuning.sideRecoveryDamping,
    tmpVec3C.z * strength - car.body.angularVelocity.z * vehicleTuning.sideRecoveryDamping,
  );
  car.body.torque.vadd(worldAirControlTorque, car.body.torque);
  car.body.wakeUp();
  return true;
}

function applyAirControls(car) {
  if (gameState.phase !== "playing") return;

  car.surfaceContactGrace = Math.max(0, car.surfaceContactGrace - fixedStep);
  const carPosition = tmpVec3A.set(car.body.position.x, car.body.position.y, car.body.position.z);
  const contact = arenaContactForPoint(carPosition);
  tmpQuat.set(car.body.quaternion.x, car.body.quaternion.y, car.body.quaternion.z, car.body.quaternion.w);
  const carUp = tmpVec3B.set(0, 1, 0).applyQuaternion(tmpQuat).normalize();
  const surfaceUpDot = carUp.dot(contact.normal);
  const speed = car.body.velocity.length();
  const nearSurfaceBind =
    surfaceUpDot < vehicleTuning.contactAssistReleaseDot &&
    (car.surfaceContactGrace > 0 || contact.distance < vehicleTuning.contactAssistSurfaceDistance) &&
    speed < vehicleTuning.contactAssistMaxSpeed;
  car.surfaceContactTime =
    car.surfaceContactGrace > 0 || nearSurfaceBind
      ? Math.min(1, car.surfaceContactTime + fixedStep)
      : Math.max(0, car.surfaceContactTime - fixedStep * 4);
  const tippedEnoughForAirControl = surfaceUpDot < 0.55;
  const sideRecoveryActive = applySideRecoveryAssist(car, contact, carUp, surfaceUpDot, speed);

  if (!car.isPlayer) {
    if (!sideRecoveryActive) applyAiAirStabilizer(car, contact.normal, carUp, surfaceUpDot);
    return;
  }

  if (car.vehicle.numWheelsOnGround >= 2 && !tippedEnoughForAirControl) return;

  const pitchInput = car.input.throttle;
  const yawInput = car.input.steer;
  if (pitchInput === 0 && yawInput === 0) {
    car.airAssistContactTime = Math.max(0, car.airAssistContactTime - fixedStep * 8);
    return;
  }

  const eligibleForContactAssist =
    tippedEnoughForAirControl &&
    (surfaceUpDot < vehicleTuning.contactAssistReleaseDot || sideRecoveryActive) &&
    car.surfaceContactTime >= vehicleTuning.contactAssistDelay &&
    speed < vehicleTuning.contactAssistMaxSpeed;
  car.airAssistContactTime = eligibleForContactAssist
    ? Math.min(1, car.airAssistContactTime + fixedStep)
    : Math.max(0, car.airAssistContactTime - fixedStep * 8);
  const contactAssist =
    eligibleForContactAssist && car.airAssistContactTime > 0
      ? vehicleTuning.contactAssistMultiplier
      : 1;

  airControlTorque.set(
    pitchInput * vehicleTuning.airPitchTorque * contactAssist,
    yawInput * vehicleTuning.airYawTorque * contactAssist,
    0,
  );
  car.body.vectorToWorldFrame(airControlTorque, worldAirControlTorque);
  car.body.torque.vadd(worldAirControlTorque, car.body.torque);
  car.body.wakeUp();
}

function applyBoost(car, dt) {
  car.boostCooldownRemaining = Math.max(0, car.boostCooldownRemaining - dt);

  if (gameState.phase !== "playing") {
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

  if (car.vehicle.numWheelsOnGround >= 2) {
    car.body.wakeUp();
    car.body.position.y += 0.22;
    car.body.velocity.y = Math.max(car.body.velocity.y, vehicleTuning.jumpVelocity);
    car.body.angularVelocity.x = 0;
    car.body.angularVelocity.z = 0;
  } else if (car.sideRecoveryTime >= vehicleTuning.sideRecoveryDelay) {
    const carPosition = tmpVec3A.set(car.body.position.x, car.body.position.y, car.body.position.z);
    const contact = arenaContactForPoint(carPosition);
    tmpQuat.set(car.body.quaternion.x, car.body.quaternion.y, car.body.quaternion.z, car.body.quaternion.w);
    const carUp = tmpVec3B.set(0, 1, 0).applyQuaternion(tmpQuat).normalize();
    tmpVec3C.copy(carUp).cross(contact.normal);
    if (tmpVec3C.lengthSq() > 0.0001) {
      tmpVec3C.normalize();
      car.body.velocity.x += contact.normal.x * vehicleTuning.sideRecoveryJumpVelocity;
      car.body.velocity.y = Math.max(car.body.velocity.y, contact.normal.y * vehicleTuning.sideRecoveryJumpVelocity + 2.2);
      car.body.velocity.z += contact.normal.z * vehicleTuning.sideRecoveryJumpVelocity;
      car.body.angularVelocity.x += tmpVec3C.x * vehicleTuning.sideRecoveryJumpSpin;
      car.body.angularVelocity.y += tmpVec3C.y * vehicleTuning.sideRecoveryJumpSpin;
      car.body.angularVelocity.z += tmpVec3C.z * vehicleTuning.sideRecoveryJumpSpin;
      car.body.wakeUp();
    }
  }

  car.input.jumpQueued = false;
}

function arenaContactForPoint(pos) {
  const xzLen = Math.hypot(pos.x, pos.z);
  const radialX = xzLen > 0.0001 ? pos.x / xzLen : 1;
  const radialZ = xzLen > 0.0001 ? pos.z / xzLen : 0;

  arenaContactResult.point.set(pos.x, 0, pos.z);
  arenaContactResult.normal.set(0, 1, 0);
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

function pickWaypoint(car) {
  const angle = Math.random() * Math.PI * 2;
  const radius = 18 + Math.random() * 42;
  car.ai.waypoint.set(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
  car.ai.waypointTimer = 2.5 + Math.random() * 2.5;
}

function addArenaAvoidance(pos, desired, car = null) {
  const radius = Math.hypot(pos.x, pos.z);
  if (radius > worldSpec.floorRadius - 10) {
    const inward = tmpVec3B.set(-pos.x, 0, -pos.z).normalize();
    desired.addScaledVector(inward, (radius - (worldSpec.floorRadius - 10)) * 2.8);
  }

  for (const obstacle of aiObstacles) {
    const dx = pos.x - obstacle.position.x;
    const dz = pos.z - obstacle.position.z;
    const d = Math.hypot(dx, dz);
    if (d > 0.001 && d < obstacle.avoidRadius) {
      const strength = obstacle.avoidRadius - d;
      const sign = car?.ai?.lateralSign ?? 1;
      desired.x += (dx / d) * strength * 0.9 + (-dz / d) * strength * 0.62 * sign;
      desired.z += (dz / d) * strength * 0.9 + (dx / d) * strength * 0.62 * sign;
    }
  }
}

function bendAroundBlockingObstacles(pos, desired, car = null) {
  const goal = pos.clone().add(desired);
  const path = goal.clone().sub(pos);
  const pathLengthSq = path.lengthSq();
  if (pathLengthSq < 0.001) return;

  for (const obstacle of aiObstacles) {
    const toObstacle = obstacle.position.clone().sub(pos);
    const t = THREE.MathUtils.clamp(toObstacle.dot(path) / pathLengthSq, 0, 1);
    if (t <= 0.05 || t >= 0.96) continue;

    const closest = pos.clone().addScaledVector(path, t);
    const clearance = Math.hypot(closest.x - obstacle.position.x, closest.z - obstacle.position.z);
    const avoidRadius = obstacle.radius + 5;
    if (clearance >= avoidRadius) continue;

    const sign = car?.ai?.lateralSign ?? 1;
    const pathDirection = path.clone().normalize();
    const tangent = new THREE.Vector3(-pathDirection.z, 0, pathDirection.x).multiplyScalar(sign);
    const away = closest.sub(obstacle.position).normalize();
    const strength = (avoidRadius - clearance) * 2.4;
    desired.addScaledVector(tangent, strength);
    desired.addScaledVector(away, strength * 0.75);
  }
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

function surfaceUpDotForCar(car) {
  const carPosition = tmpVec3A.set(car.body.position.x, car.body.position.y, car.body.position.z);
  const contact = arenaContactForPoint(carPosition);
  tmpQuat.set(car.body.quaternion.x, car.body.quaternion.y, car.body.quaternion.z, car.body.quaternion.w);
  return tmpVec3B.set(0, 1, 0).applyQuaternion(tmpQuat).normalize().dot(contact.normal);
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

function worldCarForward(car, out = new THREE.Vector3()) {
  tmpQuat.set(car.body.quaternion.x, car.body.quaternion.y, car.body.quaternion.z, car.body.quaternion.w);
  return out.set(0, 0, 1).applyQuaternion(tmpQuat).normalize();
}

function clampArenaVector(vec, maxRadius = worldSpec.floorRadius - 9) {
  const radius = Math.hypot(vec.x, vec.z);
  if (radius > maxRadius) vec.multiplyScalar(maxRadius / radius);
  return vec;
}

function closestTagTargetFor(car) {
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

function updateAiObjective(car, targetPoint, dt, refreshDistance = 10) {
  car.ai.objectiveTimer -= dt;
  const current = flatCarPosition(car, tmpVec3A);
  if (
    car.ai.objectiveTimer <= 0 ||
    current.distanceTo(car.ai.objective) < refreshDistance ||
    car.ai.objective.distanceTo(targetPoint) > 18
  ) {
    car.ai.objective.copy(targetPoint);
    car.ai.objectiveTimer = 0.75 + Math.random() * 0.45;
  }
}

function chooseAiChaseVector(car, target, desired) {
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

function chooseAiEscapeVector(car, threat, desired, dt) {
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
  updateAiObjective(car, safePoint, dt, 9);
  desired.copy(car.ai.objective).sub(pos);
}

function applyAiRecovery(car, dt, surfaceUpDot) {
  const speed = car.body.velocity.length();
  const nearSurface = car.surfaceContactTime > 0.28 || car.surfaceContactGrace > 0;
  const actualBind = speed < 2.2 && car.vehicle.numWheelsOnGround < 2 && surfaceUpDot < -0.38 && nearSurface;
  car.ai.recoveryCandidateTimer = actualBind
    ? car.ai.recoveryCandidateTimer + dt
    : Math.max(0, car.ai.recoveryCandidateTimer - dt * 3);

  if (car.ai.recoveryCandidateTimer < 0.42) {
    car.ai.rightingTimer = 0;
    return false;
  }

  car.ai.rightingTimer += dt;
  car.input.throttle = 1;
  car.input.steer = 0;

  const carPosition = tmpVec3A.set(car.body.position.x, car.body.position.y, car.body.position.z);
  const contact = arenaContactForPoint(carPosition);
  tmpQuat.set(car.body.quaternion.x, car.body.quaternion.y, car.body.quaternion.z, car.body.quaternion.w);
  const carUp = tmpVec3B.set(0, 1, 0).applyQuaternion(tmpQuat).normalize();
  tmpVec3C.copy(carUp).cross(contact.normal);
  if (tmpVec3C.lengthSq() < 0.0001) tmpVec3C.set(0, 0, 1).applyQuaternion(tmpQuat).normalize();
  else tmpVec3C.normalize();

  const recoveryPower = vehicleTuning.aiRecoveryLevelTorque * (car.isIt ? 1.22 : 1);
  worldAirControlTorque.set(
    tmpVec3C.x * recoveryPower - car.body.angularVelocity.x * vehicleTuning.aiAirAngularDamping,
    tmpVec3C.y * recoveryPower - car.body.angularVelocity.y * vehicleTuning.aiAirAngularDamping,
    tmpVec3C.z * recoveryPower - car.body.angularVelocity.z * vehicleTuning.aiAirAngularDamping,
  );
  car.body.torque.vadd(worldAirControlTorque, car.body.torque);

  if (car.ai.rightingTimer > 0.65 && contact.distance < 1.2) {
    car.body.velocity.x += contact.normal.x * 0.16;
    car.body.velocity.y = Math.max(car.body.velocity.y, contact.normal.y * 4.2);
    car.body.velocity.z += contact.normal.z * 0.16;
  }
  car.body.wakeUp();

  return true;
}

function updateAiCar(car, dt) {
  car.input.boost = false;
  car.input.boostQueued = false;
  car.input.jumpQueued = false;
  car.ai.jumpCooldown = Math.max(0, car.ai.jumpCooldown - dt);
  car.ai.reverseTimer = Math.max(0, car.ai.reverseTimer - dt);
  car.ai.unstickTimer = Math.max(0, car.ai.unstickTimer - dt);
  car.ai.targetBiasTimer = Math.max(0, car.ai.targetBiasTimer - dt);
  car.ai.decisionTimer = Math.max(0, car.ai.decisionTimer - dt);
  car.ai.lateralTimer -= dt;
  if (car.ai.lateralTimer <= 0) {
    car.ai.lateralSign *= -1;
    car.ai.lateralTimer = 2.2 + Math.random() * 2.4;
  }

  if (gameState.phase !== "playing") return;

  const pos = car.ai.lastPosition.set(car.body.position.x, 0, car.body.position.z);
  const itCar = gameState.itCar;
  const desired = car.ai.desired.set(0, 0, 0);
  let activeTarget = null;
  const surfaceUpDot = surfaceUpDotForCar(car);
  if (applyAiRecovery(car, dt, surfaceUpDot)) return;
  if (car.ai.decisionTimer > 0) return;
  car.ai.decisionTimer = car.ai.decisionInterval;

  if (car.isIt) {
    const best = closestTagTargetFor(car);
    if (best) {
      activeTarget = best;
      chooseAiChaseVector(car, best, desired);
    }
  } else if (itCar && itCar !== car) {
    activeTarget = itCar;
    const threatDistance = flatDistanceBetween(car, itCar);
    if (threatDistance > 0.001) {
      chooseAiEscapeVector(car, itCar, desired, dt);
    } else {
      car.ai.waypointTimer -= dt;
      if (car.ai.waypointTimer <= 0 || pos.distanceTo(car.ai.waypoint) < 8) pickWaypoint(car);
      desired.copy(car.ai.waypoint).sub(pos);
    }
  }

  if (desired.lengthSq() < 0.001) {
    car.ai.waypointTimer -= dt;
    if (car.ai.waypointTimer <= 0 || pos.distanceTo(car.ai.waypoint) < 8) pickWaypoint(car);
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

  if (car.ai.stuckTimer > 0.8) {
    car.ai.unstickTimer = car.isIt && activeTarget ? 0.45 : 0.95;
    car.ai.unstickSteer = car.isIt && activeTarget
      ? THREE.MathUtils.clamp(aimAngle / 0.72, -1, 1)
      : Math.random() < 0.5 ? -1 : 1;
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
    car.input.throttle = 0.55;
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
    itBannerEl.style.background = itBackground;
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
  for (const car of gameState.aiCars) destroyCar(car);
  gameState.aiCars = [];

  gameState.roundLength = Number(roundTimeSelect.value);
  gameState.timeRemaining = gameState.roundLength;
  gameState.playerCount = Number(playerCountSelect.value);
  void arenaSelect.value;
  setCarColor(playerCar, gameState.selectedColor);

  const availableColors = shuffle(carPalette.filter((color) => color !== gameState.selectedColor));
  gameState.cars = [playerCar];
  for (let i = 1; i < gameState.playerCount; i += 1) {
    const color = availableColors[(i - 1) % availableColors.length];
    const aiCar = createCar({ id: `ai-${i}`, name: color.name, color, isPlayer: false });
    pickWaypoint(aiCar);
    gameState.aiCars.push(aiCar);
    gameState.cars.push(aiCar);
  }

  const spawns = shuffle(spawnPoints);
  gameState.cars.forEach((car, index) => spawnCarAt(car, spawns[index % spawns.length]));

  gameState.itCar = gameState.cars[Math.floor(Math.random() * gameState.cars.length)];
  gameState.itCar.isIt = true;
  gameState.tagCooldown = 0;
  gameState.phase = "playing";
  setUiPhase("playing");
  gameState.leaderboardDirty = true;
  startScreenEl.classList.add("hidden");
  endScreenEl.classList.add("hidden");
}

function endRound() {
  gameState.phase = "ended";
  setUiPhase("ended");
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
  for (const car of gameState.aiCars) destroyCar(car);
  gameState.aiCars = [];
  gameState.cars = [playerCar];
  gameState.itCar = null;
  spawnCarAt(playerCar, spawnPoints[0]);
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

function moundHeightAtPoint(point, obstacle, padding = 0) {
  const local = cameraLocalPoint.copy(point).sub(obstacle.position).applyAxisAngle(upAxis, -obstacle.yaw);
  const halfWidth = obstacle.width / 2;
  const halfLength = obstacle.length / 2;
  if (Math.abs(local.x) > halfWidth + padding || Math.abs(local.z) > halfLength + padding) return -Infinity;

  const topHalfWidth = halfWidth * obstacle.topScale;
  const topHalfLength = halfLength * obstacle.topScale;
  const xFalloff =
    Math.abs(local.x) <= topHalfWidth
      ? 1
      : 1 - (Math.abs(local.x) - topHalfWidth) / Math.max(0.001, halfWidth - topHalfWidth);
  const zFalloff =
    Math.abs(local.z) <= topHalfLength
      ? 1
      : 1 - (Math.abs(local.z) - topHalfLength) / Math.max(0.001, halfLength - topHalfLength);
  return obstacle.position.y + obstacle.height * THREE.MathUtils.clamp(Math.min(xFalloff, zFalloff), 0, 1);
}

function cameraInsideRamp(point) {
  for (const obstacle of cameraObstacles) {
    const surfaceY = moundHeightAtPoint(point, obstacle, 0.35);
    if (surfaceY > -Infinity && point.y > obstacle.position.y - 0.35 && point.y < surfaceY + 0.95) {
      return true;
    }
  }
  return false;
}

function cameraLineBlocked(origin, candidate) {
  if (cameraInsideRamp(candidate)) return true;

  const toCamera = cameraToCandidate.copy(candidate).sub(origin);
  const distance = toCamera.length();
  if (distance <= 0.001 || cameraCollisionMeshes.length === 0) return false;

  cameraRaycaster.set(origin, toCamera.multiplyScalar(1 / distance));
  cameraRaycaster.near = 0.85;
  cameraRaycaster.far = distance - 0.4;
  cameraRayHits.length = 0;
  cameraRaycaster.intersectObjects(cameraCollisionMeshes, false, cameraRayHits);
  return cameraRayHits.length > 0;
}

function resolveCameraPosition(origin, desiredPosition, cameraUp, carRight) {
  const towardDesired = cameraState.towardDesired.copy(desiredPosition).sub(origin);
  cameraCandidates[0].copy(desiredPosition);
  cameraCandidates[1].copy(desiredPosition).addScaledVector(cameraUp, 2.4);
  cameraCandidates[2].copy(desiredPosition).addScaledVector(cameraUp, 4.8);
  cameraCandidates[3].copy(desiredPosition).addScaledVector(carRight, 3.2).addScaledVector(cameraUp, 2.8);
  cameraCandidates[4].copy(desiredPosition).addScaledVector(carRight, -3.2).addScaledVector(cameraUp, 2.8);
  cameraCandidates[5].copy(origin).addScaledVector(towardDesired, 0.82).addScaledVector(cameraUp, 3.6);
  cameraCandidates[6].copy(origin).addScaledVector(towardDesired, 0.68).addScaledVector(cameraUp, 5.2);

  for (const candidate of cameraCandidates) {
    const arenaContact = arenaContactForPoint(candidate);
    if (arenaContact.distance < 0.85) candidate.addScaledVector(arenaContact.normal, 0.85 - arenaContact.distance);
    if (!cameraLineBlocked(origin, candidate)) return cameraState.resolvedPosition.copy(candidate);
  }

  const direction = towardDesired.normalize();
  cameraRaycaster.set(origin, direction);
  cameraRaycaster.near = 0.85;
  cameraRaycaster.far = Math.max(1, desiredPosition.distanceTo(origin));
  cameraRayHits.length = 0;
  cameraRaycaster.intersectObjects(cameraCollisionMeshes, false, cameraRayHits);
  const fallbackDistance = cameraRayHits.length > 0 ? Math.max(5.5, cameraRayHits[0].distance - 1.25) : 8;
  return cameraState.resolvedPosition.copy(origin).addScaledVector(direction, fallbackDistance).addScaledVector(cameraUp, 2.8);
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

  savedChassisPosition.copy(car.body.position);
  savedChassisQuaternion.copy(car.body.quaternion);
  car.body.position.set(car.visual.position.x, car.visual.position.y, car.visual.position.z);
  car.body.quaternion.set(tmpQuat.x, tmpQuat.y, tmpQuat.z, tmpQuat.w);

  const wheelBaseIndex = car.wheelVisuals.slot * wheelsPerCar;
  for (let i = 0; i < car.vehicle.wheelInfos.length; i += 1) {
    car.vehicle.updateWheelTransform(i);
    const transform = car.vehicle.wheelInfos[i].worldTransform;
    wheelVisualPosition.set(transform.position.x, transform.position.y, transform.position.z);
    wheelVisualQuaternion.set(transform.quaternion.x, transform.quaternion.y, transform.quaternion.z, transform.quaternion.w);
    wheelMatrix.compose(wheelVisualPosition, wheelVisualQuaternion, wheelVisualScale);
    car.wheelVisuals.tires.setMatrixAt(wheelBaseIndex + i, wheelMatrix);
    car.wheelVisuals.rims.setMatrixAt(wheelBaseIndex + i, wheelMatrix);
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
    const pulse = 1 + Math.sin(visualTime * 0.008) * 0.08;
    car.tagMarker.scale.set(pulse, pulse, pulse);
    car.tagMarker.rotation.y += 0.04;
  }
}

function syncVisuals(dt, interpolationAlpha) {
  const visualTime = performance.now();
  for (const car of gameState.cars) syncCarVisual(car, interpolationAlpha, visualTime);
  if (globalWheelVisuals) {
    globalWheelVisuals.tires.instanceMatrix.needsUpdate = true;
    globalWheelVisuals.rims.instanceMatrix.needsUpdate = true;
  }

  const grounded = playerCar.vehicle.numWheelsOnGround > 0;
  const rawForward = tmpVec3A.set(0, 0, 1).applyQuaternion(playerCar.visual.quaternion).normalize();
  const rawUp = tmpVec3B.set(0, 1, 0).applyQuaternion(playerCar.visual.quaternion).normalize();
  const rawRight = tmpVec3C.set(1, 0, 0).applyQuaternion(playerCar.visual.quaternion).normalize();
  if (grounded) {
    cameraState.followForward.copy(rawForward);
    cameraState.followUp.copy(rawUp);
    cameraState.followRight.copy(rawRight);
  }

  const carForward = grounded ? rawForward : cameraState.followForward;
  const carUp = grounded ? rawUp : cameraState.followUp;
  const carRight = grounded ? rawRight : cameraState.followRight;
  const cameraUpBias = grounded ? 0.45 : 0.9;
  const cameraUp = tmpVec3D.copy(carUp).lerp(upAxis, cameraUpBias).normalize();
  const leadDistance = grounded ? 4.0 : 2.6;
  const chaseDistance = grounded ? 12 : 16;
  const cameraHeight = grounded ? 5.4 : 7.4;
  const lateralOffset = grounded ? -playerCar.input.steer * 1.2 : 0;

  const desiredTarget = cameraState.desiredTarget.copy(playerCar.visual.position).addScaledVector(cameraUp, 1.1).addScaledVector(carForward, leadDistance);
  const desiredPosition = cameraState.desiredPosition
    .copy(playerCar.visual.position)
    .addScaledVector(carForward, -chaseDistance)
    .addScaledVector(cameraUp, cameraHeight)
    .addScaledVector(carRight, lateralOffset);

  const cameraContact = arenaContactForPoint(desiredPosition);
  if (cameraContact.distance < 0.85) desiredPosition.addScaledVector(cameraContact.normal, 0.85 - cameraContact.distance);

  const cameraObstructionOrigin = cameraState.obstructionOrigin.copy(playerCar.visual.position).addScaledVector(cameraUp, 1.25);
  desiredPosition.copy(resolveCameraPosition(cameraObstructionOrigin, desiredPosition, cameraUp, carRight));

  cameraState.position.lerp(desiredPosition, 1 - Math.exp(-dt * 6));
  cameraState.target.lerp(desiredTarget, 1 - Math.exp(-dt * 8));
  camera.position.copy(cameraState.position);
  camera.lookAt(cameraState.target);

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
        surfaceContactTime: car.surfaceContactTime,
        sideRecoveryTime: car.sideRecoveryTime,
        input: { throttle: car.input.throttle, steer: car.input.steer, boostQueued: car.input.boostQueued },
        ai: car.isPlayer ? null : {
          stuckTimer: car.ai.stuckTimer,
          unstickTimer: car.ai.unstickTimer,
          reverseTimer: car.ai.reverseTimer,
          rightingTimer: car.ai.rightingTimer,
          recoveryCandidateTimer: car.ai.recoveryCandidateTimer,
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

  const simStart = performance.now();
  let stepsThisFrame = 0;
  while (accumulator >= fixedStep && stepsThisFrame < maxPhysicsStepsPerFrame) {
    stepsThisFrame += 1;
    updatePlayerInput();
    for (const car of gameState.aiCars) updateAiCar(car, fixedStep);
    for (const car of gameState.cars) {
      driveCar(car);
      applyAirControls(car);
      applyBoost(car, fixedStep);
    }
    physics.step(fixedStep);
    processPhysicsContacts();
    for (const car of gameState.cars) applyQueuedJump(car);
    updateRound(fixedStep);
    accumulator -= fixedStep;
  }
  const simMs = performance.now() - simStart;

  syncVisuals(dt, accumulator / fixedStep);
  const renderStart = performance.now();
  renderer.render(scene, camera);
  const renderMs = performance.now() - renderStart;
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

renderColorPicker();
setUiPhase("menu");
spawnCarAt(playerCar, spawnPoints[0]);
gameState.timeRemaining = Number(roundTimeSelect.value);
requestAnimationFrame(animate);
