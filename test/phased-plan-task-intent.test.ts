import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PrMatch } from "../src/server/registry.ts";
import type { QueueManager } from "../src/server/queue.ts";
import type { ReviewManager } from "../src/server/reviews.ts";

/**
 * What a phased-plan run actually PUBLISHES, checked on the far side of publication.
 *
 * The task text is not documentation. It is delivered verbatim as the implementing agent's
 * opening prompt (`dispatcher.ts`: `prompt: task.intent`), and from there it becomes the
 * session's recorded human goal - which conformance review scores as the user's explicit
 * requirement. So a phase plan pasted into a task does not read as "helpful context", it
 * reads as a contract the agent is failed for deviating from, and that deviation is exactly
 * what an agent must stay free to do when the repository disagrees with the plan.
 *
 * Carrying paths instead of content is only safe if those paths resolve by the time the task
 * runs, so this exercises the whole delivery chain in the order the skill mandates it: write
 * the artifacts, PUSH them (a local commit does not survive a reclaimed worktree), verify
 * every exact path resolves in that pushed commit, and only THEN create the task.
 *
 * There is exactly ONE delivery condition, and the skill names it: the planning session's PR
 * merge. That single event both puts the referenced files on the default branch and satisfies
 * the dependency edge holding the task in the backlog - so the task can never be released
 * into a repository where its own instructions are unreadable. The fixture models it as one
 * step with two observable halves, and checks both before and after.
 *
 * On the ordering, which looks wrong until you know why it is not: the task is created while
 * its files are still only on the pushed planning branch, and the assertions here deliberately
 * require that the default branch does NOT yet carry them. Publishing to the default branch
 * before scheduling was considered and rejected as a product decision - scheduling first is
 * what lets the tasks sit in the backlog and release themselves whenever the human merges,
 * instead of requiring the planning session to still be alive at merge time. Verifying the
 * PUSHED commit is therefore the correct pre-flight, and the merge is the delivery. Changing
 * this ordering changes when Mission Control schedules work; do not "fix" it in the fixture.
 */

const home = mkdtempSync(join(tmpdir(), "mission-phased-plan-intent-home-"));
const repos = mkdtempSync(join(tmpdir(), "mission-phased-plan-intent-repos-"));
process.env.HARNESS_HOME = home;

// Dynamic, so the env above is set before any module reads it.
const { ensureToken } = await import("../src/server/auth.ts");
const { Registry } = await import("../src/server/registry.ts");
const { buildApp } = await import("../src/server/routes.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { clampPrompt } = await import("../src/server/util/prompt-text.ts");

after(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repos, { recursive: true, force: true });
});

const DEFAULT_BRANCH = "main";
const PLAN_BRANCH = "plan/recurring-missions";

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

/**
 * A working repository wired to a real remote, so "published" means pushed rather than
 * merely committed locally. A reclaimed worktree is the failure this guards, and a local
 * commit does not survive one.
 */
function gitRepo(name: string): { repo: string; origin: string } {
  const origin = join(repos, `${name}-origin.git`);
  mkdirSync(origin, { recursive: true });
  execFileSync("git", ["-C", origin, "init", "-q", "--bare", "-b", DEFAULT_BRANCH]);

  const dir = join(repos, name);
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["-C", dir, "init", "-q", "-b", DEFAULT_BRANCH]);
  git(dir, "config", "user.email", "fixture@example.test");
  git(dir, "config", "user.name", "Fixture");
  writeFileSync(join(dir, "README.md"), "# fixture\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-q", "-m", "initial");
  git(dir, "remote", "add", "origin", origin);
  git(dir, "push", "-q", "-u", "origin", DEFAULT_BRANCH);
  return { repo: realpathSync(dir), origin: realpathSync(origin) };
}

