// These boundaries span Git eligibility, the retained filesystem and the daemon ledger.
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { PlanAuthority } from "../src/server/plans/store.ts";
import type { SavePlanInput } from "../src/shared/managed-plans.ts";

const home = realpathSync(mkdtempSync(join(tmpdir(), "mission-managed-plans-")));
process.env.MISSION_HOME = join(home, "state");
const { savePlan, readPlanRevision, readPlanFile, planContext, pendingPlanWriteWarnings, listPlans, authorizePlan, managedPlanCaptureScopes } = await import("../src/server/plans/store.ts");
const { openDb, closeDb, upgradeDatabaseToCurrentSchema } = await import("../src/server/db.ts");
const { applySkillsConfig, getSkillsConfig } = await import("../src/server/skills/config.ts");
const { planPlanCapture } = await import("../src/server/plans/capture-plan.ts");
const { ArchiveCaptureStore } = await import("../src/server/archives/capture-store.ts");
const { captureArchive } = await import("../src/server/archives/capture.ts");
const { Registry } = await import("../src/server/registry.ts");
const { planAuthority } = await import("../src/server/plans/authority.ts");
after(() => { closeDb(); rmSync(home, { recursive: true, force: true }); });
beforeEach(() => { openDb().exec("DELETE FROM managed_plan_revisions; DELETE FROM managed_plans; DELETE FROM app_config;"); });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
function repo(parent = randomUUID(), name = "same-name"): PlanAuthority {
  const checkout = join(home, parent, name);
  mkdirSync(checkout, { recursive: true });
  git(checkout, "init", "-q", "-b", "main");
  git(checkout, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial", "--allow-empty");
  return { sessionId: randomUUID(), taskId: randomUUID(), episodeId: randomUUID(), repoSlot: "repo-01", checkout, repoRoot: checkout };
}
function input(slug = `plan-${randomUUID()}`, title = "A saved plan"): SavePlanInput {
  return { repoSlot: "repo-01", requestId: randomUUID(), slug, expectedRevision: 0, files: [
    { name: "plan.md", content: `# ${title}\n\n[Phases](phased-plan.md)` },
    { name: "plan.html", content: `<html><body><h1>${title}</h1><a href="phased-plan.html">Phases</a></body></html>` },
    { name: "phased-plan.md", content: "# Phase index\n\n[Source](plan.md)" },
    { name: "phased-plan.html", content: '<h1>Phase index</h1><a href="plan.md">Source</a>' },
    { name: "review.txt", content: "Review companion" },
  ] };
}

test("a pre-feature database upgrades additively and retains existing settings", () => {
  const old = new DatabaseSync(join(home, `${randomUUID()}.db`));
  try {
    old.exec("CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO app_config VALUES ('skills', '{\"enabled\":false}'); PRAGMA user_version = 4;");
    upgradeDatabaseToCurrentSchema(old);
    assert.equal((old.prepare("SELECT value FROM app_config WHERE key = 'skills'").get() as { value: string }).value, '{"enabled":false}');
    assert.equal(old.prepare("SELECT * FROM managed_plans").all().length, 0);
    assert.equal(old.prepare("SELECT * FROM managed_plan_revisions").all().length, 0);
    upgradeDatabaseToCurrentSchema(old);
    assert.equal((old.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 5);
  } finally { old.close(); }
});

test("defaults stage only Markdown; HTML opt-in pins eligibility without changing skill links", async () => {
  const a = repo();
  assert.equal((await planContext(a)).policy.commitPlanHtml, false);
  const first = await savePlan(a, input("default"));
  git(a.checkout, "add", ".");
  assert.deepEqual(git(a.checkout, "diff", "--cached", "--name-only").split("\n"), ["docs/plans/default/phased-plan.md", "docs/plans/default/plan.md"]);
  assert.equal(existsSync(join(a.checkout, "docs/plans/default/plan.html")), false);
  const before = getSkillsConfig();
  assert.equal(applySkillsConfig({ commitPlanHtml: true }).changed, false);
  assert.equal(getSkillsConfig().generation, before.generation);
  const second = await savePlan(a, input("opt-in"));
  git(a.checkout, "add", ".");
  assert.equal(second.requiredPaths.length, 4);
  assert.match(git(a.checkout, "diff", "--cached", "--name-only"), /opt-in\/plan.html/);
  assert.equal(existsSync(join(a.checkout, "docs/plans/opt-in/review.txt")), false);
  const next = await savePlan(a, { ...input("default", "Updated"), planId: first.manifest.planId, expectedRevision: 1 });
  assert.equal(next.manifest.policy.commitPlanHtml, false);
  assert.equal(next.manifest.revision, 2);
  assert.match(readPlanFile(first.manifest.planId, 1, "plan.md").toString(), /A saved plan/);
  assert.equal(first.manifest.files.find((f) => f.name === "plan.html")?.sourceSha256, first.manifest.files.find((f) => f.name === "plan.md")?.sha256);
  closeDb();
  assert.equal(getSkillsConfig().commitPlanHtml, true);
  assert.equal(readPlanRevision(next.manifest.planId, 2).manifest.revision, 2);
});

test("identical retries converge; concurrent stale updates cannot mix whole revisions", async () => {
  const a = repo(), request = input("concurrent");
  const [one, two] = await Promise.all([savePlan(a, request), savePlan(a, request)]);
  assert.deepEqual(one, two);
  await assert.rejects(savePlan(a, { ...request, files: input().files.slice(0, 4) }), /identity.*different/);
  const updates = await Promise.allSettled(["second", "third"].map((title) => savePlan(a, { ...input("concurrent", title), planId: one.manifest.planId, expectedRevision: 1 })));
  assert.equal(updates.filter((r) => r.status === "fulfilled").length, 1);
  assert.match(String((updates.find((r) => r.status === "rejected") as PromiseRejectedResult).reason), /Stale/);
  const saved = readPlanRevision(one.manifest.planId, 2);
  assert.match(readPlanFile(saved.manifest.planId, 2, "plan.md").toString(), /second|third/);
});

test("linked worktrees share identity, same-name clones are isolated, retained previews and capture survive checkout removal", async () => {
  const a = repo(), b = repo();
  assert.notEqual((await planContext(a)).repoKey, (await planContext(b)).repoKey);
  const checkout = join(home, randomUUID());
  git(a.checkout, "worktree", "add", "--detach", checkout);
  const linked = { ...a, checkout, repoRoot: checkout };
  assert.equal((await planContext(a)).repoKey, (await planContext(linked)).repoKey);
  const saved = await savePlan(linked, input("durable"));
  await assert.rejects(authorizePlan(b, saved.manifest.planId), /different repository/);
  git(a.checkout, "worktree", "remove", "--force", checkout);
  assert.match(readPlanFile(saved.manifest.planId, 1, "plan.html").toString(), /A saved plan/);
  assert.equal((await listPlans(a)).length, 1);
  const scope = managedPlanCaptureScopes(a.taskId, a.episodeId)[0]!;
  const jobs = new ArchiveCaptureStore();
  const job = jobs.reserve({ kind: "plan", taskId: a.taskId, sessionId: a.sessionId, episodeId: a.episodeId, producerId: randomUUID(), title: "Durable", question: null, origin: { agent: "codex", model: null, source: null }, repos: [], scope });
  const captured = await planPlanCapture(jobs.get(job.operationKey)!, [], {});
  assert.equal(captured.ok, true);
  if (!captured.ok) return;
  assert.equal(captured.captureStatus, "complete");
  assert.equal(captured.files.length, saved.manifest.files.length + 1);
  assert.match(readFileSync(captured.files.find((f) => f.role === "primary_report")!.source, "utf8"), /A saved plan/);
});

for (const commitPlanHtml of [false, true]) test(`updates initialize missing outputs in a second linked worktree (HTML ${commitPlanHtml})`, async () => {
  applySkillsConfig({ commitPlanHtml });
  const owner = repo();
  const linked = [0, 1].map(() => {
    const checkout = join(home, randomUUID());
    git(owner.checkout, "worktree", "add", "--detach", checkout);
    return { ...owner, checkout };
  });
  const [a, b] = linked as [PlanAuthority, PlanAuthority];
  const original = input("cross-checkout");
  const first = await savePlan(a, original);
  const update = { ...input("cross-checkout", "Second revision"), planId: first.manifest.planId, expectedRevision: 1 };
  assert.equal(existsSync(join(b.checkout, "docs/plans/cross-checkout")), false);
  const second = await savePlan(b, update);
  assert.equal(second.manifest.revision, 2);
  assert.deepEqual(readPlanRevision(first.manifest.planId, 2), second, "the revision is ready");
  assert.equal(second.requiredPaths.length, commitPlanHtml ? 4 : 2);
  for (const file of second.manifest.files) {
    if (!file.checkoutPath) continue;
    assert.equal(readFileSync(join(b.checkout, file.checkoutPath), "utf8"), update.files.find((f) => f.name === file.name)!.content);
    assert.equal(readFileSync(join(a.checkout, file.checkoutPath), "utf8"), original.files.find((f) => f.name === file.name)!.content);
  }
  assert.equal(existsSync(join(b.checkout, "docs/plans/cross-checkout/plan.html")), commitPlanHtml);
  assert.equal(readPlanFile(first.manifest.planId, 1, "plan.md").toString(), original.files[0]!.content);
  assert.equal(readPlanFile(first.manifest.planId, 2, "plan.html").toString(), update.files[1]!.content);
  const returning = { ...input("cross-checkout", "Third revision"), planId: first.manifest.planId, expectedRevision: 2 };
  const third = await savePlan(a, returning);
  assert.equal(readPlanRevision(first.manifest.planId, 3).manifest.revision, 3);
  for (const file of third.manifest.files) {
    if (!file.checkoutPath) continue;
    assert.equal(readFileSync(join(a.checkout, file.checkoutPath), "utf8"), returning.files.find((f) => f.name === file.name)!.content);
    assert.equal(readFileSync(join(b.checkout, file.checkoutPath), "utf8"), update.files.find((f) => f.name === file.name)!.content);
  }
  // A checkout may also have received the current published files through Git.
  for (const file of third.manifest.files) {
    if (file.checkoutPath) writeFileSync(join(b.checkout, file.checkoutPath), returning.files.find((f) => f.name === file.name)!.content);
  }
  const fourth = await savePlan(b, { ...input("cross-checkout", "Fourth revision"), planId: first.manifest.planId, expectedRevision: 3 });
  assert.equal(readPlanRevision(first.manifest.planId, 4).manifest.revision, 4);
  assert.deepEqual(fourth.requiredPaths, second.requiredPaths);
});

test("cross-worktree updates preserve edited files and previously managed deletions", async () => {
  const a = repo(), checkout = join(home, randomUUID());
  git(a.checkout, "worktree", "add", "--detach", checkout);
  const b = { ...a, checkout };
  const first = await savePlan(a, input("protected"));
  const update = { ...input("protected", "Second revision"), planId: first.manifest.planId, expectedRevision: 1 };
  const planPath = "docs/plans/protected/plan.md";
  mkdirSync(join(b.checkout, "docs/plans/protected"), { recursive: true });
  writeFileSync(join(b.checkout, planPath), "operator content");
  await assert.rejects(savePlan(b, update), /Operator edit/);
  assert.equal(readFileSync(join(b.checkout, planPath), "utf8"), "operator content");
  assert.equal(existsSync(join(b.checkout, "docs/plans/protected/phased-plan.md")), false);
  assert.throws(() => readPlanRevision(first.manifest.planId, 2), /No such plan revision/);
  rmSync(join(b.checkout, planPath));
  await savePlan(b, update);
  const returning = { ...input("protected", "Third revision"), planId: first.manifest.planId, expectedRevision: 2 };
  writeFileSync(join(a.checkout, planPath), "operator edited after the other checkout saved");
  await assert.rejects(savePlan(a, returning), /Operator edit/);
  assert.equal(readFileSync(join(a.checkout, planPath), "utf8"), "operator edited after the other checkout saved");
  // Another checkout becoming current must not turn a deletion in the first into a new output.
  rmSync(join(a.checkout, planPath));
  await assert.rejects(savePlan(a, returning), /Operator edit/);
  assert.equal(existsSync(join(a.checkout, planPath)), false);
  assert.equal(readPlanRevision(first.manifest.planId, 2).manifest.revision, 2);
  assert.throws(() => readPlanRevision(first.manifest.planId, 3), /No such plan revision/);
});

test("tracked legacy plans and operator edits remain untouched", async () => {
  const a = repo();
  const directory = join(a.checkout, "docs/plans/legacy");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "plan.html"), "legacy HTML");
  writeFileSync(join(directory, "plan.md"), "legacy Markdown");
  git(a.checkout, "add", ".");
  await assert.rejects(savePlan(a, input("legacy")), /tracked|Unmanaged/);
  assert.equal(readFileSync(join(directory, "plan.html"), "utf8"), "legacy HTML");
  rmSync(directory, { recursive: true });
  await assert.rejects(savePlan(a, input("legacy")), /tracked/);
  const first = await savePlan(a, input("edited"));
  writeFileSync(join(a.checkout, "docs/plans/edited/plan.md"), "operator edit");
  await assert.rejects(savePlan(a, { ...input("edited"), planId: first.manifest.planId, expectedRevision: 1 }), /Operator edit/);
  assert.equal(readFileSync(join(a.checkout, "docs/plans/edited/plan.md"), "utf8"), "operator edit");
});

