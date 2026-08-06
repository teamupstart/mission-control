#!/usr/bin/env node
/**
 * Seed `~/.mission-control-demo` with a lived-in fleet, so `npm run demo -- --fresh` opens
 * onto work in progress instead of an empty dashboard.
 *
 * THE MECHANISM: replay, not fabrication. This boots the demo daemon quietly, drives the
 * same public HTTP routes the dashboard and the e2e suite drive - create a task, dispatch it,
 * raise a review, publish a workflow, submit a run, post telemetry - and then stops the
 * daemon. What those routes leave behind IS the seeded fleet: real rows written by the real
 * daemon, real JSONL transcripts written by the scenario players, real git worktrees with
 * real uncommitted edits in them. Nothing here writes to SQLite, and nothing here invents a
 * row shape a route would not have produced (see "WHY NO DIRECT DB WRITES" below).
 *
 * THE ONE TRICK WORTH KNOWING: suspended session cards are not fabricated either. An
 * embedded session whose daemon shuts down cleanly is recorded `suspended`
 * (`SdkSupervisor.stopAll` -> `endStatus()`), and the NEXT daemon relaunches it as a
 * resumable card carrying the whole conversation (`SdkSupervisor.restore` -> `resume`). So
 * this seeder gets its session cards by dispatching real sessions and then stopping the
 * daemon over them - which is also why `fake-claude.mjs` has to honour `--resume=<id>` and
 * append to the transcript already at that path rather than truncating it.
 *
 * A session still mid-turn at that shutdown keeps `turnInProgress`, and the restore sends it
 * a continuation prompt ("...ask again for any approval or input you still need"). That is
 * how the seeded fleet has a genuinely waiting-on-you CARD at first paint rather than only a
 * durable review row: `seed-cursor-pagination.json` stops on an `ask`, and
 * `resume-continuation.json` matches that continuation prompt and asks again.
 *
 * THE SECOND TRICK: the Workflow run is a real review, not a completed formality. Its five
 * reviewers are real Persona nodes whose verdicts come back through `claude -p` - the same
 * headless protocol the titler and the goal refiner use, answered by `fake-claude.mjs`'s
 * `personaVerdict` with a schema-valid pass. That is what makes ONE CLEAN end-to-end completion
 * seedable at all: a Persona review has no degradation path (an unparseable verdict is an
 * infrastructure failure, and three of those block the run), so the alternatives were a real
 * pipeline with scripted verdicts, or the two-node stub this replaced whose "completed" run had
 * reviewed nothing. `reviewOutcome` is what refuses to ship the difference silently.
 *
 * WHY NO DIRECT DB WRITES. The phase plan allowed `usage_ledger` inserts through `node:sqlite`
 * as a documented fallback, on the finding that no public route feeds arbitrary ledger
 * history. That finding does not hold: `POST /v1/metrics` stamps each row from the
 * DATAPOINT's own `timeUnixNano` (`Registry.applyOtelMetrics` -> `epochMsFromNanos`), not
 * from `Date.now()`, and `POST /api/usage/automation` takes an arbitrary `ts`. Backdating is
 * therefore a first-class property of both ingest routes, so the ledger is seeded the same
 * way everything else here is - and the daemon stays the only writer at every moment,
 * including this one.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { assertDemoRoot, bootDaemon, buildDaemonEnv, holdSignals } from "./launch.mjs";

const DAY_MS = 86_400_000;

/**
 * Run statuses worth stopping a wait on: the three terminal ones
 * (`WORKFLOW_RUN_TERMINAL_STATUSES`) plus `blocked`, which is not terminal but is settled -
 * a run that reached it is not going to move again without a human, so waiting past it would
 * only turn a reportable outcome into a timeout.
 */
export const WORKFLOW_RUN_SETTLED = ["completed", "cancelled", "failed", "blocked"];

/**
 * What the seeded run turned out to be, read from the run detail the dashboard reads.
 *
 * "Completed" alone is too weak a claim to seed a demo on. A run can complete having reviewed
 * nothing, and it can complete on round three after two refusals and a provider retry - both are
 * completions, and neither is the thing this seed exists to show. So `clean` means all of it at
 * once: it completed, it did so on the FIRST round, every gate in the pipeline cleared, every
 * reviewer answered pass, and no attempt errored or was retried.
 *
 * Checks are counted APART from reviewers rather than lumped in with them. Both carry a verdict -
 * a Check's is synthetic, which is what lets a join aggregate the two kinds together - but a
 * `skipped` check that passed because no command is configured is a different claim from a
 * reviewer that read the diff and had no objection, and a summary that said "7 reviewers passed"
 * would be overstating what this demo actually demonstrates.
 *
 * Pure, and separated from the HTTP that fetches the detail, so `test/demo-seed.test.ts` can hand
 * it the shapes a real run produces - including the unhappy ones nobody wants to reproduce by
 * hand - and pin what it calls clean.
 */
export function reviewOutcome(detail) {
  const run = detail?.run ?? {};
  const summary = detail?.summary ?? {};
  const attempts = Array.isArray(detail?.attempts) ? detail.attempts : [];
  // By the VERDICT an attempt carries: the `session`, join and `end` attempts are structure the
  // engine synthesizes, so counting rows would call a run that reviewed nothing unanimous - which
  // is exactly what the graph this replaced produced.
  const verdictOf = (attempt) => (attempt.verdict && typeof attempt.verdict === "object"
    ? attempt.verdict.verdict
    : null);
  const judged = attempts
    .filter((attempt) => verdictOf(attempt) !== null)
    .map((attempt) => ({
      // A Check attempt carries no Persona snapshot, which is also how the run detail tells the
      // two apart when it decides whether to draw a check card or a verdict card.
      name: attempt.persona?.name ?? attempt.nodeId,
      verdict: verdictOf(attempt),
      attempt: attempt.attempt,
      kind: attempt.persona ? "reviewer" : "check",
    }));
  const reviewers = judged.filter((item) => item.kind === "reviewer");
  const checks = judged.filter((item) => item.kind === "check");
  const refused = judged.filter((item) => item.verdict !== "pass");
  const errored = attempts.filter((attempt) => attempt.state === "error" || attempt.error);
  const retried = attempts.filter((attempt) => attempt.attempt > 1);
  const round = summary.round ?? 1;
  const clean = run.status === "completed"
    && round === 1
    && (summary.failedPersonaCount ?? 0) === 0
    && reviewers.length > 0
    && refused.length === 0
    && errored.length === 0
    && retried.length === 0;
  const problems = [
    ...(run.status === "completed" ? [] : [`status ${run.status} (${run.currentPhase})`]),
    ...(round === 1 ? [] : [`reached round ${round}`]),
    ...(reviewers.length === 0 ? ["no reviewer ever answered"] : []),
    ...(refused.length === 0 ? [] : [`${refused.length} did not pass`]),
    ...(errored.length === 0 ? [] : [`${errored.length} attempt(s) errored`]),
    ...(retried.length === 0 ? [] : [`${retried.length} attempt(s) retried`]),
  ];
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return {
    status: run.status ?? "unknown",
    clean,
    reviewers,
    checks,
    round,
    summary: clean
      ? [
          checks.length === 0 ? null : `${plural(checks.length, "check")} cleared`,
          `${plural(reviewers.length, "reviewer")} passed on round 1, no retries`,
        ].filter(Boolean).join(", ")
      : problems.join("; "),
  };
}

