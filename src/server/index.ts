// FIRST, and above every other local import: renames a state dir from an older name
// onto ~/.mission-control. ES modules evaluate imports in source order, so this runs
// before ./config.ts resolves STATE_DIR - move it down and the daemon would open its db
// under a path that is about to be renamed. See migrate-state.ts.
import "./migrate-state.ts";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { HOST, PORT } from "./config.ts";
import { openDb } from "./db.ts";
import { ensureToken } from "./auth.ts";
import { Registry } from "./registry.ts";
import { killLiveClaudeRuns } from "./claude-cli.ts";
import { ReviewManager } from "./reviews.ts";
import { TaskManager } from "./tasks.ts";
import { QueueManager } from "./queue.ts";
import { startPoller } from "./discovery/poller.ts";
import { startNomistakesPoller } from "./nomistakes.ts";
import { startPoolReaper } from "./pool.ts";
import { startPrPoller } from "./pr.ts";
import { startRuntimeMetaPoller } from "./runtime-meta.ts";
import { startGoalRefiner } from "./goal/refiner.ts";
import { startAwayWatcher } from "./away/watcher.ts";
import { startHeadlessPruner } from "./goal/prune.ts";
import { buildApp } from "./routes.ts";
import { warnIfSessionAttributionDisabled } from "./cost.ts";
import { reconcileSkills } from "./skills/config.ts";
import { startSkillsReloader } from "./skills/reload.ts";
import { sweepUploads } from "./uploads.ts";

openDb();
ensureToken();
// Reclaim expired image drops now, while we know no send is mid-flight. An upload
// outlives its send on purpose (the agent reads the path on its own schedule), so
// a clock is the only thing that can retire one.
sweepUploads();
// Heal any drift between the enabled skills and `~/.claude/skills` while nothing is
// mid-flight: a link deleted by hand, an app bundle that moved on disk, a DB restored
// onto a fresh machine. Idempotent, so the healthy case writes nothing and reloads
// nobody. Best-effort - it touches the operator's home directory, and a daemon that
// refused to start because of it would be worse than one running without a skill.
try {
  reconcileSkills();
} catch (err) {
  console.error("[skills] could not reconcile ~/.claude/skills:", err);
}
// Say it out loud at boot rather than letting someone find an empty ledger later: with
// OTEL_METRICS_INCLUDE_SESSION_ID false, Claude Code exports cost metrics that carry no
// session id at all, and the ingest can only drop them. The feature would look installed
// and record nothing.
warnIfSessionAttributionDisabled();
const registry = new Registry();
const reviews = new ReviewManager(registry);
const tasks = new TaskManager(registry);
const queues = new QueueManager(registry);
const stopPoller = startPoller(registry);
const stopNomistakes = startNomistakesPoller(registry);
const stopPrPoller = startPrPoller(registry);
const stopRuntimeMeta = startRuntimeMetaPoller(registry);
const stopGoalRefiner = startGoalRefiner(registry);
const away = startAwayWatcher(registry);
const stopHeadlessPruner = startHeadlessPruner();
const stopPoolReaper = startPoolReaper(registry);
const stopSkillsReloader = startSkillsReloader(registry);

const app = buildApp(registry, reviews, tasks, queues, away);

// In production the daemon serves the built SPA; in dev, Vite serves it and
// proxies /api + /events here, so the dist may be absent - that's fine.
//
// Resolve the web root to an ABSOLUTE path so serving never depends on the
// daemon's working directory (it's unpredictable when spawned by the Electron
// app). `MISSION_WEB_DIR` lets the desktop shell point at the built UI inside the
// app bundle's Resources; otherwise fall back to this module's sibling dist/web,
// which covers both `tsx src/server/index.ts` (dev) and `node dist/server/index.mjs`.
const webDir =
  process.env.MISSION_WEB_DIR ?? fileURLToPath(new URL("../../dist/web", import.meta.url));
const hasDist = existsSync(webDir);
if (hasDist) {
  app.use("/*", serveStatic({ root: webDir }));
  app.get("*", serveStatic({ path: join(webDir, "index.html") }));
}

const server = serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
  const where = hasDist
    ? `http://${HOST}:${info.port}`
    : `http://${HOST}:5173 (dev) - API on :${info.port}`;
  console.log(`[mission-control] listening on ${where}`);
});

function shutdown(): void {
  stopPoller();
  stopNomistakes();
  stopPrPoller();
  stopRuntimeMeta();
  stopGoalRefiner();
  away.stop();
  stopHeadlessPruner();
  // Stopping the refiner only stops it STARTING runs; one already in flight is a detached
  // process that outlives us and would go on burning tokens for a card nobody is watching.
  // `claude-cli.ts` hooks `process.exit` for the same reason, but this path calls it
  // explicitly rather than relying on that ordering.
  killLiveClaudeRuns();
  stopPoolReaper();
  stopSkillsReloader();
  server.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