test("ignored Markdown outputs and expired attribution cannot produce a ready save", async () => {
  const a = repo();
  writeFileSync(join(a.checkout, ".gitignore"), "docs/plans/ignored/\n");
  await assert.rejects(savePlan(a, input("ignored")), /ignored by Git/);
  assert.equal(existsSync(join(a.checkout, "docs/plans/ignored")), false);
  const revoked = { ...a, assertCurrent: () => { throw new Error("registration expired"); } };
  await assert.rejects(savePlan(revoked, input("expired")), /registration expired/);
  assert.equal((await listPlans(a)).length, 0);
});

test("a live registry rebind leaves the save incomplete through restart until an authorized retry", async () => {
  const a = repo();
  const registry = new Registry();
  const discovered = {
    syntheticId: a.sessionId, agent: "claude" as const, name: "plan", nameSource: "process" as const,
    cwd: a.checkout, gitBranch: "main", gitRoot: a.repoRoot, repoRoot: a.repoRoot,
    pid: 100, tty: null, terminals: [], startedAt: 1,
  };
  registry.applyDiscovery([discovered]);
  const authority = planAuthority(registry, registry.getSession(a.sessionId)!, "repo-01");
  const request = input("revoked-writer");
  await assert.rejects(savePlan(authority, request, {
    afterRevisionStaged: async () => {
      registry.applyDiscovery([{ ...discovered, pid: 101 }]);
      assert.equal(registry.getSession(a.sessionId)!.pid, 101);
    },
  }), /Plan writer registration changed/);
  const revision = openDb().prepare("SELECT plan_id, revision, status FROM managed_plan_revisions WHERE request_id = ?")
    .get(request.requestId) as { plan_id: string; revision: number; status: string };
  assert.equal(revision.status, "staging", "the save reached retained staging before attribution was revoked");
  assert.throws(() => readPlanRevision(revision.plan_id, revision.revision), /incomplete/);
  assert.equal((await listPlans(a)).length, 0);
  assert.equal(existsSync(join(a.checkout, "docs/plans/revoked-writer")), false);
  closeDb();
  assert.deepEqual(pendingPlanWriteWarnings(), [
    `${revision.plan_id}/${revision.revision}: Plan revision is incomplete; retry its exact save request from a currently registered session`,
  ]);
  assert.throws(() => readPlanRevision(revision.plan_id, revision.revision), /incomplete/);
  assert.equal((await listPlans(a)).length, 0);
  assert.equal(existsSync(join(a.checkout, "docs/plans/revoked-writer")), false);
  await assert.rejects(savePlan(authority, request), /Plan writer registration changed/);
  const restartedRegistry = new Registry();
  restartedRegistry.applyDiscovery([{ ...discovered, pid: 101 }]);
  const currentAuthority = planAuthority(restartedRegistry, restartedRegistry.getSession(a.sessionId)!, "repo-01");
  const recovered = await savePlan(currentAuthority, request);
  assert.equal(recovered.manifest.planId, revision.plan_id);
  assert.equal(recovered.manifest.revision, revision.revision);
  for (const file of recovered.manifest.files.filter((file) => file.checkoutPath)) {
    assert.equal(readFileSync(join(a.checkout, file.checkoutPath!), "utf8"), request.files.find((inputFile) => inputFile.name === file.name)!.content);
  }
  assert.deepEqual(pendingPlanWriteWarnings(), []);
});