// --- the seed plan (pure data, so it can be asserted without booting anything) --------------

/**
 * Tasks that get a real dispatch, a real worktree, and a real played scenario.
 *
 * `intent` is load-bearing twice over: it is what the operator reads on the card, and it is
 * what the players match a scenario against. Each one below routes to exactly one
 * `seed-*.json`, and none of them collide with the three live-dispatch starter scenarios -
 * `test/demo-seed.test.ts` pins that routing, because a silent collision would show up only
 * as a demo whose conversation is about the wrong task.
 */
export const SEED_SESSION_TASKS = [
  {
    key: "scan",
    repo: "demo-api",
    title: "Cache the workspace repo scan",
    intent: "Cache the workspace repo scan so the dispatch modal opens instantly.",
    priority: "high",
    labels: ["performance", "dashboard"],
    /** Completed work, marked done by hand - a reclaimable done-with-worktree card. */
    settle: "complete",
  },
  {
    key: "token",
    repo: "demo-web",
    title: "Stop the token refresh double-fetch",
    intent: "Stop the token refresh double-fetch in the auth client.",
    priority: "blocker",
    labels: ["auth", "bug"],
    /** Finished its turn and left running: work done, nobody has accepted it yet. */
    settle: "leave-running",
  },
  {
    key: "pagination",
    repo: "demo-api",
    title: "Move the ledger to cursor pagination",
    intent: "Move the ledger view to cursor pagination.",
    priority: "med",
    labels: ["api"],
    /** Stops on a question. Restored as the waiting-on-you card. */
    settle: "leave-waiting",
  },
  {
    key: "probe",
    repo: "demo-web",
    title: "Add a health probe to the OTLP exporter",
    intent: "Add a health probe to the OTLP exporter so a wedged collector is visible.",
    priority: "med",
    labels: ["observability"],
    /** The one a Workflow run is bound to, so the Runs page has history. */
    settle: "workflow",
  },
  {
    key: "ui-polish",
    repo: "demo-web",
    title: "UI Polish",
    intent: "UI polish: even out the card header chips, one truncation rule, keep the focus ring.",
    priority: "low",
    labels: ["dashboard", "ui"],
    /**
     * Parked on a question, which is also what HOLDS the messages queued below.
     *
     * `PendingTurnManager.canDrain` requires `paneDialog === null`, so an outbox on a card with a
     * held question waits rather than draining - the same rule that makes queueing useful to a
     * person in the first place. Left `leave-running` (idle), these three would be typed into the
     * session about a second and a half after the demo opened, and the queue nobody got to see
     * would be the point of the card.
     */
    settle: "leave-waiting",
    /**
     * The outbox, in the order it will be delivered. Every one of them is a real follow-up
     * somebody would type while an agent is blocked on them, and the first still reads correctly
     * after the question is answered - a queue whose head contradicts the answer would be a demo
     * of a mistake.
     */
    queuedMessages: [
      "While you are in there: the truncation helper needs to cover the board tile too - it cuts"
      + " at a fixed 24 characters today and disagrees with the card about the same session.",
      "Please keep the focus ring on the chips that became buttons. Losing it is how this became"
      + " keyboard-hostile last time.",
      "Once the header is even, take a screenshot at 1280 and at 1600 and put both in the PR"
      + " description - the reviewer should not have to resize a window to see the fix.",
    ],
  },
];

/**
 * Backlog texture: ready, blocked, parked, and one abandoned.
 *
 * "Blocked" and "parked" are not task statuses - there are only six of those and neither is
 * among them. Blocked is a backlog task with an unmet `dependencies` edge; parked is
 * `enabled: false`. Both are reached here the way the dashboard reaches them.
 */
export const SEED_BACKLOG_TASKS = [
  {
    key: "ingest",
    repo: "demo-api",
    title: "Retire the legacy /v1/ingest route",
    intent: "Retire the legacy /v1/ingest route and fold its callers onto /v1/metrics.",
    priority: "high",
    labels: ["api", "cleanup"],
  },
  {
    key: "pool-docs",
    repo: "demo-api",
    title: "Document the worktree pool lease protocol",
    intent: "Write up how a pool lease is taken, verified and handed back.",
    priority: "low",
    labels: ["docs"],
    /** Waits on `ingest`, so the backlog shows a real blocker rather than a flat list. */
    dependsOn: "ingest",
  },
  {
    key: "sse-batch",
    repo: "demo-web",
    title: "Batch the SSE session_upsert frames",
    intent: "Coalesce session_upsert frames within a tick so a busy fleet stops thrashing the client.",
    priority: "med",
    labels: ["performance"],
    /** Parked: a real idea nobody wants Foreman scheduling yet. */
    park: true,
  },
  {
    key: "shortcut",
    repo: "demo-web",
    title: "Add a shortcut for Focus next waiting",
    intent: "Bind a key that jumps to the next session waiting on a human.",
    priority: "low",
    labels: ["dashboard"],
  },
  {
    key: "renderer",
    repo: "demo-web",
    title: "Try the experimental cursor renderer",
    intent: "Evaluate the experimental cursor renderer against the current one.",
    priority: "low",
    labels: ["spike"],
    /** Cancelled, so the board is not uniformly hopeful. */
    cancel: true,
  },
];

/** Recurring Missions, so the schedule spine has something on it. */
export const SEED_SCHEDULES = [
  {
    repo: "demo-api",
    name: "Nightly dependency audit",
    expression: "0 3 * * *",
    overlapPolicy: "skip-active",
    missedPolicy: "coalesce-latest",
    title: "Audit dependencies for advisories",
    intent: "Check every dependency for new advisories and open a task for anything actionable.",
    priority: "med",
    labels: ["audit"],
  },
  {
    repo: "demo-web",
    name: "Weekly flake sweep",
    expression: "0 9 * * 1",
    overlapPolicy: "skip-active",
    missedPolicy: "skip",
    title: "Sweep the suite for flaky tests",
    intent: "Run the suite ten times and report any test that did not agree with itself.",
    priority: "low",
    labels: ["tests"],
  },
];

