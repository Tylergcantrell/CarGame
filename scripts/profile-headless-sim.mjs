import fs from "node:fs";
import { chromium } from "playwright-core";

const profileUrl = process.env.PROFILE_URL ?? "http://127.0.0.1:5183";
const outputPath = process.env.PROFILE_OUT ?? "profile-results-headless-sim.json";
const steps = Number(process.env.PROFILE_STEPS ?? 3600);

const browser = await chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  args: ["--use-angle=swiftshader"],
});

const page = await browser.newPage({
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
});

page.on("pageerror", (err) => console.error("PAGEERROR", err.stack || err.message));
await page.goto(profileUrl, { waitUntil: "load" });
await page.waitForFunction(() => !!window.__arenaCarDebug);

const scenarios = [
  { name: "orange-1", arena: "orange", playerCount: 1 },
  { name: "orange-4", arena: "orange", playerCount: 4 },
  { name: "orange-8", arena: "orange", playerCount: 8 },
  { name: "blue-8", arena: "blue", playerCount: 8 },
  { name: "purple-8", arena: "purple", playerCount: 8 },
  { name: "green-8", arena: "green", playerCount: 8 },
];

const results = [];
for (const scenario of scenarios) {
  await page.evaluate(({ arena, playerCount }) => {
    document.querySelector("#arena-select").value = arena;
    window.__arenaCarDebug.startRound({ roundTime: 300, playerCount });
    window.__arenaCarDebug.forcePlaying();
  }, scenario);
  const bare = await page.evaluate((benchmarkSteps) => (
    window.__arenaCarDebug.runBareHeadlessBenchmark({ steps: benchmarkSteps, scriptedPlayer: true })
  ), steps);

  await page.evaluate(({ arena, playerCount }) => {
    document.querySelector("#arena-select").value = arena;
    window.__arenaCarDebug.startRound({ roundTime: 300, playerCount });
    window.__arenaCarDebug.forcePlaying();
  }, scenario);
  const result = await page.evaluate((benchmarkSteps) => (
    window.__arenaCarDebug.runHeadlessBenchmark({ steps: benchmarkSteps, scriptedPlayer: true })
  ), steps);

  results.push({
    scenario,
    bare,
    perf: await page.evaluate(() => window.__arenaCarDebug.getPerf()),
    ...result,
  });
}

await browser.close();
fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));

const summary = results.map(({ scenario, bare, profile, perf, wallMs, realtimeMultiplier }) => {
  const buckets = profile.buckets;
  const samples = profile.samples;
  const physicsRaycasts = profile.raycasts.byPhase.physicsStep;
  return {
    name: scenario.name,
    steps: profile.steps,
    bareWallMs: Number(bare.wallMs.toFixed(1)),
    bareRealtimeX: Number(bare.realtimeMultiplier.toFixed(1)),
    profiledWallMs: Number(wallMs.toFixed(1)),
    profiledRealtimeX: Number(realtimeMultiplier.toFixed(1)),
    bodies: perf.bodies,
    stepP50: Number((samples.stepMs?.p50 ?? 0).toFixed(3)),
    stepP95: Number((samples.stepMs?.p95 ?? 0).toFixed(3)),
    stepP99: Number((samples.stepMs?.p99 ?? 0).toFixed(3)),
    physicsP95: Number((samples.physicsStepMs?.p95 ?? 0).toFixed(3)),
    physicsP99: Number((samples.physicsStepMs?.p99 ?? 0).toFixed(3)),
    physicsMsPerStep: Number((buckets.physicsStep?.msPerStep ?? 0).toFixed(3)),
    aiMsPerStep: Number((buckets.ai?.msPerStep ?? 0).toFixed(3)),
    driveMsPerStep: Number((buckets.drive?.msPerStep ?? 0).toFixed(3)),
    contactsMsPerStep: Number((buckets.contacts?.msPerStep ?? 0).toFixed(3)),
    raycastsPerStep: Number(profile.raycasts.perStep.toFixed(2)),
    raycastMsPerStep: Number((profile.raycasts.totalMs / Math.max(1, profile.steps)).toFixed(3)),
    physicsRaycastsPerStep: Number((physicsRaycasts?.perStep ?? 0).toFixed(2)),
    physicsRaycastMsPerStep: Number(((physicsRaycasts?.totalMs ?? 0) / Math.max(1, profile.steps)).toFixed(3)),
  };
});

console.table(summary);
console.log(`raw=${outputPath}`);