test("an interrupted save cannot replay in a checkout no longer issued to its writer", async () => {
  const a = repo(), request = input("moved-writer");
  const linked = join(home, randomUUID());
  git(a.checkout, "worktree", "add", "--detach", linked);
  const registry = new Registry();
  const discovered = {
    syntheticId: a.sessionId, agent: "claude" as const, name: "plan", nameSource: "process" as const,
    cwd: a.checkout, gitBranch: "main", gitRoot: a.checkout, repoRoot: a.repoRoot,
    pid: 100, tty: null, terminals: [], startedAt: 1,
  };
  registry.applyDiscovery([discovered]);
  const currentAuthority = () => planAuthority(registry, registry.getSession(a.sessionId)!, "repo-01");
  await assert.rejects(savePlan(currentAuthority(), request, {
    afterRevisionStaged: async () => { throw new Error("interrupted"); },
  }), /interrupted/);
  registry.applyDiscovery([{ ...discovered, cwd: linked, gitRoot: linked }]);
  assert.equal(currentAuthority().checkout, linked);
  await assert.rejects(savePlan(currentAuthority(), request), /checkout or repository slot.*writer/);
  assert.equal((await listPlans(a)).length, 0);
  for (const checkout of [a.checkout, linked]) assert.equal(existsSync(join(checkout, "docs/plans/moved-writer")), false);
  registry.applyDiscovery([discovered]);
  // Even the same repository and checkout do not authorize another issued slot.
  await assert.rejects(savePlan({ ...currentAuthority(), repoSlot: "repo-02" }, request), /checkout or repository slot.*writer/);
  assert.equal((await savePlan(currentAuthority(), request)).manifest.revision, 1);
});