/**
 * One custom Persona, so the Library shows something beside the built-ins - and so the seeded
 * Workflow has a reviewer an operator can see they WROTE, reviewing in the same stage as the
 * shipped roles (`workflowDraft`).
 */
export const SEED_PERSONA = {
  name: "Demo test-first reviewer",
  description: "Refuses a diff whose behaviour change has no failing-first test.",
  guidanceMarkdown: [
    // The heading matches `name` on purpose: `personaNameFromMarkdown` reads a Persona's name
    // from its first heading, and this document is now quoted into a review prompt whose verdict
    // is rendered beside the node's own label. A heading that said something else would put two
    // different names on the same reviewer.
    "# Demo test-first reviewer",
    "",
    "Read the diff, then answer one question: **if this change were reverted, which test would fail?**",
    "",
    "- If you can name that test and it is in the diff, approve.",
    "- If the behaviour changed and no test moved, refuse and say which case is uncovered.",
    "- Formatting-only and comment-only diffs are exempt. Say so explicitly rather than",
    "  approving them silently, so the exemption is visible in the record.",
    "",
    "Never ask for a test that would only restate the implementation.",
  ].join("\n"),
};

/**
 * The `POST /api/tasks` body for one spec.
 *
 * A function rather than an inline object literal at the call site, so `test/demo-seed.test.ts`
 * can parse it with the daemon's OWN `DispatchSchema`. That test is the cheap version of
 * finding out a year from now that a tightened schema turned `--fresh` into a wall of 400s.
 */
export function taskBody(spec, repoRoot, { backlog, dependsOnTaskId = null }) {
  return {
    repoRoot,
    title: spec.title,
    intent: spec.intent,
    priority: spec.priority,
    labels: spec.labels,
    backlog,
    // Explicitly none: OMITTING this applies the machine's DEFAULT after-work Workflow,
    // whose allowlist can refuse the dispatch outright. A seed must not depend on whatever
    // the operator happens to have configured.
    workflowId: null,
    ...(dependsOnTaskId ? { dependencies: [{ type: "task", taskId: dependsOnTaskId }] } : {}),
  };
}

/** The `POST /api/schedules` body for one spec. Validated in the same test, for the same reason. */
export function scheduleBody(spec, repoRoot, timezone) {
  return {
    name: spec.name,
    expression: spec.expression,
    timezone,
    overlapPolicy: spec.overlapPolicy,
    missedPolicy: spec.missedPolicy,
    template: {
      title: spec.title,
      intent: spec.intent,
      repoRoot,
      priority: spec.priority,
      labels: spec.labels,
    },
  };
}

/** What the seeded Workflow is called, in one place because the summary line names it too. */
export const SEED_WORKFLOW_NAME = "Demo review and ship";

/**
 * The built-in review roles the seeded graph is composed from, by their durable ids.
 *
 * `builtin:<slug>` is `builtinPersonaId(slug)` and the slug is the `personas/*.md` filename, both
 * documented append-only for a role that stays shipped - so naming them here is naming app data,
 * not guessing at generated ids. `test/demo-seed.test.ts` pins each one against
 * `BUILTIN_PERSONAS`, because a slug this build no longer ships would fail Publish with a
 * `missing_persona` diagnostic mid-seed rather than at a test.
 */
export const SEED_WORKFLOW_REVIEWERS = {
  intent: "builtin:intent-conformance-judge",
  risk: "builtin:code-risk-reviewer",
  evidence: "builtin:test-evidence-auditor",
  documentation: "builtin:documentation-steward",
};

/** Node ids, named after the role so a run's attempt rows read as the pipeline they came from. */
const SEED_WORKFLOW_NODES = {
  session: "session",
  typecheck: "check-typecheck",
  test: "check-test",
  buildJoin: "build-join",
  intent: "intent-conformance",
  risk: "code-risk",
  evidence: "test-evidence",
  documentation: "documentation",
  custom: "demo-test-first",
  depthJoin: "depth-join",
  end: "end",
};

/** `compileStages`'s own layout constants, so the seeded canvas opens laid out rather than piled. */
const LAYOUT = { originX: 60, originY: 60, columnStride: 280, rowStride: 170 };
const positionAt = (column, row) => ({
  x: LAYOUT.originX + column * LAYOUT.columnStride,
  y: LAYOUT.originY + row * LAYOUT.rowStride,
});

/**
 * The Workflow the seeded run comes from: the built-in **No-Mistakes Review**'s pipeline, minus
 * the one stage this machine cannot answer, hand-compiled.
 *
 * WHAT IT IS. Version 3's authored shape, stage for stage: the deterministic gate first
 * (`typecheck` and `test` in ONE stage, so both must clear before a model call is spent), then
 * Intent Conformance alone as the cheap first judge, then the three deep reviews in parallel
 * behind it. `customPersonaId` adds the SEEDED Persona (`SEED_PERSONA`) to that parallel stage
 * beside the shipped ones - the only place in the demo where a Persona an operator wrote is
 * visibly doing the job Personas are for.
 *
 * The two Checks are not decoration. With no command configured for either slot - which is every
 * fresh demo root, because check execution is consent-gated and off - each one records `skipped`
 * and PASSES, exactly as it does on any repository the built-in was bound to before its operator
 * configured commands. So the demo shows the gate, shows why it did not run, and still completes.
 *
 * WHY NOT BIND THE BUILT-IN ITSELF - measured, not assumed. Every shipped version of No-Mistakes
 * Review ends on `completionPolicy: {kind:"inspector"}`, and `WorkflowManager.enterInspectorGate`
 * reads that policy against the machine it is running on:
 *
 *   - the Inspector is off by default (`InspectorConfigSchema`: `enabled: false`), and a gate
 *     entered with it off is recorded `blocked`, phase `inspector_inspector_disabled`. A run bound
 *     to the built-in here would put "Workflow blocked" on the demo's showcase card.
 *   - armed, the gate then needs a pull request ADOPTED into the Inspector's own store and a fresh
 *     observation of its head. Every read of that state goes through `run("gh", ...)` in
 *     `src/server/inspector/github.ts` - nine call sites, no env indirection anywhere in the repo -
 *     against a real GitHub. This demo reaches no network, fakes every binary by path override,
 *     and its repositories are local `git init` directories with no remote. `dry-run` mode does not
 *     help: it still adopts and still reviews.
 *
 * Satisfying that gate from here would mean either arming, inside a demo, the one subsystem that
 * comments on real pull requests under the operator's own account, or adding a `gh` override to
 * production Inspector code so a demo can stand in for GitHub. The first is a consent boundary
 * this tooling must not cross; the second is a product change to the code that acts outside this
 * machine, and it belongs to a task that asks for it. So the seeded copy carries the create-default
 * `completionPolicy: {kind:"none"}` and ends where its End node says it does, and README.md's
 * seeded-fleet section names the omission rather than letting a reader infer completeness.
 *
 * WHY NOT THE TWO-NODE STUB IT REPLACES. `session --submitted--> end` does complete, but it
 * reviews nothing: no Persona node means no verdict, no round, and two synthetic attempts that
 * the Runs page listed under "Reviewer verdicts" as `Session` and `Complete`. A demo of a review
 * workflow whose run contains no review is the one row here that would be theatre.
 *
 * Emitted exactly as `compileStages` would emit it (same ports, same join wiring, same layout
 * stride), by hand rather than by import, because this file is plain `.mjs` driving HTTP and
 * `src/shared/workflow-stages.ts` is TypeScript. `test/demo-seed.test.ts` closes that gap the
 * only way that matters: it runs the app's OWN `projectStages` over this graph and asserts the
 * pipeline that comes back.
 */
