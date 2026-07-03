import http from "node:http";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
import WebSocket from "ws";
import { protocolVersion } from "../server/shared/protocol.js";
import { vehicleTuning } from "../server/shared/vehicle-config.js";

const port = Number(process.env.REMOTE_JITTER_PORT ?? 8821);
const workerPortBase = Number(process.env.REMOTE_JITTER_WORKER_PORT_BASE ?? 22821);
const url = `http://127.0.0.1:${port}`;
const wsUrl = `ws://127.0.0.1:${port}`;
const durationMs = Number(process.env.REMOTE_JITTER_DURATION_MS ?? 12000);
const warmupMs = Number(process.env.REMOTE_JITTER_WARMUP_MS ?? 4500);
const inputHz = Number(process.env.REMOTE_JITTER_INPUT_HZ ?? 60);
const maxForwardSpeed = (vehicleTuning.maxForwardKmh / 3.6) * vehicleTuning.itSpeedMultiplier;
const highSpeedThreshold = Number(process.env.REMOTE_JITTER_HIGH_SPEED ?? Math.max(10, maxForwardSpeed * 0.55));

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function health() {
  return new Promise((resolve) => {
    const request = http.get(`${url}/healthz`, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on("error", () => resolve(false));
    request.setTimeout(1000, () => {
      request.destroy();
      resolve(false);
    });
  });
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await health()) return;
    await wait(150);
  }
  throw new Error("remote jitter test server did not become healthy");
}

function magnitude(vector) {
  return Math.hypot(vector?.[0] ?? 0, vector?.[1] ?? 0, vector?.[2] ?? 0);
}

function percentile(values, pct) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return sorted[index];
}

function fixed(value, digits = 4) {
  return Number((Number(value) || 0).toFixed(digits));
}

function movementMetrics(samples, key) {
  const frameMs = [];
  const displacement = [];
  const speed = [];
  const acceleration = [];
  const jerk = [];
  let previous = null;
  let previousVelocity = null;
  let previousAcceleration = null;

  for (const sample of samples) {
    const position = sample[key];
    if (!position) continue;
    if (!previous) {
      previous = { t: sample.t, position };
      continue;
    }
    const dt = Math.max(0.001, (sample.t - previous.t) / 1000);
    if (dt > 0.12) {
      previous = { t: sample.t, position };
      previousVelocity = null;
      previousAcceleration = null;
      continue;
    }
    const delta = [
      position[0] - previous.position[0],
      position[1] - previous.position[1],
      position[2] - previous.position[2],
    ];
    const velocity = delta.map((value) => value / dt);
    frameMs.push(dt * 1000);
    displacement.push(magnitude(delta));
    speed.push(magnitude(velocity));
    if (previousVelocity) {
      const accelerationVector = velocity.map((value, index) => (value - previousVelocity[index]) / dt);
      acceleration.push(magnitude(accelerationVector));
      if (previousAcceleration) {
        const jerkVector = accelerationVector.map((value, index) => (value - previousAcceleration[index]) / dt);
        jerk.push(magnitude(jerkVector));
      }
      previousAcceleration = accelerationVector;
    }
    previousVelocity = velocity;
    previous = { t: sample.t, position };
  }

  return {
    frameP95Ms: fixed(percentile(frameMs, 95), 2),
    displacementP50: fixed(percentile(displacement, 50), 4),
    displacementP95: fixed(percentile(displacement, 95), 4),
    speedP50: fixed(percentile(speed, 50), 3),
    speedP95: fixed(percentile(speed, 95), 3),
    accelerationP95: fixed(percentile(acceleration, 95), 3),
    accelerationP99: fixed(percentile(acceleration, 99), 3),
    jerkP95: fixed(percentile(jerk, 95), 3),
    jerkP99: fixed(percentile(jerk, 99), 3),
  };
}

function remoteFreezeMetrics(samples) {
  const visualSteps = [];
  const bodyVisualDelta = [];
  let highSpeedFrames = 0;
  let frozenHighSpeedFrames = 0;
  let hitchFrames = 0;
  let previous = null;

  for (const sample of samples) {
    bodyVisualDelta.push(magnitude(sample.visualBodyDelta));
    if (!previous) {
      previous = sample;
      continue;
    }
    const dt = Math.max(0.001, (sample.t - previous.t) / 1000);
    if (dt > 0.12) {
      previous = sample;
      continue;
    }
    const step = magnitude([
      sample.visual[0] - previous.visual[0],
      sample.visual[1] - previous.visual[1],
      sample.visual[2] - previous.visual[2],
    ]);
    visualSteps.push(step);
    const reportedSpeed = magnitude(sample.velocity);
    if (reportedSpeed > highSpeedThreshold) {
      highSpeedFrames += 1;
      if (step < Math.max(0.035, reportedSpeed / 900)) frozenHighSpeedFrames += 1;
    }
    if (step > percentile(visualSteps, 50) * 3.5 && step > 0.45) hitchFrames += 1;
    previous = sample;
  }

  return {
    highSpeedFrames,
    frozenHighSpeedFrames,
    frozenHighSpeedPct: fixed((frozenHighSpeedFrames / Math.max(1, highSpeedFrames)) * 100, 2),
    hitchFrames,
    visualStepP50: fixed(percentile(visualSteps, 50), 4),
    visualStepP95: fixed(percentile(visualSteps, 95), 4),
    visualStepMax: fixed(Math.max(0, ...visualSteps), 4),
    visualBodyDeltaP95: fixed(percentile(bodyVisualDelta, 95), 4),
    visualBodyDeltaMax: fixed(Math.max(0, ...bodyVisualDelta), 4),
  };
}

