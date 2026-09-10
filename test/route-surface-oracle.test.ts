import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, URL } from "node:url";

/**
 * The whole route surface, checked against a committed oracle.
 *
 * `route-surface-inventory` proves the surface is order-independent, but a differential
 * cannot notice a regression that happens identically in both compositions. This binds every
 * registered route to a RECORDED expectation, so a route whose status or response VALUES
 * change fails here against a fixture written down in the repository.
 *
 * EVERY route asserts its values, with no shape-only exceptions:
 * `{"error":"keep-awake manager unavailable"}` is checked as written, not reduced to its
 * field names. Only genuinely unstable values are replaced,
 * each by a visible token - `<uuid>`, `<timestamp>`, `<path>`, `<epoch>`, and the per-process
 * or per-release keys named in VOLATILE_KEYS.
 *
 * Three host readings are pinned rather than recorded, because a fixture describing THIS
 * machine could not pass on another one, and one holding the operator's home directory has no
 * business in the repository: `MISSION_WORKSPACE_DIRS` fixes the repo index, `SETUP_PROBES`
 * fixes what the setup rows find installed, and `/events` streams forever so its read is
 * time-bounded and recorded as `stream`.
 *
 * Regenerate after an intentional route change:
 *   MISSION_UPDATE_ROUTE_SURFACE=1 node --test --import ./test/setup-state.mjs --import tsx \
 *     test/route-surface-oracle.test.ts
 *
 * HARNESS_HOME is set before importing anything that resolves it: `openDb` refuses the real
 * state dir under the test runner, and a hoisted import would defeat this preamble.
 */
const home = mkdtempSync(join(tmpdir(), "mission-route-oracle-"));
process.env.HARNESS_HOME = home;
// Pin the one host reading the daemon takes from the environment. Without this the repo
// index resolves `~/workspace` against the real home and reports the operator's checkouts,
// which differ per machine and must not be recorded in a committed fixture.
process.env.MISSION_WORKSPACE_DIRS = mkdtempSync(join(tmpdir(), "mission-route-oracle-repos-"));

const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { openDb } = await import("../src/server/db.ts");
const { stubRun } = await import("../src/server/util/exec.ts");

after(() => rmSync(home, { recursive: true, force: true }));

const LOOPBACK = { host: "127.0.0.1:7317" };
const ORACLE = fileURLToPath(new URL("./fixtures/route-surface.json", import.meta.url));



/** Values that differ per run or per host, replaced by a token so the rest can be asserted. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})/;
const ABSOLUTE_PATH = /^(~|\/)[^\s]*\//;
/** Keys whose value is inherently per-process or per-release. */
const VOLATILE_KEYS = new Set(["pid", "version", "generatedAt", "startedAt", "now"]);

function normalize(value: unknown): unknown {
  if (typeof value === "string") {
    if (UUID.test(value)) return "<uuid>";
    if (TIMESTAMP.test(value)) return "<timestamp>";
    if (ABSOLUTE_PATH.test(value)) return "<path>";
    return value;
  }
  // Epoch milliseconds. Below this a number is a count, a port or an index, all worth asserting.
  if (typeof value === "number") return value > 1_000_000_000_000 ? "<epoch>" : value;
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, inner]) => [key, VOLATILE_KEYS.has(key) ? `<${key}>` : normalize(inner)]),
    );
  }
  return value;
}


/** The asserted body: real values, with only the tokens above standing in. */
function content(text: string): string {
  if (text === "") return "empty";
  try {
    return JSON.stringify(normalize(JSON.parse(text)));
  } catch {
    // Not JSON. Markdown reports carry a rendered date, which TIMESTAMP catches inline.
    return JSON.stringify(text.replace(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/g, "<timestamp>"));
  }
}

/**
 * The recorded body content, or `stream` when the response never ends.
 *
 * `/events` and its kin hold the connection open by design, so reading them to completion
 * would hang the survey. Recording that as its own outcome keeps those routes IN the oracle -
 * a streaming route that started answering a normal body, or stopped streaming, would show up
 * as a change here rather than being quietly skipped.
 */
async function bodyContent(res: Response): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), 250);
  });
  const text = await Promise.race([res.text().catch(() => null), expired]);
  if (timer) clearTimeout(timer);
  if (text === null) {
    await res.body?.cancel().catch(() => undefined);
    return "stream";
  }
  return content(text);
}