export function workflowDraft({ customPersonaId = null } = {}) {
  const check = (id, slot) => ({ id, node: { id, kind: "check", slot } });
  const reviewer = (id, personaId) => ({ id, node: { id, kind: "persona", personaId } });
  /**
   * The pipeline, as stages. One list rather than a wall of node and edge literals, because the
   * wiring below is `compileStages`'s rule applied uniformly - a stage's members are activated
   * together, agree at a join when there is more than one of them, and return to the Session on
   * any fail - and spelling that out three times is how one stage ends up wired differently.
   */
  const stages = [
    {
      joinId: SEED_WORKFLOW_NODES.buildJoin,
      members: [
        check(SEED_WORKFLOW_NODES.typecheck, "typecheck"),
        check(SEED_WORKFLOW_NODES.test, "test"),
      ],
    },
    {
      joinId: null,
      members: [reviewer(SEED_WORKFLOW_NODES.intent, SEED_WORKFLOW_REVIEWERS.intent)],
    },
    {
      joinId: SEED_WORKFLOW_NODES.depthJoin,
      members: [
        reviewer(SEED_WORKFLOW_NODES.risk, SEED_WORKFLOW_REVIEWERS.risk),
        reviewer(SEED_WORKFLOW_NODES.evidence, SEED_WORKFLOW_REVIEWERS.evidence),
        reviewer(SEED_WORKFLOW_NODES.documentation, SEED_WORKFLOW_REVIEWERS.documentation),
        ...(customPersonaId
          ? [reviewer(SEED_WORKFLOW_NODES.custom, customPersonaId)]
          : []),
      ],
    },
  ];

  const nodes = [{ id: SEED_WORKFLOW_NODES.session, kind: "session", position: positionAt(0, 0) }];
  const edges = [];
  let column = 1;
  const activate = (targets, source, port) => {
    for (const target of targets) {
      edges.push({ id: `${source}-${port}-${target}`, source, sourcePort: port, target, targetPort: "activate" });
    }
  };
  const returnForChanges = (source) => {
    edges.push({
      id: `${source}-returns`,
      source,
      sourcePort: "fail",
      target: SEED_WORKFLOW_NODES.session,
      targetPort: "return_for_changes",
    });
  };

  for (const stage of stages) {
    stage.members.forEach((member, row) => {
      nodes.push({ ...member.node, position: positionAt(column, row) });
    });
    if (stage.joinId) {
      nodes.push({
        id: stage.joinId,
        kind: "all_pass",
        position: positionAt(column + 1, (stage.members.length - 1) / 2),
      });
    }
    column += stage.joinId ? 2 : 1;
    // The node whose onward port carries the pipeline past this stage: its join when it has one,
    // and its only member when it does not.
    stage.exitId = stage.joinId ?? stage.members[0].id;
  }
  nodes.push({
    id: SEED_WORKFLOW_NODES.end,
    kind: "end",
    outcome: "Complete",
    position: positionAt(column, 0),
  });

  activate(stages[0].members.map((m) => m.id), SEED_WORKFLOW_NODES.session, "submitted");
  stages.forEach((stage, index) => {
    if (stage.joinId) {
      // BOTH outcomes of every member feed the join: that is how an all-pass gate knows it has
      // heard from everyone before deciding, rather than passing on the first pass.
      for (const member of stage.members) {
        for (const port of ["pass", "fail"]) {
          edges.push({
            id: `${member.id}-${port}`,
            source: member.id,
            sourcePort: port,
            target: stage.joinId,
            targetPort: "result",
          });
        }
      }
      returnForChanges(stage.joinId);
    } else {
      // A single-member stage returns its own fail route, which is what the graph validator
      // demands of each stage - and what makes a refusal a repair round rather than a dead run.
      returnForChanges(stage.members[0].id);
    }
    const next = stages[index + 1];
    if (next) activate(next.members.map((m) => m.id), stage.exitId, "pass");
    else {
      edges.push({
        id: "pipeline-completes",
        source: stage.exitId,
        sourcePort: "pass",
        target: SEED_WORKFLOW_NODES.end,
        targetPort: "terminal",
      });
    }
  });

  return { nodes, edges };
}

/**
 * Which tasks a run actually creates, given the mode.
 *
 * `reduced` is `--check`'s seed: one dispatched session, one review, one ledger day. It has
 * to exercise every MECHANISM (dispatch, suspend, restore, review, telemetry) while staying
 * fast enough to be a smoke test, so it trims breadth rather than depth.
 */
export function seedPlan({ reduced = false } = {}) {
  if (!reduced) {
    return {
      sessionTasks: SEED_SESSION_TASKS,
      backlogTasks: SEED_BACKLOG_TASKS,
      schedules: SEED_SCHEDULES,
      persona: SEED_PERSONA,
      workflow: true,
      ledgerDays: 6,
    };
  }
  return {
    // The pagination task, because it is the one whose suspend/restore path has a
    // continuation turn in it - the mechanism most likely to break silently.
    sessionTasks: SEED_SESSION_TASKS.filter((t) => t.key === "pagination"),
    backlogTasks: SEED_BACKLOG_TASKS.filter((t) => t.key === "ingest"),
    schedules: [],
    persona: null,
    workflow: false,
    ledgerDays: 1,
  };
}

// --- telemetry payloads (also pure, so their backdating is testable) ------------------------

/**
 * One OTLP/HTTP JSON export, stamped at `atMs` rather than now.
 *
 * `aggregationTemporality: 1` is delta - Claude Code's own default, and the one that makes
 * each export its own window so the rows accumulate instead of replacing each other.
 *
 * `session.id` is the row's note key, and it must NOT be a seeded card's: the ingest drops every
 * datapoint whose note key belongs to a driven session, because the driver is that key's writer
 * (see `costExports`). Every id passed here is therefore a session that is over - history with no
 * card behind it, which is what past spend actually is.
 */