function summarize(result) {
  const samples = Array.isArray(result) ? result : result.samples;
  const last = samples.at(-1) ?? {};
  const startStats = Array.isArray(result) ? {} : (result.startStats ?? {});
  const rawRemoteStats = last.remoteInterpolation ?? {};
  const remoteStats = {
    ...rawRemoteStats,
    extrapolations: Math.max(0, (rawRemoteStats.extrapolations ?? 0) - (startStats.extrapolations ?? 0)),
    bufferUnderruns: Math.max(0, (rawRemoteStats.bufferUnderruns ?? 0) - (startStats.bufferUnderruns ?? 0)),
  };
  const durationSeconds = Math.max(0.001, ((samples.at(-1)?.t ?? 0) - (samples[0]?.t ?? 0)) / 1000);
  const bufferSizes = samples.map((sample) => sample.networkBufferSize ?? 0);
  const speeds = samples.map((sample) => magnitude(sample.velocity));
  const inputs = samples.map((sample) => sample.input ?? {});
  const throttleActivePct = inputs.filter((input) => Math.abs(input.throttle ?? 0) > 0.7).length / Math.max(1, inputs.length) * 100;
  return {
    sampleCount: samples.length,
    durationMs: fixed(durationSeconds * 1000, 1),
    sampleRate: fixed(samples.length / durationSeconds, 2),
    target: {
      maxForwardSpeed: fixed(maxForwardSpeed, 3),
      highSpeedThreshold: fixed(highSpeedThreshold, 3),
      speedP50: fixed(percentile(speeds, 50), 3),
      speedP95: fixed(percentile(speeds, 95), 3),
      speedMax: fixed(Math.max(0, ...speeds), 3),
      throttleActivePct: fixed(throttleActivePct, 2),
    },
    body: movementMetrics(samples, "body"),
    visual: movementMetrics(samples, "visual"),
    freezes: remoteFreezeMetrics(samples),
    remoteInterpolation: {
      ...remoteStats,
      extrapolationsPerSecondTotal: fixed((remoteStats.extrapolations ?? 0) / durationSeconds, 3),
      bufferUnderrunsPerSecondTotal: fixed((remoteStats.bufferUnderruns ?? 0) / durationSeconds, 3),
      observedBufferP50: fixed(percentile(bufferSizes, 50), 2),
      observedBufferP95: fixed(percentile(bufferSizes, 95), 2),
    },
  };
}

function makeWsClient() {
  const ws = new WebSocket(wsUrl);
  const queue = [];
  const waiters = [];
  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    const index = waiters.findIndex((entry) => entry.predicate(message));
    if (index >= 0) {
      const [entry] = waiters.splice(index, 1);
      clearTimeout(entry.timeout);
      entry.resolve(message);
    } else {
      queue.push(message);
    }
  });

  function waitFor(predicate, timeoutMs = 12000) {
    const index = queue.findIndex(predicate);
    if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const waiterIndex = waiters.findIndex((entry) => entry.resolve === resolve);
        if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
        reject(new Error("websocket wait timeout"));
      }, timeoutMs);
      waiters.push({ predicate, resolve, timeout });
    });
  }

  return { ws, waitFor };
}

async function connectGuest(roomCode) {
  const client = makeWsClient();
  await new Promise((resolve, reject) => {
    client.ws.once("open", resolve);
    client.ws.once("error", reject);
  });
  client.ws.send(JSON.stringify({
    type: "hello",
    protocolVersion,
    name: "RemoteDriver",
    roomCode,
  }));
  const joined = await client.waitFor((message) => message.type === "joined" && message.roomCode === roomCode);
  return { ...client, sessionId: joined.sessionId };
}

