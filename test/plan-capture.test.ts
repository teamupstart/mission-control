import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { ARCHIVE_PRIMARY_REPORT_PATH } from "../src/shared/archives.ts";
import { mkTask as baseTask } from "./helpers/session-fixture.ts";
import type { Session, Task } from "../src/shared/types.ts";

/**
 * A plan outlives the checkout it was written in.
 *
 * The claim this file exists to prove is narrow and has a negative half that matters more
 * than the positive one. A scout's report is at ONE convention, so finding it is a `readdir`.
 * A plan's is at `docs/plans/<name>/` with a name its author chose, in a repository that
 * routinely holds dozens of plan directories belonging to other people's work - this one
 * holds 76. So "archive the plan" is only correct if it means "archive the plan THIS TASK
 * WROTE", and every checkout below deliberately contains a second, unrelated plan directory
 * that must never appear in a bundle.
 *
 * Everything runs against real git worktrees through the real `TaskManager`, because the
 * source of truth here is a git diff and the destruction being raced is a real
 * `git worktree remove --force`. A fake checkout would prove the branches were taken, not
 * that they were right about the disk.
 */

const home = mkdtempSync(join(tmpdir(), "mission-plan-capture-"));
process.env.MISSION_HOME = home;
process.env.HARNESS_HOME = home;

const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { ArchiveManager } = await import("../src/server/archives/manager.ts");
const { RegistryArchiveTaskGateway } = await import("../src/server/archives/task-gateway.ts");
const { clearArchiveCaptureJobs } = await import("../src/server/archives/capture-store.ts");
const { clearArchiveTables } = await import("../src/server/archives/store.ts");
const { openDb } = await import("../src/server/db.ts");
const { planDirectoryOf } = await import("../src/server/plans/capture-scopes.ts");
const { changedPathsSince } = await import("../src/server/diff.ts");

const db = openDb();
after(() => rmSync(home, { recursive: true, force: true }));
beforeEach(() => {
  clearArchiveCaptureJobs(db);
  clearArchiveTables(db);
});

let seq = 0;

function mkdirp(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A self-contained plan page, the shape the `html-plans` skill mandates. */
function planHtml(title: string, body = "<p>The outcome, stated once.</p>"): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    `<head><meta charset="utf-8"><title>${title}</title>`,
    "<style>body { background: #0a0c0f; color: #e7ebf1; }</style></head>",
    `<body><h1>${title}</h1>`,
    body,
    "</body></html>",
  ].join("\n");
}

/** The unrelated plan every checkout carries, so the negative case is never hypothetical. */
const BYSTANDER = {
  "docs/plans/recurring-missions/plan.md": "# Recurring missions\n\nSomebody else's plan.\n",
  "docs/plans/recurring-missions/plan.html": planHtml("Recurring missions"),
} as const;

interface Checkout {
  repoRoot: string;
  worktreePath: string;
}

/**
 * A real worktree cut from a real repository, with a committed baseline.
 *
 * `committed` files land on the branch and `written` files stay in the working tree, because
 * both have to be found: `phased-plan` commits and pushes before it schedules, while a plan a
 * human stopped after may never have been committed at all. The bystander plan is always
 * committed to the BASE branch, so it is genuinely part of the checkout and genuinely absent
 * from this task's diff - which is the only thing separating it from the plan under test.
 */