export function costExport({ sessionId, atMs, costUsd, inputTokens, outputTokens }) {
  const nanos = (ms) => `${BigInt(Math.round(ms)) * 1_000_000n}`;
  const attributes = (extra = {}) => [
    { key: "session.id", value: { stringValue: sessionId } },
    { key: "model", value: { stringValue: "claude-sonnet-4-5" } },
    { key: "query_source", value: { stringValue: "main" } },
    ...Object.entries(extra).map(([key, value]) => ({ key, value: { stringValue: value } })),
  ];
  const point = (asDouble, extra) => ({
    asDouble,
    startTimeUnixNano: nanos(atMs - 60_000),
    timeUnixNano: nanos(atMs),
    attributes: attributes(extra),
  });
  const metric = (name, dataPoints) => ({
    name,
    sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints },
  });
  return {
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics: [
              metric("claude_code.cost.usage", [point(costUsd)]),
              metric("claude_code.token.usage", [
                point(inputTokens, { type: "input" }),
                point(outputTokens, { type: "output" }),
              ]),
            ],
          },
        ],
      },
    ],
  };
}

/**
 * The fleet's ledger BEHIND the cards: earlier today, and a few days before that.
 *
 * No row here is attributed to a seeded card, and that is a correction rather than a
 * simplification. This function used to stamp today's rows with the live sessions'
 * `agentSessionId`s on the premise that a card's own figure and the topbar chip would then
 * agree. They never could: Claude session spend has exactly one writer per note key
 * (`Registry.applyOtelMetrics` -> `sdkOwnedNoteKey`), the DRIVER wins for an embedded session,
 * and every OTLP datapoint naming a driven session's id is dropped on the ingest path. The demo
 * runs entirely on SDK sessions, so those rows were discarded in silence and the demo's cost chip
 * read $0.00 - which is also what made `npm run demo -- --check` fail its ledger assertion.
 *
 * A card's own spend now comes from where a real embedded session's comes from: the `result`
 * frame's usage, reported by `fake-claude.mjs`'s `turnUsage` and recorded by
 * `recordDriverSessionUsage`. What these rows are for is the REST of the ledger - the spend a
 * fleet has behind it, from sessions that are over. Two a day for `days` days, plus two from
 * earlier today so the topbar's today figure has history in it even before a card finishes a
 * turn (`--check`'s one session is left mid-question on purpose and finishes none).
 */
export function costExports({ nowMs, days }) {
  const exports = [];
  // Minutes rather than an hour-of-day, so this cannot stamp a row into the FUTURE (or, near
  // midnight, into yesterday's total) whatever time the demo is seeded at.
  for (const [minutesAgo, costUsd] of [[47, 4.12], [23, 2.87]]) {
    exports.push(
      costExport({
        sessionId: `demo-earlier-today-${minutesAgo}`,
        atMs: nowMs - minutesAgo * 60_000,
        costUsd,
        inputTokens: 41_000 + minutesAgo * 90,
        outputTokens: 6_200 + minutesAgo * 20,
      }),
    );
  }
  for (let day = 1; day <= days; day++) {
    // Two exports a day, so a per-day view has more than a single bar to draw.
    for (const [slot, costUsd] of [
      [10, 6.4 + ((day * 7) % 5)],
      [16, 3.1 + ((day * 3) % 4)],
    ]) {
      const at = new Date(nowMs - day * DAY_MS);
      at.setHours(slot, 15, 0, 0);
      exports.push(
        costExport({
          sessionId: `demo-history-${day}-${slot}`,
          atMs: at.getTime(),
          costUsd: Number(costUsd.toFixed(2)),
          inputTokens: 120_000 + day * 4_000,
          outputTokens: 14_000 + day * 900,
        }),
      );
    }
  }
  return exports;
}

/**
 * What the app spent on ITSELF: the autonomous loops' own headless runs.
 *
 * A separate surface from the fleet figure on purpose (`FleetCost.automation`), and worth
 * seeding precisely because a demo of "what is watching my fleet costing me" is unreadable
 * when that line is blank.
 */
export function automationReports({ nowMs, days }) {
  const roles = ["foreman:triage", "foreman:review", "inspector:review"];
  const reports = [];
  for (let day = 0; day <= days; day++) {
    roles.forEach((role, index) => {
      const at = day === 0 ? nowMs - (index + 1) * 120_000 : nowMs - day * DAY_MS;
      reports.push({
        role,
        runner: "claude",
        runId: `demo-seed-${role.replace(":", "-")}-${day}`,
        ts: Math.round(at),
        models: [
          {
            modelId: "claude-sonnet-4-5",
            input: 9_000 + index * 3_000 + day * 500,
            output: 1_400 + index * 300,
            reasoningOutput: 0,
            cacheRead: 62_000 + day * 1_500,
            cacheWrite: 3_100,
            reportedCostUsd: Number((0.42 + index * 0.31 + day * 0.05).toFixed(2)),
          },
        ],
      });
    });
  }
  return reports;
}

// --- HTTP and waiting ----------------------------------------------------------------------

/**
 * Poll `probe` until it returns something truthy, then hand that back.
 *
 * Every wait in this file goes through here rather than through a sleep, because a seed built
 * on sleeps is a seed that is either slow or flaky depending on the machine. `probe` returns
 * null for "not yet"; the message is what a timeout says it was waiting for.
 */