test("a ready save retry refuses a writer rebound to another checkout without changing either checkout", async () => {
  const a = repo(), request = input("ready-writer");
  const linked = join(home, randomUUID());
  git(a.checkout, "worktree", "add", "--detach", linked);
  const registry = new Registry();
  const discovered = {
    syntheticId: a.sessionId, agent: "claude" as const, name: "plan", nameSource: "process" as const,
    cwd: a.checkout, gitBranch: "main", gitRoot: a.checkout, repoRoot: a.repoRoot,
    pid: 100, tty: null, terminals: [], startedAt: 1,
  };
  registry.applyDiscovery([discovered]);
  const currentAuthority = () => planAuthority(registry, registry.getSession(a.sessionId)!, "repo-01");
  const saved = await savePlan(currentAuthority(), request);
  assert.deepEqual(readPlanRevision(saved.manifest.planId, 1), saved);
  const destination = join(linked, "docs/plans/ready-writer");
  mkdirSync(destination, { recursive: true });
  writeFileSync(join(destination, "plan.md"), "operator content in the new checkout");
  registry.applyDiscovery([{ ...discovered, cwd: linked, gitRoot: linked }]);
  assert.equal(currentAuthority().checkout, linked);
  await assert.rejects(savePlan(currentAuthority(), request), { status: 403, message: /checkout or repository slot.*writer/ });
  for (const file of saved.manifest.files.filter((file) => file.checkoutPath)) {
    assert.equal(readFileSync(join(a.checkout, file.checkoutPath!), "utf8"), request.files.find((f) => f.name === file.name)!.content);
  }
  assert.equal(readFileSync(join(destination, "plan.md"), "utf8"), "operator content in the new checkout");
  assert.equal(existsSync(join(destination, "phased-plan.md")), false);
  assert.equal(existsSync(join(destination, "plan.html")), false);
  assert.deepEqual(readPlanRevision(saved.manifest.planId, 1), saved);
  registry.applyDiscovery([discovered]);
  await assert.rejects(savePlan({ ...currentAuthority(), repoSlot: "repo-02" }, request), { status: 403 });
  assert.deepEqual(await savePlan(currentAuthority(), request), saved);
});

