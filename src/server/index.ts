import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { HOST, PORT } from "./config.ts";
import { openDb } from "./db.ts";
import { ensureToken } from "./auth.ts";
import { Registry } from "./registry.ts";
import { ReviewManager } from "./reviews.ts";
import { TaskManager } from "./tasks.ts";
import { QueueManager } from "./queue.ts";
import { startPoller } from "./discovery/poller.ts";
import { startNomistakesPoller } from "./nomistakes.ts";
import { startPoolReaper } from "./pool.ts";
import { startPrPoller } from "./pr.ts";
import { startRuntimeMetaPoller } from "./runtime-meta.ts";
import { buildApp } from "./routes.ts";
import { sweepUploads } from "./uploads.ts";

openDb();
ensureToken();
// Reclaim expired image drops now, while we know no send is mid-flight. An upload
// outlives its send on purpose (the agent reads the path on its own schedule), so
// a clock is the only thing that can retire one.
sweepUploads();
const registry = new Registry();
const reviews = new ReviewManager(registry);
const tasks = new TaskManager(registry);
const queues = new QueueManager(registry);
const stopPoller = startPoller(registry);
const stopNomistakes = startNomistakesPoller(registry);
const stopPrPoller = startPrPoller(registry);
const stopRuntimeMeta = startRuntimeMetaPoller(registry);
const stopPoolReaper = startPoolReaper(registry);

const app = buildApp(registry, reviews, tasks, queues);

// In production the daemon serves the built SPA; in dev, Vite serves it and
// proxies /api + /events here, so the dist may be absent - that's fine.
//
// Resolve the web root to an ABSOLUTE path so serving never depends on the
// daemon's working directory (it's unpredictable when spawned by the Electron
// app). `FLEET_WEB_DIR` lets the desktop shell point at the built UI inside the
// app bundle's Resources; otherwise fall back to this module's sibling dist/web,
// which covers both `tsx src/server/index.ts` (dev) and `node dist/server/index.mjs`.
const webDir =
  process.env.FLEET_WEB_DIR ?? fileURLToPath(new URL("../../dist/web", import.meta.url));
const hasDist = existsSync(webDir);
if (hasDist) {
  app.use("/*", serveStatic({ root: webDir }));
  app.get("*", serveStatic({ path: join(webDir, "index.html") }));
}

const server = serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
  const where = hasDist
    ? `http://${HOST}:${info.port}`
    : `http://${HOST}:5173 (dev) - API on :${info.port}`;
  console.log(`[fleet-control] listening on ${where}`);
});

function shutdown(): void {
  stopPoller();
  stopNomistakes();
  stopPrPoller();
  stopRuntimeMeta();
  stopPoolReaper();
  server.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
