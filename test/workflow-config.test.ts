import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoAllowlisted } from "../src/shared/allowlist.ts";
import { DEFAULT_WORKFLOW_CONFIG } from "../src/shared/workflow.ts";

const home = mkdtempSync(join(tmpdir(), "mission-workflow-config-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { getWorkflowConfig, setWorkflowConfig } = await import("../src/server/workflows/config.ts");
const { setAppConfig } = await import("../src/server/db.ts");
const { resolveRepoRoot } = await import("../src/server/repos.ts");

test("workflow live consent defaults off and parsed writes replace the allowlist", () => {
  assert.deepEqual(getWorkflowConfig(), DEFAULT_WORKFLOW_CONFIG);
  assert.deepEqual(
    setWorkflowConfig({ liveEnabled: true, repoAllowlist: ["/repo"] }),
    { ...DEFAULT_WORKFLOW_CONFIG, liveEnabled: true, repoAllowlist: ["/repo"] },
  );
  assert.deepEqual(
    setWorkflowConfig({ liveEnabled: false, repoAllowlist: [] }),
    DEFAULT_WORKFLOW_CONFIG,
  );
  assert.throws(() => setWorkflowConfig({ liveEnabled: true, repoAllowlist: [""] }));
});

test("workflow config HTTP writes use the shared parser and replace the complete object", async () => {
  const { Registry } = await import("../src/server/registry.ts");
  const { ReviewManager } = await import("../src/server/reviews.ts");
  const { TaskManager } = await import("../src/server/tasks.ts");
  const { QueueManager } = await import("../src/server/queue.ts");
  const { buildApp } = await import("../src/server/routes.ts");
  const registry = new Registry();
  const app = buildApp(
    registry,
    new ReviewManager(registry),
    new TaskManager(registry),
    new QueueManager(registry),
  );
  const invalid = await app.request("/api/workflows/config", {
    method: "PUT",
    headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
    body: JSON.stringify({ liveEnabled: "yes", repoAllowlist: [] }),
  });
  assert.equal(invalid.status, 400);
  const written = await app.request("/api/workflows/config", {
    method: "PUT",
    headers: { host: "127.0.0.1:7317", "content-type": "application/json" },
    body: JSON.stringify({ liveEnabled: true, repoAllowlist: ["/one", "/two"] }),
  });
  assert.equal(written.status, 200);
  assert.deepEqual(await written.json(), {
    ...DEFAULT_WORKFLOW_CONFIG,
    liveEnabled: true,
    repoAllowlist: ["/one", "/two"],
  });
  assert.deepEqual(
    await (await app.request("/api/workflows/config", {
      headers: { host: "127.0.0.1:7317" },
    })).json(),
    { ...DEFAULT_WORKFLOW_CONFIG, liveEnabled: true, repoAllowlist: ["/one", "/two"] },
  );
});

test("canonical repo roots allow linked worktree identity but reject path-prefix lookalikes", async () => {
  const repo = join(home, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  const canonical = await resolveRepoRoot(repo);
  const realRepo = realpathSync(repo);
  assert.equal(canonical, realRepo);
  assert.equal(repoAllowlisted(join(home, "worktree", "pkg"), canonical, [realRepo]), true);
  assert.equal(repoAllowlisted(`${realRepo}-unrelated`, `${realRepo}-unrelated`, [realRepo]), false);
  assert.equal(repoAllowlisted(join(realRepo, "pkg"), realRepo, [realRepo]), true);
});

test("removing consent leaves no live authorization", () => {
  const config = setWorkflowConfig({ liveEnabled: true, repoAllowlist: ["/repo"] });
  assert.equal(config.liveEnabled && repoAllowlisted("/repo/pkg", "/repo", config.repoAllowlist), true);
  const removed = setWorkflowConfig({ liveEnabled: true, repoAllowlist: [] });
  assert.equal(removed.liveEnabled && repoAllowlisted("/repo/pkg", "/repo", removed.repoAllowlist), false);
});

// ---- Check commands and their consent ----
//
// The read and the write ask DIFFERENT questions of the same shape, and this is where that
// split is held to account. `getWorkflowConfig` is on the path of every binding gate, every
// delivery decision, every check and the retention sweep, so a stored blob a newer build
// wrote must degrade rather than take all of them down. The PUT route is the opposite: a
// value that silently degraded there would revert in the panel with nothing saying why.

test("check consent defaults off with no commands, and survives a round trip", () => {
  assert.equal(getWorkflowConfig().checksEnabled, false);
  assert.deepEqual(getWorkflowConfig().checkCommands, []);

  const saved = setWorkflowConfig({
    liveEnabled: false,
    repoAllowlist: ["/repo"],
    checksEnabled: true,
    checkCommands: [{ repoRoot: "/repo", slot: "test", command: ["npm", "test"] }],
  });
  assert.equal(saved.checksEnabled, true);
  assert.deepEqual(saved.checkCommands, [{ repoRoot: "/repo", slot: "test", command: ["npm", "test"] }]);
  assert.deepEqual(getWorkflowConfig(), saved);

  setWorkflowConfig({ liveEnabled: false, repoAllowlist: [] });
  assert.deepEqual(getWorkflowConfig(), DEFAULT_WORKFLOW_CONFIG);
});

test("a config written before checks existed still reads, with both fields defaulted off", () => {
  // The upgrade path: `.default()` covers a blob that simply lacks the fields, and it must
  // land on the SAFE side rather than inheriting anything from the fields around it.
  setAppConfig("workflows", { liveEnabled: true, repoAllowlist: ["/repo"] });
  const read = getWorkflowConfig();
  assert.equal(read.liveEnabled, true);
  assert.equal(read.checksEnabled, false);
  assert.deepEqual(read.checkCommands, []);
  setWorkflowConfig({ liveEnabled: false, repoAllowlist: [] });
});

test("an unreadable stored config falls back to defaults rather than throwing", () => {
  // A downgrade, or a hand-edited row. Every field is exercised, not only the new ones:
  // before the tolerant read the whole subsystem threw on any of these.
  for (const blob of [
    { liveEnabled: "yes", repoAllowlist: [] },
    { liveEnabled: false, repoAllowlist: [""] },
    { liveEnabled: false, repoAllowlist: [], retention: { rawEvidenceDays: -1 } },
    { liveEnabled: false, repoAllowlist: [], checksEnabled: "sure" },
    { liveEnabled: false, repoAllowlist: [], checkCommands: [{ repoRoot: "/r", slot: "nope", command: ["x"] }] },
    { liveEnabled: false, repoAllowlist: [], checkCommands: [{ repoRoot: "/r", slot: "test", command: [] }] },
    { liveEnabled: false, repoAllowlist: [], checkCommands: [{ repoRoot: "/r", slot: "test", command: [""] }] },
    "not even an object",
    [1, 2, 3],
  ]) {
    setAppConfig("workflows", blob);
    // The whole default, not a field-by-field salvage: the two consent fields are what an
    // unreadable config would otherwise be trusted to grant, and off is the only safe way
    // to be wrong about them.
    assert.deepEqual(getWorkflowConfig(), DEFAULT_WORKFLOW_CONFIG, `${JSON.stringify(blob)} should degrade`);
  }
  setWorkflowConfig({ liveEnabled: false, repoAllowlist: [] });
});

test("the WRITE path still refuses what the read path tolerates", () => {
  // `.catch()` on a write turns a bad value from the panel into a silent no-op: the field
  // reverts on the next poll and nothing says why. A throw here is a 400 an operator reads.
  assert.throws(() => setWorkflowConfig({
    liveEnabled: false,
    repoAllowlist: [],
    checkCommands: [{ repoRoot: "/r", slot: "test", command: [] }],
  }));
  assert.throws(() => setWorkflowConfig({
    liveEnabled: false,
    repoAllowlist: [],
    checkCommands: [{ repoRoot: "", slot: "test", command: ["npm"] }],
  }));
  assert.throws(() => setWorkflowConfig({
    liveEnabled: false,
    repoAllowlist: [],
    // An argv nobody bounded is a durable blob nobody bounded.
    checkCommands: [{ repoRoot: "/r", slot: "test", command: Array.from({ length: 40 }, () => "x") }],
  }));
  assert.throws(() => setWorkflowConfig({
    liveEnabled: false,
    repoAllowlist: [],
    checkCommands: [{ repoRoot: "/r", slot: "test", command: ["npm", "x".repeat(5_000)] }],
  }));
});