test("a save stays incomplete if an earlier checkout output changes during later writes", async () => {
  const a = repo();
  const first = await savePlan(a, input("concurrent-edit"));
  const update = { ...input("concurrent-edit", "Second revision"), planId: first.manifest.planId, expectedRevision: 1 };
  update.files.find((file) => file.name === "phased-plan.md")!.content = "# Updated phases";
  const phasePath = join(a.checkout, "docs/plans/concurrent-edit/phased-plan.md");
  let changed = false;
  await assert.rejects(savePlan(a, update, { afterCheckoutWrite: (name) => {
    if (name !== "plan.md") return;
    assert.equal(readFileSync(phasePath, "utf8"), "# Updated phases", "the earlier output was already replaced");
    writeFileSync(phasePath, "operator changed the earlier output");
    changed = true;
  } }), /no longer matches.*incomplete/);
  assert.equal(changed, true);
  assert.equal((await listPlans(a))[0]!.manifest.revision, 1);
  assert.throws(() => readPlanRevision(first.manifest.planId, 2), /incomplete/);
  assert.equal(readFileSync(phasePath, "utf8"), "operator changed the earlier output");
  await assert.rejects(savePlan(a, update), /Operator edit/);
  writeFileSync(phasePath, "# Updated phases");
  assert.equal((await savePlan(a, update)).manifest.revision, 2);
});

