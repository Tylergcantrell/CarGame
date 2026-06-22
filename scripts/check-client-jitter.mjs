import http from "node:http";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";

const port = Number(process.env.JITTER_PORT ?? 8817);
const workerPortBase = Number(process.env.JITTER_WORKER_PORT_BASE ?? 21817);
const url = `http://127.0.0.1:${port}`;
const durationMs = Number(process.env.JITTER_DURATION_MS ?? 9000);
const warmupMs = Number(process.env.JITTER_WARMUP_MS ?? 4500);

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
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await health()) return;
    await wait(150);
  }
  throw new Error("jitter test server did not become healthy");
}

function magnitude(vector) {
  return Math.hypot(vector[0] ?? 0, vector[1] ?? 0, vector[2] ?? 0);
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
    if (!previous) {
      previous = { t: sample.t, position };
      continue;
    }
    const dt = Math.max(0.001, (sample.t - previous.t) / 1000);
    if (dt > 0.08) {
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
    const velocityMagnitude = magnitude(velocity);
    frameMs.push(dt * 1000);
    displacement.push(magnitude(delta));
    speed.push(velocityMagnitude);
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
    displacementP95: fixed(percentile(displacement, 95), 4),
    speedP95: fixed(percentile(speed, 95), 3),
    accelerationP95: fixed(percentile(acceleration, 95), 3),
    accelerationP99: fixed(percentile(acceleration, 99), 3),
    jerkP95: fixed(percentile(jerk, 95), 3),
    jerkP99: fixed(percentile(jerk, 99), 3),
  };
}

function deltaMetrics(samples) {
  const visualBodyDelta = samples.map((sample) => magnitude(sample.visualBodyDelta));
  const correction = samples.map((sample) => magnitude(sample.correction));
  const correctionActiveCount = samples.filter((sample) => sample.correctionActive).length;
  const correctionSpikes = correction.filter((value) => value > 0.05).length;
  return {
    visualBodyDeltaAvg: fixed(visualBodyDelta.reduce((sum, value) => sum + value, 0) / Math.max(1, visualBodyDelta.length), 5),
    visualBodyDeltaP95: fixed(percentile(visualBodyDelta, 95), 5),
    visualBodyDeltaMax: fixed(Math.max(0, ...visualBodyDelta), 5),
    correctionP95: fixed(percentile(correction, 95), 5),
    correctionMax: fixed(Math.max(0, ...correction), 5),
    correctionActivePct: fixed((correctionActiveCount / Math.max(1, samples.length)) * 100, 2),
    correctionSpikes,
  };
}

function summarize(samples, jitterStats = null) {
  const body = movementMetrics(samples, "body");
  const visual = movementMetrics(samples, "visual");
  const camera = movementMetrics(samples, "camera");
  const deltas = deltaMetrics(samples);
  const last = samples[samples.length - 1] ?? {};
  const inGameSampleRate = jitterStats?.durationMs > 0
    ? (jitterStats.sampleCount * 1000) / jitterStats.durationMs
    : 0;
  return {
    sampleCount: samples.length,
    durationMs: fixed((samples.at(-1)?.t ?? 0) - (samples[0]?.t ?? 0), 1),
    reliable: inGameSampleRate >= 30,
    inGameSampleRate: fixed(inGameSampleRate, 2),
    body,
    visual,
    camera,
    deltas,
    inGameJitter: jitterStats,
    prediction: last.prediction ?? null,
    remoteInterpolation: last.remoteInterpolation ?? null,
  };
}

