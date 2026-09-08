import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoAllowlisted } from "../src/shared/allowlist.ts";
import { NO_MISTAKES_REVIEW_WORKFLOW_ID } from "../src/shared/builtin-workflow.ts";
import { DEFAULT_WORKFLOW_CONFIG, DEFAULT_WORKFLOW_POLICY } from "../src/shared/workflow.ts";
import { WorkflowConfigSchema } from "../src/shared/protocol.ts";
import { APP_CONFIG_ENTRIES } from "../src/shared/app-config-entries.ts";

const home = mkdtempSync(join(tmpdir(), "mission-workflow-config-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { getWorkflowPolicy, legacyCheckCommandsToImport, setWorkflowPolicy } =
  await import("../src/server/workflows/config.ts");
const { getAppConfig, setAppConfig } = await import("../src/server/db.ts");
const { resolveRepoRoot } = await import("../src/server/repos.ts");

test("workflow live consent defaults ON with an empty allowlist, which authorises nothing", () => {
  assert.equal(DEFAULT_WORKFLOW_CONFIG.defaultWorkflowId, NO_MISTAKES_REVIEW_WORKFLOW_ID);
  assert.deepEqual(getWorkflowPolicy(), DEFAULT_WORKFLOW_POLICY);

  // The pair that makes the flipped default safe, asserted together rather than separately:
  // delivery is authorised machine-wide AND there is no repository it is authorised in. A
  // future change that seeded the allowlist would pass either assertion alone.
  assert.equal(DEFAULT_WORKFLOW_CONFIG.liveEnabled, true);
  assert.deepEqual(DEFAULT_WORKFLOW_CONFIG.repoAllowlist, []);
  assert.equal(repoAllowlisted("/repo", "/repo", DEFAULT_WORKFLOW_CONFIG.repoAllowlist), false);

  assert.deepEqual(
    setWorkflowPolicy({ liveEnabled: true, repoAllowlist: ["/repo"] }),
    { ...DEFAULT_WORKFLOW_POLICY, repoAllowlist: ["/repo"] },
  );
  assert.deepEqual(
    setWorkflowPolicy({ liveEnabled: false, repoAllowlist: [] }),
    { ...DEFAULT_WORKFLOW_POLICY, liveEnabled: false },
  );
  assert.throws(() => setWorkflowPolicy({ liveEnabled: true, repoAllowlist: [""] }));
  setWorkflowPolicy({ liveEnabled: true, repoAllowlist: [] });
});

test("an operator who explicitly turned live delivery off keeps it off across the flip", () => {
  // The upgrade case the default flip turns on. `liveEnabled` is a `.default()` over an
  // `app_config` blob, so it is only consulted when the key is ABSENT. A stored `false` is an
  // answered question and must survive, or the flip silently re-authorises terminal writes for
  // the one operator who said no.
  setAppConfig(APP_CONFIG_ENTRIES.workflows, { liveEnabled: false, repoAllowlist: ["/repo"] });
  assert.equal(getWorkflowPolicy().liveEnabled, false);

  // And the never-opened case, which is the flip's whole point: no key at all reads as ON.
  setAppConfig(APP_CONFIG_ENTRIES.workflows, { repoAllowlist: ["/repo"] });
  assert.equal(getWorkflowPolicy().liveEnabled, true);
  setWorkflowPolicy({ liveEnabled: true, repoAllowlist: [] });
});

test("the dispatch Workflow default is durable and explicit none clears it", () => {
  const selected = setWorkflowPolicy({
    liveEnabled: false,
    repoAllowlist: [],
    defaultWorkflowId: "workflow-review",
  });
  assert.equal(selected.defaultWorkflowId, "workflow-review");
  assert.equal(getWorkflowPolicy().defaultWorkflowId, "workflow-review");
  const cleared = setWorkflowPolicy({
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
  setWorkflowPolicy({
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
  setWorkflowPolicy({
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
  const config = setWorkflowPolicy({ liveEnabled: true, repoAllowlist: ["/repo"] });
  assert.equal(config.liveEnabled && repoAllowlisted("/repo/pkg", "/repo", config.repoAllowlist), true);
  const removed = setWorkflowPolicy({ liveEnabled: true, repoAllowlist: [] });
  assert.equal(removed.liveEnabled && repoAllowlisted("/repo/pkg", "/repo", removed.repoAllowlist), false);
});

// ---- Command consent, and the catalog that no longer lives beside it ----
//
// The read and the write ask DIFFERENT questions of the same shape, and this is where that
// split is held to account. `getWorkflowPolicy` is on the path of every binding gate, every
// delivery decision, every check and the retention sweep, so a stored blob a newer build
// wrote must degrade rather than take all of them down. The PUT route is the opposite: a
// value that silently degraded there would revert in the panel with nothing saying why.

test("check consent defaults on for a fresh install, and the blob carries no commands", () => {
  // A fresh install has no stored row at all, which is the ONE case this default speaks for.
  // It ships on for `liveEnabled`'s reason and behind the same second gate: the allowlist is
  // empty below, so this authorises a command in no repository.
  assert.equal(getWorkflowPolicy().checksEnabled, true);
  assert.equal(getWorkflowPolicy().repoAllowlist.length, 0);
  assert.equal("checkCommands" in getWorkflowPolicy(), false);

  const saved = setWorkflowPolicy({
    liveEnabled: false,
    repoAllowlist: ["/repo"],
    checksEnabled: true,
    // Sent by an old caller and DROPPED rather than stored: the catalog is the only durable
    // command authority, and a second copy under this key is exactly the drift the split
    // exists to prevent. The route-level adapter is what routes it into the catalog.
    checkCommands: [{ repoRoot: "/repo", slot: "test", command: ["npm", "test"] }],
  } as never);
  assert.equal(saved.checksEnabled, true);
  assert.equal("checkCommands" in saved, false);
  assert.deepEqual(getWorkflowPolicy(), saved);
  assert.equal(
    "checkCommands" in (getAppConfig(APP_CONFIG_ENTRIES.workflows) ?? {}),
    false,
    "nothing may write a command list back into app_config after the cutover",
  );

  setWorkflowPolicy({ liveEnabled: true, repoAllowlist: [] });
  assert.deepEqual(getWorkflowPolicy(), DEFAULT_WORKFLOW_POLICY);
});

test("a config written before checks existed still reads, with consent held off", () => {
  // The upgrade path, and the reason it is no longer `.default()` doing this work. That blob
  // ALREADY GRANTS a repository, made on a build where the switch was off and where the grant
  // therefore could not run anything by itself. Inheriting the new on-by-default would arm
  // branch-authored code in `/repo` on upgrade with no interaction at all.
  //
  // The signal is exact, not a guess about how configured the install looks: every write goes
  // through `setWorkflowPolicy`, which persists the whole parsed policy, so a blob missing the
  // key was written before the key existed.
  setAppConfig(APP_CONFIG_ENTRIES.workflows, { liveEnabled: true, repoAllowlist: ["/repo"] });
  const read = getWorkflowPolicy();
  assert.equal(read.liveEnabled, true);
  assert.equal(read.checksEnabled, false);
  setWorkflowPolicy({ liveEnabled: false, repoAllowlist: [] });
});

test("a stored `false` is preserved, and a stored `true` still reads on", () => {
  // The other two stored shapes, so the guard above cannot be mistaken for "old configs are
  // off": it keys on the KEY, not on the value. An operator who read the confirm dialog and
  // switched Commands off keeps that answer through the default flip - which is the same
  // promise the pre-field case makes, arrived at from the opposite direction.
  setAppConfig(APP_CONFIG_ENTRIES.workflows, {
    liveEnabled: true,
    repoAllowlist: ["/repo"],
    checksEnabled: false,
  });
  assert.equal(getWorkflowPolicy().checksEnabled, false);

  setAppConfig(APP_CONFIG_ENTRIES.workflows, {
    liveEnabled: true,
    repoAllowlist: ["/repo"],
    checksEnabled: true,
  });
  assert.equal(getWorkflowPolicy().checksEnabled, true);

  setWorkflowPolicy({ liveEnabled: false, repoAllowlist: [] });
});

test("a write that never mentions Commands cannot switch them on", () => {
  // The hole the read guard alone left open, and the reason consent is resolved on BOTH
  // sides. `PUT /api/workflows/config` replaces the whole policy and the schema fills an
  // omitted `checksEnabled` with the shipped default, which is now `true` - so a legacy
  // install that already holds grants would have had branch-authored execution armed in
  // every one of them by an operator changing retention, and the read guard undone on the
  // first save.
  //
  // The write is a real one, not a no-op: `defaultWorkflowId` moves, so a fix that simply
  // refused to persist anything would fail here too.
  setAppConfig(APP_CONFIG_ENTRIES.workflows, {
    liveEnabled: true,
    repoAllowlist: ["/repo"],
  });
  assert.equal(getWorkflowPolicy().checksEnabled, false, "the legacy read starts off");

  const saved = setWorkflowPolicy({
    liveEnabled: true,
    repoAllowlist: ["/repo"],
    defaultWorkflowId: "some-workflow",
  } as never);

  assert.equal(saved.checksEnabled, false, "an unrelated write must not arm Commands");
  assert.equal(saved.defaultWorkflowId, "some-workflow", "the rest of the write still lands");
  assert.equal(getWorkflowPolicy().checksEnabled, false, "and it stayed off on the next read");

  // An operator who says so explicitly is still obeyed, in both directions - the guard keys
  // on the field being ABSENT, never on the value.
  assert.equal(
    setWorkflowPolicy({ liveEnabled: true, repoAllowlist: ["/repo"], checksEnabled: true } as never)
      .checksEnabled,
    true,
  );
  assert.equal(getWorkflowPolicy().checksEnabled, true);

  setWorkflowPolicy({ liveEnabled: false, repoAllowlist: [] });
});

test("an omitting write on a FRESH install still lands on the shipped default", () => {
  // The other side of the same resolution, and the case that says this is not just "always
  // preserve". Nothing is stored, so there is no consent to inherit and the write takes the
  // shipped `on` - which is what makes a first save through the panel agree with what the
  // daemon was already enforcing.
  setAppConfig(APP_CONFIG_ENTRIES.workflows, null as never);

  assert.equal(setWorkflowPolicy({ liveEnabled: true, repoAllowlist: [] }).checksEnabled, true);

  setWorkflowPolicy({ liveEnabled: false, repoAllowlist: [] });
});

test("an unreadable stored policy falls back to defaults rather than throwing", () => {
  // A downgrade, or a hand-edited row. Every field is exercised, not only the new ones:
  // before the tolerant read the whole subsystem threw on any of these.
  for (const blob of [
    { liveEnabled: "yes", repoAllowlist: [] },
    { liveEnabled: false, repoAllowlist: [""] },
    { liveEnabled: false, repoAllowlist: [], retention: { rawEvidenceDays: -1 } },
    { liveEnabled: false, repoAllowlist: [], checksEnabled: "sure" },
    "not even an object",
    [1, 2, 3],
  ]) {
    setAppConfig(APP_CONFIG_ENTRIES.workflows, blob as never);
    // The whole default, not a field-by-field salvage. What makes that safe is the ALLOWLIST
    // coming back empty, not the consent boolean coming back off - `liveEnabled` now defaults
    // on, and an argument resting on the boolean would already be wrong. A field-by-field
    // salvage is the dangerous one: it could keep a parsed allowlist beside a defaulted flag.
    const degraded = getWorkflowPolicy();
    assert.deepEqual(degraded, DEFAULT_WORKFLOW_POLICY, `${JSON.stringify(blob)} should degrade`);
    assert.equal(
      repoAllowlisted("/repo", "/repo", degraded.repoAllowlist),
      false,
      `${JSON.stringify(blob)} must authorise no repository after degrading`,
    );
  }
  setWorkflowPolicy({ liveEnabled: true, repoAllowlist: [] });
});

test("an unreadable POLICY no longer takes an operator's commands down with it", () => {
  // The consequence of the split, stated as its own case. A preference this build cannot
  // parse says nothing about the commands: those are rows with their own revisions, and the
  // old whole-blob fallback used to silently empty them alongside the allowlist.
  setAppConfig(
    APP_CONFIG_ENTRIES.workflows,
    { liveEnabled: "yes", checkCommands: "not a list" } as never,
  );
  assert.deepEqual(getWorkflowPolicy(), DEFAULT_WORKFLOW_POLICY);
  // And the migration parser refuses the same blob's command field without throwing.
  assert.deepEqual(legacyCheckCommandsToImport(), []);
  setWorkflowPolicy({ liveEnabled: true, repoAllowlist: [] });
});

test("the WRITE path still refuses what the read path tolerates", () => {
  // `.catch()` on a write turns a bad value from the panel into a silent no-op: the field
  // reverts on the next poll and nothing says why. A throw here is a 400 an operator reads.
  assert.throws(() => setWorkflowPolicy({ liveEnabled: false, repoAllowlist: [""] }));
  assert.throws(() => setWorkflowPolicy({
    liveEnabled: false,
    repoAllowlist: [],
    retention: { rawEvidenceDays: 0 },
  }));

  // And the legacy command bounds are unchanged, still refused by the schema the config PUT
  // parses - they simply refuse a REQUEST now rather than a stored blob.
  for (const checkCommands of [
    [{ repoRoot: "/r", slot: "test", command: [] }],
    [{ repoRoot: "", slot: "test", command: ["npm"] }],
    // An argv nobody bounded is a durable blob nobody bounded.
    [{ repoRoot: "/r", slot: "test", command: Array.from({ length: 40 }, () => "x") }],
    [{ repoRoot: "/r", slot: "test", command: ["npm", "x".repeat(5_000)] }],
    [{ repoRoot: "/r", slot: "nope", command: ["x"] }],
  ]) {
    assert.equal(
      WorkflowConfigSchema.safeParse({ liveEnabled: false, repoAllowlist: [], checkCommands })
        .success,
      false,
      `${JSON.stringify(checkCommands)} must still be refused`,
    );
  }
});

test("the migration parser keeps every valid legacy row and drops only the invalid ones", () => {
  // Deliberately NOT the tolerant whole-blob read. That answers "is this readable?" and would
  // report an otherwise fine config with one bad row as having no commands at all, silently
  // dropping every good row beside it.
  setAppConfig(APP_CONFIG_ENTRIES.workflows, {
    liveEnabled: true,
    repoAllowlist: ["/repo"],
    checkCommands: [
      { repoRoot: "/repo", slot: "test", command: ["npm", "test"] },
      { repoRoot: "/repo", slot: "nope", command: ["x"] },
      { repoRoot: "/repo", slot: "lint", command: [] },
      { repoRoot: "/repo/pkg", slot: "test", command: ["pnpm", "test"] },
    ],
  } as never);
  assert.deepEqual(legacyCheckCommandsToImport(), [
    { slot: "test", repoRoot: "/repo", command: ["npm", "test"] },
    { slot: "test", repoRoot: "/repo/pkg", command: ["pnpm", "test"] },
  ]);
  // Neither a non-object blob nor a missing field is an error; both import nothing.
  assert.deepEqual(legacyCheckCommandsToImport("not an object"), []);
  assert.deepEqual(legacyCheckCommandsToImport({ liveEnabled: true }), []);
  setWorkflowPolicy({ liveEnabled: true, repoAllowlist: [] });
});
