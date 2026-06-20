import http from "node:http";
import { spawn } from "node:child_process";

const port = Number(process.env.CHECK_STRESS_PORT ?? 8798);
const serverUrl = `ws://127.0.0.1:${port}`;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function health() {
  return new Promise((resolve) => {
    const request = http.get(`http://127.0.0.1:${port}/healthz`, (response) => {
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
  throw new Error("stress server did not become healthy");
}

function runStress() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/stress-multiplayer.mjs"], {
      stdio: "inherit",
      env: {
        ...process.env,
        STRESS_SERVER_URL: serverUrl,
        STRESS_ROOMS: process.env.STRESS_ROOMS ?? "8",
        STRESS_PLAYERS_PER_ROOM: process.env.STRESS_PLAYERS_PER_ROOM ?? "6",
        STRESS_DURATION_MS: process.env.STRESS_DURATION_MS ?? "12000",
        STRESS_INPUT_HZ: process.env.STRESS_INPUT_HZ ?? "30",
      },
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`stress test failed with exit code ${code}`));
    });
  });
}

const server = spawn(process.execPath, ["server/game-server.mjs"], {
  stdio: ["ignore", "inherit", "inherit"],
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
  },
});

try {
  await waitForHealth();
  await runStress();
  console.log(JSON.stringify({ ok: true, serverUrl }, null, 2));
} finally {
  server.kill("SIGTERM");
}