test("authorized recovery removes orphan staging directories while preserving published revisions", async () => {
  const a = repo();
  const first = await savePlan(a, input("orphan-stages"));
  const update = { ...input("orphan-stages", "Second revision"), planId: first.manifest.planId, expectedRevision: 1 };
  await assert.rejects(savePlan(a, update, { afterRevisionStaged: async () => { throw new Error("interrupted"); } }), /interrupted/);
  const planStore = join((await planContext(a)).localStore, first.manifest.planId);
  const published = [1, 2].map((revision) => readFileSync(join(planStore, String(revision), "manifest.json")));
  // Model a process exit partway through filling a staging directory. It has no manifest.
  const orphan = join(planStore, `staging-${randomUUID()}`);
  mkdirSync(orphan);
  writeFileSync(join(orphan, "plan.md"), "partial bundle");
  const unrelated = join(planStore, "operator-notes");
  mkdirSync(unrelated);
  writeFileSync(join(unrelated, "keep.txt"), "keep");
  const link = join(planStore, `staging-${randomUUID()}`);
  symlinkSync(unrelated, link);
  closeDb();
  assert.equal(pendingPlanWriteWarnings().length, 1);
  assert.equal(existsSync(orphan), true, "startup has no writer authority to recover");
  const recovered = await savePlan(a, update);
  assert.equal(recovered.manifest.revision, 2);
  assert.equal(existsSync(orphan), false);
  for (const revision of [1, 2]) assert.deepEqual(readFileSync(join(planStore, String(revision), "manifest.json")), published[revision - 1]);
  assert.match(readPlanFile(first.manifest.planId, 1, "plan.md").toString(), /A saved plan/);
  assert.equal(readFileSync(join(unrelated, "keep.txt"), "utf8"), "keep");
  assert.equal(existsSync(link), true, "cleanup never follows symlinks");
});

