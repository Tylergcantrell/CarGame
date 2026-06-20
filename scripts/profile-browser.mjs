import fs from "node:fs";
import { chromium } from "playwright-core";

const profileUrl = process.env.PROFILE_URL ?? "http://127.0.0.1:5183";
const outputPath = process.env.PROFILE_OUT ?? "profile-results-browser.json";

const browser = await chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  args: [
    "--use-angle=swiftshader",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
  ],
});

const page = await browser.newPage({
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
});

page.on("pageerror", (err) => console.error("PAGEERROR", err.stack || err.message));
await page.goto(profileUrl, { waitUntil: "load" });
await page.waitForFunction(() => !!window.__arenaCarDebug);

const scenarios = [
  { name: "orange-1", arena: "orange", playerCount: 1, durationMs: 12000 },
  { name: "orange-4", arena: "orange", playerCount: 4, durationMs: 12000 },
  { name: "orange-8", arena: "orange", playerCount: 8, durationMs: 12000 },
  { name: "blue-8", arena: "blue", playerCount: 8, durationMs: 12000 },
  { name: "purple-8", arena: "purple", playerCount: 8, durationMs: 12000 },
  { name: "green-8", arena: "green", playerCount: 8, durationMs: 12000 },
];

const results = [];
for (const scenario of scenarios) {
  await page.evaluate(({ arena, playerCount }) => {
    document.querySelector("#arena-select").value = arena;
    window.__arenaCarDebug.startRound({ roundTime: 60, playerCount });
    window.__arenaCarDebug.forcePlaying();
  }, scenario);
  await page.evaluate(() => window.__arenaCarDebug.resetDetailedPerf());

  await page.keyboard.down("KeyW");
  let steer = "KeyA";
  const startedAt = Date.now();
  while (Date.now() - startedAt < scenario.durationMs) {
    await page.keyboard.down(steer);
    await page.waitForTimeout(500);
    await page.keyboard.up(steer);
    if ((Date.now() - startedAt) % 3000 < 700) await page.keyboard.press("KeyQ");
    if ((Date.now() - startedAt) % 5000 < 700) await page.keyboard.press("Space");
    steer = steer === "KeyA" ? "KeyD" : "KeyA";
  }
  await page.keyboard.up("KeyW");
  await page.keyboard.up("KeyA").catch(() => {});
  await page.keyboard.up("KeyD").catch(() => {});

  results.push({
    scenario,
    perf: await page.evaluate(() => window.__arenaCarDebug.getPerf()),
    detailed: await page.evaluate(() => window.__arenaCarDebug.getDetailedPerf()),
  });
}

await browser.close();
fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));

const summary = results.map(({ scenario, detailed, perf }) => {
  const buckets = detailed.buckets;
  const samples = detailed.samples;
  const physicsRaycasts = detailed.raycasts.byPhase.physicsStep;
  return {
    name: scenario.name,
    steps: detailed.steps,
    cappedFrames: detailed.cappedFrames,
    fps: Number(perf.fps.toFixed(1)),
    bodies: perf.bodies,
    contacts: perf.contacts,
    stepP50: Number((samples.stepMs?.p50 ?? 0).toFixed(3)),
    stepP95: Number((samples.stepMs?.p95 ?? 0).toFixed(3)),
    stepP99: Number((samples.stepMs?.p99 ?? 0).toFixed(3)),
    physicsP95: Number((samples.physicsStepMs?.p95 ?? 0).toFixed(3)),
    physicsP99: Number((samples.physicsStepMs?.p99 ?? 0).toFixed(3)),
    physicsMsPerStep: Number((buckets.physicsStep?.msPerStep ?? 0).toFixed(3)),
    aiMsPerStep: Number((buckets.ai?.msPerStep ?? 0).toFixed(3)),
    contactsMsPerStep: Number((buckets.contacts?.msPerStep ?? 0).toFixed(3)),
    syncVisualsMsPerFrame: Number((buckets.syncVisuals?.avgMs ?? 0).toFixed(3)),
    renderMsPerFrame: Number((buckets.render?.avgMs ?? 0).toFixed(3)),
    raycastsPerStep: Number(detailed.raycasts.perStep.toFixed(2)),
    raycastMsPerStep: Number((detailed.raycasts.totalMs / Math.max(1, detailed.steps)).toFixed(3)),
    physicsRaycastsPerStep: Number((physicsRaycasts?.perStep ?? 0).toFixed(2)),
    physicsRaycastMsPerStep: Number(((physicsRaycasts?.totalMs ?? 0) / Math.max(1, detailed.steps)).toFixed(3)),
  };
});

console.table(summary);
console.log(`raw=${outputPath}`);
