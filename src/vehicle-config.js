import * as THREE from "three";
import * as CANNON from "cannon-es";

export const wheelOptions = {
  radius: 0.52,
  directionLocal: new CANNON.Vec3(0, -1, 0),
  suspensionStiffness: 58,
  suspensionRestLength: 0.38,
  frictionSlip: 6.35,
  dampingRelaxation: 6.6,
  dampingCompression: 12.4,
  maxSuspensionForce: 95000,
  rollInfluence: 0.014,
  axleLocal: new CANNON.Vec3(1, 0, 0),
  maxSuspensionTravel: 0.3,
  customSlidingRotationalSpeed: -32,
  useCustomSlidingRotationalSpeed: true,
};

export const rearWheelOptions = {
  ...wheelOptions,
  suspensionStiffness: 68,
  suspensionRestLength: 0.35,
  dampingRelaxation: 7.0,
  dampingCompression: 13.8,
  maxSuspensionTravel: 0.26,
};

export const wheelPositions = [
  new CANNON.Vec3(-1.18, -0.2, 1.46),
  new CANNON.Vec3(1.18, -0.2, 1.46),
  new CANNON.Vec3(-1.18, -0.2, -1.44),
  new CANNON.Vec3(1.18, -0.2, -1.44),
];

export const stabilitySamplePoints = [
  new THREE.Vector3(0, 0, 0),
  new THREE.Vector3(-1.16, -0.38, 1.1),
  new THREE.Vector3(1.16, -0.38, 1.1),
  new THREE.Vector3(-1.16, -0.38, -1.1),
  new THREE.Vector3(1.16, -0.38, -1.1),
  new THREE.Vector3(-1.12, 0.24, 0),
  new THREE.Vector3(1.12, 0.24, 0),
  new THREE.Vector3(0, 0.76, -0.18),
];

export const vehicleTuning = {
  engineForce: 1600,
  reverseForce: 900,
  brakeForce: 36,
  steerAngle: 0.43,
  highSpeedSteerScale: 0.38,
  steerResponse: 4.2,
  airPitchTorque: 1550,
  airYawTorque: 2100,
  contactAssistSurfaceGrace: 0.12,
  surfaceStabilityDistance: 1.45,
  wheelSupportMinUpDot: 0.22,
  manualRightingDot: 0.58,
  manualRightingSurfaceDistance: 1.55,
  manualRightingDuration: 0.42,
  manualRightingMaxSpeed: 10.5,
  manualRightingMaxAngularSpeed: 5.2,
  manualRightingClearance: 0.28,
  manualRightingPopVelocity: 2.8,
  tagImmunityDuration: 1.6,
  itSpeedMultiplier: 1.1,
  boostForce: 7000,
  boostDuration: 0.6,
  boostCooldown: 15,
  jumpVelocity: 11.5,
  maxForwardKmh: 96,
};

export const carPalette = [
  { name: "red", hex: 0xe0182d, css: "#e0182d" },
  { name: "teal", hex: 0x2fd8c4, css: "#2fd8c4" },
  { name: "gold", hex: 0xffc247, css: "#ffc247" },
  { name: "blue", hex: 0x4f8cff, css: "#4f8cff" },
  { name: "purple", hex: 0xb86cff, css: "#b86cff" },
  { name: "green", hex: 0x9fe44d, css: "#9fe44d" },
  { name: "orange", hex: 0xff7a2f, css: "#ff7a2f" },
  { name: "pink", hex: 0xff6fd8, css: "#ff6fd8" },
];

export const spawnHeight = 1.08;
