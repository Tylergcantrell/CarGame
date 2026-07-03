import http from "node:http";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

const port = Number(process.env.SOLO_JITTER_PORT ?? 8823);
const workerPortBase = Number(process.env.SOLO_JITTER_WORKER_PORT_BASE ?? 23021);
const url = `http://127.0.0.1:${port}`;
const durationMs = Number(process.env.SOLO_JITTER_DURATION_MS ?? 9000);
const warmupMs = Number(process.env.SOLO_JITTER_WARMUP_MS ?? 1800);

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
  throw new Error("solo jitter test server did not become healthy");
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
      const accel = velocity.map((value, index) => (value - previousVelocity[index]) / dt);
      acceleration.push(magnitude(accel));
      if (previousAcceleration) {
        jerk.push(magnitude(accel.map((value, index) => (value - previousAcceleration[index]) / dt)));
      }
      previousAcceleration = accel;
    }
    previousVelocity = velocity;
    previous = { t: sample.t, position };
  }

  return {
    frameP95Ms: fixed(percentile(frameMs, 95), 2),
    displacementP95: fixed(percentile(displacement, 95), 4),
    displacementMax: fixed(Math.max(0, ...displacement), 4),
    speedP95: fixed(percentile(speed, 95), 3),
    accelerationP95: fixed(percentile(acceleration, 95), 3),
    accelerationP99: fixed(percentile(acceleration, 99), 3),
    jerkP95: fixed(percentile(jerk, 95), 3),
    jerkP99: fixed(percentile(jerk, 99), 3),
  };
}

function summarize(samples, jitterStats) {
  const visualBodyDelta = samples.map((sample) => magnitude(sample.visualBodyDelta));
  const carsById = new Map();
  for (const sample of samples) {
    for (const car of sample.cars ?? []) {
      let entries = carsById.get(car.id);
      if (!entries) {
        entries = [];
        carsById.set(car.id, entries);
      }
      entries.push({
        t: sample.t,
        visual: car.visual.position,
        body: car.position,
      });
    }
  }
  const cars = [...carsById.entries()].map(([id, entries]) => ({
    id,
    visual: movementMetrics(entries, "visual"),
    body: movementMetrics(entries, "body"),
  }));
  return {
    sampleCount: samples.length,
    durationMs: fixed((samples.at(-1)?.t ?? 0) - (samples[0]?.t ?? 0), 1),
    body: movementMetrics(samples, "body"),
    visual: movementMetrics(samples, "visual"),
    camera: movementMetrics(samples, "camera"),
    deltas: {
      visualBodyDeltaP95: fixed(percentile(visualBodyDelta, 95), 5),
      visualBodyDeltaMax: fixed(Math.max(0, ...visualBodyDelta), 5),
    },
    cars,
    inGameJitter: jitterStats,
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
    headless: process.env.SOLO_JITTER_HEADLESS !== "0",
    args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding"],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForFunction(() => Boolean(window.__arenaCarDebug?.startRound), null, { timeout: 10000 });
  await page.evaluate(() => {
    document.querySelector("#mode-solo")?.click();
    window.__arenaCarDebug.startRound({ roundTime: 60, playerCount: 4, arena: "orange" });
    window.__arenaCarDebug.forcePlaying();
  });
  await page.waitForFunction(() => window.__arenaCarDebug?.getState().phase === "playing", null, { timeout: 10000 });
  await page.locator("#game").click({ force: true });
  await page.waitForTimeout(warmupMs);
  await page.evaluate(() => window.__arenaCarDebug.resetJitterStats());

  const sampling = page.evaluate((sampleDurationMs) => new Promise((resolve) => {
    const samples = [];
    const startedAt = performance.now();
    function frame(now) {
      const state = window.__arenaCarDebug.getState();
      samples.push({
        t: now - startedAt,
        body: state.position,
        visual: state.visual.position,
        visualBodyDelta: state.visual.bodyDelta,
        camera: state.camera.position,
        speed: state.speed,
        cars: state.cars.map((car) => ({
          id: car.id,
          position: car.position,
          visual: car.visual,
        })),
      });
      if (now - startedAt < sampleDurationMs) requestAnimationFrame(frame);
      else resolve(samples);
    }
    requestAnimationFrame(frame);
  }), durationMs);

  await page.keyboard.down("KeyW");
  await page.waitForTimeout(Math.floor(durationMs * 0.34));
  await page.keyboard.down("Shift");
  await page.waitForTimeout(Math.floor(durationMs * 0.1));
  await page.keyboard.up("Shift");
  await page.keyboard.down("KeyD");
  await page.waitForTimeout(Math.floor(durationMs * 0.18));
  await page.keyboard.up("KeyD");
  await page.keyboard.down("KeyA");
  await page.waitForTimeout(Math.floor(durationMs * 0.18));
  await page.keyboard.up("KeyA");
  await page.waitForTimeout(Math.floor(durationMs * 0.2));
  await page.keyboard.up("KeyW");

  const samples = await sampling;
  const jitterStats = await page.evaluate(() => window.__arenaCarDebug.getJitterStats());
  await page.evaluate(() => window.__arenaCarDebug.stopJitterStats());
  console.log(JSON.stringify({ ok: true, url, ...summarize(samples, jitterStats) }, null, 2));
} finally {
  if (browser) await browser.close();
  server.kill("SIGTERM");
}