/** `/api/tasks/:id` cannot be requested as written; give every parameter a value. */
function concrete(path: string): string {
  return path.replace(/:[A-Za-z0-9_]+\??/g, "x").replace(/\*/g, "x");
}

/** A machine that never changes, so setup rows record the route rather than the host. */
const SETUP_PROBES = {
  environment: {
    homeDir: home,
    readText: async () => ({ ok: false, missing: true, reason: "missing" }),
    subdirectories: async () => [],
  },
  agentBin: (agent: string) => `/fixture/${agent}`,
  installedBackend: async (id: string) => `/fixture/${id}`,
  herdrServer: async () => ({ state: "ready", socket: "/fixture/herdr.sock", version: "0.9.0" }),
  ghBin: () => "/fixture/gh",
  resolveBinPath: async (bin: string) => bin,
  runCommand: async () => stubRun({ stdout: "", stderr: "", code: 0 }),
  installedPlugins: async () => ({ ok: true, plugins: [], recordPath: "/fixture/record" }),
  skills: () => ({ enabled: false, readable: true, configured: 0, directories: [], problems: [] }),
  conductorProbe: async () => {
    throw new Error("not probed in the oracle");
  },
  terminalTargets: () => [],
  environmentChecks: async () => [],
  readBannerDismissal: () => ({ firstLaunchAcknowledged: false, acknowledged: [] }),
  writeBannerDismissal: () => undefined,
} as never;

async function surveyRouteSurface(): Promise<Record<string, string>> {
  openDb();
  // Real managers, not bare stubs. With `{}` in their place a third of the surface answers
  // 500 because a handler reached into the registry and threw, which records the fixture
  // rather than the route. These four construct against the temp home above and leave every
  // route answering something it actually chose to answer.
  const registry = new Registry();
  const app = buildApp({
    registry,
    reviews: new ReviewManager(registry),
    tasks: new TaskManager(registry),
    queues: new QueueManager(registry),
    // `/api/setup/checks` probes the host for installed agent binaries, so its answer is a
    // description of whoever ran it. This is the seam the route already exposes for exactly
    // that reason: a fixed machine, so the recorded values describe the ROUTE.
    setupDeps: SETUP_PROBES,
  });

  const keys = [
    ...new Set(
      app.routes.filter((route) => route.method !== "ALL").map((r) => `${r.method} ${r.path}`),
    ),
  ].sort();

  const surface: Record<string, string> = {};
  for (const key of keys) {
    const split = key.indexOf(" ");
    const method = key.slice(0, split);
    const res = await app.request(concrete(key.slice(split + 1)), { method, headers: LOOPBACK });
    surface[key] = `${res.status} ${await bodyContent(res)}`;
  }
  return surface;
}

test("every registered route answers the status and response values the oracle records", async () => {
  const surface = await surveyRouteSurface();

  if (process.env.MISSION_UPDATE_ROUTE_SURFACE === "1") {
    writeFileSync(ORACLE, `${JSON.stringify(surface, null, 2)}\n`);
    console.log(`regenerated the oracle with ${Object.keys(surface).length} routes`);
    return;
  }

  const expected = JSON.parse(readFileSync(ORACLE, "utf8")) as Record<string, string>;

  const added = Object.keys(surface).filter((key) => !(key in expected));
  const removed = Object.keys(expected).filter((key) => !(key in surface));
  assert.deepEqual(added, [], "routes registered but absent from the oracle");
  assert.deepEqual(removed, [], "routes in the oracle but no longer registered");

  const changed = Object.keys(expected)
    .filter((key) => surface[key] !== expected[key])
    .map((key) => `${key}: expected ${expected[key]}, got ${surface[key]}`);
  assert.deepEqual(changed, [], "routes whose status or response content changed");

  const statuses = new Map<string, number>();
  for (const value of Object.values(surface)) {
    const code = value.slice(0, value.indexOf(" "));
    statuses.set(code, (statuses.get(code) ?? 0) + 1);
  }
  const tally = [...statuses.entries()]
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([code, count]) => `${code}:${count}`)
    .join("  ");
  console.log(`${Object.keys(surface).length} routes matched the oracle   ${tally}`);
});
