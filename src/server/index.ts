// FIRST, and above every other local import: renames a state dir from an older name
// onto ~/.mission-control. ES modules evaluate imports in source order, so this runs
// before ./config.ts resolves STATE_DIR - move it down and the daemon would open its db
// under a path that is about to be renamed. See migrate-state.ts.
import "./migrate-state.ts";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { HOST, PORT } from "./config.ts";
import { openDb } from "./db.ts";
import { ensureToken } from "./auth.ts";
import { Registry } from "./registry.ts";
import { killLiveLlmRuns, llmRunner } from "./llm/index.ts";
import { claudeTransportChoice, getLlmConfig, llmRunnerChoice } from "./llm/config.ts";
import { configureClaudeRunnerTransport } from "./llm/claude.ts";
import { resolveLlmJobModel, LLM_JOB_SPECS } from "@shared/llm-jobs.ts";
import { WORKFLOW_PERSONA_MODEL_ENV } from "@shared/workflow.ts";
import { envVar } from "@shared/harness-runtime.mjs";
import { resolveEvaluatorExecution } from "./ensembles/reviews/execution.ts";
import { ReviewManager } from "./reviews.ts";
import { TaskManager } from "./tasks.ts";
import { QueueManager } from "./queue.ts";
import { startPoller } from "./discovery/poller.ts";
import { SdkSupervisor } from "./sdk/supervisor.ts";
import { PendingTurnManager } from "./pending-turns.ts";
import { runtimePromptInjector } from "./sdk/deliver.ts";
import { startAgentsShadow } from "./discovery/agents-shadow.ts";
import { startPoolReaper } from "./pool.ts";
import { installCheckLeasePins } from "./pool-lease.ts";
import { CheckLeaseManager } from "./workflows/check-lease.ts";
import { CheckRuntime } from "./workflows/check-runtime.ts";
import { startPrPoller } from "./pr.ts";
import { startInspector } from "./inspector/worker.ts";
import { startRuntimeMetaPoller } from "./runtime-meta.ts";
import { startRetroWorthinessPoller } from "./retro-worthiness.ts";
import { startUsagePoller } from "./usage.ts";
import { setLlmSpendSink } from "./llm/spend.ts";
import { recordSpendReport } from "./spend-ledger.ts";
import { startGoalRefiner } from "./goal/refiner.ts";
import { startAwayWatcher } from "./away/watcher.ts";
import { startHeadlessPruner } from "./goal/prune.ts";
import { buildApp } from "./routes.ts";
import { KeepAwakeManager } from "./keep-awake.ts";
import { warnIfSessionAttributionDisabled } from "./cost.ts";
import { reconcileSkills } from "./skills/config.ts";
import { startSkillsReloader } from "./skills/reload.ts";
import { startTaskSourceSweeper } from "./task-sources/sweeper.ts";
import { publishSettingsStatus } from "./settings-status.ts";
import { ScheduleManager } from "./schedules/manager.ts";
import { startScheduleManager } from "./schedules/loop.ts";
import { sweepUploads } from "./uploads.ts";
import { PersonaManager } from "./workflows/personas.ts";
import { SessionActionManager } from "./workflows/session-actions.ts";
import { WorkflowManager } from "./workflows/manager.ts";
import { EnsembleManager } from "./ensembles/manager.ts";
import { TaskManagerGateway } from "./ensembles/member-launch.ts";
import { createFinalizeDeps, resolveEnsembleWorkflowVersion } from "./ensembles/finalize-deps.ts";
import { createReviewScheduler } from "./llm/review-scheduler.ts";
import { createCheckScheduler } from "./workflows/checks.ts";