test("archive publication rejects retained bytes changed after managed capture planning", async () => {
  const a = repo();
  await savePlan(a, input("capture-tamper"));
  const jobs = new ArchiveCaptureStore();
  const reserved = jobs.reserve({
    kind: "plan", taskId: a.taskId, sessionId: a.sessionId, episodeId: a.episodeId,
    producerId: randomUUID(), title: "Capture tampering", question: null,
    origin: { agent: "codex", model: null, source: null }, repos: [],
    scope: managedPlanCaptureScopes(a.taskId, a.episodeId)[0]!,
  });
  const job = jobs.get(reserved.operationKey)!;
  const libraryRoot = join(home, `library-${randomUUID()}`);
  mkdirSync(libraryRoot);
  let changed = false;
  const outcome = await captureArchive(job, {
    libraryRoot, producerLabel: null,
    beforeCopy: async (source) => {
      if (changed || !source.endsWith("/plan.html")) return;
      const before = statSync(source);
      const original = readFileSync(source, "utf8");
      const altered = original.replace("A saved plan", "A rogue plan");
      assert.notEqual(altered, original);
      writeFileSync(source, altered);
      assert.equal(statSync(source).ino, before.ino);
      assert.equal(statSync(source).size, before.size);
      changed = true;
    },
  });
  assert.equal(changed, true, "the real capture planner accepted the saved revision before its source changed");
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.ok(outcome.problems.includes("docs/plans/capture-tamper/plan.html: no longer matches its registered revision digest"), JSON.stringify(outcome));
  assert.equal(existsSync(join(libraryRoot, job.producerId, job.archiveId)), false);
});

test("restart holds interrupted writes for an explicit retry that refuses conflicting operator edits", async () => {
  const a = repo(), request = input("interrupted");
  await assert.rejects(savePlan(a, request, { afterRevisionStaged: async () => { throw new Error("power loss"); } }), /power loss/);
  assert.throws(() => managedPlanCaptureScopes(a.taskId, a.episodeId), /incomplete/);
  assert.equal((await listPlans(a)).length, 0);
  closeDb();
  assert.match(pendingPlanWriteWarnings().join(" "), /retry its exact save request/);
  assert.equal((await listPlans(a)).length, 0);
  assert.equal(existsSync(join(a.checkout, "docs/plans/interrupted")), false);
  const recovered = await savePlan(a, request);
  assert.equal(recovered.manifest.revision, 1);
  const update = { ...input("interrupted", "new revision"), planId: recovered.manifest.planId, expectedRevision: 1 };
  await assert.rejects(savePlan(a, update, { beforeCheckoutWrite: async () => {
    writeFileSync(join(a.checkout, "docs/plans/interrupted/plan.md"), "operator intervened");
    throw new Error("crash");
  } }), /crash/);
  closeDb();
  assert.match(pendingPlanWriteWarnings().join(" "), /retry its exact save request/);
  await assert.rejects(savePlan(a, update), /Operator edit/);
  assert.throws(() => readPlanRevision(recovered.manifest.planId, 2), /incomplete/);
  assert.equal(readFileSync(join(a.checkout, "docs/plans/interrupted/plan.md"), "utf8"), "operator intervened");
  writeFileSync(join(a.checkout, "docs/plans/interrupted/plan.md"), request.files[0]!.content);
  assert.equal((await savePlan(a, update)).manifest.revision, 2);
});

