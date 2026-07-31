import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoAllowlisted } from "../src/shared/allowlist.ts";
import { NO_MISTAKES_REVIEW_WORKFLOW_ID } from "../src/shared/builtin-workflow.ts";
import { DEFAULT_WORKFLOW_CONFIG } from "../src/shared/workflow.ts";

const home = mkdtempSync(join(tmpdir(), "mission-workflow-config-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { getWorkflowConfig, setWorkflowConfig } = await import("../src/server/workflows/config.ts");
const { setAppConfig } = await import("../src/server/db.ts");
const { resolveRepoRoot } = await import("../src/server/repos.ts");

test("workflow live consent defaults ON with an empty allowlist, which authorises nothing", () => {
  assert.equal(DEFAULT_WORKFLOW_CONFIG.defaultWorkflowId, NO_MISTAKES_REVIEW_WORKFLOW_ID);
  assert.deepEqual(getWorkflowConfig(), DEFAULT_WORKFLOW_CONFIG);

  // The pair that makes the flipped default safe, asserted together rather than separately:
  // delivery is authorised machine-wide AND there is no repository it is authorised in. A
  // future change that seeded the allowlist would pass either assertion alone.
  assert.equal(DEFAULT_WORKFLOW_CONFIG.liveEnabled, true);
  assert.deepEqual(DEFAULT_WORKFLOW_CONFIG.repoAllowlist, []);
  assert.equal(repoAllowlisted("/repo", "/repo", DEFAULT_WORKFLOW_CONFIG.repoAllowlist), false);

  assert.deepEqual(
    setWorkflowConfig({ liveEnabled: true, repoAllowlist: ["/repo"] }),
    { ...DEFAULT_WORKFLOW_CONFIG, repoAllowlist: ["/repo"] },
  );
  assert.deepEqual(
    setWorkflowConfig({ liveEnabled: false, repoAllowlist: [] }),
    { ...DEFAULT_WORKFLOW_CONFIG, liveEnabled: false },
  );
  assert.throws(() => setWorkflowConfig({ liveEnabled: true, repoAllowlist: [""] }));
  setWorkflowConfig({ liveEnabled: true, repoAllowlist: [] });
});

test("an operator who explicitly turned live delivery off keeps it off across the flip", () => {
  // The upgrade case the default flip turns on. `liveEnabled` is a `.default()` over an
  // `app_config` blob, so it is only consulted when the key is ABSENT. A stored `false` is an
  // answered question and must survive, or the flip silently re-authorises terminal writes for
  // the one operator who said no.
  setAppConfig("workflows", { liveEnabled: false, repoAllowlist: ["/repo"] });
  assert.equal(getWorkflowConfig().liveEnabled, false);

  // And the never-opened case, which is the flip's whole point: no key at all reads as ON.
  setAppConfig("workflows", { repoAllowlist: ["/repo"] });
  assert.equal(getWorkflowConfig().liveEnabled, true);
  setWorkflowConfig({ liveEnabled: true, repoAllowlist: [] });
});

test("the dispatch Workflow default is durable and explicit none clears it", () => {
  const selected = setWorkflowConfig({
    liveEnabled: false,
    repoAllowlist: [],
    defaultWorkflowId: "workflow-review",
  });
  assert.equal(selected.defaultWorkflowId, "workflow-review");
  assert.equal(getWorkflowConfig().defaultWorkflowId, "workflow-review");
  const cleared = setWorkflowConfig({
    liveEnabled: false,
    repoAllowlist: [],
    defaultWorkflowId: null,
  });
  assert.equal(cleared.defaultWorkflowId, null);
});

test("task creation owns Workflow inheritance and preserves explicit opt-outs", async () => {
  const { Registry } = await import("../src/server/registry.ts");
  const { TaskManager } = await import("../src/server/tasks.ts");
  const tasks = new TaskManager(new Registry());
  setWorkflowConfig({
    liveEnabled: false,
    repoAllowlist: [],
    defaultWorkflowId: "workflow-review",
  });
  const input = {
    repoRoot: "/repo",
    intent: "Review this task",
    title: "Review task",
    kind: "ship" as const,
    agent: "claude" as const,
    backlog: true,
  };

  assert.equal(tasks.create(input).workflowId, "workflow-review");
  assert.equal(tasks.create({ ...input, workflowId: null }).workflowId, null);
  const scheduledOptions = {
    id: "scheduled-workflow-default",
    schedule: {
      scheduleId: "schedule",
      scheduleOccurrenceId: "occurrence",
      scheduledFor: 1,
    },
  };
  assert.equal(tasks.create(input, scheduledOptions).workflowId, "workflow-review");
  setWorkflowConfig({
    liveEnabled: false,
    repoAllowlist: [],
    defaultWorkflowId: null,
  });
  assert.equal(
    tasks.create(input, scheduledOptions).workflowId,
    "workflow-review",
    "an occurrence retry keeps the Workflow inherited when its task was first filed",
  );
  assert.equal(
    tasks.create(
      { ...input, workflowId: null },
      { id: "ensemble-workflow-opt-out" },
    ).workflowId,
    null,
  );
});

test("workflow config HTTP writes use the shared parser and replace the complete object", async () => {
  const { Registry } = await import("../src/server/registry.ts");
  const { ReviewManager } = await import("../src/server/reviews.ts");
  const { TaskManager } = await import("../src/server/tasks.ts");
  const { QueueManager } = await import("../src/server/queue.ts");
  const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
  const { buildApp } = await import("../src/server/routes.ts");
  const registry = new Registry();
  const workflows = new WorkflowManager(registry);
  const app = buildApp(
    registry,
    new ReviewManager(registry),
    new TaskManager(registry),
    new QueueManager(registry),
    undefined,
    undefined,
    workflows,
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

  setWorkflowConfig({ liveEnabled: true, repoAllowlist: [] });
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
    // The whole default, not a field-by-field salvage. What makes that safe is the ALLOWLIST
    // coming back empty, not the consent boolean coming back off - `liveEnabled` now defaults
    // on, and an argument resting on the boolean would already be wrong. A field-by-field
    // salvage is the dangerous one: it could keep a parsed allowlist beside a defaulted flag.
    const degraded = getWorkflowConfig();
    assert.deepEqual(degraded, DEFAULT_WORKFLOW_CONFIG, `${JSON.stringify(blob)} should degrade`);
    assert.equal(
      repoAllowlisted("/repo", "/repo", degraded.repoAllowlist),
      false,
      `${JSON.stringify(blob)} must authorise no repository after degrading`,
    );
  }
  setWorkflowConfig({ liveEnabled: true, repoAllowlist: [] });
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
