import http from "node:http";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
import { vehicleTuning } from "../server/shared/vehicle-config.js";

const port = Number(process.env.REMOTE_INTERP_PORT ?? 8822);
const workerPortBase = Number(process.env.REMOTE_INTERP_WORKER_PORT_BASE ?? 22921);
const url = `http://127.0.0.1:${port}`;
const durationMs = Number(process.env.REMOTE_INTERP_DURATION_MS ?? 10000);
const warmupMs = Number(process.env.REMOTE_INTERP_WARMUP_MS ?? 2500);
const maxForwardSpeed = (vehicleTuning.maxForwardKmh / 3.6) * vehicleTuning.itSpeedMultiplier;

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
  throw new Error("remote interpolation test server did not become healthy");
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

function movementMetrics(samples) {
  const steps = [];
  const speeds = [];
  const acceleration = [];
  const jerk = [];
  let previous = null;
  let previousVelocity = null;
  let previousAcceleration = null;
  for (const sample of samples) {
    if (!previous) {
      previous = sample;
      continue;
    }
    const dt = Math.max(0.001, (sample.t - previous.t) / 1000);
    if (dt > 0.12) {
      previous = sample;
      previousVelocity = null;
      previousAcceleration = null;
      continue;
    }
    const delta = [
      sample.visual[0] - previous.visual[0],
      sample.visual[1] - previous.visual[1],
      sample.visual[2] - previous.visual[2],
    ];
    const velocity = delta.map((value) => value / dt);
    steps.push(magnitude(delta));
    speeds.push(magnitude(velocity));
    if (previousVelocity) {
      const accel = velocity.map((value, index) => (value - previousVelocity[index]) / dt);
      acceleration.push(magnitude(accel));
      if (previousAcceleration) {
        jerk.push(magnitude(accel.map((value, index) => (value - previousAcceleration[index]) / dt)));
      }
      previousAcceleration = accel;
    }
    previousVelocity = velocity;
    previous = sample;
  }
  return {
    visualStepP50: fixed(percentile(steps, 50), 4),
    visualStepP95: fixed(percentile(steps, 95), 4),
    visualStepMax: fixed(Math.max(0, ...steps), 4),
    observedSpeedP50: fixed(percentile(speeds, 50), 3),
    observedSpeedP95: fixed(percentile(speeds, 95), 3),
    accelerationP95: fixed(percentile(acceleration, 95), 3),
    accelerationP99: fixed(percentile(acceleration, 99), 3),
    jerkP95: fixed(percentile(jerk, 95), 3),
    jerkP99: fixed(percentile(jerk, 99), 3),
  };
}

function summarize(name, result) {
  const samples = result.samples;
  const stats = samples.at(-1)?.remoteInterpolation ?? {};
  const bufferSizes = samples.map((sample) => sample.networkBufferSize ?? 0);
  const bodyDelta = samples.map((sample) => magnitude(sample.visualBodyDelta));
  const durationSeconds = Math.max(0.001, ((samples.at(-1)?.t ?? 0) - (samples[0]?.t ?? 0)) / 1000);
  return {
    name,
    sentSnapshots: result.sentSnapshots,
    droppedSnapshots: result.droppedSnapshots,
    sampleCount: samples.length,
    sampleRate: fixed(samples.length / durationSeconds, 2),
    targetSpeed: fixed(result.targetSpeed, 3),
    movement: movementMetrics(samples),
    visualBodyDeltaP95: fixed(percentile(bodyDelta, 95), 4),
    visualBodyDeltaMax: fixed(Math.max(0, ...bodyDelta), 4),
    interpolation: {
      delayMs: fixed(stats.delayMs, 2),
      extrapolations: stats.extrapolations ?? 0,
      bufferUnderruns: stats.bufferUnderruns ?? 0,
      extrapolationsPerSecondTotal: fixed((stats.extrapolations ?? 0) / durationSeconds, 3),
      bufferUnderrunsPerSecondTotal: fixed((stats.bufferUnderruns ?? 0) / durationSeconds, 3),
      observedBufferP50: fixed(percentile(bufferSizes, 50), 2),
      observedBufferP95: fixed(percentile(bufferSizes, 95), 2),
      maxBufferSize: stats.maxBufferSize ?? 0,
    },
  };
}

const server = spawn(process.execPath, ["server/game-server.mjs"], {
  stdio: ["ignore", "inherit", "inherit"],
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    WORKER_PORT_BASE: String(workerPortBase),
    WORKER_COUNT: "1",
    MAX_ROOMS: "1",
    MAX_ACTIVE_ROOMS: "1",
  },
});