/** Does this exact path resolve from `ref` in `repo`? */
function resolvesAt(repo: string, ref: string, path: string): boolean {
  try {
    execFileSync("git", ["-C", repo, "cat-file", "-e", `${ref}:${path}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function readAt(repo: string, ref: string, path: string): string {
  return git(repo, "show", `${ref}:${path}`);
}

/**
 * The representative phase task a phased-plan run publishes: the worked `intent` the skill
 * instructs the author to imitate, read from the shipped skill itself so the fixture cannot
 * drift away from what the skill actually teaches.
 */
function representativePhaseIntent(): string {
  const text = readFileSync(new URL("../skills/phased-plan/SKILL.md", import.meta.url), "utf8");
  const marker = "A well-formed `intent` reads like a person asking for the feature:";
  const at = text.indexOf(marker);
  assert.ok(at >= 0, "the skill should show a worked intent, not only describe one");

  const quoted: string[] = [];
  for (const line of text.slice(at + marker.length).split("\n")) {
    if (line.trim() === "") {
      if (quoted.length > 0) quoted.push("");
      continue;
    }
    if (!line.startsWith(">")) break;
    quoted.push(line.replace(/^>\s?/, ""));
  }
  return quoted.join("\n").trim();
}

/** Every plan document the task points at, read back out of the task's own text. */
function referencedPlanPaths(intent: string): string[] {
  return [...new Set(intent.match(/docs\/plans\/[a-z0-9-]+\/[a-z0-9-]+\.md/g) ?? [])];
}

/** The contract a published phase task's `intent` must satisfy. */
function assertPublishedIntentContract(intent: string): void {
  assert.ok(intent.length > 0, "a published task should carry an intent");

  // A goal, stated before any path, in the words a human would use.
  const [opening] = intent.split("\n\n");
  assert.ok(opening, "intent should open with a goal paragraph");
  assert.doesNotMatch(opening, /\.md\b/, "the goal comes before the pointers, not after");

  // Pointers to the plan documents, so the detail is referenced rather than inlined.
  assert.match(intent, /docs\/plans\/[a-z0-9-]+\/plan\.md/);
  assert.match(intent, /docs\/plans\/[a-z0-9-]+\/phased-plan\.md/);
  assert.match(intent, /docs\/plans\/[a-z0-9-]+\/phase-\d+-[a-z0-9-]+\.md/);

  // The plan is a route, not a spec. An agent that deviates with reason still conforms.
  assert.match(intent, /not a specification/);
  assert.match(intent, /judgement/);
  assert.match(intent, /deviation/);

  // Boundaries and the verification bar.
  assert.match(intent, /Implement only this phase/);
  assert.match(intent, /pull request/);

  // No implementation detail - the failure this contract exists to prevent.
  assert.doesNotMatch(intent, /^#{1,6} /m, "no embedded Markdown headings");
  assert.doesNotMatch(intent, /^\s*[-*] \[[ x]\]/m, "no acceptance checklists");
  assert.doesNotMatch(intent, /^\s*\d+\.\s/m, "no numbered implementation steps");
  assert.doesNotMatch(intent, /```/, "no embedded code or schema blocks");
}

/** The detail that leaves the task lands here: a phase file that stands on its own. */
function phaseFileBody(path: string): string {
  if (path.endsWith("plan.md") && !path.includes("phased")) {
    return "# Recurring missions\n\nThe approved product goal and its submitted decisions.\n";
  }
  if (path.endsWith("phased-plan.md")) {
    return "# Phased plan\n\n| Phase | Depends on |\n| --- | --- |\n| 1 | - |\n";
  }
  return [
    "# Phase 1: Durable schedule foundation",
    "",
    "## Implementation steps",
    "",
    "1. Add the `schedules` table in `src/server/db.ts` with `addColumn` beside its upgrade path.",
    "2. Wire the durable store in `src/server/schedules/store.ts`.",
    "",
    "## Exit criteria",
    "",
    "- [ ] the migration is idempotent on an existing database",
    "- [ ] a due window fires exactly once across a restart",
    "",
    "## Cross-phase audit record",
    "",
    "Phase 2 consumes the store contract and must not change its column names.",
    "",
  ].join("\n");
}

function prMatch(over: Partial<PrMatch> = {}): PrMatch {
  const result: PrMatch = {
    url: "https://github.com/example/repo/pull/7",
    number: 7,
    state: "open",
    checks: null,
    branch: PLAN_BRANCH,
    agentSessionId: null,
    episodeId: null,
    createdAt: null,
    mergedAt: null,
    // A PR is only bound to an episode when its head is known and it belongs to that episode
    // (`acceptPrForEpisode`), so a fixture without these is silently ignored.
    headSha: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c",
    worktreeHeadSha: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c",
    ...over,
  };
  if (result.state === "merged" && result.mergedAt === null) result.mergedAt = Date.now();
  return result;
}

test("the planning PR merge both publishes the plan files and releases the phase task", async () => {
  const { repo, origin } = gitRepo("published-phase-task");
  const registry = new Registry();
  const tasks = new TaskManager(registry);

  // The task text the skill publishes, and the exact paths it will name. An author knows
  // both before scheduling, which is what makes the pre-flight check below possible.
  const published = representativePhaseIntent();
  const referenced = referencedPlanPaths(published);
  assert.deepEqual(referenced.toSorted(), [
    "docs/plans/recurring-missions/phase-1-durable-schedule-foundation.md",
    "docs/plans/recurring-missions/phased-plan.md",
    "docs/plans/recurring-missions/plan.md",
  ]);

  // 1. WRITE the artifacts on the planning branch.
  git(repo, "checkout", "-q", "-b", PLAN_BRANCH);
  for (const path of referenced) {
    const absolute = join(repo, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, phaseFileBody(path));
  }
  git(repo, "add", "docs");
  git(repo, "commit", "-q", "-m", "Add recurring-missions phased plan");

  // 2. PUSH them, and VERIFY every exact path resolves in the pushed commit. This is the
  //    skill's pre-scheduling requirement, and it is what makes a path-only task safe to
  //    create at all: a local commit does not survive a reclaimed planning worktree.
  git(repo, "push", "-q", "origin", PLAN_BRANCH);
  for (const path of referenced) {
    assert.equal(
      resolvesAt(repo, `origin/${PLAN_BRANCH}`, path),
      true,
      `${path} must resolve in the pushed commit before its task is created`,
    );
    assert.ok(readAt(repo, `origin/${PLAN_BRANCH}`, path).trim().length > 0);
  }

  // The detail the task deliberately omits really is in the phase file, not lost: the steps,
  // checklist, and cross-phase contract an implementing agent needs to do the work.
  const phaseFile = readAt(
    repo,
    `origin/${PLAN_BRANCH}`,
    "docs/plans/recurring-missions/phase-1-durable-schedule-foundation.md",
  );
  assert.match(phaseFile, /^#{1,6} /m);
  assert.match(phaseFile, /^\s*\d+\.\s/m);
  assert.match(phaseFile, /^\s*- \[ \]/m);
  assert.match(phaseFile, /Cross-phase audit record/);

  // 3. CREATE the phase task, through the `create_task` MCP tool's own route.
  registry.applyDiscovery([
    {
      syntheticId: "planning-session",
      agent: "claude",
      name: "phase the plan",
      nameSource: "process",
      cwd: repo,
      gitBranch: PLAN_BRANCH,
      gitRoot: repo,
      repoRoot: repo,
      pid: 101,
      tty: null,
      terminals: [],
      startedAt: Date.now(),
    },
  ]);
  registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: "planning-agent-session",
    cwd: repo,
    transcriptPath: null,
    env: {},
  });
  const planningSession = registry
    .snapshot()
    .sessions.find((session) => session.name === "phase the plan");
  assert.ok(planningSession);
  const episode = registry.workEpisodeForSession(planningSession.id);
  assert.ok(episode);

  const app = buildApp(registry, {} as ReviewManager, tasks, {} as QueueManager);
  const response = await app.request("/mcp/tasks", {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": ensureToken() },
    body: JSON.stringify({
      env: {},
      sessionId: "planning-agent-session",
      cwd: repo,
      repoRoot: repo,
      title: "Implement Recurring Missions - Phase 1: Durable schedule foundation",
      intent: published,
      dependsOnTaskIds: [],
      dependsOnCurrentSession: true,
    }),
  });
  assert.equal(response.status, 200);
  const created = (await response.json()) as { id: string };

  // Read it back out of the store rather than trusting the response echo. This is the record
  // the dispatcher later reads `intent` off of to build the agent's prompt.
  const stored = tasks.get(created.id);
  assert.ok(stored, "the published task should be retrievable from the store");
  assertPublishedIntentContract(stored.intent);
  assert.deepEqual(
    referencedPlanPaths(stored.intent).toSorted(),
    referenced.toSorted(),
    "the stored task must name exactly the paths that were verified as pushed",
  );

  // The whole requirement survives into the recorded goal the judge reads. A pasted phase
  // document would not: `clampPrompt` keeps head 3000 + tail 1000 and elides the middle,
  // silently promoting whatever fragment lands at the edges into the requirement.
  assert.equal(
    clampPrompt(stored.intent),
    stored.intent,
    "a published intent must survive the recorded-goal clamp intact",
  );

  // 4. BEFORE the delivery condition: the files are not on the default branch an implementing
  //    agent would receive, and the task is correspondingly gated. One condition governs both.
  const receiving = join(repos, "receiving-checkout");
  execFileSync("git", ["clone", "-q", origin, receiving]);
  for (const path of referenced) {
    assert.equal(
      resolvesAt(receiving, `origin/${DEFAULT_BRANCH}`, path),
      false,
      `${path} should not be on the default branch before the planning PR merges`,
    );
  }
  assert.equal(stored.status, "backlog");
  assert.equal(stored.dependencies.length, 1);
  assert.equal(stored.dependencies[0]?.type, "session");
  assert.equal(
    stored.dependencies[0]?.satisfiedAt,
    null,
    "the task must stay gated until the planning PR merges",
  );

  // 5. THE DELIVERY CONDITION, as a single event: the planning session's PR merges. Its two
  //    observable halves are the artifacts landing on the default branch and the dependency
  //    edge being satisfied - which is exactly what the skill documents.
  git(repo, "checkout", "-q", DEFAULT_BRANCH);
  git(repo, "merge", "-q", "--no-ff", PLAN_BRANCH, "-m", "Merge the phased plan");
  git(repo, "push", "-q", "origin", DEFAULT_BRANCH);
  registry.reconcilePrs(
    new Map([
      [
        planningSession.id,
        prMatch({
          state: "merged",
          checks: "passing",
          agentSessionId: episode.agentSessionId,
          episodeId: episode.episodeId,
          createdAt: episode.startedAt,
        }),
      ],
    ]),
    new Set(),
  );

  // 6. AFTER it: the same merge that released the task also put every referenced path on the
  //    default branch, so the agent it releases can read them from a fresh checkout.
  git(receiving, "fetch", "-q", "origin");
  for (const path of referenced) {
    assert.equal(
      resolvesAt(receiving, `origin/${DEFAULT_BRANCH}`, path),
      true,
      `${path} must resolve from the receiving default branch once the planning PR merges`,
    );
    assert.ok(readAt(receiving, `origin/${DEFAULT_BRANCH}`, path).trim().length > 0);
  }
  assert.ok(
    registry.getTask(created.id)?.dependencies[0]?.satisfiedAt,
    "the merge that publishes the plan files must also release the phase task",
  );
});

test("publishing a phase plan as the task text violates the contract", async () => {
  const { repo } = gitRepo("pasted-phase-plan");
  const registry = new Registry();
  const tasks = new TaskManager(registry);

  // The regression this change exists to prevent, in the exact shape the skill used to
  // instruct: the good goal and pointers, then the phase document appended under an
  // "Authoritative phase instructions" heading. Keeping the pointers is what makes this a
  // real negative control - only the embedded detail differs from a conforming task.
  const pasted = [
    representativePhaseIntent(),
    "",
    "## Authoritative phase instructions",
    "",
    "1. Add the `schedules` table in `src/server/db.ts`.",
    "2. Wire the store in `src/server/schedules/store.ts`.",
    "",
    "- [ ] migration is idempotent",
    "",
    "filler detail that a plan document is full of. ".repeat(120),
  ].join("\n");

  const app = buildApp(registry, {} as ReviewManager, tasks, {} as QueueManager);
  const response = await app.request("/mcp/tasks", {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": ensureToken() },
    body: JSON.stringify({
      env: {},
      cwd: repo,
      repoRoot: repo,
      title: "Implement Recurring Missions - Phase 1: Durable schedule foundation",
      intent: pasted,
      dependsOnTaskIds: [],
      dependsOnCurrentSession: false,
    }),
  });
  assert.equal(response.status, 200);
  const created = (await response.json()) as { id: string };
  const stored = tasks.get(created.id);
  assert.ok(stored);

  // Proves the contract has teeth: it rejects the old format on a real published task.
  assert.throws(() => assertPublishedIntentContract(stored.intent), /no embedded Markdown headings/);

  // And proves the clamp bites on a pasted document, losing its middle.
  assert.notEqual(clampPrompt(stored.intent), stored.intent);
  assert.match(clampPrompt(stored.intent), /\[…\]/);
});
