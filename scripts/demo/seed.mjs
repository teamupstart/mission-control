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

/** One custom Persona, so the Library shows something beside the built-ins. */
export const SEED_PERSONA = {
  name: "Demo test-first reviewer",
  description: "Refuses a diff whose behaviour change has no failing-first test.",
  guidanceMarkdown: [
    "# Test-first reviewer",
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

/**
 * The Workflow the seeded run history comes from: a session node whose `submitted` port ends
 * the run. The narrowest published graph that produces a real completed run, which is what
 * the Runs page needs - the graph itself is not what a demo is showing off.
 */
export function workflowDraft() {
  return {
    nodes: [
      { id: "session", kind: "session", position: { x: 0, y: 0 } },
      { id: "end", kind: "end", outcome: "Complete", position: { x: 240, y: 0 } },
    ],
    edges: [
      {
        id: "complete",
        source: "session",
        sourcePort: "submitted",
        target: "end",
        targetPort: "terminal",
      },
    ],
  };
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
 * `session.id` is the row's note key: pass a live session's `agentSessionId` and the figure
 * lands on that card as well as in the fleet total; pass anything else and it is history with
 * no card behind it, which is what yesterday's spend actually is.
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
 * The fleet's ledger: today's spend attributed to the seeded cards, plus a few days behind it.
 *
 * Today's rows carry the live sessions' own ids so the per-card cost and the topbar chip agree
 * (`estimatedCostToday` counts from local midnight, so only these reach the chip). The
 * backdated rows are deliberately NOT attributed to a card - a session that ran on Tuesday
 * has no card today, and pretending otherwise would be the one dishonest row in the seed.
 */
export function costExports({ nowMs, sessionIds, days }) {
  const exports = [];
  const todayShare = [4.12, 2.87, 1.94, 3.41];
  sessionIds.forEach((sessionId, index) => {
    exports.push(
      costExport({
        sessionId,
        atMs: nowMs - (index + 1) * 60_000,
        costUsd: todayShare[index % todayShare.length],
        inputTokens: 41_000 + index * 9_000,
        outputTokens: 6_200 + index * 1_100,
      }),
    );
  });
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
      seeded.tasks.push({ title: spec.title, status: spec.settle });
      seeded.sessions.push({
        id: settled.id,
        agentSessionId: settled.agentSessionId,
        title: spec.title,
        key: spec.key,
        taskId: task.id,
        cwd: settled.cwd,
        state: waiting ? "waiting on a question" : "idle",
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

    // --- a Persona, a Workflow, and one completed run --------------------------------------
    if (plan.persona) {
      await api.post("/api/personas", plan.persona);
      seeded.personas += 1;
      log(`[seed] persona: ${plan.persona.name}`);
    }

    if (plan.workflow) {
      const host = sessionFor("probe");
      if (host) {
        const created = await api.post("/api/workflows", {
          name: "Demo review and ship",
          draft: workflowDraft(),
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
            note(`status=${detail.run.status}`);
            // `WORKFLOW_RUN_TERMINAL_STATUSES` plus `blocked`: blocked is not terminal, but
            // it is settled enough to stop waiting on and worth surfacing in the summary
            // rather than timing out over.
            return WORKFLOW_RUN_SETTLED.includes(detail.run.status) ? detail.run : null;
          },
          { timeoutMs: 120_000 },
        );
        seeded.workflowRuns += 1;
        log(`[seed] workflow run ${finished.status} for "${host.title}"`);
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
    const nowMs = Date.now();
    const liveIds = seeded.sessions.map((s) => s.agentSessionId).filter(Boolean);
    for (const body of costExports({ nowMs, sessionIds: liveIds, days: plan.ledgerDays })) {
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
    `${seeded.workflowRuns} workflow run(s)`,
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
    console.log(`[demo]   session "${session.title}" (${session.state}) in ${session.cwd}`);
  }
}