function makeCheckout(
  options: { committed?: Record<string, string>; written?: Record<string, string> } = {},
): Checkout {
  const n = ++seq;
  const repoRoot = mkdirp(join(home, `repo-${n}`));
  const git = (cwd: string, ...args: string[]): void => {
    execFileSync("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@e",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@e",
      },
    });
  };
  git(repoRoot, "init", "-q", "-b", "main");
  writeFileSync(join(repoRoot, "README.md"), "# demo\n");
  for (const [relative, contents] of Object.entries(BYSTANDER)) {
    mkdirp(join(repoRoot, relative.split("/").slice(0, -1).join("/")));
    writeFileSync(join(repoRoot, relative), contents);
  }
  git(repoRoot, "add", "-A");
  git(repoRoot, "commit", "-qm", "base");

  const worktreePath = join(home, `worktree-${n}`);
  git(repoRoot, "worktree", "add", "-q", "-b", `harness/plan-${n}`, worktreePath);
  const put = (files: Record<string, string>): void => {
    for (const [relative, contents] of Object.entries(files)) {
      mkdirp(join(worktreePath, relative.split("/").slice(0, -1).join("/") || "."));
      writeFileSync(join(worktreePath, relative), contents);
    }
  };
  if (options.committed) {
    put(options.committed);
    git(worktreePath, "add", "-A");
    git(worktreePath, "commit", "-qm", "the plan");
  }
  if (options.written) put(options.written);
  return { repoRoot, worktreePath };
}

interface Harness {
  registry: InstanceType<typeof Registry>;
  tasks: InstanceType<typeof TaskManager>;
  archives: InstanceType<typeof ArchiveManager>;
  library: string;
}

function harness(options: { rename?: (from: string, to: string) => Promise<void> } = {}): Harness {
  const registry = new Registry();
  const library = mkdirp(join(home, `library-${++seq}`));
  const archives = new ArchiveManager({
    root: library,
    tasks: new RegistryArchiveTaskGateway(registry),
    intervalMs: null,
    watch: false,
    log: () => {},
    ...options,
  });
  registry.onSessionExit((session) => archives.reserveOnExit(session));
  const tasks = new TaskManager(registry, undefined, undefined, undefined, archives);
  return { registry, tasks, archives, library };
}

function mkPlan(over: Partial<Task> = {}): Task {
  return baseTask({
    id: `plan-${++seq}`,
    kind: "plan",
    title: "Plan the archive rename",
    intent: "Plan how the durable bundle library stops being scout-shaped.",
    status: "running",
    provider: "git",
    branch: null,
    ...over,
  });
}

/** The bundle directory one published job wrote. */
function bundleDir(h: Harness, taskId: string): string[] {
  return h.archives
    .captureJobsForTask(taskId)
    .filter((job) => job.status === "published")
    .map((job) => join(h.library, job.producerId, job.archiveId));
}

function archivedPaths(dir: string): string[] {
  const walk = (base: string, prefix: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) out.push(...walk(join(base, entry.name), rel));
      else out.push(rel);
    }
    return out.sort();
  };
  return walk(dir, "");
}

// ---------------------------------------------------------------------------
// The central claim, and its negative half
// ---------------------------------------------------------------------------

test("a plan task archives the plan directory its own diff touched", async () => {
  const h = harness();
  const { repoRoot, worktreePath } = makeCheckout({
    committed: {
      "docs/plans/archive-rename/plan.md": "# The kind-agnostic archive\n\nWhat and why.\n",
      "docs/plans/archive-rename/plan.html": planHtml("The kind-agnostic archive"),
      "docs/plans/archive-rename/phase-1.md": "# Phase 1\n",
    },
  });
  const task = mkPlan({ worktreePath, repoRoot, status: "done" });
  h.registry.upsertTask(task);

  const reclaimed = await h.tasks.reclaim(task.id);
  assert.equal(reclaimed.ok, true, reclaimed.error);

  const bundles = bundleDir(h, task.id);
  assert.equal(bundles.length, 1, "one plan directory, one bundle");
  const paths = archivedPaths(bundles[0]!);
  assert.deepEqual(paths, [
    "manifest.json",
    "report/phase-1.md",
    "report/plan.md",
    ARCHIVE_PRIMARY_REPORT_PATH,
  ].sort());
  // The page itself, byte for byte, as the bundle's primary.
  assert.equal(
    readFileSync(join(bundles[0]!, ARCHIVE_PRIMARY_REPORT_PATH), "utf8"),
    planHtml("The kind-agnostic archive"),
  );
});

