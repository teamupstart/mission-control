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
 * registered route to a RECORDED expectation instead, so a route whose status or response
 * shape changes fails here against a fixture written down in the repository.
 *
 * The oracle stores a status and a body SHAPE - the sorted top-level keys of a JSON object,
 * or `array`, `text`, `empty` - rather than exact bytes. Ids, clock readings and file paths
 * vary between runs and machines; the shape does not, and a handler that starts returning a
 * different set of fields is what a reviewer needs to see.
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

const { Registry } = await import("../src/server/registry.ts");
const { ReviewManager } = await import("../src/server/reviews.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { QueueManager } = await import("../src/server/queue.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { openDb } = await import("../src/server/db.ts");

after(() => rmSync(home, { recursive: true, force: true }));

const LOOPBACK = { host: "127.0.0.1:7317" };
const ORACLE = fileURLToPath(new URL("./fixtures/route-surface.json", import.meta.url));

/**
 * Routes whose body is a reading of THIS MACHINE rather than of the code.
 *
 * They enumerate the operator's checkouts, probe for installed binaries, or resolve real
 * home-relative paths, so their values differ between a laptop and a CI runner and would
 * make the oracle a record of where it was generated. Two reasons to reduce these to a
 * shape: an oracle that cannot pass on another machine is worthless, and a fixture holding
 * `/Users/<someone>/workspace` is operator data this repository must not carry.
 *
 * Every OTHER route asserts its values. Keep this list short, and justify additions.
 */
const MACHINE_DEPENDENT = new Set([
  "GET /api/repo-index", // enumerates the operator's real checkout directories
  "PUT /api/repo-index", // same projection, returned after a write
  "POST /api/repo-index/rescan", // same projection, returned after a rescan
  "GET /api/setup/checks", // probes the host for installed agent binaries and versions
  "PUT /api/pipelines/config", // carries provider probes that look for local installs
]);

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

/** Only the top-level field names, for the machine-dependent routes above. */
function shape(text: string): string {
  if (text === "") return "empty";
  try {
    const value: unknown = JSON.parse(text);
    if (Array.isArray(value)) return "array";
    if (value && typeof value === "object") {
      return `object{${Object.keys(value).sort().join(",")}}`;
    }
    return "scalar";
  } catch {
    return "text";
  }
}

/** The asserted body: real values, with only the tokens above standing in. */
function content(key: string, text: string): string {
  if (MACHINE_DEPENDENT.has(key)) return `shape ${shape(text)}`;
  if (text === "") return "empty";
  try {
    return JSON.stringify(normalize(JSON.parse(text)));
  } catch {
    // Not JSON. Markdown reports carry a rendered date, which TIMESTAMP catches inline.
    return JSON.stringify(text.replace(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/g, "<timestamp>"));
  }
}

/**
 * A body's shape, or `stream` when the response never ends.
 *
 * `/events` and its kin hold the connection open by design, so reading them to completion
 * would hang the survey. Recording that as its own outcome keeps those routes IN the oracle -
 * a streaming route that started answering a normal body, or stopped streaming, would show up
 * as a change here rather than being quietly skipped.
 */
async function bodyShape(key: string, res: Response): Promise<string> {
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
  return content(key, text);
}

/** `/api/tasks/:id` cannot be requested as written; give every parameter a value. */
function concrete(path: string): string {
  return path.replace(/:[A-Za-z0-9_]+\??/g, "x").replace(/\*/g, "x");
}

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
    surface[key] = `${res.status} ${await bodyShape(key, res)}`;
  }
  return surface;
}

test("every registered route answers the status and body shape the oracle records", async () => {
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
  assert.deepEqual(changed, [], "routes whose status or body shape changed");

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