openDb();
// Only the daemon can read app_config. The Foreman imports the same runner in a separate
// process and receives this resolved transport over HTTP. Resolve on every run so an API
// config edit reaches the next call in both processes.
configureClaudeRunnerTransport(claudeTransportChoice);
ensureToken();
// Reclaim expired image drops now, while we know no send is mid-flight. An upload
// outlives its send on purpose (the agent reads the path on its own schedule), so
// a clock is the only thing that can retire one.
sweepUploads();
// Heal any drift between the enabled skills and `~/.claude/skills` while nothing is
// mid-flight: a link deleted by hand, an app bundle that moved on disk, a DB restored
// onto a fresh machine. Idempotent, so the healthy case writes nothing and reloads
// nobody. Best-effort - it touches the operator's home directory, and a daemon that
// refused to start because of it would be worse than one running without a skill.
try {
  reconcileSkills();
} catch (err) {
  console.error("[skills] could not reconcile ~/.claude/skills:", err);
}
// Say it out loud at boot rather than letting someone find an empty ledger later: with
// OTEL_METRICS_INCLUDE_SESSION_ID false, Claude Code exports cost metrics that carry no
// session id at all, and the ingest can only drop them. The feature would look installed
// and record nothing.
warnIfSessionAttributionDisabled();
const registry = new Registry();
const reviews = new ReviewManager(registry);
// Embedded (SDK-runtime) sessions. Constructed HERE, above `TaskManager`, because the
// dispatcher branches on it and the startup reconciliation below asks it whether an
// embedded task's agent survived. `restore()` is a separate step further down, and its
// ordering against `startPoller` is the contract - see the comment there.
const sdkSessions = new SdkSupervisor(registry);
const pendingTurns = new PendingTurnManager(registry, sdkSessions);
const tasks = new TaskManager(registry, undefined, sdkSessions, pendingTurns);
const queues = new QueueManager(registry);
const personas = new PersonaManager(registry);
// Shares the Persona manager's store handle, so both catalogs and the workflow family are
// read through one connection and one transaction boundary.
const sessionActions = new SessionActionManager(registry, personas.store);
// One ceiling on tool-less review work for the whole daemon, constructed here and injected,
// never reached for as a module global. Workflow Persona attempts and context compaction
// share it today. The Foreman is a separate process and unrelated background jobs keep
// their own limits on purpose - see llm/review-scheduler.ts.
const reviewScheduler = createReviewScheduler();
// The SECOND ceiling, and deliberately not the first one. A Workflow check runs a build,
// not a tool-less model call, so it is not a member of the budget above by that budget's own
// definition - and a three-minute test suite holding one of its three slots would starve the
// Persona reviews it exists to pace. Constructed here and injected for the same reason: a
// subsystem reaching for its own limiter is a subsystem whose "two" quietly becomes four.
const checkScheduler = createCheckScheduler();
// Workflow check leases and the runtime that takes them. The ORDERING here is the whole
// protection, not tidiness, and it runs ABOVE the WorkflowManager for a second reason on top
// of the reaper one: `workflows.start()` recovers runs and can schedule a check attempt
// immediately, and a check must not be able to lease a tree before the daemon knows which
// trees it already holds.
//
// A check holds a pooled worktree with no session, no task and - between the lease and the
// spawn - no processes, so every liveness signal the reaper trusts reads "idle" on a tree
// that is about to be built in. Two things stop it being reaped, and both have to be in
// place before the reaper's first sweep: the pin source below, and the durable rows
// reconciliation restores into it. A pin registered after that sweep is invisible to it -
// the same rule that makes `sdkSessions.restore()` run before `startPoller`.
//
// Reconciliation resolves only what it can prove safe. It returns a tree whose supervisor
// gate was never released, and otherwise asks the supervisor's group recovery whether
// anything is still running in it: proving the tree is OURS is not proving that nothing is
// still writing in it, and only the second authorises a `return --force`. That seam is
// injected here - it is declared with a refusing default, so a daemon that forgot this line
// would keep every non-sentinel lease across a restart and quietly lose a pool slot each time.
//
// Awaited rather than fire-and-forget for the ordering itself, and best-effort because a
// daemon that refused to start over one unreconcilable lease would be worse than one
// running without it.
const checkLeases = new CheckLeaseManager();
const checkRuntime = new CheckRuntime(checkLeases);
installCheckLeasePins(() => checkLeases.pinnedPaths());
try {
  await checkLeases.reconcileOnStartup(checkRuntime.groupRecovery);
} catch (err) {
  console.error("[mission-control] could not reconcile check leases:", err);
}
// Assigned below. The Workflow binding guard reaches it through this reference, and the reference
// is safe because the guard fires only at bind time - long after `ensembles` is constructed. This
// is the two-way seam the plan requires: Workflow asks Ensemble whether a session may be bound,
// and Ensemble asks Workflow to bind/submit the finalized winner, without either importing the
// other's store. The guard hands back only a reason string or null.
let ensembles: EnsembleManager;
const workflows = new WorkflowManager(registry, personas.store, {
  queueManager: queues,
  reviewScheduler,
  checkScheduler,
  // The gate stops being a formality here. A configured, allowlisted check now leases a
  // pooled worktree pinned to the captured commit, runs the operator's argv in it, and a
  // non-zero exit FAILS the submission - where before it recorded "not run" and passed.
  checkDeps: (attempt) => ({ execute: checkRuntime.executorFor(attempt) }),
  // And its other half: no check node may be retried onto a second worktree while the first
  // attempt's lease is still unresolved.
  unresolvedCheckLease: (submissionId, nodeId) =>
    checkRuntime.unresolvedLeaseForNode(submissionId, nodeId),
  inject: runtimePromptInjector(sdkSessions),
  // How often the resumption observer and the session action sweep look, in ms.
  //
  // Overridable for the reason `INSPECTOR_POLL_MS` and `MISSION_POLL_MS` are: both loops ask
  // "has the bound session stopped?", and the shipped fifteen seconds is a cadence chosen for
  // a laptop with real agents on it. A browser test driving a real action turn otherwise waits
  // that long per state transition for a fake agent that answered instantly. Unset, the
  // shipped default stands - this is not a setting an operator has any reason to touch.
  ...(envVar("WORKFLOW_SWEEP_MS")
    ? { resumptionIntervalMs: Number(envVar("WORKFLOW_SWEEP_MS")) }
    : {}),
  canBindSessionToWorkflow: (sessionId) => ensembles.canBindSessionToWorkflow(sessionId),
  externalBindingEligibility: ({ sessionId }) => ensembles.canBindSessionToWorkflow(sessionId),
});
workflows.start();
// The ensemble manager: it populates the registry's ensemble collection so a reconnect snapshot
// is truthful, registers the task projection so a member's session card names its group, owns the
// engine that launches member waves, captures submissions and recovers, runs the Best-of-N
// comparison through the human-decision boundary, and drives the confirmed finalization through
// its injected Task/Workflow seams. Public creation is enabled now that every production driver
// is executable; an existing installation still creates no rows until an operator calls that API.
//
// Its Persona resolver is the manager's own store, so a comparison configured against a Persona
// snapshots that Persona's exact revision, name, guidance and overrides at creation instead of
// re-reading a Markdown file that may since have been edited or archived. The review executor
// shares the daemon-wide `reviewScheduler`, so a comparison counts against the SAME ceiling as
// Workflow review and compaction; it resolves runner/model per attempt through the persona ladder
// or the `ensemble-comparison` job, and its provider call is tool-less by construction.
ensembles = new EnsembleManager(registry, undefined, {
  resolvePersona: (personaId) => {
    const persona = personas.store.getPersona(personaId);
    return persona
      ? {
          id: persona.id,
          revision: persona.revision,
          name: persona.name,
          guidanceMarkdown: persona.guidanceMarkdown,
          runner: persona.runner,
          model: persona.model,
          archived: persona.archivedAt !== null,
        }
      : null;
  },
  tasks: new TaskManagerGateway(tasks, registry),
  review: {
    scheduler: reviewScheduler,
    resolveExecution: (guidance, pins) => {
      const cfg = getLlmConfig();
      return resolveEvaluatorExecution(guidance, pins, {
        appRunner: llmRunnerChoice(cfg),
        personaEnvModel: envVar(WORKFLOW_PERSONA_MODEL_ENV) ?? null,
        jobModel: (runnerId) =>
          resolveLlmJobModel(
            "ensemble-comparison",
            cfg.models,
            envVar(LLM_JOB_SPECS["ensemble-comparison"].envKey),
            runnerId,
          ).id,
      });
    },
    runModel: (runnerId, prompt, opts) =>
      llmRunner(runnerId).run(prompt, {
        model: opts.modelId,
        timeoutMs: opts.timeoutMs,
        schema: opts.schema,
      }),
    guaranteesSchema: (runnerId) =>
      llmRunner(runnerId).structuredOutput?.guaranteesInputShape === true,
  },
  // The finalization authorities: exact restore through `resetSession`, replacement Task
  // materialization through TaskManager, guarded pane injection, and the Workflow external
  // boundary. This is what lets a human-confirmed decision reap losers, preserve one exact winner,
  // and optionally submit its clean snapshot into a published Workflow - all restart-safe.
  finalize: createFinalizeDeps({
    registry,
    tasks,
    workflows,
    sdk: sdkSessions,
    pendingTurns,
  }),
  // Resolve an operator's Workflow placement to an immutable version at creation; a Live/Foreman
  // selection is a typed refusal here, never a Preview downgrade.
  resolveWorkflowVersion: (workflowId, version) => resolveEnsembleWorkflowVersion(workflows, workflowId, version),
});
// Resume non-terminal ensembles once the first discovery sweep makes member Task/Session state
// real - the same gate TaskManager and WorkflowManager recovery use, and registered after both so
// their reconstruction runs first. Recovery is derived from SQLite plus current registry state,
// never from missed events. A deletion interrupted mid-flight is resumed in the same pass.
registry.onSessionsObserved(() => {
  void ensembles.recoverNonTerminalRuns();
  void ensembles.recoverDeletions();
});
// Embedded (SDK-runtime) sessions, restored BEFORE the poller starts - the other half of the
// gate above. `onSessionsObserved` fires on the first COMPLETED sweep, and every restart twin
// hangs off it, so a session registered after that moment is invisible to the reconciliation
// that would have settled its task. Restoring first is what makes an embedded session look
// exactly like a rediscovered terminal one to `reconcileTasksWithNoLiveSession` and
// `reconcileBindingsAfterDiscovery`. Inert on an installation nobody has turned the runtime on
// for: with every harness's `sessionRuntime` at its shipped `terminal`, no row was ever
// written and there is nothing to resume. Awaited rather than fire-and-forget for the ordering
// itself, and best-effort because a daemon that refused to start over one unresumable session
// would be worse than one running without it.
try {
  await sdkSessions.restore();
} catch (err) {
  console.error("[sdk] could not restore embedded sessions:", err);
}
// The daemon's half of usage accounting. Installed before the Inspector starts, because
// the Inspector runs IN this process and would otherwise spend before there was anywhere
// to record it. Straight to the ledger - the daemon is the only process allowed to write
// it, which is exactly why the Foreman worker POSTs instead (`/api/usage/automation`).
setLlmSpendSink((report) => {
  if (recordSpendReport(report).kind === "recorded") registry.applyAutomationUsage();
});
const stopPoller = startPoller(registry);
// Off unless MISSION_AGENTS_SHADOW_MS is set; returns a no-op stopper when disabled.
const stopAgentsShadow = startAgentsShadow(registry);
const stopPrPoller = startPrPoller(registry);
const stopInspector = startInspector(registry, {
  workflowGate: (prKey) => workflows.mergeGate(prKey),
});
const stopRuntimeMeta = startRuntimeMetaPoller(registry);
// Whether each live session has been corrected by its human, which is half of whether the
// dashboard offers it a retrospective. Its own loop rather than a sixth reader on the meta
// poll above: different question, different read, and a session that has already flipped is
// never looked at again. See `retro-worthiness.ts` for why the steady-state cost is a stat.
const stopRetroWorthiness = startRetroWorthinessPoller(registry);
const stopUsage = startUsagePoller(registry);
const stopGoalRefiner = startGoalRefiner(registry);
// The repeat-offender derivation is detail-only (it walks a run's submissions and attempts),
// so it reaches the alert engine on its own channel rather than by widening the SSE summary.
const away = startAwayWatcher(registry, undefined, {
  workflowRepeatOffenders: () => workflows.repeatOffenderSignals(),
});
const stopHeadlessPruner = startHeadlessPruner();
// The reclamation pass rides the reaper's tick: same cadence, same lock, and it collects
// what the reaper structurally cannot see. A check lease is held under a token outside
// LEASE_HOLDERS precisely so the reaper refuses it, which means the reaper can never
// collect a leaked one either - so this is an obligation that comes with that protection.
//
// It gets the SAME group-recovery seam startup reconciliation got, and for the same reason:
// ownership is not emptiness, and a pass that returned a tree on ownership alone would
// hard-reset one a build is still writing into. Left uninjected here, every non-sentinel
// lease would be kept forever - fail closed, but a pool slot per crashed check.
const stopPoolReaper = startPoolReaper(registry, {
  reclaimLeases: () => checkLeases.reclaimLeaked(checkRuntime.groupRecovery),
});
const stopSkillsReloader = startSkillsReloader(registry);
// Pulls work INTO the backlog from systems that already hold it. In the daemon because
// ingest writes to the DB and the daemon is the only writer; needs none of the reload
// loop's pane gate because it never types (see src/shared/task-source.ts).
const stopTaskSources = startTaskSourceSweeper(tasks, () => publishSettingsStatus(registry));
// Recurring Missions, for the same two reasons as the sweeper above: it writes to the DB,
// and the port bind guarantees exactly one of it. It files backlog tasks and stops there -
// Foreman is still the only autonomous path to a running agent. Inert until an operator
// saves a schedule through the routes below.
//
// The Registry is its live-state notifier: the manager announces a durable schedule change
// through `upsert`/`remove`, and the Registry both caches it and emits the SSE variant. The
// adapter is thin because the two names differ (the Registry's methods are `*Schedule`, so
// they sit beside `upsertEnsemble` / `upsertWorkflow`), but it IS the Registry.
const schedules = new ScheduleManager({
  tasks,
  notifier: {
    upsert: (schedule) => registry.upsertSchedule(schedule),
    remove: (id) => registry.removeSchedule(id),
  },
});
let stopSchedules = () => {};