test("an unrelated plan directory in the same checkout is never archived", async () => {
  const h = harness();
  const { repoRoot, worktreePath } = makeCheckout({
    written: {
      "docs/plans/archive-rename/plan.md": "# The kind-agnostic archive\n",
      "docs/plans/archive-rename/plan.html": planHtml("The kind-agnostic archive"),
    },
  });
  // The bystander is real, present, and a perfectly valid plan directory. The ONLY thing
  // that distinguishes it is that this task did not write it.
  assert.ok(existsSync(join(worktreePath, "docs/plans/recurring-missions/plan.html")));

  const task = mkPlan({ worktreePath, repoRoot, status: "done" });
  h.registry.upsertTask(task);
  assert.equal((await h.tasks.reclaim(task.id)).ok, true);

  const bundles = bundleDir(h, task.id);
  assert.equal(bundles.length, 1, "the bystander must not have minted a bundle of its own");
  const manifest = JSON.parse(readFileSync(join(bundles[0]!, "manifest.json"), "utf8")) as {
    content: { artifacts: Array<{ original_path: string | null }> };
  };
  const origins = manifest.content.artifacts.map((artifact) => artifact.original_path ?? "");
  assert.ok(origins.length > 0);
  for (const origin of origins) {
    assert.ok(
      origin.startsWith("docs/plans/archive-rename/"),
      `${origin} came from a plan this task never touched`,
    );
  }
});

test("a ship task that writes a plan directory is not archived", async () => {
  const h = harness();
  const { repoRoot, worktreePath } = makeCheckout({
    written: {
      "docs/plans/archive-rename/plan.md": "# The kind-agnostic archive\n",
      "docs/plans/archive-rename/plan.html": planHtml("The kind-agnostic archive"),
    },
  });
  // Capture is keyed on the DURABLE KIND, not on what the diff happens to look like.
  const task = mkPlan({ kind: "ship", worktreePath, repoRoot, status: "done" });
  h.registry.upsertTask(task);

  assert.equal((await h.tasks.reclaim(task.id)).ok, true);
  assert.deepEqual(h.archives.captureJobsForTask(task.id), []);
});

// ---------------------------------------------------------------------------
// Every path that destroys a checkout
// ---------------------------------------------------------------------------

test("every teardown path publishes the plan before the checkout goes", async () => {
  for (const action of ["reclaim", "remove", "reschedule", "cancel"] as const) {
    const h = harness();
    const { repoRoot, worktreePath } = makeCheckout({
      written: {
        "docs/plans/archive-rename/plan.md": "# The kind-agnostic archive\n",
        "docs/plans/archive-rename/plan.html": planHtml("The kind-agnostic archive"),
      },
    });
    const task = mkPlan({
      worktreePath,
      repoRoot,
      status: action === "cancel" ? "running" : action === "reschedule" ? "failed" : "done",
    });
    h.registry.upsertTask(task);

    const result = await h.tasks[action](task.id);
    assert.equal(result.ok, true, `${action}: ${result.error ?? "cleanup failed"}`);
    const published = h.archives.captureJobsForTask(task.id).filter((job) => job.status === "published");
    assert.equal(published.length, 1, `${action} must publish the plan before teardown`);
    assert.equal(published[0]!.captureStatus, "complete", `${action} captured the whole plan`);
    assert.equal(published[0]!.kind, "plan");
  }
});