let browser;
try {
  await waitForHealth();
  browser = await chromium.launch({
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: process.env.REMOTE_INTERP_HEADLESS !== "0",
    args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding"],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForFunction(() => Boolean(window.__arenaCarDebug?.startSyntheticNetworkRound), null, { timeout: 10000 });

  async function runScenario(options) {
    return page.evaluate(async ({ durationMs, warmupMs, maxForwardSpeed, options }) => {
      const debug = window.__arenaCarDebug;
      const { roundId, remoteKey } = debug.startSyntheticNetworkRound({ roundId: `interp-${options.name}` });
      const targetSpeed = options.speed ?? maxForwardSpeed;
      const snapshotHz = options.snapshotHz ?? 30;
      const periodMs = 1000 / snapshotHz;
      const amp = options.curveAmplitude ?? 7;
      const freq = options.curveFrequency ?? 1.05;
      const totalMs = durationMs + warmupMs;
      let sentSnapshots = 0;
      let droppedSnapshots = 0;

      function quantize(value, scale) {
        return Math.round((Number(value) || 0) * scale);
      }
      function qv(values, scale) {
        return values.map((value) => quantize(value, scale));
      }
      function snapshotAt(serverTime, seconds) {
        const x = amp * Math.sin(seconds * freq);
        const y = 2.1;
        const z = targetSpeed * seconds;
        const vx = amp * freq * Math.cos(seconds * freq);
        const vz = targetSpeed;
        return {
          type: "snapshot",
          roomCode: "DEBUG",
          roundId,
          serverTime,
          sampleTime: serverTime,
          remainingMs: 60000,
          compact: 2,
          cars: [[
            remoteKey,
            qv([x, y, z], 100),
            [0, 0, 0, 32767],
            qv([vx, 0, vz], 100),
            [0, 0, 0],
            0,
            0,
            0,
            0,
            0,
            [1000, 0, 0, 0],
            0,
            null,
            0,
          ]],
        };
      }

      const startPerf = performance.now();
      const serverBase = performance.now();
      const timers = [];
      for (let sample = 0; sample * periodMs <= totalMs + 250; sample += 1) {
        const shouldDrop = options.dropEvery && sample > 4 && sample % options.dropEvery === 0;
        if (shouldDrop) {
          droppedSnapshots += 1;
          continue;
        }
        const scheduledMs = sample * periodMs;
        const jitter = (options.jitterMs ?? 0) * Math.sin(sample * 12.9898) +
          (options.burstEvery && sample % options.burstEvery === 0 ? options.burstMs ?? 0 : 0);
        const deliveryMs = Math.max(0, scheduledMs + jitter);
        const serverTime = serverBase + scheduledMs;
        const seconds = scheduledMs / 1000;
        timers.push(setTimeout(() => {
          sentSnapshots += 1;
          debug.injectServerSnapshot(snapshotAt(serverTime, seconds));
        }, deliveryMs));
      }

      await new Promise((resolve) => setTimeout(resolve, warmupMs));
      const samples = [];
      await new Promise((resolve) => {
        const sampleStart = performance.now();
        function frame(now) {
          const state = debug.getState();
          const remote = state.cars.find((car) => car.networkControlled && car.name === "RemoteDriver");
          if (remote) {
            samples.push({
              t: now - sampleStart,
              visual: remote.visual.position,
              velocity: remote.velocity,
              visualBodyDelta: remote.visual.bodyDelta,
              networkBufferSize: remote.networkBufferSize,
              remoteInterpolation: state.multiplayer.remoteInterpolationStats,
            });
          }
          if (now - sampleStart < durationMs) requestAnimationFrame(frame);
          else resolve();
        }
        requestAnimationFrame(frame);
      });
      for (const timer of timers) clearTimeout(timer);
      return { samples, sentSnapshots, droppedSnapshots, targetSpeed, elapsedMs: performance.now() - startPerf };
    }, { durationMs, warmupMs, maxForwardSpeed, options });
  }

  const clean = await runScenario({ name: "clean", speed: maxForwardSpeed, snapshotHz: 30 });
  const jittery = await runScenario({
    name: "jitter-loss",
    speed: maxForwardSpeed,
    snapshotHz: 30,
    jitterMs: 28,
    burstEvery: 18,
    burstMs: 85,
    dropEvery: 23,
  });

  console.log(JSON.stringify({
    ok: true,
    url,
    scenarios: [
      summarize("clean", clean),
      summarize("jitter-loss", jittery),
    ],
  }, null, 2));
} finally {
  if (browser) await browser.close();
  server.kill("SIGTERM");
}