// The transient Keep Awake owner. Constructed before the app so the routes never see a
// daemon without it, and SEEDED into the registry before the server accepts traffic so
// the very first snapshot already carries a truthful status - which, on every boot, is
// `off`: the mode is deliberately never persisted or reacquired across restarts.
const keepAwake = new KeepAwakeManager({
  onStatus: (status) => registry.setKeepAwakeStatus(status),
});
registry.setKeepAwakeStatus(keepAwake.status());

const app = buildApp(
  registry,
  reviews,
  tasks,
  queues,
  away,
  personas,
  workflows,
  schedules,
  ensembles,
  sdkSessions,
  undefined,
  undefined,
  sessionActions,
  pendingTurns,
  undefined,
  keepAwake,
);

// In production the daemon serves the built SPA; in dev, Vite serves it and
// proxies /api + /events here, so the dist may be absent - that's fine.
//
// Resolve the web root to an ABSOLUTE path so serving never depends on the
// daemon's working directory (it's unpredictable when spawned by the Electron
// app). `MISSION_WEB_DIR` lets the desktop shell point at the built UI inside the
// app bundle's Resources; otherwise fall back to this module's sibling dist/web,
// which covers both `tsx src/server/index.ts` (dev) and `node dist/server/index.mjs`.
const webDir =
  process.env.MISSION_WEB_DIR ?? fileURLToPath(new URL("../../dist/web", import.meta.url));