test("startup reconciliation publishes the plan of a task whose agent did not survive", async () => {
  const h = harness();
  const { repoRoot, worktreePath } = makeCheckout({
    written: {
      "docs/plans/archive-rename/plan.md": "# The kind-agnostic archive\n",
      "docs/plans/archive-rename/plan.html": planHtml("The kind-agnostic archive"),
    },
  });
  // No session and no home name, so the startup pass reads the agent as gone and reclaims -
  // the one destructive path the exit listener can never reach, because the agent died with
  // the daemon and no `session_exit` was ever emitted.
  h.registry.upsertTask(mkPlan({ id: "plan-startup", worktreePath, repoRoot, status: "running" }));
  const deadAgent = { taskLiveness: () => false } as unknown as ConstructorParameters<typeof TaskManager>[2];
  new TaskManager(h.registry, undefined, deadAgent, undefined, h.archives);

  await waitFor(() =>
    h.archives.captureJobsForTask("plan-startup").some((job) => job.status === "published"),
  );
  const [job] = h.archives.captureJobsForTask("plan-startup");
  assert.equal(job!.captureStatus, "complete");
});

// ---------------------------------------------------------------------------
// Producing nothing is allowed; failing to capture something is not
// ---------------------------------------------------------------------------

test("a plan task that produced nothing tears down cleanly rather than wedging", async () => {
  const h = harness();
  // The human read the plan, said no, and stopped - or the agent never got that far. Unlike
  // a scout, which cannot complete without an archive, this is an ordinary outcome, and the
  // naive generalization of the scout refusal would hold this worktree for ever.
  const { repoRoot, worktreePath } = makeCheckout({ written: { "notes.md": "thinking about it" } });
  const task = mkPlan({ worktreePath, repoRoot, status: "done" });
  h.registry.upsertTask(task);

  const reclaimed = await h.tasks.reclaim(task.id);
  assert.equal(reclaimed.ok, true, reclaimed.error);
  assert.deepEqual(h.archives.captureJobsForTask(task.id), [], "nothing found, nothing reserved");
  assert.equal(h.registry.getTask(task.id)?.worktreePath, null, "the worktree was released");
});

test("a capture failure refuses the teardown and keeps the resources tracked", async () => {
  const h = harness({ rename: () => Promise.reject(new Error("the disk went away")) });
  const { repoRoot, worktreePath } = makeCheckout({
    written: {
      "docs/plans/archive-rename/plan.md": "# The kind-agnostic archive\n",
      "docs/plans/archive-rename/plan.html": planHtml("The kind-agnostic archive"),
    },
  });
  const task = mkPlan({ worktreePath, repoRoot, status: "done" });
  h.registry.upsertTask(task);

  const refused = await h.tasks.reclaim(task.id);
  assert.equal(refused.ok, false, "a plan that WAS found and could not be published must refuse");
  assert.match(refused.error ?? "", /could not be published/);
  assert.match(refused.error ?? "", /the disk went away/);
  // Still tracked, so the operator gets the ordinary Clean up affordance and a retry.
  assert.equal(h.registry.getTask(task.id)?.worktreePath, worktreePath);
});

test("a checkout that cannot say what it changed archives nothing rather than a stranger's plan", async () => {
  const h = harness();
  // A path that is not a git repository at all: `changedPathsSince` fails closed, and the
  // conservative fallback is the whole point - scanning for `docs/plans/*` here would find
  // the bystander and archive somebody else's work under this task's name.
  const bare = mkdirp(join(home, `not-a-repo-${++seq}`));
  mkdirp(join(bare, "docs/plans/recurring-missions"));
  writeFileSync(join(bare, "docs/plans/recurring-missions/plan.md"), "# Recurring missions\n");
  writeFileSync(join(bare, "docs/plans/recurring-missions/plan.html"), planHtml("Recurring missions"));

  const task = mkPlan({ worktreePath: bare, repoRoot: bare, status: "done" });
  h.registry.upsertTask(task);

  // Asserted at the archive boundary rather than through `reclaim`, because tearing down a
  // directory that is not a worktree fails for its own unrelated reason. What matters here is
  // that the settle does not refuse and does not invent a bundle.
  const settled = await h.archives.settleBeforeCleanup(task.id);
  assert.equal(settled.ok, true, "an unreadable diff must not hold the worktree");
  assert.deepEqual(h.archives.captureJobsForTask(task.id), []);
});