async function createRoom(host) {
  await host.goto(url, { waitUntil: "networkidle" });
  await host.waitForFunction(() => Boolean(window.__arenaCarDebug?.getState), null, { timeout: 10000 });
  await host.evaluate(() => document.querySelector("#mode-multiplayer")?.click());
  await host.waitForFunction(() => window.__arenaCarDebug?.getState?.().multiplayer.connected, null, { timeout: 10000 });
  await host.evaluate(() => {
    const input = document.querySelector("#multiplayer-name");
    if (!input) return;
    input.value = "RemoteObserver";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await host.evaluate(() => document.querySelector("#create-room-open")?.click());
  await host.waitForFunction(() => !document.querySelector("#create-room-panel")?.classList?.contains("hidden"), null, { timeout: 10000 });
  await host.evaluate(() => document.querySelector("#create-room")?.click());
  await host.waitForFunction(() => Boolean(window.__arenaCarDebug?.getState().multiplayer.roomCode), null, { timeout: 10000 });
  return host.evaluate(() => window.__arenaCarDebug.getState().multiplayer.roomCode);
}

function startRemoteDriver(guest, roundId) {
  let sequence = 0;
  const intervalMs = Math.max(8, 1000 / inputHz);
  const startedAt = performance.now();
  const timer = setInterval(() => {
    if (guest.ws.readyState !== WebSocket.OPEN) return;
    sequence += 1;
    const elapsed = (performance.now() - startedAt) / 1000;
    const steer = elapsed < 7
      ? Math.sin(elapsed * 0.9) * 0.06
      : Math.sin(elapsed * 1.55) * 0.72 + Math.sin(elapsed * 3.7) * 0.18;
    guest.ws.send(JSON.stringify({
      type: "input",
      roundId,
      sequence,
      input: {
        throttle: 1,
        steer: Math.max(-1, Math.min(1, steer)),
        boost: true,
        boostQueued: sequence % Math.round(inputHz * 2.8) === 4,
        jumpQueued: false,
        airRoll: 0,
      },
    }));
  }, intervalMs);
  return () => clearInterval(timer);
}

async function startRound(host, guest) {
  await host.waitForFunction(() => document.querySelector("#lobby-list")?.textContent?.includes("RemoteDriver"), null, { timeout: 10000 });
  await host.evaluate(() => document.querySelector("#start-round")?.click());
  const started = await guest.waitFor((message) => message.type === "roundStarted");
  await host.waitForFunction(() => window.__arenaCarDebug?.getState().phase === "playing", null, { timeout: 15000 });
  return started.round.id;
}

async function sampleObservedRemote(host, guest, roundId) {
  const stopDriver = startRemoteDriver(guest, roundId);
  await host.waitForTimeout(warmupMs);
  const startStats = await host.evaluate(() => ({ ...window.__arenaCarDebug.getState().multiplayer.remoteInterpolationStats }));
  const samples = await host.evaluate((sampleDurationMs) => new Promise((resolve) => {
    const samples = [];
    const startedAt = performance.now();
    function frame(now) {
      const state = window.__arenaCarDebug.getState();
      const remote = state.cars.find((car) => car.networkControlled && car.name === "RemoteDriver") ??
        state.cars.find((car) => car.networkControlled);
      if (remote) {
        samples.push({
          t: now - startedAt,
          body: remote.position,
          visual: remote.visual.position,
          velocity: remote.velocity,
          input: remote.input,
          visualBodyDelta: remote.visual.bodyDelta,
          networkBufferSize: remote.networkBufferSize,
          remoteInterpolation: state.multiplayer.remoteInterpolationStats,
        });
      }
      if (now - startedAt < sampleDurationMs) requestAnimationFrame(frame);
      else resolve(samples);
    }
    requestAnimationFrame(frame);
  }), durationMs);
  stopDriver();
  return { samples, startStats };
}

const server = spawn(process.execPath, ["server/game-server.mjs"], {
  stdio: ["ignore", "inherit", "inherit"],
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    WORKER_PORT_BASE: String(workerPortBase),
    WORKER_COUNT: process.env.REMOTE_JITTER_WORKER_COUNT ?? "2",
    MAX_ROOMS: process.env.REMOTE_JITTER_MAX_ROOMS ?? "2",
    MAX_ACTIVE_ROOMS: process.env.REMOTE_JITTER_MAX_ACTIVE_ROOMS ?? "2",
  },
});

let browser;
let guest;
try {
  await waitForHealth();
  browser = await chromium.launch({
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: process.env.REMOTE_JITTER_HEADLESS !== "0",
    args: [
      ...(process.env.REMOTE_JITTER_SWIFTSHADER === "1" ? ["--use-angle=swiftshader"] : []),
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
    ],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await context.addInitScript((targetWsUrl) => {
    window.CARTAG_MULTIPLAYER_URL = targetWsUrl;
  }, wsUrl);
  const host = await context.newPage();
  host.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) console.error(`[browser:${message.type()}] ${message.text()}`);
  });
  host.on("pageerror", (error) => console.error(`[browser:pageerror] ${error.stack ?? error.message}`));

  const roomCode = await createRoom(host);
  guest = await connectGuest(roomCode);
  const roundId = await startRound(host, guest);
  const result = await sampleObservedRemote(host, guest, roundId);
  console.log(JSON.stringify({ ok: true, url, roomCode, ...summarize(result) }, null, 2));
} finally {
  if (guest) guest.ws.close();
  if (browser) await browser.close();
  server.kill("SIGTERM");
}