const hasDist = existsSync(webDir);
if (hasDist) {
  app.use("/*", serveStatic({ root: webDir }));
  app.get("*", serveStatic({ path: join(webDir, "index.html") }));
}

const server = serve({ fetch: app.fetch, hostname: HOST, port: PORT }, (info) => {
  // Startup recovery changes durable rows, so it starts only after this process wins the
  // loopback port and is therefore the daemon's sole SQLite writer.
  pendingTurns.start();
  // Startup recovery treats every open claim as abandoned, so it may begin only after
  // this daemon has won the port that makes it the single writer.
  stopSchedules = startScheduleManager(schedules);
  const where = hasDist
    ? `http://${HOST}:${info.port}`
    : `http://${HOST}:5173 (dev) - API on :${info.port}`;
  console.log(`[mission-control] listening on ${where}`);
});

async function shutdown(): Promise<void> {
  stopPoller();
  stopAgentsShadow();
  stopPrPoller();
  stopInspector();
  stopRuntimeMeta();
  stopRetroWorthiness();
  stopUsage();
  stopGoalRefiner();
  // Stopping the refiner only stops it STARTING runs; one already in flight is a detached
  // process that outlives us and would go on burning tokens for a card nobody is watching.
  // `claude-cli.ts` hooks `process.exit` for the same reason, but this path calls it
  // explicitly rather than relying on that ordering.
  //
  // Through the REGISTRY rather than one provider's kill: the daemon's background jobs
  // spawn through whichever runner is configured, so a shutdown that only knew how to kill
  // `claude -p` would leave a second provider's children running - which is the shape of
  // leak `killLiveRuns` is required (not optional) on the interface to prevent.
  // Kill before awaiting workflow workers, or a 120s Persona timeout becomes a 120s
  // daemon shutdown.
  killLiveLlmRuns();
  // Ask every embedded session's driver to close before we go. An SDK subprocess is OUR
  // child, unlike an agent in a tmux pane that outlives us, so this is the difference
  // between a harness closing its session file cleanly and it being killed mid-turn.
  pendingTurns.stop();
  await sdkSessions.stopAll();
  // `workflows.stop()` cancels any live check process group and then waits for its attempt to
  // hand the pooled worktree back. It MUST stay above `stopPoolReaper()` below: those returns
  // run through the pool adapter and its lock, and stopping the reaper first would leave the
  // last thing that could collect a lease already shut down while leases were still being
  // returned. Do not reorder.
  await workflows.stop();
  ensembles.stop();
  away.stop();
  stopHeadlessPruner();
  stopPoolReaper();
  stopSkillsReloader();
  stopTaskSources();
  stopSchedules();
  // Release the idle-sleep assertion while we can still do it gracefully. `caffeinate`'s
  // own `-w <daemon PID>` covers every exit that never reaches this line, so this is the
  // orderly half of a two-part cleanup, not the only one.
  await keepAwake.stop();
  server.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