// ---------------------------------------------------------------------------
// Completion is Foreman's ordinary boundary, not an archive gate
// ---------------------------------------------------------------------------

test("a plan task reaches done with no archive at all", async () => {
  const h = harness();
  const { repoRoot, worktreePath } = makeCheckout({
    written: {
      "docs/plans/archive-rename/plan.md": "# The kind-agnostic archive\n",
      "docs/plans/archive-rename/plan.html": planHtml("The kind-agnostic archive"),
    },
  });
  const task = mkPlan({ worktreePath, repoRoot, status: "running" });
  h.registry.upsertTask(task);

  // The approved decision, and the thing a reviewer who knows the scout path will assume was
  // copied: a scout cannot be marked done until its bundle exists and verifies. A plan can,
  // and must - durability happens at teardown instead, which is what the tests above cover.
  const done = await h.tasks.complete(task.id, "planned");
  assert.ok(done, "completion returned no task");
  assert.equal(h.registry.getTask(task.id)?.status, "done");
  assert.deepEqual(
    h.archives.captureJobsForTask(task.id),
    [],
    "completion must not have reserved, captured, or waited on anything",
  );
});

// ---------------------------------------------------------------------------
// What one plan bundle holds
// ---------------------------------------------------------------------------

test("a plan page carrying external documentation links is archived as complete", async () => {
  const h = harness();
  // Real plan pages in this repository link out to external documentation, which is exactly
  // what the navigational relaxation was approved for. A link requests nothing until a human
  // clicks it; this proves the whole path end to end rather than the validator alone.
  const page = planHtml(
    "The kind-agnostic archive",
    '<p>See <a href="https://nodejs.org/api/sqlite.html">node:sqlite</a> and ' +
      '<a href="http://example.com/spec">the spec</a>.</p>',
  );
  const { repoRoot, worktreePath } = makeCheckout({
    written: {
      "docs/plans/archive-rename/plan.md": "# The kind-agnostic archive\n",
      "docs/plans/archive-rename/plan.html": page,
    },
  });
  const task = mkPlan({ worktreePath, repoRoot, status: "done" });
  h.registry.upsertTask(task);

  assert.equal((await h.tasks.reclaim(task.id)).ok, true);
  const [job] = h.archives.captureJobsForTask(task.id);
  assert.equal(job!.captureStatus, "complete", "a clickable external link is not a fetch");
  assert.equal(readFileSync(join(bundleDir(h, task.id)[0]!, ARCHIVE_PRIMARY_REPORT_PATH), "utf8"), page);
});

test("a plan bundle keeps its companions where the page's own links expect them", async () => {
  const h = harness();
  const { repoRoot, worktreePath } = makeCheckout({
    committed: {
      "docs/plans/archive-rename/plan.md": "# The kind-agnostic archive\n",
      "docs/plans/archive-rename/plan.html": planHtml(
        "The kind-agnostic archive",
        '<p>Phases: <a href="./phased-plan.html">index</a>, <a href="./phase-1.md">one</a>.</p>',
      ),
      "docs/plans/archive-rename/phased-plan.html": planHtml("Phased"),
      "docs/plans/archive-rename/phase-1.md": "# Phase 1\n",
      "docs/plans/archive-rename/diagrams/flow.svg": "<svg xmlns='http://www.w3.org/2000/svg'/>",
    },
  });
  const task = mkPlan({ worktreePath, repoRoot, status: "done" });
  h.registry.upsertTask(task);
  assert.equal((await h.tasks.reclaim(task.id)).ok, true);

  // Nested layout preserved, so a relative link inside the page still resolves in the bundle.
  assert.deepEqual(archivedPaths(bundleDir(h, task.id)[0]!), [
    "manifest.json",
    "report/diagrams/flow.svg",
    "report/phase-1.md",
    "report/phased-plan.html",
    "report/plan.md",
    ARCHIVE_PRIMARY_REPORT_PATH,
  ].sort());
});

