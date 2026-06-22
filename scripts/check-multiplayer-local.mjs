import http from "node:http";
import { spawn } from "node:child_process";

const port = Number(process.env.CHECK_PORT ?? 8797);
const workerPortBase = Number(process.env.CHECK_WORKER_PORT_BASE ?? 18797);
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
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await health()) return;
    await wait(150);
  }
  throw new Error("server did not become healthy");
}

function runSmoke() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/smoke-multiplayer.mjs"], {
      stdio: "inherit",
      env: {
        ...process.env,
        SMOKE_SERVER_URL: serverUrl,
      },
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`smoke test failed with exit code ${code}`));
    });
  });
}

const server = spawn(process.execPath, ["server/game-server.mjs"], {
  stdio: ["ignore", "inherit", "inherit"],
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    WORKER_PORT_BASE: String(workerPortBase),
  },
});

try {
  await waitForHealth();
  await runSmoke();
  console.log(JSON.stringify({ ok: true, serverUrl }, null, 2));
} finally {
  server.kill("SIGTERM");
}
