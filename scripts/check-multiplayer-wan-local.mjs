import http from "node:http";
import { spawn } from "node:child_process";
import WebSocket, { WebSocketServer } from "ws";

const serverPort = Number(process.env.CHECK_WAN_SERVER_PORT ?? 8808);
const proxyPort = Number(process.env.CHECK_WAN_PROXY_PORT ?? 8809);
const targetHttpUrl = `http://127.0.0.1:${serverPort}`;
const targetWsUrl = `ws://127.0.0.1:${serverPort}`;
const proxyServerUrl = `ws://127.0.0.1:${proxyPort}`;
const latencyMs = Number(process.env.WAN_LATENCY_MS ?? 80);
const jitterMs = Number(process.env.WAN_JITTER_MS ?? 35);
const lossRate = Number(process.env.WAN_LOSS_RATE ?? 0);

const proxyStats = {
  clientToServerFrames: 0,
  serverToClientFrames: 0,
  droppedClientToServer: 0,
  droppedServerToClient: 0,
  closedSockets: 0,
};

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function delayForFrame() {
  const jitter = (Math.random() * 2 - 1) * jitterMs;
  return Math.max(0, latencyMs + jitter);
}

function shouldDrop() {
  return Math.random() < lossRate;
}

function health(port) {
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

async function waitForHealth(port, label) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await health(port)) return;
    await wait(150);
  }
  throw new Error(`${label} did not become healthy`);
}

function proxyHttpRequest(request, response) {
  const upstream = http.request(`${targetHttpUrl}${request.url}`, {
    method: request.method,
    headers: {
      ...request.headers,
      host: `127.0.0.1:${serverPort}`,
    },
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on("error", () => {
    response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    response.end("WAN proxy upstream unavailable\n");
  });
  request.pipe(upstream);
}

function makeImpairedSender(target, direction) {
  let nextSendAt = performance.now();
  return (data, isBinary) => {
    if (shouldDrop()) {
      if (direction === "clientToServer") proxyStats.droppedClientToServer += 1;
      else proxyStats.droppedServerToClient += 1;
      return;
    }
    if (direction === "clientToServer") proxyStats.clientToServerFrames += 1;
    else proxyStats.serverToClientFrames += 1;
    const now = performance.now();
    nextSendAt = Math.max(nextSendAt + 0.1, now + delayForFrame());
    setTimeout(() => {
      if (target.readyState === WebSocket.OPEN) target.send(data, { binary: isBinary });
    }, Math.max(0, nextSendAt - now));
  };
}

function forwardWithImpairment({ source, send }) {
  source.on("message", (data, isBinary) => {
    send(data, isBinary);
  });
}

function closePair(a, b) {
  proxyStats.closedSockets += 1;
  if (a.readyState === WebSocket.OPEN || a.readyState === WebSocket.CONNECTING) a.close();
  if (b.readyState === WebSocket.OPEN || b.readyState === WebSocket.CONNECTING) b.close();
}

function createWanProxy() {
  const proxy = http.createServer(proxyHttpRequest);
  const wss = new WebSocketServer({ noServer: true });

  proxy.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (clientSocket) => {
      const upstreamSocket = new WebSocket(`${targetWsUrl}${request.url ?? ""}`);
      const pendingClientMessages = [];
      let upstreamOpen = false;
      const sendToClient = makeImpairedSender(clientSocket, "serverToClient");
      const sendToServer = makeImpairedSender(upstreamSocket, "clientToServer");
      clientSocket.on("message", (data, isBinary) => {
        if (!upstreamOpen) {
          pendingClientMessages.push({ data, isBinary });
          return;
        }
        sendToServer(data, isBinary);
      });
      upstreamSocket.on("open", () => {
        upstreamOpen = true;
        for (const message of pendingClientMessages.splice(0)) {
          sendToServer(message.data, message.isBinary);
        }
        forwardWithImpairment({ source: upstreamSocket, send: sendToClient });
      });
      upstreamSocket.on("error", () => closePair(clientSocket, upstreamSocket));
      clientSocket.on("error", () => closePair(clientSocket, upstreamSocket));
      upstreamSocket.on("close", () => closePair(clientSocket, upstreamSocket));
      clientSocket.on("close", () => closePair(clientSocket, upstreamSocket));
    });
  });

  return new Promise((resolve) => {
    proxy.listen(proxyPort, "127.0.0.1", () => resolve(proxy));
  });
}

function runStress() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/stress-multiplayer.mjs"], {
      stdio: "inherit",
      env: {
        ...process.env,
        STRESS_SERVER_URL: proxyServerUrl,
        STRESS_ROOMS: process.env.STRESS_ROOMS ?? "4",
        STRESS_PLAYERS_PER_ROOM: process.env.STRESS_PLAYERS_PER_ROOM ?? "4",
        STRESS_DURATION_MS: process.env.STRESS_DURATION_MS ?? "12000",
        STRESS_INPUT_HZ: process.env.STRESS_INPUT_HZ ?? "30",
        STRESS_MIN_SNAPSHOT_HZ: process.env.STRESS_MIN_SNAPSHOT_HZ ?? "8",
        STRESS_ACK_GRACE_SEQUENCES: process.env.STRESS_ACK_GRACE_SEQUENCES ?? "120",
        STRESS_CONNECT_TIMEOUT_MS: process.env.STRESS_CONNECT_TIMEOUT_MS ?? "30000",
      },
    });
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`WAN stress test failed with exit code ${code}`));
    });
  });
}

const server = spawn(process.execPath, ["server/game-server.mjs"], {
  stdio: ["ignore", "inherit", "inherit"],
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(serverPort),
  },
});

let proxy = null;
try {
  await waitForHealth(serverPort, "WAN target server");
  proxy = await createWanProxy();
  await waitForHealth(proxyPort, "WAN proxy");
  await runStress();
  console.log(JSON.stringify({
    ok: true,
    targetServerUrl: targetWsUrl,
    proxyServerUrl,
    impairment: { latencyMs, jitterMs, lossRate },
    proxyStats,
  }, null, 2));
} finally {
  if (proxy) {
    await new Promise((resolve) => proxy.close(resolve));
  }
  server.kill("SIGTERM");
}
