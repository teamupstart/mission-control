// F1: the real daemon, not a fake: the MCP server's tool list follows the flag through the
// daemon's actual /events stream, with the flag changed through the daemon's own gate.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { serve } from "@hono/node-server";

const home = mkdtempSync(join(tmpdir(), "mission-home-dispatch-live-"));
process.env.MISSION_HOME = home;
// The MCP child derives its daemon URL from MISSION_PORT, so reserve the port first.
const reservation = createServer();
await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const address = reservation.address();
assert.ok(address && typeof address !== "string");
const port = address.port;
await new Promise<void>((resolve, reject) => reservation.close((err) => err ? reject(err) : resolve()));
process.env.MISSION_PORT = String(port);
after(() => rmSync(home, { recursive: true, force: true }));

const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("./helpers/task-manager-fixture.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { ensureToken } = await import("../src/server/auth.ts");
const flags = await import("../src/server/feature-flags/index.ts");
const { closeDb } = await import("../src/server/db.ts");
const { HOME_DISPATCH_MCP_TOOLS } = await import("../src/shared/home-dispatch-tools.ts");
const { connectFakeFormsClient, eventually } = await import("./helpers/home-dispatch-fakes.ts");
after(() => closeDb());

test("F1 MCP real daemon: the tool list follows the flag over the daemon's own /events stream", async () => {
  flags.applyFeatureFlagIntent({ kind: "flag", id: "headless-mode", enabled: false });
  const registry = new Registry();
  // Daemon composition: one subscription carries every flag change to the open streams.
  const unsubscribe = flags.onFeatureFlagsChanged((config) => registry.emitFeatureFlags(config));
  const app = buildApp({ registry, reviews: new ReviewManager(registry), tasks: new TaskManager(registry), queues: new QueueManager(registry) });
  const server = serve({ hostname: "127.0.0.1", port, fetch: app.fetch });
  await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", resolve)));
  const hasAll = (list: string[]) => HOME_DISPATCH_MCP_TOOLS.every((n) => list.includes(n));
  const hasNone = (list: string[]) => HOME_DISPATCH_MCP_TOOLS.every((n) => !list.includes(n));
  let session: Awaited<ReturnType<typeof connectFakeFormsClient>> | undefined;
  try {
    // Connected inside the try, so a failed connect still closes the daemon below.
    session = await connectFakeFormsClient({ daemonPort: port, forms: true, home, env: { MISSION_API_TOKEN: ensureToken() } });
    const live = session;
    assert.ok(hasNone(await live.listTools()), "off at start");
    flags.applyFeatureFlagIntent({ kind: "flag", id: "headless-mode", enabled: true });
    await eventually(async () => (hasAll(await live.listTools()) ? true : false), 10_000);
    flags.applyFeatureFlagIntent({ kind: "flag", id: "headless-mode", enabled: false });
    await eventually(async () => (hasNone(await live.listTools()) ? true : false), 10_000);
  } finally {
    await session?.close();
    unsubscribe();
    (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