test("corruption, path escapes, symlink swaps, invalid encodings and incomplete HTML are refused", async () => {
  const a = repo();
  for (const name of ["../escape.md", "/tmp/escape.md", "nested/plan.md", "bad\\name.md"]) {
    const bad = input(); bad.files[0]!.name = name;
    await assert.rejects(savePlan(a, bad));
  }
  for (const content of ["\ud800", "x".repeat(1024 * 1024 + 1), "bad\0text"]) {
    const bad = input(); bad.files[0]!.content = content;
    await assert.rejects(savePlan(a, bad));
  }
  for (const content of ['<script>alert(1)</script>', '<img src="https://invalid.example/x">', '<a href="missing.md">missing</a>', '<img src="review.svg">']) {
    const bad = input(); bad.files[1]!.content = content;
    await assert.rejects(savePlan(a, bad));
  }
  const collision = input(); collision.files.push({ name: "PLAN.md", content: "collision" });
  await assert.rejects(savePlan(a, collision), /case-colliding/);
  const outside = join(home, randomUUID()); mkdirSync(outside);
  const swapped = input("swapped");
  await assert.rejects(savePlan(a, swapped, { beforeCheckoutWrite: async () => { mkdirSync(join(a.checkout, "docs"), { recursive: true }); symlinkSync(outside, join(a.checkout, "docs/plans")); } }), /symbolic link/);
  assert.equal(existsSync(join(outside, "swapped")), false);
  rmSync(join(a.checkout, "docs/plans"));
  const saved = await savePlan(a, input("corrupt"));
  const root = (await planContext(a)).localStore;
  writeFileSync(join(root, saved.manifest.planId, "1", "plan.html"), "corrupt");
  assert.throws(() => readPlanFile(saved.manifest.planId, 1, "plan.md"), /corrupt/);
  openDb().prepare("INSERT OR REPLACE INTO app_config VALUES ('skills', ?)").run('{"commitPlanHtml":"yes"}');
  await assert.rejects(savePlan(a, input("invalid-config")), /Stored Skills settings are invalid/);
});

test("a failed retained stage retries from its journal; partially applied checkout writes recover as one revision", async () => {
  const a = repo(), request = input("stage-retry");
  const context = await planContext(a);
  const outside = join(home, randomUUID()); mkdirSync(outside);
  mkdirSync(join(context.localStore, ".."), { recursive: true });
  symlinkSync(outside, context.localStore);
  await assert.rejects(savePlan(a, request), /symbolic link/);
  assert.equal((await listPlans(a)).length, 0);
  rmSync(context.localStore);
  const first = await savePlan(a, request);
  const next = { ...input("stage-retry", "Updated atomically"), planId: first.manifest.planId, expectedRevision: 1 };
  next.files.find((f) => f.name === "phased-plan.md")!.content = "# Revised phase index";
  next.files.find((f) => f.name === "phased-plan.html")!.content = "<h1>Revised phase index</h1>";
  await assert.rejects(savePlan(a, next, { beforeCheckoutWrite: async () => {
    writeFileSync(join(a.checkout, "docs/plans/stage-retry/plan.md"), next.files[0]!.content);
    throw new Error("interrupted after first replacement");
  } }), /first replacement/);
  assert.throws(() => readPlanRevision(first.manifest.planId, 2), /incomplete/);
  closeDb();
  assert.match(pendingPlanWriteWarnings().join(" "), /retry its exact save request/);
  assert.throws(() => readPlanRevision(first.manifest.planId, 2), /incomplete/);
  assert.equal(readFileSync(join(a.checkout, "docs/plans/stage-retry/plan.md"), "utf8"), next.files[0]!.content);
  assert.equal(readFileSync(join(a.checkout, "docs/plans/stage-retry/phased-plan.md"), "utf8"), request.files.find((file) => file.name === "phased-plan.md")!.content);
  const recovered = await savePlan(a, next);
  for (const file of recovered.manifest.files.filter((f) => f.checkoutPath)) {
    assert.equal(readFileSync(join(a.checkout, file.checkoutPath!), "utf8"), readPlanFile(first.manifest.planId, 2, file.name).toString());
  }
  assert.equal(recovered.manifest.revision, 2);
});
