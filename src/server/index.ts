import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { HOST, PORT } from "./config.ts";
import { openDb } from "./db.ts";
import { ensureToken } from "./auth.ts";
import { Registry } from "./registry.ts";
import { ReviewManager } from "./reviews.ts";
import { TaskManager } from "./tasks.ts";
import { startPoller } from "./discovery/poller.ts";
import { startNomistakesPoller } from "./nomistakes.ts";
import { buildApp } from "./routes.ts";

openDb();
ensureToken();
const registry = new Registry();
const reviews = new ReviewManager(registry);
const tasks = new TaskManager(registry);
const stopPoller = startPoller(registry);
const stopNomistakes = startNomistakesPoller(registry);

const app = buildApp(registry, reviews, tasks);

// In production the daemon serves the built SPA; in dev, Vite serves it and
// proxies /api + /events here, so the dist may be absent - that's fine.
const distDir = fileURLToPath(new URL("../../dist/web", import.meta.url));
const hasDist = existsSync(distDir);
if (hasDist) {
  app.use("/*", serveStatic({ root: "./dist/web" }));
  app.get("*", serveStatic({ path: "./dist/web/index.html" }));
}

const server = serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
  const where = hasDist
    ? `http://${HOST}:${info.port}`
    : `http://${HOST}:5173 (dev) - API on :${info.port}`;
  console.log(`[ai-harness] listening on ${where}`);
});

function shutdown(): void {
  stopPoller();
  stopNomistakes();
  server.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