test("two plan directories become two bundles, each led by its own page", async () => {
  const h = harness();
  const { repoRoot, worktreePath } = makeCheckout({
    committed: {
      "docs/plans/archive-rename/plan.md": "# The kind-agnostic archive\n",
      "docs/plans/archive-rename/plan.html": planHtml("The kind-agnostic archive"),
      "docs/plans/plan-kind/plan.md": "# The plan task kind\n",
      "docs/plans/plan-kind/plan.html": planHtml("The plan task kind"),
    },
  });
  const task = mkPlan({ worktreePath, repoRoot, status: "done" });
  h.registry.upsertTask(task);
  assert.equal((await h.tasks.reclaim(task.id)).ok, true);

  // Never merged: a bundle has exactly one primary artifact, so merging would make one
  // plan's page the primary for the other plan's files.
  const jobs = h.archives.captureJobsForTask(task.id);
  assert.equal(jobs.length, 2);
  assert.deepEqual(
    jobs.map((job) => job.scope?.directory).sort(),
    ["docs/plans/archive-rename", "docs/plans/plan-kind"],
  );
  // Each names itself, so two bundles from one task are told apart in a catalog.
  assert.deepEqual(
    jobs.map((job) => job.title).sort(),
    ["The kind-agnostic archive", "The plan task kind"],
  );
  for (const dir of bundleDir(h, task.id)) {
    assert.ok(existsSync(join(dir, ARCHIVE_PRIMARY_REPORT_PATH)));
  }
});

test("a plan's own text is searchable with no agent-supplied metadata", async () => {
  const h = harness();
  const { repoRoot, worktreePath } = makeCheckout({
    written: {
      "docs/plans/archive-rename/plan.md": "# The kind-agnostic archive\n",
      "docs/plans/archive-rename/plan.html": planHtml(
        "The kind-agnostic archive",
        "<p>The reconciler rebuilds the index from disk.</p>",
      ),
    },
  });
  const task = mkPlan({ worktreePath, repoRoot, status: "done" });
  h.registry.upsertTask(task);
  assert.equal((await h.tasks.reclaim(task.id)).ok, true);
  await h.archives.reconcileNow();

  const query = {
    q: "reconciler rebuilds", producer: null, repo: null, agent: null, kind: "plan" as const,
    status: null, from: null, to: null, cursor: null, limit: 10,
  };
  const page = h.archives.list(query);
  assert.equal(page.archives.length, 1, "the body text alone made it findable");
  assert.equal(page.archives[0]!.kind, "plan");
  assert.equal(page.archives[0]!.title, "The kind-agnostic archive");
  assert.equal(page.archives[0]!.summary, null, "a plan submits nothing, so it claims nothing");
});

test("a plan page that is not self-contained degrades to a partial rather than blocking", async () => {
  const h = harness();
  // An agent that slipped a remote image into its page. Refusing the capture here would
  // refuse every teardown path for this task, permanently and with no way to clear it, to
  // protect a file that is committed and reaches the pull request anyway.
  const { repoRoot, worktreePath } = makeCheckout({
    written: {
      "docs/plans/archive-rename/plan.md": "# The kind-agnostic archive\n",
      "docs/plans/archive-rename/plan.html": planHtml(
        "The kind-agnostic archive",
        '<p><img src="https://example.com/chart.png" alt="chart"></p>',
      ),
    },
  });
  const task = mkPlan({ worktreePath, repoRoot, status: "done" });
  h.registry.upsertTask(task);

  const reclaimed = await h.tasks.reclaim(task.id);
  assert.equal(reclaimed.ok, true, reclaimed.error);
  const [job] = h.archives.captureJobsForTask(task.id);
  assert.equal(job!.captureStatus, "partial", "honest about what it could not lead with");
  // The page is still kept, under its own name, so nothing is lost and the other documents'
  // links to it still resolve.
  const paths = archivedPaths(bundleDir(h, task.id)[0]!);
  assert.ok(paths.includes("report/plan.html"), paths.join(", "));
  assert.ok(paths.includes("report/plan.md"));
  assert.ok(!paths.includes(ARCHIVE_PRIMARY_REPORT_PATH));
});