async function createAndStartRound(host, guest) {
  await host.goto(url, { waitUntil: "networkidle" });
  await host.evaluate(() => document.querySelector("#mode-multiplayer")?.click());
  await host.fill("#multiplayer-name", "JitterHost");
  await host.evaluate(() => document.querySelector("#create-room-open")?.click());
  await host.evaluate(() => document.querySelector("#create-room")?.click());
  await host.waitForFunction(() => document.querySelector("#room-summary")?.textContent?.includes("Room"), null, { timeout: 10000 });
  const code = await host.evaluate(() => window.__arenaCarDebug.getState().multiplayer.roomCode);

  await guest.goto(url, { waitUntil: "networkidle" });
  await guest.evaluate(() => document.querySelector("#mode-multiplayer")?.click());
  await guest.fill("#multiplayer-name", "JitterGuest");
  await guest.evaluate(() => document.querySelector("#refresh-rooms")?.click());
  const row = guest.locator(".room-row").filter({ hasText: code }).first();
  await row.waitFor({ timeout: 10000 });
  await row.locator("button").click({ force: true });
  await guest.waitForFunction(() => document.querySelector("#room-summary")?.textContent?.includes("Room"), null, { timeout: 10000 });
  await host.waitForFunction(() => document.querySelector("#lobby-list")?.textContent?.includes("JitterGuest"), null, { timeout: 10000 });
  await host.waitForFunction(() => {
    const button = document.querySelector("#start-round");
    return button && !button.classList.contains("hidden") && !button.disabled;
  }, null, { timeout: 10000 });

  await host.evaluate(() => document.querySelector("#start-round")?.click());
  await host.waitForFunction(() => Boolean(window.__arenaCarDebug?.getState().multiplayer.activeRoundId), null, { timeout: 10000 });
  if (process.env.JITTER_FORCE_PLAYING === "1") {
    await host.evaluate(() => window.__arenaCarDebug.forcePlaying());
  }
  try {
    await host.waitForFunction(() => window.__arenaCarDebug?.getState().phase === "playing", null, { timeout: 15000 });
  } catch (error) {
    const diagnostics = await host.evaluate(() => ({
      phase: window.__arenaCarDebug?.getState().phase,
      multiplayer: window.__arenaCarDebug?.getState().multiplayer,
      roundTime: window.__arenaCarDebug?.getState().roundTime,
      countdown: document.querySelector("#countdown")?.textContent,
      lobby: document.querySelector("#lobby-status")?.textContent,
      startText: document.querySelector("#start-round")?.textContent,
      summary: document.querySelector("#room-summary")?.textContent,
    }));
    if (diagnostics.phase === "playing") return { code };
    if (diagnostics.phase === "countdown" && diagnostics.multiplayer?.activeRoundId && diagnostics.roundTime < 119) {
      await host.evaluate(() => window.__arenaCarDebug.forcePlaying());
      await host.waitForFunction(() => window.__arenaCarDebug?.getState().phase === "playing", null, { timeout: 5000 });
      return { code };
    }
    throw new Error(`round did not reach playing: ${JSON.stringify(diagnostics)}`);
  }
  return { code };
}

async function sampleLocalPlayer(page) {
  await page.bringToFront();
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
        correction: state.visualCorrection.position,
        correctionActive: state.visualCorrection.active,
        camera: state.camera.position,
        speed: state.speed,
        prediction: state.multiplayer.predictionStats,
        remoteInterpolation: state.multiplayer.remoteInterpolationStats,
      });
      if (now - startedAt < sampleDurationMs) requestAnimationFrame(frame);
      else resolve(samples);
    }
    requestAnimationFrame(frame);
  }), durationMs);

  await page.keyboard.down("KeyW");
  await page.waitForTimeout(Math.floor(durationMs * 0.35));
  await page.keyboard.down("KeyD");
  await page.waitForTimeout(Math.floor(durationMs * 0.2));
  await page.keyboard.up("KeyD");
  await page.keyboard.down("KeyA");
  await page.waitForTimeout(Math.floor(durationMs * 0.2));
  await page.keyboard.up("KeyA");
  await page.waitForTimeout(Math.floor(durationMs * 0.25));
  await page.keyboard.up("KeyW");
  const samples = await sampling;
  const jitterStats = await page.evaluate(() => window.__arenaCarDebug.getJitterStats());
  await page.evaluate(() => window.__arenaCarDebug.stopJitterStats());
  return { samples, jitterStats };
}

const server = spawn(process.execPath, ["server/game-server.mjs"], {
  stdio: ["ignore", "inherit", "inherit"],
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    WORKER_PORT_BASE: String(workerPortBase),
    WORKER_COUNT: process.env.JITTER_WORKER_COUNT ?? "2",
    MAX_ROOMS: process.env.JITTER_MAX_ROOMS ?? "2",
    MAX_ACTIVE_ROOMS: process.env.JITTER_MAX_ACTIVE_ROOMS ?? "2",
  },
});

let browser;
try {
  await waitForHealth();
  browser = await chromium.launch({
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: process.env.JITTER_HEADLESS !== "0",
    args: [
      "--use-angle=swiftshader",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
    ],
  });

  const hostContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const guestContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();
  await createAndStartRound(host, guest);
  const { samples, jitterStats } = await sampleLocalPlayer(host);
  const summary = summarize(samples, jitterStats);
  console.log(JSON.stringify({ ok: true, url, ...summary }, null, 2));
} finally {
  if (browser) await browser.close();
  server.kill("SIGTERM");
}
