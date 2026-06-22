import * as THREE from "three";

export const input = {
  throttle: 0,
  steer: 0,
  boost: false,
  boostQueued: false,
  jumpQueued: false,
  airRoll: 0,
  cameraView: "normal",
};

export const touchInput = {
  throttle: 0,
  steer: 0,
  joystickPointerId: null,
  joystickCenterX: 0,
  joystickCenterY: 0,
  joystickRadius: 0,
};

const keys = new Set();
const lastTouchCommandAt = {
  boost: -Infinity,
  jump: -Infinity,
};

function isTypingTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName.toLowerCase();
  return tagName === "input" ||
    tagName === "textarea" ||
    tagName === "select" ||
    target.isContentEditable;
}

function controlCode(event) {
  if (event.key === "Shift" && event.location === 2) return "ShiftRight";
  if (event.key === "Shift" && event.location === 1) return "ShiftLeft";
  return event.code;
}

export function keyboardAxes() {
  const forward = keys.has("KeyW") || keys.has("ArrowUp");
  const reverse = keys.has("KeyS") || keys.has("ArrowDown");
  const left = keys.has("KeyA") || keys.has("ArrowLeft");
  const right = keys.has("KeyD") || keys.has("ArrowRight");
  const rollLeft = keys.has("KeyQ");
  const rollRight = keys.has("KeyE");
  return {
    throttle: (forward ? 1 : 0) + (reverse ? -1 : 0),
    steer: (left ? 1 : 0) + (right ? -1 : 0),
    boost: keys.has("ShiftLeft") || keys.has("ShiftRight"),
    airRoll: (rollRight ? 1 : 0) + (rollLeft ? -1 : 0),
  };
}

function cancelTouchEvent(event) {
  if (event.cancelable) event.preventDefault();
}

function setJoystickInput(pointerX, pointerY, joystickKnobEl) {
  const dx = pointerX - touchInput.joystickCenterX;
  const dy = pointerY - touchInput.joystickCenterY;
  const radius = Math.max(1, touchInput.joystickRadius);
  const rawDistance = Math.hypot(dx, dy);
  const distance = Math.min(radius, rawDistance);
  const unitX = rawDistance > 0.001 ? dx / rawDistance : 0;
  const unitY = rawDistance > 0.001 ? dy / rawDistance : 0;
  const knobX = unitX * distance;
  const knobY = unitY * distance;
  const deadzone = 0.14;
  const rawMagnitude = radius > 0 ? distance / radius : 0;
  const magnitude =
    rawMagnitude <= deadzone ? 0 : (rawMagnitude - deadzone) / (1 - deadzone);
  const normalizedX = unitX * magnitude;
  const normalizedY = unitY * magnitude;

  touchInput.steer = -normalizedX;
  touchInput.throttle = -normalizedY;
  joystickKnobEl.style.transform = `translate(calc(-50% + ${knobX}px), calc(-50% + ${knobY}px))`;
}

function resetJoystickInput(joystickKnobEl) {
  touchInput.throttle = 0;
  touchInput.steer = 0;
  touchInput.joystickPointerId = null;
  touchInput.joystickCenterX = 0;
  touchInput.joystickCenterY = 0;
  touchInput.joystickRadius = 0;
  joystickKnobEl.style.transform = "translate(-50%, -50%)";
}

function handleTouchCommand(event, command) {
  cancelTouchEvent(event);
  event.stopPropagation();
  const now = performance.now();
  if (event.type === "click" && now - lastTouchCommandAt[command] < 650) return;
  lastTouchCommandAt[command] = now;
  if (command === "boost") input.boostQueued = true;
  if (command === "jump") input.jumpQueued = true;
}

export function installInputControls({ boostHudEl, jumpButtonEl, joystickEl, joystickKnobEl, desktopCameraToggle = true }) {
  window.addEventListener("keydown", (event) => {
    const code = controlCode(event);
    if (isTypingTarget(event.target)) {
      keys.delete(code);
      return;
    }

    const handledCodes = [
      "KeyW",
      "KeyA",
      "KeyS",
      "KeyD",
      "ArrowUp",
      "ArrowLeft",
      "ArrowDown",
      "ArrowRight",
      "KeyQ",
      "KeyE",
      "ShiftLeft",
      "ShiftRight",
      "Space",
    ];
    if (desktopCameraToggle) handledCodes.push("KeyR");
    if (handledCodes.includes(code)) {
      event.preventDefault();
    }

    if (!keys.has(code) && code === "Space") input.jumpQueued = true;
    if (!keys.has(code) && (code === "ShiftLeft" || code === "ShiftRight")) input.boostQueued = true;
    if (!keys.has(code) && desktopCameraToggle && code === "KeyR") {
      input.cameraView = input.cameraView === "normal" ? "reverse" : "normal";
    }
    keys.add(code);
  });

  window.addEventListener("keyup", (event) => {
    keys.delete(controlCode(event));
  });

  joystickEl.addEventListener("pointerdown", (event) => {
    cancelTouchEvent(event);
    event.stopPropagation();
    if (touchInput.joystickPointerId !== null) return;
    const rect = joystickEl.getBoundingClientRect();
    touchInput.joystickPointerId = event.pointerId;
    touchInput.joystickCenterX = rect.left + rect.width * 0.5;
    touchInput.joystickCenterY = rect.top + rect.height * 0.5;
    touchInput.joystickRadius = rect.width * 0.42;
    if (joystickEl.setPointerCapture) joystickEl.setPointerCapture(event.pointerId);
    setJoystickInput(event.clientX, event.clientY, joystickKnobEl);
  });

  joystickEl.addEventListener("pointermove", (event) => {
    if (touchInput.joystickPointerId !== event.pointerId) return;
    cancelTouchEvent(event);
    event.stopPropagation();
    setJoystickInput(event.clientX, event.clientY, joystickKnobEl);
  });

  for (const eventName of ["pointerup", "pointercancel", "lostpointercapture"]) {
    joystickEl.addEventListener(eventName, (event) => {
      if (touchInput.joystickPointerId !== event.pointerId && eventName !== "lostpointercapture") return;
      resetJoystickInput(joystickKnobEl);
    });
  }

  for (const eventName of ["pointerdown", "click"]) {
    boostHudEl.addEventListener(eventName, (event) => handleTouchCommand(event, "boost"));
    jumpButtonEl.addEventListener(eventName, (event) => handleTouchCommand(event, "jump"));
  }

  boostHudEl.addEventListener(
    "touchstart",
    (event) => handleTouchCommand(event, "boost"),
    { passive: false },
  );
  jumpButtonEl.addEventListener(
    "touchstart",
    (event) => handleTouchCommand(event, "jump"),
    { passive: false },
  );

  for (const element of [boostHudEl, jumpButtonEl, joystickEl]) {
    element.addEventListener("contextmenu", (event) => cancelTouchEvent(event));
  }
}

export function clampPlayerInput(keyboard) {
  return {
    throttle: THREE.MathUtils.clamp(keyboard.throttle + touchInput.throttle, -1, 1),
    steer: THREE.MathUtils.clamp(keyboard.steer + touchInput.steer, -1, 1),
    boost: keyboard.boost,
    airRoll: THREE.MathUtils.clamp(keyboard.airRoll, -1, 1),
  };
}