// ---------------------------------------------------------------------------
// Reserving at the moment a session goes away
// ---------------------------------------------------------------------------

test("a session exiting publishes nothing while the plan task is still live", async () => {
  const h = harness();
  const { repoRoot, worktreePath } = makeCheckout({
    written: {
      "docs/plans/archive-rename/plan.md": "# The kind-agnostic archive\n",
      "docs/plans/archive-rename/plan.html": planHtml("The kind-agnostic archive"),
    },
  });
  const task = mkPlan({ worktreePath, repoRoot, status: "running" });
  const session = {
    ...({} as Session),
    id: `sess-${++seq}`,
    agent: "claude",
    runtime: "terminal",
    origin: "dispatch",
    name: "agent",
    state: "idle",
    cwd: worktreePath,
    repoRoot: worktreePath,
    instrumented: true,
    pendingReviews: 0,
    meta: null,
  } as Session;
  (h.registry as unknown as { sessions: Map<string, Session> }).sessions.set(session.id, session);
  h.registry.upsertTask({ ...task, sessionId: session.id });

  // The exit listener fires while the task is still `running` - that is the condition it
  // selects for. A scout publishes here because its report is untracked and its session was
  // the only thing that could have submitted it. A plan must NOT, because an archive is
  // immutable and this is not the end of the work.
  h.archives.reserveOnExit(session);
  await settle();
  assert.deepEqual(
    h.archives.captureJobsForTask(task.id),
    [],
    "an exiting session must not freeze a plan that is still being written",
  );

  // The proof that the exclusion matters rather than merely being tidy: the plan changes
  // after that exit, and it is the FINAL text that gets archived. Had the exit published,
  // the teardown would have found a published job under the same scoped key and replayed
  // its verification instead of capturing again - so the draft would have won permanently.
  writeFileSync(
    join(worktreePath, "docs/plans/archive-rename/plan.html"),
    planHtml("The kind-agnostic archive", "<p>The conclusion the human actually approved.</p>"),
  );
  h.registry.upsertTask({ ...task, sessionId: session.id, status: "done" });
  assert.equal((await h.tasks.reclaim(task.id)).ok, true);

  const [job] = h.archives.captureJobsForTask(task.id);
  assert.equal(job!.kind, "plan");
  assert.equal(job!.captureStatus, "complete");
  assert.equal(job!.scope?.directory, "docs/plans/archive-rename");
  assert.match(
    readFileSync(join(bundleDir(h, task.id)[0]!, ARCHIVE_PRIMARY_REPORT_PATH), "utf8"),
    /the human actually approved/,
    "the archive holds the plan as it finally stood, not as it stood at the exit",
  );
});

test("settling twice publishes one bundle, not two", async () => {
  const h = harness();
  const { repoRoot, worktreePath } = makeCheckout({
    written: {
      "docs/plans/archive-rename/plan.md": "# The kind-agnostic archive\n",
      "docs/plans/archive-rename/plan.html": planHtml("The kind-agnostic archive"),
    },
  });
  const task = mkPlan({ worktreePath, repoRoot, status: "done" });
  h.registry.upsertTask(task);

  // Two teardown paths in a row - cancel then remove, or a retried reclaim. The scoped
  // operation key is what makes them converge rather than mint a second archive of the
  // same plan.
  await h.archives.settleBeforeCleanup(task.id);
  await h.archives.settleBeforeCleanup(task.id);
  assert.equal(h.archives.captureJobsForTask(task.id).length, 1);
});

