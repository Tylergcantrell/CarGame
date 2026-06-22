import { startGameServer } from "./runtime.mjs";
import { startClusterRouter } from "./cluster-router.mjs";

if (process.env.CARTAG_WORKER === "1") {
  startGameServer();
} else {
  startClusterRouter();
}