export async function waitFor(what, probe, { timeoutMs = 90_000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastNote = "";
  for (;;) {
    const result = await probe((note) => (lastNote = note));
    if (result) return result;
    if (Date.now() > deadline) {
      throw new Error(
        `[seed] timed out after ${timeoutMs}ms waiting for ${what}${lastNote ? ` (last saw: ${lastNote})` : ""}`,
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** A daemon client bound to one base URL, with the token for the guarded ingest routes. */
function client(baseURL, root) {
  const tokenPath = join(root, "token");
  const token = () => (existsSync(tokenPath) ? readFileSync(tokenPath, "utf8").trim() : "");

  async function call(method, path, body, { auth = false } = {}) {
    const res = await fetch(`${baseURL}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        // `/api/*` is loopback-authenticated and takes no token; `/mcp/*`, `/statusline` and
        // `/v1/metrics` are reachable by every process on the machine and require one.
        ...(auth ? { "x-harness-token": token() } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) {
      throw new Error(`[seed] ${method} ${path} answered ${res.status}: ${await res.text()}`);
    }
    if (res.status === 204) return null;
    return await res.json().catch(() => null);
  }

  return {
    get: (path) => call("GET", path),
    post: (path, body, opts) => call("POST", path, body ?? {}, opts),
    put: (path, body) => call("PUT", path, body ?? {}),
  };
}

/**
 * The dashboard's own first read: the `snapshot` frame `GET /events` opens with.
 *
 * Used instead of assembling three `/api/*` reads because it is the exact surface a browser
 * gets, so a summary printed from it cannot claim something the dashboard would not show -
 * `fleetCost`, in particular, exists nowhere else.
 */
export async function readSnapshot(baseURL) {
  const controller = new AbortController();
  try {
    const res = await fetch(`${baseURL}/events`, {
      headers: { accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(`[seed] /events answered ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffered = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error("[seed] /events closed before sending a snapshot");
      buffered += decoder.decode(value, { stream: true });
      // SSE frames are separated by a blank line; the snapshot is always the first.
      const split = buffered.indexOf("\n\n");
      if (split < 0) continue;
      const frame = buffered.slice(0, split);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("");
      const parsed = JSON.parse(data);
      if (parsed.type !== "snapshot") throw new Error(`[seed] first frame was ${parsed.type}`);
      return parsed;
    }
  } finally {
    controller.abort();
  }
}

// --- the seeder ----------------------------------------------------------------------------

/**
 * Boot quietly, drive the routes, stop cleanly. Returns what was seeded.
 *
 * Order matters in two places and nowhere else. Sessions are dispatched before reviews,
 * because `POST /mcp/reviews` resolves the session it belongs to by cwd and needs it live.
 * Telemetry is posted before the shutdown, because the ingest routes are the daemon's, and
 * the daemon is the only writer.
 */
export async function seedDemoFleet({ root, port, reduced = false, log = console.log }) {
  assertDemoRoot(root);
  const plan = seedPlan({ reduced });
  const workspace = join(root, "workspace");
  const repoRoot = (name) => join(workspace, name);
  const bins = {
    claude: join(root, "bin", "claude"),
    codex: join(root, "bin", "codex"),
    pi: join(root, "bin", "pi"),
  };

  const daemon = await bootDaemon(root, port, buildDaemonEnv(root, port, bins));
  const api = client(daemon.baseURL, root);
  const seeded = {
    tasks: [],
    sessions: [],
    reviews: { pending: 0, resolved: 0 },
    schedules: 0,
    personas: 0,
    workflowRuns: 0,
    /** What the seeded run reviewed and how cleanly - `reviewOutcome`, or null when none ran. */
    workflowReview: null,
    ledgerRows: 0,
  };

  // Signals wired to THIS daemon for as long as we hold it, because the seed takes minutes: a
  // Ctrl-C in that window would otherwise leave it holding the port, and the next
  // `npm run demo` would refuse to boot against a pid it does not own. Released in the
  // `finally` below - `main` installs its own long-lived handlers afterwards.
  const releaseSignals = holdSignals(() => daemon.stop());

  try {
    // --- backlog first, so a dependency edge exists before the task that needs it ---------
    const byKey = new Map();
    for (const spec of plan.backlogTasks) {
      const blocker = spec.dependsOn ? byKey.get(spec.dependsOn) : null;
      const task = await api.post(
        "/api/tasks",
        taskBody(spec, repoRoot(spec.repo), {
          backlog: true,
          dependsOnTaskId: blocker?.id ?? null,
        }),
      );
      byKey.set(spec.key, task);
      if (spec.park) await api.post(`/api/tasks/${task.id}/update`, { enabled: false });
      if (spec.cancel) await api.post(`/api/tasks/${task.id}/cancel`);
      seeded.tasks.push({ title: spec.title, status: spec.cancel ? "cancelled" : "backlog" });
      log(`[seed] backlog: ${spec.title}${spec.park ? " (parked)" : ""}${spec.cancel ? " (cancelled)" : ""}${blocker ? ` (waiting on ${blocker.title})` : ""}`);
    }

    // --- dispatched sessions ---------------------------------------------------------------
    for (const spec of plan.sessionTasks) {
      const task = await api.post(
        "/api/tasks",
        taskBody(spec, repoRoot(spec.repo), { backlog: false }),
      );
      log(`[seed] dispatched: ${spec.title}`);

      // Through `Task.sessionId` rather than a field on the session: that is the link the
      // dispatcher itself records, and a Session carries only a denormalized `task` summary
      // whose correlation can fall back to the worktree path.
      const session = await waitFor(
        `a session for "${spec.title}"`,
        async (note) => {
          const tasks = await api.get("/api/tasks");
          const sessionId = tasks.find((t) => t.id === task.id)?.sessionId;
          if (!sessionId) {
            note(`task status=${tasks.find((t) => t.id === task.id)?.status}, no session yet`);
            return null;
          }
          const sessions = await api.get("/api/sessions");
          const found = sessions.find((s) => s.id === sessionId && s.state !== "exited");
          note(`task points at ${sessionId}, ${found ? `state=${found.state}` : "not registered yet"}`);
          return found ?? null;
        },
      );

      // Wait for the scenario to reach the state this task is meant to be left in.
      //
      // A held question is NOT a session state. An embedded session with an unanswered
      // `AskUserQuestion` stays `working` and grows a `paneDialog` whose `source` is
      // `"driver"` (`applyDriverEvent`'s `request` arm projects the driver request into the
      // same dialog shape a terminal pane's menu produces, which is why the field keeps the
      // pane's name). `awaiting_input` is NOT it: that state is written by the hooks and the
      // discovery sweep, and this demo has both switched off. So the two waits below look at
      // different fields on purpose.
      const waiting = spec.settle === "leave-waiting";
      const wanted = waiting ? "a held question" : "idle";
      const settled = await waitFor(
        `"${spec.title}" to reach ${wanted}`,
        async (note) => {
          const sessions = await api.get("/api/sessions");
          const live = sessions.find((s) => s.id === session.id);
          note(`state=${live?.state}, paneDialog=${live?.paneDialog?.source ?? "none"}`);
          if (!live) return null;
          const held = live.paneDialog?.source === "driver";
          return (waiting ? held : live.state === "idle") ? live : null;
        },
      );

      if (spec.settle === "complete") {
        await api.post(`/api/tasks/${task.id}/complete`, {
          outcome: "Cached the workspace scan behind an mtime guard; second open is 12ms.",
        });
      }
      // --- the outbox, through the composer's own route ------------------------------------
      //
      // `POST /api/sessions/:id/inject` with the default body IS what the composer sends when a
      // person hits Queue: `InjectPromptSchema` defaults `origin: "human"` and `buffer: true`,
      // which is the pair that routes a message to `PendingTurnManager.submit` instead of typing
      // it at the session. Each one becomes a durable `pending_turns` row, so the outbox survives
      // the shutdown below exactly as the conversation does.
      //
      // AFTER the settle wait, and that ordering is the whole trick: the queue is only held while
      // the card has a dialog on it, so enqueueing before the question was raised would deliver
      // the first message instead of queueing it.
      const queuedMessages = spec.queuedMessages ?? [];
      for (const text of queuedMessages) {
        const submitted = await api.post(`/api/sessions/${settled.id}/inject`, { text });
        // The route answers 200 with `ok: false` when the manager refuses (a session that cannot
        // be messaged, an empty body), which a status check alone would read as success.
        if (!submitted?.ok || submitted.delivery !== "pending") {
          throw new Error(
            `[seed] queueing a message on "${spec.title}" was not queued: ${JSON.stringify(submitted)}`,
          );
        }
      }
      if (queuedMessages.length > 0) {
        // Read back from `/api/sessions`, not from the submit answers: the claim being made is
        // that the outbox is STILL queued after every message landed, and only the session
        // projection the dashboard reads can say that. A drain would show up here as a short list.
        const outbox = await waitFor(
          `${queuedMessages.length} queued message(s) on "${spec.title}"`,
          async (note) => {
            const sessions = await api.get("/api/sessions");
            const live = sessions.find((s) => s.id === settled.id);
            const pending = live?.pendingTurns ?? [];
            note(`${pending.length} pending, states=${pending.map((t) => t.state).join("/") || "none"}`);
            return pending.length === queuedMessages.length ? pending : null;
          },
          { timeoutMs: 15_000 },
        );
        const unqueued = outbox.filter((turn) => turn.state !== "queued");
        if (unqueued.length > 0) {
          throw new Error(
            `[seed] ${unqueued.length} seeded message(s) left the queue before the demo started`
            + ` (states: ${unqueued.map((t) => t.state).join(", ")})`,
          );
        }
        log(`[seed] queued ${outbox.length} messages on "${spec.title}", held by its open question`);
      }

      seeded.tasks.push({ title: spec.title, status: spec.settle });
      seeded.sessions.push({
        id: settled.id,
        agentSessionId: settled.agentSessionId,
        title: spec.title,
        key: spec.key,
        taskId: task.id,
        cwd: settled.cwd,
        state: waiting ? "waiting on a question" : "idle",
        queued: queuedMessages.length,
      });
    }

    // --- reviews: one pending, and resolved history behind it ------------------------------
    const sessionFor = (key) => seeded.sessions.find((s) => s.key === key);
    /**
     * Raise one review against a live session, returning its id.
     *
     * `cwd` rather than a session id, because `findSessionByEnv` resolves a review to the one
     * live session at that path - and each dispatch cut its own worktree, so the path is
     * unambiguous by construction. This is also why reviews come after the dispatches: the
     * route answers 404 for a session that is not live.
     */
    const raise = async (session, body) => {
      const created = await api.post(
        "/mcp/reviews",
        { env: {}, cwd: session.cwd, ...body },
        { auth: true },
      );
      return created.id;
    };
    const resolve = (reviewId, body) => api.post(`/api/reviews/${reviewId}/resolve`, body);

    const pendingHost = sessionFor("scan") ?? seeded.sessions[0];
    if (pendingHost) {
      await raise(pendingHost, {
        kind: "plan-decisions",
        title: "How should the scan cache invalidate?",
        body: [
          "The cache is keyed on the workspace root's mtime, which covers a new clone but not",
          "a repo that moved inside an existing root. Two ways to close that, and they trade",
          "off differently under a large workspace.",
        ].join(" "),
        decisions: [
          {
            id: "invalidation",
            question: "What should invalidate an entry?",
            options: [
              { id: "root-mtime", label: "Root mtime only", detail: "One stat per root. Misses a move inside the root until something else touches it.", recommended: true },
              { id: "per-repo", label: "Per-repo mtime", detail: "Correct for moves, but one stat per repo on every read - which is the cost we just removed." },
            ],
          },
          {
            id: "ttl",
            question: "Should entries also expire on a timer?",
            options: [
              { id: "no-ttl", label: "No TTL", detail: "The mtime guard is the only invalidation. Simplest to reason about." },
              { id: "ttl-60", label: "60s TTL as a backstop", detail: "Bounds the blast radius of any case the guard misses." },
            ],
            multiSelect: false,
          },
        ],
      });
      seeded.reviews.pending += 1;
      log(`[seed] raised a pending plan-decisions review on "${pendingHost.title}"`);
    }

    const resolvedHost = sessionFor("token") ?? seeded.sessions[0];
    if (resolvedHost && !reduced) {
      const planReview = await raise(resolvedHost, {
        kind: "plan",
        title: "Collapse concurrent refreshes onto one in-flight promise",
        body: [
          "Two callers arriving on an expired token each start their own refresh, and the",
          "second one replaces the token the first was about to use. Plan: wrap the refresh",
          "in a `single()` helper that shares one in-flight promise, and cover both the",
          "concurrent case and the after-it-settles case with tests.",
        ].join(" "),
      });
      await resolve(planReview, {
        action: "approve",
        response: "Right shape. Keep the helper generic - the OTLP exporter needs it next.",
        by: "human",
      });
      const inputReview = await raise(resolvedHost, {
        kind: "input",
        title: "What should an expired refresh token do?",
        body: "Sign the user out, or attempt one silent re-auth before giving up?",
      });
      await resolve(inputReview, {
        action: "answer",
        response: "One silent re-auth, then sign out. Log the re-auth so we can see how often it fires.",
        by: "human",
      });
      seeded.reviews.resolved += 2;
      log(`[seed] resolved two reviews on "${resolvedHost.title}"`);
    }

    // --- a Persona, a Workflow, and one clean completed run --------------------------------
    let customPersonaId = null;
    if (plan.persona) {
      // The id is KEPT rather than discarded: the seeded Workflow puts THIS Persona in its
      // parallel stage, so the demo shows a reviewer the operator wrote working beside the
      // shipped ones. `POST /api/personas` answers with the Persona itself (201).
      const persona = await api.post("/api/personas", plan.persona);
      customPersonaId = typeof persona?.id === "string" ? persona.id : null;
      if (!customPersonaId) {
        throw new Error(
          `[seed] POST /api/personas answered without an id: ${JSON.stringify(persona)}`,
        );
      }
      seeded.personas += 1;
      log(`[seed] persona: ${plan.persona.name}`);
    }

    if (plan.workflow) {
      const host = sessionFor("probe");
      // Loud, like the cleanliness check below: the run is bound to THIS session, and a plan that
      // asks for a workflow but no longer dispatches its host would otherwise seed a fleet with
      // no run in it at all and say so only in a count nobody reads.
      if (!host) {
        throw new Error(
          "[seed] the plan asks for a workflow run but no session was dispatched to bind it to "
          + '(no seeded task with settle: "workflow")',
        );
      }
      {
        // NOT waited for, and measured rather than assumed: the run's captured context will carry
        // `primaryGoal.rawPrompt: ""`, so its "Captured intent and evidence" panel reads
        // "(No captured goal)". That is not a race this seeder can wait out. A goal exists only
        // once a prompt has been CAPTURED FROM A HOOK (`Registry.captureGoalPrompt` is reached
        // only from `applyHook`, via `HookSpec.promptText`), and this demo installs no hook bridge
        // for its scripted CLIs - so no prompt is ever captured and the refiner has nothing to
        // reconcile. The same class of gap as the missing origin chips, and documented beside them
        // in README.md. The human instruction is still in the panel, under "Human decisions and
        // rationale", where the transcript reader put it.
        const created = await api.post("/api/workflows", {
          name: SEED_WORKFLOW_NAME,
          draft: workflowDraft({ customPersonaId }),
        });
        const published = await api.post(`/api/workflows/${created.workflow.id}/publish`, {
          expectedDraftRevision: 1,
        });
        const binding = await api.post("/api/workflow-bindings", {
          workflowVersionId: published.version.id,
          sessionId: host.id,
          // BOTH explicit, and neither is a default worth inheriting here. An omitted
          // `triggerMode` falls back to the VERSION's binding defaults, which
          // `CreateWorkflowSchema` sets to `foreman_complete` - refused outright unless
          // Foreman is enabled and the harness has measured hook and work-queue
          // capabilities. `preview` delivery for the matching reason: `live` additionally
          // demands Workflows Live mode and an allowlisted repository. A seed must not
          // depend on either.
          triggerMode: "manual",
          deliveryMode: "preview",
        });
        const bindingId = binding.binding?.id ?? binding.id;
        const submitted = await api.post(`/api/workflow-bindings/${bindingId}/submit`, {
          requestId: `demo-seed-${host.key}`,
        });
        const runId = submitted.run.id;
        const finished = await waitFor(
          "the seeded workflow run to settle",
          async (note) => {
            const detail = await api.get(`/api/workflow-runs/${runId}`);
            note(`status=${detail.run.status}, phase=${detail.run.currentPhase}`);
            // `WORKFLOW_RUN_TERMINAL_STATUSES` plus `blocked`: blocked is not terminal, but
            // it is settled enough to stop waiting on and worth surfacing in the summary
            // rather than timing out over.
            return WORKFLOW_RUN_SETTLED.includes(detail.run.status) ? detail : null;
          },
          { timeoutMs: 120_000 },
        );
        const review = reviewOutcome(finished);
        seeded.workflowRuns += 1;
        seeded.workflowReview = { session: host.title, ...review };
        log(
          `[seed] workflow run ${review.status} for "${host.title}": ${review.summary}`,
        );
        // Loud rather than silent, because "at least one CLEAN end-to-end completion" is the
        // point of seeding a run at all. A demo that quietly shipped a blocked run, a repair
        // round, or a reviewer that never answered would look like the product failing at the
        // one thing this card is meant to show.
        if (!review.clean) {
          throw new Error(
            `[seed] the seeded workflow run is not a clean completion: ${review.summary}`,
          );
        }
      }
    }

    // --- Recurring Missions ----------------------------------------------------------------
    for (const spec of plan.schedules) {
      await api.post(
        "/api/schedules",
        scheduleBody(spec, repoRoot(spec.repo), localTimezone()),
      );
      seeded.schedules += 1;
      log(`[seed] schedule: ${spec.name} (${spec.expression})`);
    }

    // --- telemetry, through the daemon's own ingest routes ---------------------------------
    //
    // The CARDS' own spend is not posted here and cannot be: it was already written by the driver
    // as each seeded turn finished, off the usage `fake-claude.mjs` reports on its `result` frame
    // (see `costExports` for why an OTLP row naming a driven session is dropped). What follows is
    // the ledger behind them.
    const nowMs = Date.now();
    for (const body of costExports({ nowMs, days: plan.ledgerDays })) {
      await api.post("/v1/metrics", body, { auth: true });
      seeded.ledgerRows += 1;
    }
    for (const report of automationReports({ nowMs, days: plan.ledgerDays })) {
      await api.post("/api/usage/automation", report);
      seeded.ledgerRows += 1;
    }
    // NOT seeded, deliberately: the cost chip's quota runway. `/statusline` is where a real
    // session reports its rate-limit windows, but `Registry.latestRateLimits` is a private
    // in-memory field that nothing persists - posting one here would be undone by the
    // shutdown three lines below, and a seeder that pretends otherwise is worse than one that
    // says so. The chip still appears and still opens; it just has no forward-looking row
    // until a live session reports one.
    log(`[seed] posted ${seeded.ledgerRows} telemetry exports through the ingest routes`);

    const snapshot = await readSnapshot(daemon.baseURL);
    seeded.fleetCost = snapshot.fleetCost?.estimatedCostToday ?? null;
  } finally {
    // Cleanly, and waited for: this shutdown is what turns the live sessions above into the
    // `suspended` rows the next daemon restores as cards. A hard kill here would leave the
    // seed with no fleet in it at all.
    log("[seed] stopping the daemon so its sessions suspend...");
    await daemon.stop();
    releaseSignals();
  }

  seeded.headline = [
    `${seeded.tasks.length} tasks`,
    `${seeded.sessions.length} sessions`,
    `${seeded.reviews.pending} pending / ${seeded.reviews.resolved} resolved reviews`,
    // The count alone said nothing about whether the run was worth showing, which is the whole
    // difference between a seeded completion and a seeded review.
    seeded.workflowReview
      ? `1 clean workflow run (${seeded.workflowReview.summary})`
      : `${seeded.workflowRuns} workflow run(s)`,
    `${seeded.schedules} schedule(s)`,
    seeded.fleetCost != null ? `$${seeded.fleetCost.toFixed(2)} today` : "no priced spend",
  ].join(", ");
  return seeded;
}

/** The operator's timezone, so a seeded schedule's next-fire time reads like a local one. */
function localTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** What the launcher prints after a seed, so `--fresh` says what it built. */
export function printSeedSummary(seeded) {
  console.log(`[demo] seeded: ${seeded.headline}`);
  for (const session of seeded.sessions) {
    const queued = session.queued > 0 ? `, ${session.queued} queued message(s)` : "";
    console.log(`[demo]   session "${session.title}" (${session.state}${queued}) in ${session.cwd}`);
  }
  // Named individually, because "1 clean workflow run" is a claim and these are what backs it:
  // which reviewers answered on which session, which is also exactly what the card's ⌁ Approved
  // chip and the Runs page will show.
  if (seeded.workflowReview) {
    console.log(
      `[demo]   workflow "${SEED_WORKFLOW_NAME}" on "${seeded.workflowReview.session}": `
      + [...seeded.workflowReview.checks, ...seeded.workflowReview.reviewers]
        .map((item) => `${item.name} ${item.verdict}`).join(", "),
    );
  }
}