test("a checkout that vanished after a refusal publishes an honest partial, not a wedge", async () => {
  const h = harness({ rename: () => Promise.reject(new Error("the disk went away")) });
  const { repoRoot, worktreePath } = makeCheckout({
    written: {
      "docs/plans/archive-rename/plan.md": "# The kind-agnostic archive\n",
      "docs/plans/archive-rename/plan.html": planHtml("The kind-agnostic archive"),
    },
  });
  const task = mkPlan({ worktreePath, repoRoot, status: "done" });
  h.registry.upsertTask(task);
  assert.equal((await h.archives.settleBeforeCleanup(task.id)).ok, false, "the job is reserved and failing");

  // The operator removed the tree by hand rather than retrying. The reserved job now points
  // at a checkout that is gone, and the one thing it must not do is refuse for ever over
  // files that were committed and are in the pull request.
  rmSync(worktreePath, { recursive: true, force: true });
  const healthy = new ArchiveManager({
    root: h.library,
    tasks: new RegistryArchiveTaskGateway(h.registry),
    intervalMs: null,
    watch: false,
    log: () => {},
  });
  const settled = await healthy.settleBeforeCleanup(task.id);
  assert.equal(settled.ok, true, "error" in settled ? settled.error : "");
  const [job] = healthy.captureJobsForTask(task.id);
  assert.equal(job!.captureStatus, "partial", "it says what it could not reach rather than claiming a plan");
});

// ---------------------------------------------------------------------------
// The two server-derived answers everything above rests on
// ---------------------------------------------------------------------------

test("a plan directory is one named segment under docs/plans, and a loose file is not one", () => {
  const cases: Array<[string, string | null]> = [
    ["docs/plans/plan-kind/plan.md", "docs/plans/plan-kind"],
    ["docs/plans/plan-kind/diagrams/flow.svg", "docs/plans/plan-kind"],
    // A real file this repository holds directly under `docs/plans/`. Reading it as a
    // directory would name a path that is not there.
    ["docs/plans/migrate-electron.md", null],
    ["docs/plans/", null],
    ["docs/plansible/x/plan.md", null],
    ["docs/reports/resume/report.html", null],
    ["src/server/plans/prompt.ts", null],
  ];
  for (const [input, expected] of cases) {
    assert.equal(planDirectoryOf(input), expected, input);
  }
});

test("changed paths name what a branch added, and never what it only deleted", async () => {
  const { worktreePath } = makeCheckout({
    committed: { "docs/plans/archive-rename/plan.md": "# The kind-agnostic archive\n" },
    written: { "docs/plans/archive-rename/plan.html": planHtml("The kind-agnostic archive") },
  });
  // A file the BASE branch carries, removed on this branch. `changedPaths` reads new-side
  // paths off a diff and so drops it; this must agree, because a path that no longer exists
  // cannot be captured and must not be reported as though it could.
  execFileSync("git", ["rm", "-q", "docs/plans/recurring-missions/plan.html"], { cwd: worktreePath });

  const changed = await changedPathsSince(worktreePath);
  assert.equal(changed.ok, true);
  if (!changed.ok) return;
  assert.ok(changed.paths.includes("docs/plans/archive-rename/plan.md"), "a committed change");
  assert.ok(changed.paths.includes("docs/plans/archive-rename/plan.html"), "an uncommitted one");
  assert.ok(
    !changed.paths.includes("docs/plans/recurring-missions/plan.html"),
    "a deletion is not a path that can be archived",
  );
  // And the bystander's surviving file is still absent: it was never touched.
  assert.ok(!changed.paths.includes("docs/plans/recurring-missions/plan.md"));
});

test("changed paths fail closed rather than answering that nothing changed", async () => {
  const notARepo = mkdirp(join(home, `plain-dir-${++seq}`));
  const changed = await changedPathsSince(notARepo);
  assert.equal(changed.ok, false, "an empty list here would read as a task that wrote nothing");
});

/** Let any work an inline listener kicked off run, so "nothing happened" is a real result. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 20));
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("condition was never met");
}
