/**
 * What is at stake: a SessionAction is the first graph node that WRITES to the operator's
 * session, and the first one whose completion produces new evidence instead of a verdict.
 * Three ways to get it wrong are all silent:
 *
 *  - completing on the session's pre-delivery idle, which is the normal state at the instant
 *    the packet is typed, so the action would "finish" before anybody read it;
 *  - reusing the parent submission, which would make upstream and downstream attempts claim
 *    they reviewed the same evidence when the action turn changed it;
 *  - opening a repair round instead of a segment, which restarts the graph at Session and
 *    spends budget an action never earned.
 *
 * Every test here drives the real Registry, store, engine and manager. There is no raw SQL and
 * no hand-written row: a test that has to fabricate state is a test proving the state is
 * unreachable in production.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { LlmRunner } from "../src/shared/llm.ts";
import type { Session } from "../src/shared/types.ts";
import type { InjectDeps, PromptWriteGuard } from "../src/server/actions.ts";
import type { WorkflowEvidenceProbe } from "../src/server/workflows/context.ts";
import type { WorkflowManagerOptions } from "../src/server/workflows/manager.ts";
import type {
  SessionActionAdoptedPullRequest,
} from "../src/server/workflows/session-action-adapters.ts";
import { mkMuxHandle, mkTask } from "./helpers/session-fixture.ts";
import { prCreationFixture } from "./helpers/pr-creation-fixture.ts";

const home = mkdtempSync(join(tmpdir(), "session-action-runtime-"));
process.env.MISSION_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const { Registry } = await import("../src/server/registry.ts");
const { sessionMessages } = await import("../src/server/harness/index.ts");
const { PersonaManager } = await import("../src/server/workflows/personas.ts");
const { SessionActionManager } = await import("../src/server/workflows/session-actions.ts");
const { WorkflowStore } = await import("../src/server/workflows/store.ts");
const { WorkflowManager } = await import("../src/server/workflows/manager.ts");
const { boundedWorkflowTranscript, fallbackWorkflowContext } = await import("../src/server/workflows/context.ts");
const { getWorkflowPolicy, setWorkflowPolicy } = await import("../src/server/workflows/config.ts");
const { getForemanConfig } = await import("../src/server/foreman/config.ts");
const { PersonaVerdictSchema, WorkflowContextSnapshotSchema, WorkflowInspectorGateStateSchema } = await import("../src/shared/protocol.ts");

setWorkflowPolicy({ liveEnabled: true, repoAllowlist: ["/repo"] });

/** Far past every `lastActivity` this file writes, so `settledIdle` is satisfied. */
const SETTLED = () => Date.now() + 600_000;

function discovered(id: string): DiscoveredSession {
  return {
    syntheticId: id,
    agent: "claude",
    name: id,
    nameSource: "process",
    cwd: "/repo",
    gitBranch: "feature",
    gitRoot: "/repo",
    repoRoot: "/repo",
    pid: 6000 + id.length,
    tty: `tty-${id}`,
    terminals: [mkMuxHandle({ paneId: `%${id.length}` })],
    startedAt: 1,
  } as DiscoveredSession;
}

/** A reviewer whose verdict this file chooses, so downstream failure is drivable. */
function runner(verdict: () => "pass" | "fail"): LlmRunner {
  return {
    id: "claude",
    label: "fake",
    runInThread: null,
    structuredOutput: null,
    sandbox: null,
    price: () => null,
    litter: null,
    killLiveRuns() {},
    async run() {
      return verdict() === "pass"
        ? JSON.stringify({
            verdict: "pass",
            summary: "Looks right.",
            approvalDetails: { reason: "The evidence supports it.", evidence: [] },
            confidence: 1,
          })
        : JSON.stringify({
            verdict: "fail",
            summary: "One issue",
            requestedChanges: [{
              basis: "substantive",
              title: "Rename the misleading helper",
              rationale: "The evidence requires it.",
              evidence: [{ kind: "diff", quote: "bad line" }],
            }],
            confidence: 1,
          });
    },
  };
}

/**
 * The budget for an in-process wait - no spawn, no compile, nothing off-box.
 *
 * Five seconds was the original figure on the theory that a sweep and a store write are a
 * tick away, and on an idle machine they are: this file runs in under two seconds on its own.
 * It is not idle under `npm test`, where `--test-concurrency=6` keeps other files' HTTP
 * servers, spawned `node --import tsx` children and real Electron geometry tests on the same
 * CPU, and a wall-clock budget measures the machine's load rather than the code's progress.
 * The wait at "an action pipeline captures a segment per action" timed out at exactly this
 * budget during a full run and passed alone immediately after - the segment was captured, the
 * poll just did not get scheduled to say so inside five seconds.
 *
 * Thirty seconds, and this is the SECOND time this budget has been raised for the same reason -
 * which is the argument for making it generous rather than incrementally larger. The first raise
 * (five to ten) was for the wait at "an action pipeline captures a segment per action"; ten then
 * failed at exactly the budget for "two actions run in order in one repair round" during a full
 * `npm test`, and that file passed alone immediately afterwards. Both times the condition was
 * already true and the poll had simply not been scheduled to say so.
 *
 * Generous costs nothing when the condition is true, because the loop returns on the first poll
 * that sees it - the only thing a tight bound here buys is false failures on a loaded machine.
 * `test/foreman-spend-delivery.test.ts` keeps its own ten: it has not shown this, and copying a
 * number across files is how one file's timing becomes an accident of another's.
 */
const IN_PROCESS_WAIT_MS = 30_000;

async function waitFor(check: () => boolean, message: string): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > IN_PROCESS_WAIT_MS) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface HarnessOptions {
  /** Actions in pipeline order, each a `session_turn` action unless it names a skill. */
  actions?: Array<{ id: string; prompt: string; skillId?: string | null }>;
  /**
   * Give every action the `pull_request` completion instead of `session_turn`.
   *
   * The harness's mutable `adopted` list is then what decides whether the proof succeeds, so a
   * test states "there is an open pull request on this branch at this commit" rather than
   * arranging one on GitHub.
   */
  pullRequest?: boolean;
  unchangedRepository?: boolean;
  unchangedRepositoryProblem?: string;
  beforeReadContext?: () => Promise<void> | void;
  readUnchangedRepository?: WorkflowManagerOptions["readUnchangedRepository"];
  realLedger?: boolean;
  resolveCommitTree?: WorkflowManagerOptions["resolveCommitTree"];
  readRepositoryId?: WorkflowManagerOptions["readRepositoryId"];
  resumptionSettleMs?: number;
  localReport?: boolean;
  omitContentTree?: boolean;
  inspector?: boolean;
  inspectorFindingsPolicy?: "restart_workflow" | "inspector_only";
  resumptionPolicy?: "manual" | "auto";
  trackCiFailures?: () => boolean;
  deliveryMode?: "preview" | "live";
  maxRepairRounds?: number;
  probeEvidence?: boolean;
  publicationCheckoutRevision?: WorkflowManagerOptions["publicationCheckoutRevision"];
  readEvidenceProbe?: WorkflowManagerOptions["readEvidenceProbe"];
  /** A reviewer AFTER the last action, so downstream activation is observable. */
  downstream?: boolean;
  /** Exercise the published fresh-evidence preflight on every evaluator-bound submission. */
  evidenceReadinessPolicy?: "off" | "criterion_mapped_v1";
  verdict?: () => "pass" | "fail";
  /**
   * Wire both actions off Session directly rather than in a chain, so they become ready in
   * the same submission. Only the raw draft API can author this; a linear pipeline cannot.
   */
  parallelActions?: boolean;
  /** Make the pane positively reject the write, the way a guard or a busy pane does. */
  refuseInject?: boolean;
  onInject?: (payload: string) => void;
  requireSkill?: (session: Session, id: string) => { ok: true; command: string } | { ok: false; message: string };
}

async function harness(sessionId: string, options: HarnessOptions = {}) {
  const actionSpecs = options.actions
    ?? (options.parallelActions
      ? [
          { id: "first", prompt: "# First\n\nDo the first thing.\n" },
          { id: "second", prompt: "# Second\n\nDo the second thing.\n" },
        ]
      : [{ id: "act", prompt: "# Tidy\n\nRun the tidy pass.\n" }]);
  const registry = new Registry();
  registry.applyDiscovery([discovered(sessionId)]);
  const personas = new PersonaManager(registry);
  const store = personas.store;
  const actionsManager = new SessionActionManager(registry, store);
  const injected: string[] = [];
  const head = { sha: "head-1" };
  /**
   * The repository and the adoption ledger, as facts a test states rather than arranges.
   *
   * `full()` is the harness's whole answer to the short-versus-full head problem the runtime
   * has to solve for real: evidence capture records an abbreviation and GitHub reports a
   * 40-character object id, so the fixture keeps the two spellings of one commit distinct and
   * `resolveCommit` maps between them exactly as `resolveCapturedCommit` does against git.
   */
  const full = (sha: string): string =>
    ([...sha].map((char) => char.charCodeAt(0).toString(16)).join("") + "0".repeat(40)).slice(0, 40);
  const contentTree = { oid: full("reviewed-tree") };
  const commitTrees = new Map<string, string>();
  const repository = { root: "/repo", branch: "feature" as string | null };
  /**
   * The commit evidence capture records, when it must differ from the one the PROOF read.
   *
   * Null means "the same commit", which is the ordinary case. Setting it is how a test
   * reproduces the race the whole re-check path exists for: the adapter proves the pull
   * request at one commit and the checkout has moved by the time the capture reads it, which
   * on a real machine is an agent that pushed and then kept working.
   */
  const captureHead: { sha: string | null } = { sha: null };
  const adopted: SessionActionAdoptedPullRequest[] = [];
  let verdictChoice: () => "pass" | "fail" = options.verdict ?? (() => "pass");
  const managerOptions: WorkflowManagerOptions = {
    trackCiFailures: options.trackCiFailures,
    publicationCheckoutRevision: options.publicationCheckoutRevision ?? (() => contentTree.oid),
    resumptionSettleMs: options.resumptionSettleMs,
    ...(options.probeEvidence ? { readEvidenceProbe: async (_registry, binding) => ({
      stagedImageGeneration: store.workflowEvidenceGeneration(binding.noteKey, binding.sessionCwd || ""),
      contentTreeOid: options.localReport ? full("tree-with-report") : contentTree.oid,
      headSha: captureHead.sha ?? head.sha,
      workingTreeStatus: [],
      diffFingerprint: `diff-${captureHead.sha ?? head.sha}`,
      localArtifactHashes: options.localReport ? [{
        path: "docs/reports/result/report.html",
        sha256: createHash("sha256").update("report").digest("hex"),
      }] : [],
    }) } : {}),
    ...(options.readEvidenceProbe ? { readEvidenceProbe: options.readEvidenceProbe } : {}),
    readUnchangedRepository: options.readUnchangedRepository ?? (async (_root, headOid) => {
      if (options.unchangedRepositoryProblem) throw new Error(options.unchangedRepositoryProblem);
      return options.unchangedRepository
        ? { headOid, baseOid: headOid, baseRef: "origin/main", treeOid: contentTree.oid } : null;
    }),
    readRepositoryHead: async () => ({
      repositoryId: repository.root,
      root: repository.root,
      branch: repository.branch,
      headOid: full(head.sha),
      headCommittedAt: null,
    }),
    adoptedPullRequests: options.realLedger ? undefined : () => adopted,
    readRepositoryId: options.readRepositoryId ?? (async root => root),
    resolveCommit: async (_root, headSha) => full(headSha),
    resolveCommitTree: options.resolveCommitTree ?? (async (_root, oid) => commitTrees.get(oid) ?? contentTree.oid),
    requireSkill: options.requireSkill
      ?? (() => ({ ok: true, command: "/mission-pull-request" })),
    inject: (async (
      _session: Session,
      payload: string,
      _deps?: InjectDeps,
      beforeWrite?: PromptWriteGuard,
    ) => {
      const blocked = beforeWrite?.();
      if (blocked) return { ok: false, error: blocked, pasted: false, submitVerified: false };
      // `pasted: false` is a POSITIVE refusal: the write was attempted and the pane rejected
      // it, so nothing landed. That is a different answer from an uncertain write, and the
      // runtime treats the two differently.
      if (options.refuseInject) {
        return { ok: false, error: "pane_blocked", pasted: false, paneBlocked: true, submitVerified: false };
      }
      options.onInject?.(payload);
      injected.push(payload);
      return { ok: true, pasted: true, submitVerified: true };
    }) as never,
    recordInjection: (() => {}) as never,
    readContextRaw: async (_registry, binding) => {
      if (options.beforeReadContext) await options.beforeReadContext();
      const session = _registry.getSession(binding.sessionId!);
      const located = session ? sessionMessages(session) : null;
      const transcript = boundedWorkflowTranscript(located?.read.window(located.path, 12, 68).messages ?? []);
      const transcriptSize = located?.read.size(located.path) ?? null;
      const raw = {
        primaryGoal: { rawPrompt: "Ship it", refined: null, sourceNoteKey: binding.noteKey },
        humanDecisions: [],
        priorPersonaFeedback: [],
        session: { agent: "claude" as const, name: sessionId, cwd: binding.sessionCwd, branch: "feature" },
        evidence: {
          headSha: captureHead.sha ?? head.sha,
          ...(options.omitContentTree ? {} : {
            contentTreeOid: options.localReport ? full("tree-with-report") : contentTree.oid,
          }),
          ...(options.localReport ? {
            publication: {
              version: 1 as const, treeOid: contentTree.oid, unpublishedPaths: [], pathsTruncated: false,
              localArtifacts: [{ path: "docs/reports/result/report.html", sha256: createHash("sha256").update("report").digest("hex"), bytes: 6 }],
            },
            artifacts: [{
              id: "local-report", ordinal: 0, displayName: "docs/reports/result/report.html",
              caption: "Retained local report", repositoryScope: "all" as const, mimeType: "text/plain" as const,
              bytes: 6, sha256: createHash("sha256").update("report").digest("hex"), content: "report",
              availability: "retained" as const, prunedAt: null, createdAt: 1,
            }],
          } : {}),
          diffFingerprint: `diff-${captureHead.sha ?? head.sha}`,
          diff: `patch at ${captureHead.sha ?? head.sha}`,
          diffTruncated: false,
          workingTreeDirty: !!options.localReport,
          workingTreeStatus: [],
          workingTreeStatusTruncated: false,
          transcript: transcript.transcript,
          transcriptAnchor: transcriptSize ?? 1,
          transcriptTruncated: transcript.truncated,
          standards: [],
          standardsTruncated: false,
        },
      };
      return {
        raw,
        context: fallbackWorkflowContext(raw, null),
        boundary: {
          noteKey: binding.noteKey,
          sessionId: binding.sessionId!,
          headSha: captureHead.sha ?? head.sha,
          transcriptPath: located?.path ?? null,
          transcriptSize: transcriptSize ?? 0,
          repositoryFingerprint: `repo-${captureHead.sha ?? head.sha}`,
        },
      };
    },
    boundaryChanged: async () => false,
    compactContext: async (raw) => options.evidenceReadinessPolicy === "criterion_mapped_v1"
      ? {
          ...fallbackWorkflowContext(raw, null),
          canonicalCriteria: [{
            id: "criterion-reviewed-content",
            text: "The reviewed content is ready to ship",
            material: true,
            suggestedProofClass: "focused_execution",
          }],
          criterionMappings: [{
            criterionId: "criterion-reviewed-content",
            matchedClientCriterionIds: ["reviewed-content"],
          }],
          compaction: { status: "model", runner: "claude", model: "fake", error: null },
        }
      : fallbackWorkflowContext(raw, null),
    engine: {
      runnerFor: () => runner(() => verdictChoice()),
      resolveExecution: () => ({
        runner: { id: "claude", source: "config", unknown: null },
        model: { id: "fake", source: "config" },
      }),
    },
  };
  let manager = new WorkflowManager(registry, store, managerOptions);

  const upstream = personas.create({
    name: `upstream-${sessionId}`,
    description: "",
    guidanceMarkdown: "# Review",
    runner: "claude",
    model: "fake",
  });
  assert.equal(upstream.ok, true);
  const upstreamId = upstream.ok ? upstream.persona.id : "";
  let downstreamId = "";
  if (options.downstream) {
    const created = personas.create({
      name: `downstream-${sessionId}`,
      description: "",
      guidanceMarkdown: "# Review",
      runner: "claude",
      model: "fake",
    });
    assert.equal(created.ok, true);
    downstreamId = created.ok ? created.persona.id : "";
  }
  const actionIds = actionSpecs.map((spec) => {
    const created = actionsManager.create({
      name: `${spec.id}-${sessionId}`,
      description: "",
      promptMarkdown: spec.prompt,
      requiredSkillId: spec.skillId ?? null,
      completion: { kind: options.pullRequest ? "pull_request" : "session_turn" },
    });
    assert.equal(created.ok, true, `session action ${spec.id} was refused`);
    return created.ok ? created.action.id : "";
  });

  // Session -> upstream persona -> action(s) in order -> [downstream persona] -> End.
  const chain = actionSpecs.map((spec, index) => ({
    node: spec.id,
    actionId: actionIds[index]!,
  }));
  const nodes: unknown[] = [
    { id: "session", kind: "session", position: { x: 0, y: 0 } },
    { id: "upstream", kind: "persona", personaId: upstreamId, position: { x: 150, y: 0 } },
    ...chain.map((entry, index) => ({
      id: entry.node,
      kind: "session_action",
      sessionActionId: entry.actionId,
      position: { x: 300 + index * 150, y: 0 },
    })),
    ...(options.downstream
      ? [{ id: "downstream", kind: "persona", personaId: downstreamId, position: { x: 700, y: 0 } }]
      : []),
    { id: "end", kind: "end", outcome: "Approved", position: { x: 900, y: 0 } },
  ];
  const edges: unknown[] = [
    { id: "e-start", source: "session", sourcePort: "submitted", target: "upstream", targetPort: "activate" },
    { id: "f-upstream", source: "upstream", sourcePort: "fail", target: "session", targetPort: "return_for_changes" },
  ];
  if (options.parallelActions) {
    // One `pass` fans out to BOTH actions, so both become ready off the same receipt.
    for (const entry of chain) {
      edges.push({
        id: `e-fan-${entry.node}`,
        source: "upstream",
        sourcePort: "pass",
        target: entry.node,
        targetPort: "activate",
      });
      edges.push({
        id: `e-${entry.node}`,
        source: entry.node,
        sourcePort: "complete",
        target: "end",
        targetPort: "terminal",
      });
    }
  } else {
    const sequence = ["upstream", ...chain.map((entry) => entry.node)];
    if (options.downstream) sequence.push("downstream");
    for (let index = 0; index < sequence.length; index += 1) {
      const from = sequence[index]!;
      const to = sequence[index + 1] ?? "end";
      const port = from === "upstream" || from === "downstream" ? "pass" : "complete";
      const targetPort = to === "end" ? "terminal" : "activate";
      edges.push({ id: `e-${from}`, source: from, sourcePort: port, target: to, targetPort });
      if (port === "pass" && from !== "upstream") {
        edges.push({
          id: `f-${from}`,
          source: from,
          sourcePort: "fail",
          target: "session",
          targetPort: "return_for_changes",
        });
      }
    }
  }

  const created = manager.create({
    name: `Action runtime ${sessionId}`,
    description: "",
    draft: { nodes, edges } as never,
    completionPolicy: options.inspector
      ? { kind: "inspector", onFindings: options.inspectorFindingsPolicy ?? "restart_workflow", missingPrAction: "wait" }
      : { kind: "none" },
    evidenceReadinessPolicy: options.evidenceReadinessPolicy ?? "off",
    // Opt into the observer only when the test drives automatic resumption itself.
    resumptionPolicy: options.resumptionPolicy ?? "manual",
    bindingDefaults: {
      triggerMode: "manual",
      deliveryMode: options.deliveryMode ?? "live",
      maxRepairRounds: options.maxRepairRounds ?? 8,
    },
  });
  assert.equal(created.ok, true, "the workflow was refused");
  const workflowId = created.ok ? created.workflow.id : "";
  const published = manager.publish(workflowId, 1);
  assert.equal(published.ok, true, `publish was refused: ${JSON.stringify(published)}`);
  const versionId = published.ok ? published.version.id : "";

  registry.applyHook({
    agent: "claude",
    event: "PreToolUse",
    sessionId: `agent-${sessionId}`,
    cwd: "/repo",
    transcriptPath: null,
    env: { tmuxPane: `%${sessionId.length}` },
    prCreated: false,
  });
  manager.start();

  const reportIdle = (transcriptPath: string | null = null): void => {
    registry.applyHook({
      agent: "claude",
      event: "Stop",
      sessionId: `agent-${sessionId}`,
      cwd: "/repo",
      transcriptPath,
      env: { tmuxPane: `%${sessionId.length}` },
      prCreated: false,
    });
    assert.equal(registry.getSession(sessionId)?.state, "idle", "the Stop hook did not land");
  };

  /**
   * The session picking the packet up, exactly as its own tool-use hook would report it.
   *
   * Held back to the next millisecond first, which is load-bearing rather than tidiness.
   * Pickup is proven by `lastActivity > anchor.deliveredAt` - STRICTLY, so that an idle the
   * session was already sitting in before the send can never satisfy it - and this harness
   * leaves that comparison as the ONLY proof there is: it reports `transcriptPath: null`, so
   * the byte-offset route `sessionActionPickup` uses is closed, and this is the single ACTIVE
   * transition a whole test makes. Both stamps are `Date.now()` in milliseconds, and the
   * anchor is written in the same transaction that marks the packet delivered, so a test that
   * observes `delivered` and reports its hook inside that same millisecond hands the runtime
   * an activity timestamp EQUAL to the anchor. That is rejected, correctly, and no second
   * transition ever comes: the action waits for a pickup that already happened, and the test
   * fails thirty seconds later at whatever it was really waiting for. It is invisible in the
   * events, too - the run reaches `delivery_delivered` and simply never emits
   * `session_action_picked_up`.
   *
   * A real agent cannot read a packet and run a tool inside the millisecond it was typed, so
   * the runtime is right and this harness was wrong to be able to. Waiting out the millisecond
   * costs each turn under 1ms and buys back an interval that is never zero in production.
   */
  const reportWorking = (): void => {
    const entered = Date.now();
    while (Date.now() <= entered) { /* the clock has to move before the hook can prove pickup */ }
    registry.applyHook({
      agent: "claude",
      event: "PreToolUse",
      sessionId: `agent-${sessionId}`,
      cwd: "/repo",
      transcriptPath: null,
      env: { tmuxPane: `%${sessionId.length}` },
      prCreated: false,
    });
    assert.equal(registry.getSession(sessionId)?.state, "working", "the PreToolUse hook did not land");
  };

  /** One complete action turn: the session reads the packet, works, and settles. */
  const runActionTurn = (): void => {
    reportWorking();
    reportIdle();
  };

  const reportPrompt = (prompt: string, ts?: number): void => {
    const entered = Date.now();
    while (Date.now() <= entered) { /* distinguish successive prompt receipts */ }
    registry.applyHook({ agent: "claude", event: "UserPromptSubmit", sessionId: `agent-${sessionId}`,
      cwd: "/repo", transcriptPath: null, env: { tmuxPane: `%${sessionId.length}` }, prompt, ...(ts === undefined ? {} : { ts }) });
  };

  /** State that an open pull request for this branch now sits at the given captured head. */
  const adoptPr = (
    patch: Partial<SessionActionAdoptedPullRequest> & { atHead?: string } = {},
  ): void => {
    const { atHead, ...rest } = patch;
    adopted.push({
      key: "owner/repo#7",
      url: "https://github.com/owner/repo/pull/7",
      number: 7,
      repositoryRoot: "/repo",
      branch: "feature",
      observedHeadOid: full(atHead ?? head.sha),
      observedState: "OPEN",
      observedAt: 1,
      // Attributable to the bound session and adopted after any packet this file delivers, so
      // a test that moves the row off-branch reproduces the stray case rather than the
      // unattributable one.
      sessionId,
      adoptedAt: Number.MAX_SAFE_INTEGER,
      ...rest,
    });
  };

  return {
    registry,
    store,
    get manager() { return manager; },
    restartWorkflowManager: async () => {
      await manager.stop();
      manager = new WorkflowManager(registry, new WorkflowStore(), managerOptions);
      manager.start();
    },
    injected,
    head,
    captureHead,
    contentTree,
    commitTrees,
    full,
    repository,
    adopted,
    adoptPr,
    sessionId,
    versionId,
    reportIdle,
    reportWorking,
    reportPrompt,
    runActionTurn,
    evidenceReadinessPolicy: options.evidenceReadinessPolicy ?? "off",
    setVerdict: (next: () => "pass" | "fail") => { verdictChoice = next; },
    settle: () => manager.settleBackgroundWork(),
    stop: () => manager.stop(),
  };
}

type Harness = Awaited<ReturnType<typeof harness>>;

/** Bind, submit, and wait for the first action to be waiting with its packet prepared. */
async function runToAction(h: Harness, prompted = false): Promise<string> {
  const bound = h.manager.createBinding({
    workflowVersionId: h.versionId,
    sessionId: h.sessionId,
    ...(prompted ? { triggerMode: "foreman_complete" as const } : {}),
  });
  assert.equal(bound.ok, true, "the binding was refused");
  const bindingId = bound.ok ? bound.value.id : "";
  if (h.evidenceReadinessPolicy === "criterion_mapped_v1") {
    const evidenceId = `reviewed-content-command-${h.sessionId}`;
    const output = "reviewed content passed\n";
    h.store.stageWorkflowEvidence(bound.ok ? bound.value.noteKey : "", [{
      id: `reviewed-content-evidence-${h.sessionId}`,
      clientItemId: evidenceId,
      sourceKind: "command",
      evidenceKind: "text",
      sourceRoot: "/repo",
      sourceLocator: "node --test reviewed-content.test.ts",
      inlineContent: output,
      commandExitCode: 0,
      displayName: "node --test reviewed-content.test.ts",
      caption: "Reviewed content passed focused verification",
      repositoryScope: "repo-01",
      mimeType: "text/plain",
      bytes: Buffer.byteLength(output),
      sha256: createHash("sha256").update(output).digest("hex"),
    }], Date.now(), null, [{
        id: `reviewed-content-coverage-${h.sessionId}`,
        sourceRoot: "/repo",
        clientCriterionId: "reviewed-content",
        criterion: "The reviewed content is ready to ship",
        proofClass: "focused_execution",
        repositoryScope: "repo-01",
        links: [{ clientItemId: evidenceId, role: "execution" }],
    }]);
  }
  let runId: string;
  if (prompted) {
    const objective = "Publish the reviewed plan";
    h.registry.upsertGoal(h.sessionId, {
      prompt: objective, text: objective, objective, focus: objective,
      relationship: "initial", rationale: "Plan completion", objectiveVersion: 1,
      promptRevision: 1, resolvedPromptRevision: 1, pendingPrompts: [], source: "heuristic",
    }, Date.now());
    h.runActionTurn();
    const cycle = h.registry.getSession(h.sessionId)!.workCycle!;
    const claim = await h.manager.claimCompletion(h.sessionId, {
      completionKind: "prompted", marker: "a".repeat(64), summary: "The plan review and handoff are complete",
      evidenceFingerprint: "published-plan",
      expectedIntent: { objective, objectiveVersion: 1, promptRevision: 1, episodeKey: "intent:1:1" },
      expectedWorkCycle: { logicalKey: cycle.logicalKey, generation: cycle.generation },
    });
    assert.ok(claim.claimed, JSON.stringify(claim));
    runId = claim.runId;
    assert.equal(h.store.getRun(runId)?.triggerSource, "foreman");
  } else {
    const submitted = await h.manager.submit(bindingId, { requestId: `submit-${h.sessionId}` });
    assert.equal(submitted.ok, true, "the submission failed");
    runId = submitted.ok ? submitted.value.run.id : "";
  }
  await waitFor(
    () => h.store.listSubmissions(runId)
      .some((submission) => h.store.listAttempts(submission.id)
        .some((attempt) => attempt.state === "waiting")),
    "no session action attempt ever reached the waiting state",
  );
  return runId;
}

function waitingAttempt(h: Harness, runId: string) {
  const attempts = h.store.listSubmissions(runId)
    .flatMap((submission) => h.store.listAttempts(submission.id))
    .filter((attempt) => attempt.state === "waiting");
  return attempts[0] ?? null;
}

/**
 * The action attempt's id, whatever state it has since reached.
 *
 * `waitingAttempt` answers only while it is still waiting, and the assertions that matter most
 * are about what it holds AFTERWARDS - the completed output's proven expectation, the block
 * code - so the id has to be findable by node rather than by state.
 */
function waitingActionAttemptId(h: Harness, runId: string): string {
  const attempts = h.store.listSubmissions(runId)
    .flatMap((submission) => h.store.listAttempts(submission.id))
    .filter((attempt) => attempt.sessionAction !== null);
  assert.ok(attempts.length > 0, "no session action attempt exists on this run");
  return attempts[0]!.id;
}

test("only PR actions with CI tracking enabled receive the runtime policy", async () => {
  for (const pullRequest of [false, true]) {
    for (const trackCiFailures of [false, true]) {
      const h = await harness(`ci-policy-${pullRequest}-${trackCiFailures}`, {
        pullRequest,
        trackCiFailures: () => trackCiFailures,
        deliveryMode: "preview",
      });
      try {
        const runId = await runToAction(h);
        await waitFor(() => h.store.listDeliveries(runId).length === 1, "no action packet was prepared");
        const delivery = h.store.listDeliveries(runId)[0]!;
        assert.equal(delivery.payload.includes("## Workflow pull request CI follow-through"), pullRequest && trackCiFailures);
        assert.equal(delivery.payload.includes("## Pull request creation policy"), pullRequest);
        assert.equal(h.injected.length, 0);
      } finally {
        await h.stop();
      }
    }
  }
});

test("a Pull Request skill action with session-turn completion receives the creation policy", async () => {
  const h = await harness("pr-skill-turn-policy", {
    actions: [{ id: "act", prompt: "# Create a pull request\n", skillId: "pull-request" }],
    pullRequest: false,
    deliveryMode: "live",
  });
  try {
    const runId = await runToAction(h);
    await waitFor(
      () => h.store.listDeliveries(runId).some((delivery) => delivery.state === "delivered"),
      "the Pull Request skill packet never reached the pane",
    );
    const attempt = waitingAttempt(h, runId)!;
    assert.equal(attempt.sessionAction?.completion.kind, "session_turn");
    assert.equal(attempt.sessionAction?.requiredSkillId, "pull-request");
    const delivery = h.store.listDeliveries(runId).find((item) => item.kind === "session_action")!;
    assert.deepEqual(h.injected, [delivery.payload]);
    assert.match(h.injected[0]!, /^\/mission-pull-request\n/);
    assert.match(h.injected[0]!, /## Pull request creation policy/);
    assert.match(h.injected[0]!, /get_pull_request_policy/);
    assert.match(h.injected[0]!, /gh pr create --draft/);
    assert.match(h.injected[0]!, /Only the human may promote it/);
  } finally {
    await h.stop();
  }
});

// Allow the real MCP startup and all eight CLI subprocesses to finish under full-suite load.
test("scripted skill and workflow sessions create PRs from the live draft policy", { timeout: 90_000 }, async (t) => {
  const h = await harness("draft-pr-creation", {
    actions: [{ id: "act", prompt: "# Create a pull request\n", skillId: "pull-request" }],
    pullRequest: true,
    deliveryMode: "live",
  });
  let fixture: Awaited<ReturnType<typeof prCreationFixture>> | null = null;
  try {
    fixture = await prCreationFixture(h.registry, home);
    await fixture.setPolicy(false);
    const runId = await runToAction(h);
    await waitFor(() => h.injected.length === 1, "the PR workflow packet was not delivered");
    assert.equal(waitingAttempt(h, runId)!.sessionAction?.completion.kind, "pull_request");
    const skill = readFileSync(new URL("../skills/pull-request/SKILL.md", import.meta.url), "utf8");
    const paths = [
      { name: "pull-request skill", instructions: skill },
      { name: "workflow PR phase", instructions: h.injected[0]! },
    ];
    t.diagnostic("Boundary: real settings HTTP, real MCP subprocess, real workflow delivery; scripted agent and stateful GitHub CLI fixture. No live GitHub writes or model calls.");
    for (const path of paths) {
      assert.match(path.instructions, /get_pull_request_policy/);
      assert.match(path.instructions, /gh pr create --draft/);
      assert.match(path.instructions, /Only the human may promote it/);
      // The script models an agent following the delivered instructions. It is not a
      // claim that a probabilistic model will obey them. GitHub's fixture is independent:
      // its persisted isDraft is derived only from creation argv, never from settings.
      for (const enabled of [false, true]) {
        await fixture.setPolicy(enabled); // After packet delivery: no frozen preference.
        const readsBeforeCreation: number = fixture.reads.length;
        const policy = await fixture.readPolicy();
        assert.equal(fixture.reads.length, readsBeforeCreation + 1, "each creation must read the live policy");
        assert.deepEqual(fixture.reads.at(-1), { alwaysDraftPr: enabled });
        const args = ["pr", "create", "--title", path.name, "--body", "Isolated policy integration"];
        if (policy.alwaysDraftPr) args.push("--draft");
        const url = await fixture.gh(args);
        const created = JSON.parse(await fixture.gh(["pr", "view", url, "--json", "number,url,isDraft,state"]));
        assert.equal(created.isDraft, enabled, `${path.name}: saved PR state must match the setting`);
        assert.equal(created.state, "OPEN");
        t.diagnostic(JSON.stringify({ path: path.name, settingRead: fixture.reads.at(-1),
          creationCommand: ["gh", ...args], createdPr: created, promotion: "human only; no promotion command issued" }));
      }
    }
    assert.equal(fixture.commands.filter((args) => args[1] === "create").length, 4);
    assert.ok(fixture.commands.every((args) => args[1] === "create" || args[1] === "view"));
  } finally {
    try {
      await fixture?.setPolicy(false);
    } finally {
      try {
        await fixture?.close();
      } finally {
        await h.stop();
      }
    }
  }
});

// Publication is performed by the instructed session, not a daemon GitHub writer. As in
// the draft-policy integration above, exercise that session with a deterministic script.
for (const mode of ["create", "update"] as const) {
  test(`scripted Pull Request action ${mode} reads back published content and comment notes`, { timeout: 90_000 }, async (t) => {
    const title = "fix: review drafts before publication";
    const body = "Validate draft content before the Pull Request action.";
    const note = "Deviation: publication proof is checked by the Pull Request action.";
    const h = await harness(`publication-readback-${mode}`, {
      actions: [{ id: "act", prompt: `# Pull Request\n\nTitle: ${title}\nBody: ${body}\nRequired note: ${note}\n`, skillId: "pull-request" }],
      pullRequest: true,
      deliveryMode: "live",
    });
    let fixture: Awaited<ReturnType<typeof prCreationFixture>> | null = null;
    try {
      fixture = await prCreationFixture(h.registry, home);
      const existingUrl = mode === "update"
        ? await fixture.gh(["pr", "create", "--title", "Old title", "--body", "Old body", "--draft"])
        : null;
      const runId = await runToAction(h);
      await waitFor(() => h.injected.length === 1, "the publication action packet was not delivered");
      const packet = h.injected[0]!;
      assert.match(packet, /After creating or updating the PR, read back its URL, published title and body from GitHub/);
      assert.match(packet, /Verify required notes posted in a comment by reading back that comment/);
      assert.match(packet, /repair mismatches before reporting this action complete/);
      assert.equal(waitingAttempt(h, runId)!.sessionAction?.completion.kind, "pull_request");
      h.reportWorking();
      t.diagnostic("Boundary: real workflow delivery, settings/MCP and CLI subprocesses; scripted session and stateful fake GitHub. No model calls or live GitHub writes. Checks below execute the instructed session's read-back procedure, not a daemon-enforced title/notes gate.");

      let url: string;
      if (existingUrl) {
        await fixture.gh(["pr", "edit", existingUrl, "--title", title, "--body", body]);
        url = existingUrl;
      } else {
        const policy = await fixture.readPolicy();
        url = await fixture.gh(["pr", "create", "--title", title, "--body", body,
          ...(policy.alwaysDraftPr ? ["--draft"] : [])]);
      }
      type Published = { number: number; url: string; title: string; body: string;
        isDraft: boolean; comments: Array<{ url: string; body: string }> };
      const readBack = async (): Promise<Published> => JSON.parse(await fixture!.gh([
        "pr", "view", url, "--json", "number,url,title,body,isDraft,comments",
      ]));
      const check = (published: Published) => ({
        url: published.url === url,
        title: published.title === title,
        body: published.body === body,
        requiredNote: published.comments.some(comment => comment.body === note && comment.url.startsWith(`${url}#`)),
      });
      // The fake CLI persists only command arguments, independently of the expected content.
      // A successful create/edit is insufficient: the first read must detect the absent note.
      const before = await readBack();
      assert.deepEqual(check(before), { url: true, title: true, body: true, requiredNote: false });
      t.diagnostic(JSON.stringify({ mode, readBack: before, checks: check(before), outcome: "required comment note missing; repair before completing" }));
      assert.equal(h.store.getRun(runId)?.status, "waiting_for_action");
      await fixture.gh(["pr", "comment", url, "--body", note]);
      const published = await readBack();
      assert.deepEqual(check(published), { url: true, title: true, body: true, requiredNote: true });
      if (existingUrl) assert.equal(published.isDraft, true, "editing and commenting must preserve draft status");
      assert.equal(fixture.commands.filter(args => args[1] === "create").length, 1,
        "updating an existing PR must not create a duplicate");
      t.diagnostic(JSON.stringify({ mode, commands: fixture.commands, readBack: published,
        checks: check(published), verifiedPrUrl: published.url }));
      h.adoptPr({ number: published.number, key: `fixture/repo#${published.number}`, url: published.url });
      h.reportIdle();
      await h.manager.sweepSessionActions(SETTLED());
      await waitFor(() => h.store.getRun(runId)?.status === "completed", "verified publication did not finish the action");
      assert.equal(h.store.listSubmissions(runId).length, 2, "action completion captures its continuation");
      t.diagnostic(`${mode}: publication checks passed; Pull Request action and workflow completed`);
    } finally {
      try { await fixture?.close(); } finally { await h.stop(); }
    }
  });
}

test("an unstored Foreman CI preference reaches PR packets as default-on", async () => {
  const h = await harness("ci-policy-default", {
    pullRequest: true,
    trackCiFailures: () => getForemanConfig().trackCiFailures,
    deliveryMode: "preview",
  });
  try {
    const runId = await runToAction(h);
    await waitFor(() => h.store.listDeliveries(runId).length === 1, "no action packet was prepared");
    assert.match(h.store.listDeliveries(runId)[0]!.payload, /Workflow pull request CI follow-through/);
  } finally {
    await h.stop();
  }
});

test("a prepared PR packet keeps its CI policy across setting changes and restart", async () => {
  let tracking = true;
  let reads = 0;
  const h = await harness("ci-policy-durable", {
    pullRequest: true,
    trackCiFailures: () => { reads++; return tracking; },
    deliveryMode: "preview",
  });
  try {
    const runId = await runToAction(h);
    await waitFor(() => h.store.listDeliveries(runId).length === 1, "no action packet was prepared");
    const original = h.store.listDeliveries(runId)[0]!;
    assert.match(original.payload, /Workflow pull request CI follow-through/);
    tracking = false;
    await h.manager.stop();
    h.manager.start();
    await h.manager.sweepSessionActions(SETTLED());
    const recovered = h.store.listDeliveries(runId);
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]!.payload, original.payload);
    assert.equal(recovered[0]!.payloadSha256, original.payloadSha256);
    assert.equal(reads, 1, "restart re-read policy for an already prepared packet");
    assert.equal(h.injected.length, 0, "restart sent a preview packet");
  } finally {
    await h.stop();
  }
});

test("retrying a refused PR delivery uses its recorded CI instructions", async () => {
  let tracking = true;
  let reads = 0;
  const options: HarnessOptions = {
    pullRequest: true,
    trackCiFailures: () => { reads++; return tracking; },
    refuseInject: true,
  };
  const h = await harness("ci-policy-retry", options);
  try {
    const runId = await runToAction(h);
    await waitFor(() => h.store.listDeliveries(runId).some((item) => item.state === "refused"), "no refused packet");
    const original = h.store.listDeliveries(runId)[0]!;
    assert.match(original.payload, /Workflow pull request CI follow-through/);
    tracking = false;
    options.refuseInject = false;
    const binding = h.store.getBinding(h.store.getRun(runId)!.bindingId)!;
    const retried = await h.manager.retryDelivery(original.id, {
      requestId: "retry-ci-policy",
      expectedSessionId: binding.sessionId!,
      expectedNoteKey: binding.noteKey,
    });
    assert.equal(retried.ok, true);
    if (!retried.ok) return;
    assert.equal(retried.value.state, "delivered");
    assert.equal(retried.value.payloadSha256, original.payloadSha256);
    assert.deepEqual(h.injected, [original.payload]);
    assert.equal(reads, 1, "retry must not re-read the preference");
  } finally {
    await h.stop();
  }
});

test("an action activates as one waiting attempt, with no evaluator work and no receipt", async () => {
  const h = await harness("activation");
  try {
    const runId = await runToAction(h);
    const submission = h.store.latestSubmission(runId)!;
    const attempt = h.store.listAttempts(submission.id).find((item) => item.nodeId === "act");
    assert.ok(attempt, "the action node produced no attempt");
    assert.equal(attempt.state, "waiting");
    // Not a Persona: no snapshot, no runner, no model, no verdict, ever.
    assert.equal(attempt.persona, null);
    assert.equal(attempt.runner, null);
    assert.equal(attempt.model, null);
    assert.equal(attempt.verdict, null);
    // The frozen snapshot is on the attempt, so history and recovery never re-resolve the
    // live library entity.
    assert.equal(attempt.sessionAction?.promptMarkdown, "# Tidy\n\nRun the tidy pass.\n");
    assert.equal(attempt.sessionAction?.completion.kind, "session_turn");
    // Nothing downstream is authorized until the action turn finishes.
    assert.deepEqual(
      h.store.listReceipts(submission.id).filter((receipt) => receipt.edgeId === "e-act"),
      [],
    );
    // A waiting attempt occupies no model execution slot.
    assert.deepEqual(h.store.listRunnableAttempts(Date.now()), []);
  } finally {
    await h.stop();
  }
});

test("Live delivers the exact snapshot prompt once and parks in waiting_for_action", async () => {
  const h = await harness("live-delivery");
  try {
    const runId = await runToAction(h);
    await waitFor(
      () => h.store.listDeliveries(runId).some((delivery) => delivery.state === "delivered"),
      "the action packet never reached the pane",
    );
    const delivery = h.store.listDeliveries(runId).find((item) => item.kind === "session_action");
    assert.ok(delivery, "no session_action delivery was written");
    const attempt = waitingAttempt(h, runId)!;
    // Durably linked to the attempt that owns it, which is what keeps two action nodes in one
    // submission from being deduplicated into a single packet.
    assert.equal(delivery.nodeAttemptId, attempt.id);
    assert.equal(h.injected.length, 1);
    // The exact authored Markdown, verbatim, after a small envelope.
    assert.match(h.injected[0]!, /Mission Control session action: act-live-delivery/);
    assert.ok(h.injected[0]!.endsWith("# Tidy\n\nRun the tidy pass.\n"));
    assert.equal(h.store.getRun(runId)?.status, "waiting_for_action");
    assert.equal(h.store.getRun(runId)?.currentPhase, "session_action");
    assert.equal(h.store.runSummary(runId)?.actionWait, "awaiting_pickup");
  } finally {
    await h.stop();
  }
});

test("Preview prepares the packet and never types it, and never completes on its own", async () => {
  const h = await harness("preview", { deliveryMode: "preview" });
  try {
    const runId = await runToAction(h);
    const delivery = h.store.listDeliveries(runId).find((item) => item.kind === "session_action");
    assert.ok(delivery, "Preview must still prepare the packet so the operator can read it");
    assert.equal(delivery.state, "prepared");
    assert.deepEqual(h.injected, [], "Preview typed into the pane");
    assert.equal(h.store.runSummary(runId)?.actionWait, "awaiting_send");

    // A settled, idle session is the ordinary state of a Preview target. Sweeping repeatedly
    // must not invent a completion from activity nobody attributed to this packet.
    h.reportIdle();
    for (let tick = 0; tick < 3; tick += 1) await h.manager.sweepSessionActions(SETTLED());
    assert.equal(waitingAttempt(h, runId)?.state, "waiting");
    assert.equal(h.store.listSubmissions(runId).length, 1);
    assert.deepEqual(h.injected, []);
  } finally {
    await h.stop();
  }
});

test("a settled idle BEFORE pickup never completes the action", async () => {
  const h = await harness("stale-idle");
  try {
    const runId = await runToAction(h);
    await waitFor(
      () => h.store.listDeliveries(runId).some((delivery) => delivery.state === "delivered"),
      "the action packet never reached the pane",
    );
    // The session goes idle with NO activity after the send anchor - which is exactly what a
    // stale idle event, a resubscribed observer, or a restart looks like.
    h.reportIdle();
    const session = h.registry.getSession(h.sessionId)!;
    assert.ok(session.state === "idle", "the fixture must present an idle session");

    // `SETTLED()` is far past the settle window, so the ONLY thing standing between this and
    // a completion is the missing pickup proof.
    for (let tick = 0; tick < 3; tick += 1) await h.manager.sweepSessionActions(SETTLED());
    assert.equal(waitingAttempt(h, runId)?.state, "waiting");
    assert.equal(h.store.runSummary(runId)?.actionWait, "awaiting_pickup");
    assert.equal(h.store.listSubmissions(runId).length, 1, "a segment was captured with no pickup");
  } finally {
    await h.stop();
  }
});

test("pickup then settled idle captures a child segment and activates only downstream", async () => {
  const h = await harness("continuation", { downstream: true });
  try {
    const runId = await runToAction(h);
    await waitFor(
      () => h.store.listDeliveries(runId).some((delivery) => delivery.state === "delivered"),
      "the action packet never reached the pane",
    );
    const parent = h.store.latestSubmission(runId)!;
    const attempt = waitingAttempt(h, runId)!;
    assert.equal(parent.segment, 0);

    // The session works, then settles: activity strictly after the send anchor is the pickup
    // proof, and only then does a settled idle mean the turn finished.
    h.head.sha = "head-2";
    h.runActionTurn();
    await h.manager.sweepSessionActions(SETTLED());
    await waitFor(
      () => h.store.listSubmissions(runId).length === 2,
      "the completed action never captured a continuation segment",
    );

    const submissions = h.store.listSubmissions(runId);
    const child = submissions[1]!;
    // A SEGMENT, not a repair round: the budget is untouched.
    assert.equal(child.round, parent.round);
    assert.equal(child.segment, 1);
    assert.equal(child.parentSubmissionId, parent.id);
    assert.equal(child.continuationNodeId, "act");
    assert.equal(child.continuationNodeAttemptId, attempt.id);
    assert.equal(h.store.runSummary(runId)?.round, parent.round);
    assert.equal(h.store.runSummary(runId)?.segment, 1);

    // The action attempt completed exactly once, in the PARENT submission.
    const finished = h.store.getAttempt(attempt.id)!;
    assert.equal(finished.state, "completed");
    assert.equal(finished.submissionId, parent.id);

    // Only the action's own `complete` route is seeded into the child, and the child does NOT
    // re-submit from Session - the upstream reviewer must not run again on this evidence.
    const seeded = h.store.listReceipts(child.id).find((receipt) => receipt.edgeId === "e-act");
    assert.ok(seeded, "the action's complete route was never seeded into the child");
    assert.equal(seeded.sourceAttemptId, attempt.id, "cross-submission provenance is lost");
    // Session's own `submitted` route is NOT re-seeded: a continuation resumes the action's
    // downstream path, it does not restart the graph.
    assert.equal(
      h.store.listReceipts(child.id).some((receipt) => receipt.edgeId === "e-start"),
      false,
    );
    await waitFor(
      () => h.store.listAttempts(child.id).some((item) => item.nodeId === "downstream"),
      "the downstream reviewer never activated on the child evidence",
    );
    assert.deepEqual(
      h.store.listAttempts(child.id).map((item) => item.nodeId).sort(),
      ["downstream", "end"],
    );
    // The upstream reviewer stays tied to the PARENT evidence and is never re-run.
    assert.equal(
      h.store.listAttempts(parent.id).filter((item) => item.nodeId === "upstream").length,
      1,
    );
    // Fresh evidence: the child captured the head the action turn produced.
    assert.match(JSON.stringify(child.evidence), /head-2/);
  } finally {
    await h.stop();
  }
});

test("an unchanged checkout is a legitimate action outcome, not the repair loop's refusal", async () => {
  const h = await harness("unchanged", { downstream: true });
  try {
    const runId = await runToAction(h);
    await waitFor(
      () => h.store.listDeliveries(runId).some((delivery) => delivery.state === "delivered"),
      "the action packet never reached the pane",
    );
    // `head.sha` is deliberately NOT moved: an action may change only remote or conversation
    // state, so an unchanged checkout must not produce the unchanged-evidence nudge a
    // repair round would.
    h.runActionTurn();
    await h.manager.sweepSessionActions(SETTLED());
    await waitFor(
      () => h.store.listSubmissions(runId).length === 2,
      "an unchanged checkout blocked the continuation",
    );
    const events = h.store.listEvents(runId).map((event) => event.kind);
    assert.equal(events.includes("resubmit_refused_unchanged"), false);
    assert.equal(
      h.store.listDeliveries(runId).some((item) => item.kind === "unchanged_evidence_nudge"),
      false,
    );
  } finally {
    await h.stop();
  }
});

test("two actions run in order in one repair round and spend no repair budget", async () => {
  const h = await harness("two-actions", {
    actions: [
      { id: "first", prompt: "# First\n\nDo the first thing.\n" },
      { id: "second", prompt: "# Second\n\nDo the second thing.\n" },
    ],
  });
  try {
    const runId = await runToAction(h);
    await waitFor(
      () => h.store.listDeliveries(runId).some((delivery) => delivery.state === "delivered"),
      "the first action packet never reached the pane",
    );
    // Exactly ONE packet is live: the bound session has one turn.
    assert.equal(h.injected.length, 1);
    assert.match(h.injected[0]!, /Do the first thing/);

    h.head.sha = "head-2";
    h.runActionTurn();
    await h.manager.sweepSessionActions(SETTLED());
    await waitFor(() => h.injected.length === 2, "the second action never ran");
    assert.match(h.injected[1]!, /Do the second thing/);

    h.head.sha = "head-3";
    h.runActionTurn();
    await h.manager.sweepSessionActions(SETTLED());
    await waitFor(
      () => h.store.listSubmissions(runId).length === 3,
      "the second action never captured its own segment",
    );
    const submissions = h.store.listSubmissions(runId);
    assert.deepEqual(submissions.map((item) => [item.round, item.segment]), [[1, 0], [1, 1], [1, 2]]);
    // The repair budget saw none of it.
    assert.equal(h.store.runSummary(runId)?.round, 1);
    assert.equal(
      h.store.listEvents(runId).some((event) => event.kind === "resumption_started"),
      false,
    );
  } finally {
    await h.stop();
  }
});

test("a downstream failure after a continuation starts round two at segment zero", async () => {
  const h = await harness("repair-after", { downstream: true, verdict: () => "pass" });
  try {
    const runId = await runToAction(h);
    await waitFor(
      () => h.store.listDeliveries(runId).some((delivery) => delivery.state === "delivered"),
      "the action packet never reached the pane",
    );
    // The downstream reviewer fails on the CHILD evidence.
    h.setVerdict(() => "fail");
    h.head.sha = "head-2";
    h.runActionTurn();
    await h.manager.sweepSessionActions(SETTLED());
    await waitFor(
      () => h.store.getRun(runId)?.status === "waiting_for_session",
      "the downstream failure never parked the run",
    );
    const child = h.store.listSubmissions(runId).at(-1)!;
    assert.equal(child.segment, 1);

    // Repair is round + 1 at segment ZERO, and it restarts from Session.
    h.head.sha = "head-3";
    const resubmitted = await h.manager.resubmit(runId, { requestId: "repair", resubmitUnchanged: false });
    assert.equal(resubmitted.ok, true, `resubmit was refused: ${JSON.stringify(resubmitted)}`);
    const repair = h.store.listSubmissions(runId).at(-1)!;
    assert.equal(repair.round, child.round + 1);
    assert.equal(repair.segment, 0);
    assert.equal(repair.parentSubmissionId, null);
    assert.equal(repair.continuationNodeAttemptId, null);
    await waitFor(
      () => h.store.listAttempts(repair.id).some((item) => item.nodeId === "upstream"),
      "the repair round did not restart the graph at Session",
    );
  } finally {
    await h.stop();
  }
});

test("cancelling a run closes the waiting attempt and its live packet", async () => {
  const h = await harness("cancel");
  try {
    const runId = await runToAction(h);
    await waitFor(
      () => h.store.listDeliveries(runId).some((delivery) => delivery.state === "delivered"),
      "the action packet never reached the pane",
    );
    const attempt = waitingAttempt(h, runId)!;
    const cancelled = h.manager.cancel(runId, "cancel-request");
    assert.equal(cancelled.ok, true);
    assert.equal(h.store.getAttempt(attempt.id)?.state, "cancelled");

    // A cancelled run leaves nothing an observer would pick back up.
    h.reportIdle();
    for (let tick = 0; tick < 3; tick += 1) await h.manager.sweepSessionActions(SETTLED());
    assert.equal(h.store.listSubmissions(runId).length, 1);
    assert.equal(h.injected.length, 1);
  } finally {
    await h.stop();
  }
});

test("an unavailable required skill blocks the action instead of typing anything", async () => {
  const h = await harness("skill-missing", {
    actions: [{ id: "act", prompt: "# Needs a skill\n", skillId: "pull-request" }],
    requireSkill: () => ({ ok: false, message: "Enable Skills and the pull-request skill first." }),
  });
  try {
    const bound = h.manager.createBinding({
      workflowVersionId: h.versionId,
      sessionId: h.sessionId,
    });
    assert.equal(bound.ok, true);
    const bindingId = bound.ok ? bound.value.id : "";
    const submitted = await h.manager.submit(bindingId, { requestId: "skill-missing" });
    assert.equal(submitted.ok, true);
    const runId = submitted.ok ? submitted.value.run.id : "";
    await waitFor(
      () => h.store.getRun(runId)?.currentPhase === "session_action_blocked",
      "an unavailable required skill did not block the action",
    );
    assert.equal(h.store.getRun(runId)?.status, "blocked");
    assert.deepEqual(h.injected, [], "a packet was typed despite the missing skill");
    // A block is a RUN state and never a graph outcome: no repair packet, no round spent.
    assert.equal(h.store.runSummary(runId)?.round, 1);
    assert.equal(
      h.store.listDeliveries(runId).some((item) => item.kind === "persona_feedback"),
      false,
    );
  } finally {
    await h.stop();
  }
});

test("a session that exits before its turn is observed blocks rather than completing", async () => {
  const h = await harness("session-lost");
  try {
    const runId = await runToAction(h);
    await waitFor(
      () => h.store.listDeliveries(runId).some((delivery) => delivery.state === "delivered"),
      "the action packet never reached the pane",
    );
    h.registry.applyDiscovery([]);
    await waitFor(
      () => h.registry.getSession(h.sessionId)?.state === "exited"
        || h.registry.getSession(h.sessionId) === undefined,
      "the session never left the fleet",
    );
    await h.manager.sweepSessionActions(SETTLED());
    assert.equal(h.store.listSubmissions(runId).length, 1, "a lost session completed an action");
  } finally {
    await h.stop();
  }
});

test("a restart mid-flight never sends, completes, or captures twice", async () => {
  const h = await harness("restart", { downstream: true });
  try {
    const runId = await runToAction(h);
    await waitFor(
      () => h.store.listDeliveries(runId).some((delivery) => delivery.state === "delivered"),
      "the action packet never reached the pane",
    );
    assert.equal(h.injected.length, 1);
    const attempt = waitingAttempt(h, runId)!;

    // Restart with the packet SENT and the turn not yet observed: recovery must not prepare
    // a second packet or type the same instruction again.
    await h.manager.stop();
    h.manager.start();
    // Recovery schedules its work as tasks, so drain the loop before asserting that it
    // scheduled nothing - otherwise the assertion would pass on timing rather than on rule.
    for (let tick = 0; tick < 10; tick += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(h.injected.length, 1, "recovery re-typed a packet the session already had");
    assert.equal(h.store.listDeliveriesForAttempt(attempt.id).length, 1);
    assert.equal(waitingAttempt(h, runId)?.id, attempt.id);

    // Now the turn happens, and the continuation is captured.
    h.head.sha = "head-2";
    h.runActionTurn();
    await h.manager.sweepSessionActions(SETTLED());
    await waitFor(
      () => h.store.listSubmissions(runId).length === 2,
      "the completed action never captured a continuation segment",
    );

    // Restart AFTER the child segment exists: no second segment, no second receipt, and the
    // attempt stays completed exactly once.
    await h.manager.stop();
    h.manager.start();
    for (let tick = 0; tick < 3; tick += 1) await h.manager.sweepSessionActions(SETTLED());
    assert.equal(h.store.listSubmissions(runId).length, 2);
    assert.equal(h.store.getAttempt(attempt.id)?.state, "completed");
    const child = h.store.listSubmissions(runId)[1]!;
    assert.equal(
      h.store.listReceipts(child.id).filter((receipt) => receipt.edgeId === "e-act").length,
      1,
    );
    assert.equal(h.injected.length, 1);
  } finally {
    await h.stop();
  }
});

test("an uncertain write parks the action and is never automatically resent", async () => {
  const h = await harness("uncertain");
  try {
    const runId = await runToAction(h);
    await waitFor(
      () => h.store.listDeliveries(runId).some((delivery) => delivery.state === "delivered"),
      "the action packet never reached the pane",
    );
    const delivery = h.store.listDeliveries(runId)
      .find((item) => item.kind === "session_action")!;
    // A daemon that stopped with the row in `sending` cannot know whether the paste landed,
    // so the packet becomes uncertain - the state a human resolves.
    h.store.setDeliveryState(delivery.id, "uncertain", "daemon_restart_after_send_claim");

    await h.manager.stop();
    h.manager.start();
    for (let tick = 0; tick < 10; tick += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    await h.manager.sweepSessionActions(SETTLED());
    assert.equal(h.injected.length, 1, "an uncertain packet was retyped automatically");
    assert.equal(h.store.getDelivery(delivery.id)?.state, "uncertain");

    // The action BLOCKS rather than waiting forever behind a generic delivery diagnostic.
    // An action's contract is that its exact instruction ran once, so the runtime refuses to
    // guess in either direction about a write it cannot confirm.
    const attempt = h.store.listSubmissions(runId)
      .flatMap((submission) => h.store.listAttempts(submission.id))
      .find((item) => item.nodeId === "act")!;
    assert.equal(attempt.state, "error");
    assert.match(attempt.error ?? "", /delivery_uncertain/);
    assert.equal(h.store.getRun(runId)?.currentPhase, "session_action_blocked");
    // And no turn is credited to it either: a completed turn afterwards cannot complete an
    // action whose instruction may never have arrived.
    h.runActionTurn();
    await h.manager.sweepSessionActions(SETTLED());
    assert.equal(h.store.listSubmissions(runId).length, 1);
    assert.equal(h.injected.length, 1);
  } finally {
    await h.stop();
  }
});

test("marking an uncertain packet delivered reopens the action and lets it finish", async () => {
  const h = await harness("uncertain-resolved", { downstream: true });
  try {
    const runId = await runToAction(h);
    await waitFor(
      () => h.store.listDeliveries(runId).some((delivery) => delivery.state === "delivered"),
      "the action packet never reached the pane",
    );
    const delivery = h.store.listDeliveries(runId)
      .find((item) => item.kind === "session_action")!;
    h.store.setDeliveryState(delivery.id, "uncertain", "daemon_restart_after_send_claim");
    await h.manager.sweepSessionActions(SETTLED());
    const attemptId = h.store.listSubmissions(runId)
      .flatMap((submission) => h.store.listAttempts(submission.id))
      .find((item) => item.nodeId === "act")!.id;
    assert.equal(h.store.getAttempt(attemptId)?.state, "error");

    // The operator answers the one question the runtime would not guess at. Without this the
    // block would be terminal, and "it landed" would be an answer nothing could act on.
    const resolved = await h.manager.resolveDelivery(delivery.id, {
      resolution: "mark_delivered",
      requestId: "resolve-1",
    });
    assert.equal(resolved.ok, true, `resolve was refused: ${JSON.stringify(resolved)}`);
    assert.equal(h.store.getAttempt(attemptId)?.state, "waiting");
    assert.equal(h.store.getRun(runId)?.status, "waiting_for_action");
    // Anchored at the resolution, with no transcript offset claimed - none was ever measured.
    const state = h.store.sessionActionState(h.store.getAttempt(attemptId)!)!;
    assert.equal(state.anchor?.transcriptBytes, null);
    assert.equal(state.blocked, null);

    // And the action now completes on the ordinary turn boundary.
    h.head.sha = "head-2";
    h.runActionTurn();
    await h.manager.sweepSessionActions(SETTLED());
    await waitFor(
      () => h.store.listSubmissions(runId).length === 2,
      "the reopened action never captured its continuation segment",
    );
    assert.equal(h.store.getAttempt(attemptId)?.state, "completed");
    assert.equal(h.injected.length, 1, "reopening retyped the packet");
  } finally {
    await h.stop();
  }
});

test("receipt cleanup failure preserves refusal, prevents binding and retries after restart", async () => {
  const { openDb } = await import("../src/server/db.ts");
  const { workflowDeliveryLedger } = await import("../src/server/delivery-ledgers.ts");
  const { forgetDeliveryBindingState } = await import("../src/server/delivery-binding.ts");
  const db = openDb();
  const h = await harness("refused-receipt-cleanup", { refuseInject: true });
  db.exec(`CREATE TEMP TRIGGER hold_workflow_receipt BEFORE DELETE ON workflow_delivery_turns
    WHEN OLD.discarded_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'cleanup temporarily unavailable'); END`);
  try {
    const id = await runToAction(h);
    await waitFor(() => h.store.listDeliveries(id).some(row => row.state === "refused"), "no persisted refusal");
    const delivery = h.store.listDeliveries(id)[0]!;
    const read = () => db.prepare("SELECT discarded_at FROM workflow_delivery_turns WHERE delivery_id = ?").get(delivery.id);
    forgetDeliveryBindingState();
    assert.ok(read()?.discarded_at);
    assert.ok(!workflowDeliveryLedger.rows(delivery.noteKey).some(row => row.deliveryId === delivery.id));
    assert.ok(read()?.discarded_at, "cleanup intent survives the failed deletion");
    db.exec("DROP TRIGGER hold_workflow_receipt");
    workflowDeliveryLedger.rows(delivery.noteKey);
    assert.equal(read(), undefined);
    assert.equal(h.store.getDelivery(delivery.id)?.state, "refused");
  } finally { db.exec("DROP TRIGGER IF EXISTS hold_workflow_receipt"); await h.stop(); }
});

test("a refused packet blocks the action, and no restart quietly prepares another", async () => {
  // A GENUINE refusal: the write is attempted and the pane positively rejects it, so nothing
  // landed. That is the state the observer used to sit behind forever.
  const h = await harness("refused", { refuseInject: true });
  try {
    const runId = await runToAction(h);
    await waitFor(
      () => h.store.listDeliveries(runId).some((item) => item.state === "refused"),
      "the rejecting pane did not refuse the packet",
    );
    const delivery = h.store.listDeliveries(runId)
      .find((item) => item.kind === "session_action")!;
    assert.equal(delivery.state, "refused");
    assert.deepEqual(h.injected, [], "a refused packet must never reach the pane");

    await h.manager.sweepSessionActions(SETTLED());
    const attempt = h.store.listSubmissions(runId)
      .flatMap((submission) => h.store.listAttempts(submission.id))
      .find((item) => item.nodeId === "act")!;
    // Blocked with the action's OWN code, not left waiting behind a generic delivery state.
    assert.equal(attempt.state, "error");
    assert.match(attempt.error ?? "", /delivery_refused/);
    assert.equal(h.store.getRun(runId)?.status, "blocked");
    assert.equal(h.store.getRun(runId)?.currentPhase, "session_action_blocked");

    // A restart must not prepare a replacement: that would retry, on every daemon start, a
    // write the operator never re-authorized.
    await h.manager.stop();
    h.manager.start();
    for (let tick = 0; tick < 10; tick += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(h.store.listDeliveriesForAttempt(attempt.id).length, 1);
    assert.deepEqual(h.injected, []);
  } finally {
    await h.stop();
  }
});

test("two actions ready at once are refused, never silently deferred", async () => {
  // A branching graph, which a linear pipeline cannot author but the raw draft API can. The
  // dangerous behaviour is running one and holding the other: the continuation seeds the
  // child with only the completed action's routes, so the held sibling's activating receipt
  // stays behind in the parent and it is never delivered at all.
  const h = await harness("parallel", { parallelActions: true });
  try {
    const bound = h.manager.createBinding({
      workflowVersionId: h.versionId,
      sessionId: h.sessionId,
    });
    assert.equal(bound.ok, true);
    const bindingId = bound.ok ? bound.value.id : "";
    const submitted = await h.manager.submit(bindingId, { requestId: "parallel" });
    assert.equal(submitted.ok, true);
    const runId = submitted.ok ? submitted.value.run.id : "";
    await waitFor(
      () => h.store.getRun(runId)?.currentPhase === "session_action_parallel_unsupported",
      "two concurrently ready actions were not refused",
    );
    assert.equal(h.store.getRun(runId)?.status, "failed");
    // Nothing was typed, and neither action was half-started.
    assert.deepEqual(h.injected, []);
    const submission = h.store.latestSubmission(runId)!;
    assert.deepEqual(
      h.store.listAttempts(submission.id).filter((item) => item.state === "waiting"),
      [],
    );
    // The diagnostic names both nodes, so a human can see which pair to chain.
    const failure = h.store.listEvents(runId).find((event) => event.kind === "workflow_failed")!;
    const payload = failure.payload as { error?: string };
    assert.match(payload.error ?? "", /first/);
    assert.match(payload.error ?? "", /second/);
  } finally {
    await h.stop();
  }
});

test("a child captured but interrupted before its receipt is sealed, not re-captured", async () => {
  const h = await harness("seal", { downstream: true });
  try {
    const runId = await runToAction(h);
    await waitFor(
      () => h.store.listDeliveries(runId).some((delivery) => delivery.state === "delivered"),
      "the action packet never reached the pane",
    );
    const attempt = waitingAttempt(h, runId)!;

    // Reserve and capture the child WITHOUT sealing it - the exact window where a daemon
    // stopped between "the evidence is durable" and "the receipt is written". Re-capturing
    // is impossible from here: the capture guard wants the run and submission both
    // `capturing`, and neither is any more.
    const reserved = h.store.reserveSessionActionContinuation({
      attemptId: attempt.id,
      submissionId: "sealed-child",
      triggerKey: `session_action:${attempt.id}:interrupted`,
      now: Date.now(),
    });
    assert.equal(reserved.ok, true);
    const parent = h.store.getSubmission(attempt.submissionId)!;
    h.store.updateSubmissionCapture("sealed-child", {
      context: parent.context,
      evidence: parent.evidence,
      fingerprint: "sealed-fingerprint",
      status: "running",
    }, Date.now());
    // And the engine's own recovery blocks the run, exactly as it would on restart.
    h.store.setRunState(runId, "blocked", "capture_interrupted", { error: "interrupted" });

    await h.manager.stop();
    h.manager.start();
    await waitFor(
      () => h.store.getAttempt(attempt.id)?.state === "completed",
      "the captured child was never sealed, so the run stayed stuck on a waiting attempt",
    );

    // Sealed through the recovery path specifically, not re-captured through the ordinary
    // one - which the capture guard would have refused anyway, leaving the run stuck.
    assert.equal(
      h.store.listEvents(runId).some((event) => event.kind === "session_action_continuation_resealed"),
      true,
    );
    // No SECOND child, one receipt, and the graph moved on from the reserved segment.
    assert.equal(h.store.listSubmissions(runId).length, 2);
    assert.equal(
      h.store.listReceipts("sealed-child").filter((receipt) => receipt.edgeId === "e-act").length,
      1,
    );
    await waitFor(
      () => h.store.listAttempts("sealed-child").some((item) => item.nodeId === "downstream"),
      "the downstream reviewer never activated on the resealed child",
    );
    assert.equal(h.injected.length, 1, "the packet was retyped while resealing");
  } finally {
    await h.stop();
  }
});

// ---- the pull request completion, driven through the real runtime ---------------------------
//
// The adapter's own decisions are unit-tested in `session-action-pull-request-adapter.test.ts`.
// What these prove is the WIRING: that the manager reads the repository and the ledger at the
// right moment, that a decision reaches the continuation, that the captured commit is held to
// the one the pull request was proven at, and that none of it sends or completes twice.

/** Publish Inspector's clean observation through its ledger and Registry notification. */
async function observeCleanInspectorReview(h: Harness, number: number, head: string, now: number) {
  const { adoptInspectorPr, updateInspectorPr } = await import("../src/server/db.ts");
  const key = `owner/repo#${number}`;
  const url = `https://github.com/owner/repo/pull/${number}`;
  adoptInspectorPr({
    key, url, owner: "owner", repo: "repo", number,
    repoRoot: "/repo", cwd: "/repo", sessionId: h.sessionId, source: "hook", state: "open",
    headSha: head, reviewPosture: "live", round: 1, lastReviewedAt: now, lastError: null,
    failCount: 0, lastFailKind: null, nextAttemptAt: null, lastAttemptSha: head,
    mergedAt: null, mergeBlock: null, observedHeadSha: head, observedState: "OPEN", observedAt: now,
    headRefName: "feature", title: "Publish", adoptedAt: now, updatedAt: now,
  });
  updateInspectorPr(key, { headSha: head, cleanReviewHeadSha: head, lastAttemptSha: head,
    reviewPosture: "live", round: 1, lastReviewedAt: now }, now);
  h.registry.inspectionUpdated(key, head, "OPEN", now);
}

for (const next of ["unchanged", "edited tree", "tree edited during PR action", "human instruction", "changed sibling", "proof only", "author idle before End", "probe rejection", "missed handoff", "Inspector completion"] as const) {
  test(`final idle handoff after a completed publication: ${next}`, async (t) => {
    const inspector = next === "Inspector completion";
    if (inspector) {
      const { getInspectorConfig, setInspectorConfig } = await import("../src/server/inspector/config.ts");
      const { enabled } = getInspectorConfig();
      setInspectorConfig({ enabled: true });
      t.after(() => setInspectorConfig({ enabled }));
    }
    let rejectedProbes = 0;
    const h = await harness(`publication-handoff-${next.replaceAll(" ", "-")}`, {
      pullRequest: true, probeEvidence: true, inspector, evidenceReadinessPolicy: "criterion_mapped_v1",
      readEvidenceProbe: next === "probe rejection" ? async () => {
        rejectedProbes++;
        throw new Error("checkout unavailable");
      } : undefined,
    });
    try {
      const sibling = "/second-publication-checkout";
      if (next === "changed sibling") {
        const base = h.full("base");
        const task = mkTask({
          id: h.sessionId, sessionId: h.sessionId, status: "running", worktreePath: "/repo",
          branch: "feature", baseSha: base, provider: "git",
          extraRepos: [{ repoRoot: sibling, worktreePath: sibling, branch: "feature", provider: "git",
            worktreeLeaseId: null, baseSha: base, prUrl: null, prState: null, mergedAt: null }],
        });
        h.registry.upsertTask(task);
        h.registry.bindTaskToWorkEpisode(task.id, h.sessionId);
        h.registry.recordWorktreeHeads(new Map([["/repo", h.full("primary")], [sibling, base]]));
      }
      const runId = await runToAction(h, true);
      await waitFor(() => h.store.listDeliveries(runId).some(d => d.state === "delivered"), "no PR action");
      h.head.sha = "published";
      if (next === "tree edited during PR action") h.contentTree.oid = h.full("published-without-review");
      h.runActionTurn();
      const number = 1847;
      h.adoptPr(inspector ? { key: `owner/repo#${number}`, url: `https://github.com/owner/repo/pull/${number}`, number } : {});
      await h.manager.sweepSessionActions(SETTLED());
      if (inspector) {
        await waitFor(() => h.store.listEvents(runId).some(event => event.kind === "inspector_gate_entered"),
          "publication must reach the Inspector gate");
        assert.notEqual(h.store.getRun(runId)?.status, "completed");
        // Separate the generation at End from the generation Inspector will accept.
        h.runActionTurn();
        await observeCleanInspectorReview(h, number, h.full(h.head.sha), Date.now());
      }
      await waitFor(() => h.store.getRun(runId)?.status === "completed", "publication did not complete");
      if (inspector) {
        const gate = WorkflowInspectorGateStateSchema.parse(h.store.getRun(runId)?.gateState);
        assert.equal(gate.observedHeadSha, h.full(h.head.sha));
        assert.equal(gate.waitReason, null);
      }
      const published = h.store.latestSubmission(runId)!;
      const reviewed = h.store.listSubmissions(runId)[0]!;
      const retained = h.store.listSubmissionTextArtifacts(reviewed.id);
      assert.ok(retained.length, "the reviewed submission carries its registered proof");
      await h.restartWorkflowManager();
      const revision = next === "human instruction" ? 2 : 1;
      const objective = "Publish the reviewed plan";
      if (revision === 2) {
        h.registry.upsertGoal(h.sessionId, {
          prompt: "Review my follow-up", text: objective, objective, focus: "Review my follow-up",
          relationship: "amend", rationale: "Follow-up", objectiveVersion: 1,
          promptRevision: revision, resolvedPromptRevision: revision, pendingPrompts: [], source: "heuristic",
        }, Date.now());
      }
      if (next === "changed sibling") h.registry.recordWorktreeHeads(new Map([[sibling, h.full("changed")]]));
      if (next === "edited tree") h.contentTree.oid = h.full("edited");
      if (next === "proof only") {
        const { noteKey } = h.store.getBinding(h.store.getRun(runId)!.bindingId)!;
        const before = h.store.workflowEvidenceGeneration(noteKey, "/repo");
        const output = "CI follow-through passed";
        h.store.stageWorkflowEvidence(noteKey, [{
          id: "follow-through-output", clientItemId: "final-ci", sourceKind: "command", evidenceKind: "text",
          sourceRoot: "/repo", sourceLocator: "ci-summary", inlineContent: output, commandExitCode: 0,
          displayName: "ci-summary", caption: "Final CI result", repositoryScope: "repo-01", mimeType: "text/plain",
          bytes: Buffer.byteLength(output), sha256: createHash("sha256").update(output).digest("hex"),
        }], Date.now());
        assert.ok(h.store.workflowEvidenceGeneration(noteKey, "/repo") > before);
      }
      if (next === "missed handoff") h.runActionTurn();
      if (next !== "author idle before End") h.runActionTurn();
      const { logicalKey, generation } = h.registry.getSession(h.sessionId)!.workCycle!;
      const claim = {
        completionKind: "prompted" as const, marker: "b".repeat(64), summary: "Author finished follow-through",
        evidenceFingerprint: "later-transcript", expectedWorkCycle: { logicalKey, generation },
        expectedIntent: { objective, objectiveVersion: 1, promptRevision: revision, episodeKey: `intent:1:${revision}` },
      };
      const result = await h.manager.claimCompletion(h.sessionId, claim);
      assert.ok(result.claimed);
      assert.equal(h.registry.getQueue(h.sessionId)?.promptedConsumedGeneration, generation);
      if (next === "unchanged" || next === "changed sibling" || next === "proof only" || next === "author idle before End" || inspector) {
        assert.equal(result.runId, runId);
        assert.equal(h.store.latestSubmission(runId)?.id, published.id);
        assert.deepEqual(h.store.listSubmissionTextArtifacts(reviewed.id), retained);
        assert.equal(result.state, "already_claimed");
        assert.deepEqual(await h.manager.claimCompletion(h.sessionId, claim), result);
        if (next === "proof only" || next === "author idle before End" || inspector) {
          await h.restartWorkflowManager();
          h.runActionTurn();
          const cycle = h.registry.getSession(h.sessionId)!.workCycle!;
          assert.equal(cycle.generation, generation + 1);
          const independent = await h.manager.claimCompletion(h.sessionId, {
            ...claim, marker: "c".repeat(64), expectedWorkCycle: { logicalKey, generation: cycle.generation },
          });
          assert.ok(independent.claimed);
          assert.notEqual(independent.runId, runId, "a subsequent independent same-intent cycle earns a fresh review");
          assert.equal(h.registry.getQueue(h.sessionId)?.promptedConsumedGeneration, cycle.generation);
          await waitFor(() => h.store.latestSubmission(independent.runId)?.status === "waiting_for_evidence_readiness",
            "the independent cycle requires its own evidence");
          return;
        }
        if (next === "changed sibling") {
          const binding = h.store.getRun(runId)!.bindingId;
          const noteKey = h.store.getBinding(binding)!.noteKey;
          const runs = h.store.listRuns().filter(run => h.store.getBinding(run.bindingId)?.noteKey === noteKey);
          assert.equal(runs.length, 2, "the same proof creates only the new sibling review");
          const siblingRun = runs.find(run => run.id !== runId)!;
          assert.equal(h.store.getBinding(siblingRun.bindingId)?.repoRoot, sibling);
          await waitFor(() => h.store.latestSubmission(siblingRun.id)?.status === "waiting_for_evidence_readiness",
            "sibling review must require its own evidence");
          return;
        }
        const again = await h.manager.submit(h.store.getRun(runId)!.bindingId, { requestId: "run-again" });
        assert.ok(again.ok);
        assert.notEqual(again.value.run.id, runId, "explicit Run again starts a fresh review");
        await waitFor(() => h.store.latestSubmission(again.value.run.id)?.status === "waiting_for_evidence_readiness",
          "Run again must require fresh evidence");
      } else {
        if (next === "probe rejection") assert.equal(rejectedProbes, 1);
        assert.notEqual(result.runId, runId);
        assert.equal(h.store.latestSubmission(result.runId)?.round, 1);
        await waitFor(() => h.store.latestSubmission(result.runId)?.status === "waiting_for_evidence_readiness",
          "new content or intent must pass evidence readiness");
      }
    } finally { await h.stop(); }
  });
}

for (const timing of ["during the sibling probe", "immediately before the claim"] as const) {
  test(`a checkout edited ${timing} earns a fresh review`, async t => {
    const sibling = "/second-probed-publication";
    let releaseSibling!: () => void;
    const held = new Promise<void>(resolve => { releaseSibling = resolve; });
    const probes: string[] = [];
    let primaryEdited = false;
    const h = await harness(`two-published-checkouts-${timing.replaceAll(" ", "-")}`, {
      publicationCheckoutRevision: cwd => cwd === "/repo" && primaryEdited ? "edited" : "published",
      pullRequest: true, readEvidenceProbe: async (_registry, binding) => {
        const cwd = binding.sessionCwd!;
        probes.push(cwd);
        if (cwd === sibling) await held;
        return { headSha: h.head.sha, workingTreeStatus: [], diffFingerprint: `diff-${h.head.sha}`,
          contentTreeOid: cwd === "/repo" && primaryEdited ? h.full("late-edit") : h.contentTree.oid };
      },
    });
    try {
      const base = h.full("base");
      const task = mkTask({
        id: h.sessionId, sessionId: h.sessionId, status: "running", worktreePath: "/repo",
        branch: "feature", baseSha: base, provider: "git",
        extraRepos: [{ repoRoot: sibling, worktreePath: sibling, branch: "feature", provider: "git",
          worktreeLeaseId: null, baseSha: base, prUrl: null, prState: null, mergedAt: null }],
      });
      h.registry.upsertTask(task);
      h.registry.bindTaskToWorkEpisode(task.id, h.sessionId);
      h.registry.recordWorktreeHeads(new Map([["/repo", h.full("one")], [sibling, h.full("two")]]));
      const primaryId = await runToAction(h, true);
      const note = h.store.getBinding(h.store.getRun(primaryId)!.bindingId)!.noteKey;
      const siblingBinding = h.store.activeBindingForNoteRepo(note, sibling)!;
      const siblingId = h.store.latestRunForBinding(siblingBinding.id)!.id;
      for (const [id, root] of [[primaryId, "/repo"], [siblingId, sibling]] as const) {
        h.repository.root = root;
        await waitFor(() => h.store.listDeliveries(id).some(d => d.state === "delivered"), "no publication packet for " + root);
        h.adoptPr({ repositoryRoot: root, key: root === sibling ? "owner/second#8" : "owner/repo#7",
          number: root === sibling ? 8 : 7, url: root === sibling ? "https://github.com/owner/second/pull/8" : "https://github.com/owner/repo/pull/7" });
        h.runActionTurn();
        await h.manager.sweepSessionActions(SETTLED());
        await waitFor(() => h.store.getRun(id)?.status === "completed", "publication did not complete for " + root);
      }
      const { logicalKey, generation } = h.registry.getSession(h.sessionId)!.workCycle!;
      if (timing === "immediately before the claim") {
        const reserve = h.store.claimForemanCompletions.bind(h.store);
        t.mock.method(h.store, "claimForemanCompletions", (inputs: Parameters<typeof reserve>[0]) => {
          primaryEdited = true;
          return reserve(inputs);
        });
      }
      const result = h.manager.claimCompletion(h.sessionId, {
        completionKind: "prompted", marker: "b".repeat(64), summary: "Finished publication",
        expectedWorkCycle: { logicalKey, generation }, evidenceFingerprint: "final-idle",
        expectedIntent: { objective: "Publish the reviewed plan", objectiveVersion: 1, promptRevision: 1, episodeKey: "intent:1:1" },
      });
      await waitFor(() => probes.includes(sibling) && probes.includes("/repo"), "both checkouts must be probed");
      if (timing === "during the sibling probe") primaryEdited = true;
      releaseSibling();
      const claimed = await result;
      assert.ok(claimed.claimed);
      assert.notEqual(claimed.runId, primaryId);
      assert.equal(h.store.latestRunForBinding(siblingBinding.id)?.id, siblingId);
      assert.equal(h.registry.getQueue(h.sessionId)?.promptedConsumedGeneration, generation);
    } finally { releaseSibling(); await h.stop(); }
  });
}

for (const change of ["session awaits CI", "repository binding becomes manual", "newer run is active", "newer run is cancelled",
  "sibling rerun supersedes matching checkout", "sibling rerun supersedes changed checkout"] as const) {
  test(`pending publication probe refuses the idle handoff when the ${change}`, async () => {
    let finishProbe: ((probe: WorkflowEvidenceProbe) => void) | undefined;
    const h = await harness(`pending-probe-${change.replaceAll(" ", "-")}`, {
      pullRequest: true,
      readEvidenceProbe: () => new Promise(resolve => { finishProbe = resolve; }),
    });
    try {
      const sibling = "/second-publication-checkout";
      const siblingRace = change.startsWith("sibling rerun");
      if (siblingRace) {
        // Publish the sibling first. A later primary edit makes the primary the lead
        // in the pending claim, so a non-atomic fan-out would spend its generation.
        const base = h.full("base");
        const task = mkTask({
          id: h.sessionId, sessionId: h.sessionId, status: "running", worktreePath: "/repo",
          branch: "feature", baseSha: base, provider: "git",
          extraRepos: [{ repoRoot: sibling, worktreePath: sibling, branch: "feature", provider: "git",
            worktreeLeaseId: null, baseSha: base, prUrl: null, prState: null, mergedAt: null }],
        });
        h.registry.upsertTask(task);
        h.registry.bindTaskToWorkEpisode(task.id, h.sessionId);
        h.registry.recordWorktreeHeads(new Map([["/repo", base], [sibling, h.full("changed")]]));
        h.repository.root = sibling;
      }
      const runId = await runToAction(h, true);
      await waitFor(() => h.store.listDeliveries(runId).some(d => d.state === "delivered"), "no PR action");
      h.adoptPr({ repositoryRoot: h.repository.root });
      h.runActionTurn();
      await h.manager.sweepSessionActions(SETTLED());
      await waitFor(() => h.store.getRun(runId)?.status === "completed", "publication did not complete");

      const bindingId = h.store.getRun(runId)!.bindingId;
      const published = h.store.latestSubmission(runId)!;
      const { headSha, contentTreeOid, workingTreeStatus, diffFingerprint } =
        WorkflowContextSnapshotSchema.parse(published.context).evidence;
      assert.ok(contentTreeOid);
      h.runActionTurn();
      const { logicalKey, generation } = h.registry.getSession(h.sessionId)!.workCycle!;
      const lead = h.store.activeBindingForNote(logicalKey)!;
      if (siblingRace) {
        assert.equal(h.store.getBinding(bindingId)?.repoRoot, sibling);
        h.registry.recordWorktreeHeads(new Map([["/repo", h.full("primary-edit")]]));
        assert.equal(h.store.latestRunForBinding(lead.id), null);
      }
      const consumedBefore = h.registry.getQueue(h.sessionId)!.promptedConsumedGeneration;
      assert.ok(consumedBefore !== null && consumedBefore < generation);
      const pending = h.manager.claimCompletion(h.sessionId, {
        completionKind: "prompted", marker: "b".repeat(64), summary: "Author finished publication",
        evidenceFingerprint: "final-idle", expectedWorkCycle: { logicalKey, generation },
        expectedIntent: { objective: "Publish the reviewed plan", objectiveVersion: 1, promptRevision: 1, episodeKey: "intent:1:1" },
      });
      await waitFor(() => Boolean(finishProbe), "claim never entered the publication probe");
      let refusal = /Workflow publication changed during completion comparison/;
      const expectedRunIds = [runId];
      let verifyNewerRun: (() => void) | undefined;
      if (change === "session awaits CI") {
        refusal = /session is no longer idle for handoff/;
        assert.ok(h.registry.reportAwaiting(h.sessionId, {
          what: "Waiting for CI checks", wakeSource: "command", expectedBy: Date.now() + 60_000,
          referenceUrl: null, details: null,
        }).ok);
      } else if (change === "repository binding becomes manual") {
        refusal = /repository ownership changed during publication comparison/;
        assert.equal(h.store.updateBinding(bindingId, { triggerMode: "manual" })?.triggerMode, "manual");
      } else {
        const newer = await h.manager.submit(bindingId, { requestId: "run-again-during-probe" });
        assert.ok(newer.ok);
        const newerId = newer.value.run.id;
        assert.notEqual(newerId, runId);
        await waitFor(() => h.store.listDeliveries(newerId).some(d => d.state === "delivered"), "no newer PR action");
        if (change === "newer run is cancelled") assert.ok(h.manager.cancel(newerId, "cancel-rerun").ok);
        await h.settle();
        assert.equal(h.store.latestRunForBinding(bindingId)?.id, newerId);
        expectedRunIds.push(newerId);
        const snapshot = () => ({
          run: h.store.getRun(newerId), submissions: h.store.listSubmissions(newerId), events: h.store.listEvents(newerId),
        });
        const before = snapshot();
        verifyNewerRun = () => assert.deepEqual(snapshot(), before);
      }
      const persisted = () => [lead.id, bindingId].map(id => ({
        binding: h.store.getBinding(id),
        runs: h.store.listRuns().filter(run => run.bindingId === id).map(run => ({
          run, submissions: h.store.listSubmissions(run.id), deliveries: h.store.listDeliveries(run.id), events: h.store.listEvents(run.id),
        })),
      }));
      const beforeRefusal = persisted();
      finishProbe!({
        headSha, workingTreeStatus, diffFingerprint,
        contentTreeOid: change === "sibling rerun supersedes changed checkout" ? h.full("other-tree") : contentTreeOid,
      });
      await assert.rejects(pending, refusal);
      assert.deepEqual(persisted(), beforeRefusal);
      if (siblingRace) assert.equal(h.store.latestRunForBinding(lead.id), null, "lead reservation rolled back");
      assert.equal(h.registry.getQueue(h.sessionId)!.promptedConsumedGeneration, consumedBefore);
      assert.ok(h.store.publicationHandoffTree(runId, generation), "the refused claim must leave the handoff available");
      const actualRunIds = h.store.listRuns().filter(run => run.bindingId === bindingId).map(run => run.id);
      assert.deepEqual(actualRunIds.sort(), expectedRunIds.sort());
      verifyNewerRun?.();
      assert.equal(h.store.latestSubmission(runId)?.id, published.id);
    } finally { await h.stop(); }
  });
}

test("a post-send anchor survives restart and preserves matching human turns in a different transcript", async () => {
  const { readWorkflowIntentSnapshot } = await import("../src/server/workflows/context.ts");
  const { forgetInjections } = await import("../src/server/injections.ts");
  const path = join(home, "transcript-created-during-publication.jsonl");
  const turn = (uuid: string, content: string) => JSON.stringify({
    type: "user", uuid, timestamp: new Date().toISOString(), message: { role: "user", content },
  }) + "\n";
  const h = await harness("publication-transcript-first-seen", {
    pullRequest: true,
    onInject: payload => {
      writeFileSync(path, turn("original-ask", "Publish this change") + turn("delivered", payload));
      h.reportIdle(path);
    },
  });
  try {
    const runId = await runToAction(h);
    await waitFor(() => h.store.listDeliveries(runId).some(d => d.state === "delivered"), "no PR packet");
    const binding = h.store.getBinding(h.store.getRun(runId)!.bindingId)!;
    const packet = h.store.listDeliveries(runId)[0]!.payload;
    const throughDelivery = readFileSync(path, "utf8");
    const anchors = new WorkflowStore().listDeliveredTranscriptAnchors(h.sessionId, binding.noteKey);
    const { workflowDeliveryLedger } = await import("../src/server/delivery-ledgers.ts");
    assert.ok(!workflowDeliveryLedger.rows(binding.noteKey).some(row => row.deliveryId === h.store.listDeliveries(runId)[0]!.id));
    forgetInjections(h.sessionId);
    writeFileSync(path, throughDelivery + turn("human-repeat", packet));
    for (const deliveries of [anchors, anchors.map(anchor => ({ ...anchor, receiptId: "unusable-prior-receipt" }))]) {
      const intent = readWorkflowIntentSnapshot(h.registry, binding, deliveries)!;
      assert.deepEqual(intent.decisions.filter(d => d.source.kind === "transcript").map(d => d.source.id),
        ["original-ask", "human-repeat"]);
    }
    const otherPath = join(home, "replacement-publication-transcript.jsonl");
    const other = turn("original-ask", "Publish this change") + turn("human-dup", packet);
    assert.equal(Buffer.byteLength(other), Buffer.byteLength(throughDelivery));
    writeFileSync(otherPath, other);
    h.reportIdle(otherPath);
    assert.deepEqual(readWorkflowIntentSnapshot(h.registry, binding, anchors)!.decisions
      .filter(d => d.source.kind === "transcript").map(d => d.source.id), ["original-ask", "human-dup"]);
    assert.deepEqual(anchors, [{ payload: packet, transcriptAnchor: Buffer.byteLength(throughDelivery), transcriptPath: path }]);
  } finally { await h.stop(); }
});

test("a delivered PR packet binds across an intervening human turn and preserves a later human repeat after restart", async () => {
  const { readWorkflowIntentSnapshot } = await import("../src/server/workflows/context.ts");
  const h = await harness("publication-packet-attribution", { pullRequest: true });
  try {
    const path = join(home, "delayed-publication-packet.jsonl");
    const turn = (uuid: string, content: string, ts: number) => JSON.stringify({
      type: "user", uuid, timestamp: new Date(ts).toISOString(), message: { role: "user", content },
    }) + "\n";
    const start = Date.now();
    const original = turn("initial-ask", "Publish my work", start);
    writeFileSync(path, original);
    h.reportIdle(path);
    const runId = await runToAction(h);
    await waitFor(() => h.store.listDeliveries(runId).some(d => d.state === "delivered"), "no PR packet");
    const binding = h.store.getBinding(h.store.getRun(runId)!.bindingId)!;
    const anchors = new WorkflowStore().listDeliveredTranscriptAnchors(h.sessionId, binding.noteKey);
    const packet = h.store.listDeliveries(runId)[0]!.payload;
    const receiptId = anchors[0]?.receiptId;
    assert.ok(receiptId);
    assert.deepEqual(anchors, [{ payload: packet, transcriptAnchor: Buffer.byteLength(original), beforeSend: true, receiptId }]);
    const { forgetDeliveryBindingState } = await import("../src/server/delivery-binding.ts");
    const { workflowDeliveryLedger } = await import("../src/server/delivery-ledgers.ts");
    const { forgetInjections } = await import("../src/server/injections.ts");
    forgetInjections(h.sessionId);
    forgetDeliveryBindingState();
    writeFileSync(path, original + turn("intervening-human", "Keep the fix scoped", start + 1)
      + turn("workflow-packet", packet, start + 2) + turn("human-repeat", packet, start + 3));
    const decisions = () => readWorkflowIntentSnapshot(h.registry, binding,
      new WorkflowStore().listDeliveredTranscriptAnchors(h.sessionId, binding.noteKey))!.decisions
      .filter(d => d.source.kind === "transcript").map(d => d.source.id);
    const otherPath = join(home, "other-publication-transcript.jsonl");
    writeFileSync(otherPath, original + turn("other-human", packet, start + 1));
    h.reportIdle(otherPath);
    const { reserveDelegatedTurn } = await import("../src/server/delegated-turns.ts");
    const { delegatedLedger } = await import("../src/server/delivery-ledgers.ts");
    const other = { key: binding.noteKey, transcript: sessionMessages(h.registry.getSession(h.sessionId)!)! };
    const delegated = reserveDelegatedTurn(other, packet, { id: "controller", name: "Controller" });
    assert.equal(delegatedLedger.rows(binding.noteKey).find(row => row.id === delegated)?.contested, false);
    assert.equal(workflowDeliveryLedger.rows(binding.noteKey).find(row => row.id === receiptId)?.contested, false);
    assert.deepEqual(decisions(), ["initial-ask", "other-human"], "the receipt belongs to the sampled transcript");
    h.reportIdle(path);
    assert.deepEqual(decisions(), ["initial-ask", "intervening-human", "human-repeat"]);
    forgetDeliveryBindingState();
    assert.equal(workflowDeliveryLedger.rows(binding.noteKey).find(row => row.id === receiptId)?.messageId, "workflow-packet");
    assert.deepEqual(decisions(), ["initial-ask", "intervening-human", "human-repeat"]);
    writeFileSync(otherPath, original + turn("workflow-packet", packet, start + 2));
    h.reportIdle(otherPath);
    assert.deepEqual(decisions(), ["initial-ask", "workflow-packet"], "even the same native ID is scoped to the receipt's file");
  } finally { await h.stop(); }
});

test("a Code Quality Judge repair must pass before the verified pull request action can complete locally", async () => {
  const h = await harness("quality-judge-repair", { pullRequest: true, verdict: () => "fail" });
  try {
    const bound = h.manager.createBinding({
      workflowVersionId: h.versionId,
      sessionId: h.sessionId,
    });
    assert.equal(bound.ok, true, "the binding was refused");
    const bindingId = bound.ok ? bound.value.id : "";
    const submitted = await h.manager.submit(bindingId, { requestId: "quality-judge-fail" });
    assert.equal(submitted.ok, true, "the first submission failed");
    const runId = submitted.ok ? submitted.value.run.id : "";

    await waitFor(
      () => h.store.getRun(runId)?.status === "waiting_for_session",
      "the Code Quality Judge failure never returned to the session",
    );
    assert.equal(
      h.store.listSubmissions(runId)
        .flatMap((submission) => h.store.listAttempts(submission.id))
        .some((attempt) => attempt.sessionAction !== null),
      false,
      "the pull request action activated before the judge passed",
    );
    assert.equal(
      h.store.listDeliveries(runId).some((delivery) => delivery.kind === "session_action"),
      false,
      "the pull request action prepared a packet before the judge passed",
    );
    assert.equal(h.injected.length, 1, "the failed judge should type only its repair packet");
    assert.match(h.injected[0]!, /Workflow review failed/);

    h.setVerdict(() => "pass");
    h.head.sha = "head-2";
    const repaired = await h.manager.resubmit(runId, {
      requestId: "quality-judge-pass",
      resubmitUnchanged: false,
    });
    assert.equal(repaired.ok, true, `the repaired submission was refused: ${JSON.stringify(repaired)}`);
    await waitFor(
      () => h.store.listDeliveries(runId).some((delivery) =>
        delivery.kind === "session_action" && delivery.state === "delivered"),
      "the verified pull request action never followed the passing judge",
    );

    h.runActionTurn();
    h.adoptPr({ atHead: "head-2" });
    await h.manager.sweepSessionActions(SETTLED());
    await waitFor(
      () => h.store.getRun(runId)?.status === "completed",
      "the verified action continuation never reached End",
    );

    const finalSubmission = h.store.listSubmissions(runId).at(-1)!;
    assert.equal(
      h.store.listAttempts(finalSubmission.id).some((attempt) =>
        attempt.nodeId === "end" && attempt.state === "completed"),
      true,
    );
    assert.equal(h.store.getRun(runId)?.currentPhase, "complete");
    assert.equal(
      h.store.listDeliveries(runId).some((delivery) => delivery.kind === "inspector_feedback"),
      false,
      "a local completion unexpectedly waited for GitHub Inspector",
    );
  } finally {
    await h.stop();
  }
});

test("a terminal pull request continuation reaches End without starting a new readiness cycle", async () => {
  const h = await harness("terminal-pr-readiness", {
    pullRequest: true,
    evidenceReadinessPolicy: "criterion_mapped_v1",
  });
  try {
    const runId = await runToAction(h);
    await waitFor(
      () => h.store.listDeliveries(runId).some((delivery) =>
        delivery.kind === "session_action" && delivery.state === "delivered"),
      "the pull request action never followed the passing judge",
    );

    h.head.sha = "head-2";
    h.runActionTurn();
    h.adoptPr({ atHead: "head-2" });
    await h.manager.sweepSessionActions(SETTLED());
    await waitFor(
      () => h.store.getRun(runId)?.status === "completed",
      "the terminal continuation was incorrectly parked for evidence readiness",
    );

    const [parent, child] = h.store.listSubmissions(runId);
    assert.ok(parent);
    assert.ok(child);
    assert.equal(child.parentSubmissionId, parent.id);
    assert.equal(child.readiness, null);
    assert.equal(
      h.store.listDeliveries(runId).some((delivery) => delivery.kind === "evidence_readiness"),
      false,
    );
    assert.equal(
      h.store.listEvents(runId).filter((event) =>
        event.kind === "evidence_readiness_evaluated"
        && (event.payload as { segment?: number }).segment === 1).length,
      0,
    );
    assert.deepEqual(
      h.store.listAttempts(child.id).map((attempt) => attempt.nodeId),
      ["end"],
    );
    assert.equal(
      h.store.listAttempts(parent.id).filter((attempt) => attempt.nodeId === "upstream").length,
      1,
    );
  } finally {
    await h.stop();
  }
});

test("changed pull request content warns and still reaches End", async () => {
  const h = await harness("terminal-pr-content-changed", { pullRequest: true });
  try {
    const runId = await runToAction(h);
    await waitFor(
      () => h.store.listDeliveries(runId).some((delivery) => delivery.state === "delivered"),
      "the pull request packet was never delivered",
    );
    h.head.sha = "packaging-head";
    h.contentTree.oid = h.full("changed-tree");
    h.runActionTurn();
    h.adoptPr({ atHead: "packaging-head" });
    await h.manager.sweepSessionActions(SETTLED());
    await waitFor(
      () => h.store.getRun(runId)?.status === "completed",
      "changed published content stopped the completed PR action",
    );

    const attempt = h.store.getAttempt(waitingActionAttemptId(h, runId))!;
    assert.equal(attempt.state, "completed");
    const output = attempt.output as { warnings?: Array<{ code: string; detail: string }> };
    assert.equal(output.warnings?.[0]?.code, "pull_request_review_mismatch");
    assert.match(output.warnings?.[0]?.detail ?? "", /workflow continued/);
    const child = h.store.listSubmissions(runId)[1]!;
    assert.equal(
      h.store.listAttempts(child.id).some((item) => item.nodeId === "end"),
      true,
    );
    assert.equal(
      h.store.listEvents(runId).some((event) => event.kind === "session_action_warning"),
      true,
    );
    assert.equal(
      h.store.listDeliveries(runId).some((delivery) => delivery.kind === "evidence_readiness"),
      false,
    );
  } finally {
    await h.stop();
  }
});

test("a mid-graph pull request continuation still requires fresh criterion evidence", async () => {
  const h = await harness("midgraph-pr-readiness", {
    pullRequest: true,
    downstream: true,
    evidenceReadinessPolicy: "criterion_mapped_v1",
  });
  try {
    const runId = await runToAction(h);
    await waitFor(
      () => h.store.listDeliveries(runId).some((delivery) => delivery.state === "delivered"),
      "the pull request packet was never delivered",
    );
    h.head.sha = "head-2";
    h.runActionTurn();
    h.adoptPr({ atHead: "head-2" });
    await h.manager.sweepSessionActions(SETTLED());
    await waitFor(
      () => h.store.getRun(runId)?.status === "waiting_for_evidence_readiness",
      "the evaluator-bound continuation skipped fresh readiness",
    );

    const child = h.store.listSubmissions(runId)[1]!;
    assert.equal(child.readiness?.status, "gaps");
    assert.equal(
      h.store.listDeliveries(runId).some((delivery) => delivery.kind === "evidence_readiness"),
      true,
    );
    assert.equal(
      h.store.listAttempts(child.id).some((item) => item.nodeId === "downstream"),
      false,
    );
  } finally {
    await h.stop();
  }
});

test("terminal pull request recovery remains idempotent after verified completion", async () => {
  const h = await harness("terminal-pr-recovery", {
    pullRequest: true,
    evidenceReadinessPolicy: "criterion_mapped_v1",
  });
  try {
    const runId = await runToAction(h);
    await waitFor(
      () => h.store.listDeliveries(runId).some((delivery) => delivery.state === "delivered"),
      "the pull request packet was never delivered",
    );
    h.head.sha = "head-2";
    h.runActionTurn();
    h.adoptPr({ atHead: "head-2" });
    await h.manager.sweepSessionActions(SETTLED());
    await waitFor(() => h.store.getRun(runId)?.status === "completed", "shipping did not complete");

    await h.manager.stop();
    h.manager.start();
    for (let tick = 0; tick < 3; tick += 1) await h.manager.sweepSessionActions(SETTLED());
    const submissions = h.store.listSubmissions(runId);
    assert.deepEqual(submissions.map((item) => [item.round, item.segment]), [[1, 0], [1, 1]]);
    assert.equal(
      h.store.listAttempts(submissions[1]!.id).filter((item) => item.nodeId === "end").length,
      1,
    );
    assert.equal(h.injected.length, 1);
  } finally {
    await h.stop();
  }
});

test("a pull request action waits for adoption, then warns and advances on a different pushed ref", async () => {
  const h = await harness("pr-wait", { pullRequest: true, downstream: true });
  try {
    const runId = await runToAction(h);
    await waitFor(
      () => h.store.listDeliveries(runId).some((delivery) => delivery.state === "delivered"),
      "the action packet never reached the pane",
    );

    // The turn runs and settles, and the session has pushed a new commit - but nothing has
    // adopted a pull request. A `session_turn` action would be finished here.
    h.head.sha = "head-2";
    h.runActionTurn();
    await h.manager.sweepSessionActions(SETTLED());
    assert.equal(waitingAttempt(h, runId)?.state, "waiting");
    assert.equal(h.store.runSummary(runId)?.actionWait, "awaiting_pull_request");
    assert.equal(h.store.listSubmissions(runId).length, 1, "a segment was captured with no proof");

    // A pull request appears on the branch, but the poller last saw it at the old commit. The
    // publication is complete, so the mismatch is advisory and downstream review starts.
    h.adoptPr({ atHead: "head-1" });
    await h.manager.sweepSessionActions(SETTLED());
    await waitFor(
      () => h.store.listSubmissions(runId).length === 2,
      "an adopted pull request never captured a continuation segment",
    );
    const child = h.store.listSubmissions(runId)[1]!;
    assert.equal(child.segment, 1);
    await waitFor(
      () => h.store.listAttempts(child.id).some((item) => item.nodeId === "downstream"),
      "the downstream reviewer never activated on the child evidence",
    );

    // One packet, whatever the adoption wait cost. The mismatch never retypes the instruction.
    assert.equal(h.injected.length, 1);

    // The observed PR and warning are both durable on the completed attempt.
    const done = h.store.getAttempt(waitingActionAttemptId(h, runId))!;
    assert.equal(done.state, "completed");
    const output = done.output as {
      expectation?: { kind: string; expectedHeadOid?: string; pullRequestUrl?: string };
      warnings?: Array<{ detail: string }>;
    };
    assert.equal(output.expectation?.kind, "pull_request");
    assert.equal(output.expectation?.expectedHeadOid, h.full("head-1"));
    assert.equal(output.expectation?.pullRequestUrl, "https://github.com/owner/repo/pull/7");
    assert.match(output.warnings?.[0]?.detail ?? "", /pushed ref/);
  } finally {
    await h.stop();
  }
});

test("a pull request opened on another branch warns and still completes the action", async () => {
  const h = await harness("pr-wrong", { pullRequest: true });
  try {
    const runId = await runToAction(h);
    await waitFor(
      () => h.store.listDeliveries(runId).some((delivery) => delivery.state === "delivered"),
      "the action packet never reached the pane",
    );
    h.runActionTurn();

    // Same commit, wrong branch - a stacked branch, or one that was never switched.
    h.adoptPr({ branch: "some-other-branch" });
    await h.manager.sweepSessionActions(SETTLED());
    await waitFor(
      () => h.store.getRun(runId)?.status === "completed",
      "the branch warning stopped the pull request action",
    );
    const attempt = h.store.getAttempt(waitingActionAttemptId(h, runId))!;
    const output = attempt.output as { warnings?: Array<{ detail: string }> };
    assert.match(output.warnings?.[0]?.detail ?? "", /not the checked branch/);
    assert.equal(h.injected.length, 1);
  } finally {
    await h.stop();
  }
});

test("a pull request closed after opening warns without blocking the run", async () => {
  const h = await harness("pr-closed", { pullRequest: true });
  try {
    const runId = await runToAction(h);
    await waitFor(
      () => h.store.listDeliveries(runId).some((delivery) => delivery.state === "delivered"),
      "the action packet never reached the pane",
    );
    h.runActionTurn();
    h.adoptPr({ observedState: "CLOSED" });
    await h.manager.sweepSessionActions(SETTLED());
    await waitFor(() => h.store.getRun(runId)?.status === "completed", "the closed PR warning blocked");

    const attempt = h.store.getAttempt(waitingActionAttemptId(h, runId))!;
    assert.equal(attempt.state, "completed");
    assert.equal(attempt.verdict, null, "an action warning must never become a verdict");
    const output = attempt.output as { warnings?: Array<{ detail: string }> };
    assert.match(output.warnings?.[0]?.detail ?? "", /closed/);
    assert.equal(h.store.runSummary(runId)?.round, 1);
    assert.equal(h.store.listSubmissions(runId).length, 2);
    assert.equal(h.injected.length, 1);
  } finally {
    await h.stop();
  }
});

test("a head that moves between PR observation and capture warns and advances", async () => {
  const h = await harness("pr-head-moved", { pullRequest: true, downstream: true });
  try {
    const runId = await runToAction(h);
    await waitFor(
      () => h.store.listDeliveries(runId).some((delivery) => delivery.state === "delivered"),
      "the action packet never reached the pane",
    );

    // The adapter proves the pull request at `head-2`, and the checkout moves to `head-3`
    // before the capture reads it - the ordinary shape of an agent that pushed and then kept
    // working. The captured child therefore holds `head-3`, which the expectation refuses.
    h.head.sha = "head-2";
    h.runActionTurn();
    h.adoptPr({ atHead: "head-2" });
    // The PROOF still reads `head-2` and matches, and the CAPTURE records `head-3`.
    h.captureHead.sha = "head-3";
    await h.manager.sweepSessionActions(SETTLED());

    // The child seals immediately. The mismatch is retained as an advisory, not a moving target
    // the action waits for the pull request to catch up with.
    assert.equal(h.store.getAttempt(waitingActionAttemptId(h, runId))?.state, "completed");
    assert.equal(h.store.listSubmissions(runId).length, 2, "the reservation was not reused");
    assert.equal(
      h.store.listEvents(runId).some((event) => event.kind === "session_action_warning"),
      true,
    );

    // Still exactly one child segment, one packet, and one receipt.
    assert.equal(h.store.listSubmissions(runId).length, 2);
    assert.equal(h.injected.length, 1);
    const child = h.store.listSubmissions(runId)[1]!;
    assert.equal(
      h.store.listReceipts(child.id).filter((receipt) => receipt.edgeId === "e-act").length,
      1,
    );
    const output = h.store.getAttempt(waitingActionAttemptId(h, runId))!.output as {
      expectation?: { expectedHeadOid?: string };
      warnings?: Array<{ detail: string }>;
    };
    assert.equal(output.expectation?.expectedHeadOid, h.full("head-2"));
    assert.match(output.warnings?.[0]?.detail ?? "", /did not match/);
  } finally {
    await h.stop();
  }
});

test("a restart while waiting for a pull request neither retypes nor completes", async () => {
  const h = await harness("pr-restart", { pullRequest: true, downstream: true });
  try {
    const runId = await runToAction(h);
    await waitFor(
      () => h.store.listDeliveries(runId).some((delivery) => delivery.state === "delivered"),
      "the action packet never reached the pane",
    );
    h.head.sha = "head-2";
    h.runActionTurn();
    await h.manager.sweepSessionActions(SETTLED());
    assert.equal(h.store.runSummary(runId)?.actionWait, "awaiting_pull_request");

    await h.manager.stop();
    h.manager.start();
    // Recovery must not prepare a second packet for an action whose only problem is that its
    // proof has not arrived: the delivery landed, and the wait is the runtime working.
    await h.manager.sweepSessionActions(SETTLED());
    assert.equal(h.injected.length, 1, "the packet was retyped across a restart");
    assert.equal(waitingAttempt(h, runId)?.state, "waiting");
    assert.equal(h.store.listSubmissions(runId).length, 1);

    // And the proof still lands afterwards, so the wait was a wait and not a wedge.
    h.adoptPr({ atHead: "head-2" });
    await h.manager.sweepSessionActions(SETTLED());
    await waitFor(
      () => h.store.listSubmissions(runId).length === 2,
      "the run never recovered once its pull request appeared",
    );
    assert.equal(h.injected.length, 1);
  } finally {
    await h.stop();
  }
});

test("a pull request already open at the reviewed commit completes without a second one", async () => {
  const h = await harness("pr-existing", { pullRequest: true });
  try {
    // Adopted BEFORE the run even starts, which is the shape of a branch that already had a
    // pull request open. The action still runs its turn - the description may need updating -
    // but it must not demand that a second pull request be opened.
    const runId = await runToAction(h);
    h.adoptPr();
    await waitFor(
      () => h.store.listDeliveries(runId).some((delivery) => delivery.state === "delivered"),
      "the action packet never reached the pane",
    );
    h.runActionTurn();
    await h.manager.sweepSessionActions(SETTLED());
    await waitFor(
      () => h.store.listSubmissions(runId).length === 2,
      "an already-matching pull request never satisfied the action",
    );
    assert.equal(h.adopted.length, 1, "the fixture adopted a second pull request");
    assert.equal(h.injected.length, 1);
  } finally {
    await h.stop();
  }
});


test("the PR comparison uses reviewed publication content while retaining the local report", async () => {
  const h = await harness("pr-with-local-report", { pullRequest: true, localReport: true });
  try {
    const runId = await runToAction(h);
    await waitFor(() => h.store.listDeliveries(runId).some((delivery) => delivery.state === "delivered"),
      "the pull request packet was never delivered");
    h.head.sha = "packaging-head";
    h.runActionTurn();
    h.adoptPr({ atHead: "packaging-head" });
    await h.manager.sweepSessionActions(SETTLED());
    await waitFor(() => h.store.getRun(runId)?.status === "completed", "the PR continuation did not finish");
    const attempt = h.store.getAttempt(waitingActionAttemptId(h, runId))!;
    const output = attempt.output as { warnings?: Array<{ code: string }> };
    assert.equal(output.warnings?.length ?? 0, 0,
      "an uncommitted retained report must not create a PR content-mismatch warning");
    for (const submission of h.store.listSubmissions(runId)) {
      assert.equal(h.store.listSubmissionTextArtifacts(submission.id)[0]?.content, "report");
    }
  } finally {
    await h.stop();
  }
});


for (const { parentProof, childProof, changed, number, disableInspector = false, findingsPolicy, autoResumption = false } of [
  { parentProof: "publication", childProof: "publication", changed: false, number: 71 },
  { parentProof: "publication", childProof: "publication", changed: true, number: 72 },
  { parentProof: "legacy", childProof: "publication", changed: false, number: 73 },
  { parentProof: "legacy", childProof: "publication", changed: true, number: 74 },
  { parentProof: "missing", childProof: "publication", changed: false, number: 75 },
  { parentProof: "legacy", childProof: "legacy", changed: false, number: 76 },
  { parentProof: "legacy", childProof: "legacy", changed: true, number: 77 },
  { parentProof: "missing", childProof: "legacy", changed: false, number: 78 },
  { parentProof: "legacy", childProof: "missing", changed: false, number: 79 },
  { parentProof: "publication", childProof: "publication", changed: true, number: 80, disableInspector: true },
  ...(["restart_workflow", "inspector_only"] as const).map((findingsPolicy, i) => ({
    parentProof: "publication", childProof: "publication", changed: true, number: 81 + i, findingsPolicy, disableInspector: false,
    autoResumption: false,
  })),
  { parentProof: "publication", childProof: "publication", changed: true, number: 83, autoResumption: true },
]) {
  test(`Inspector holds a shipping continuation to its parent's accepted tree: parent=${parentProof}, child=${childProof}, changed=${changed}, disabled=${disableInspector}, findings=${findingsPolicy}, auto=${autoResumption}`, async (t) => {
    const { updateInspectorPr, upsertInspectorComment } = await import("../src/server/db.ts");
    const { setInspectorConfig } = await import("../src/server/inspector/config.ts");
    setInspectorConfig({ enabled: true });
    const options: HarnessOptions = {
      pullRequest: true, localReport: parentProof === "publication", inspector: true, maxRepairRounds: 3, probeEvidence: true,
      omitContentTree: parentProof === "missing", inspectorFindingsPolicy: findingsPolicy,
      resumptionPolicy: findingsPolicy || autoResumption ? "auto" : "manual",
    };
    const h = await harness(`publication-inspector-${parentProof}-${childProof}-${changed}-${disableInspector}-${findingsPolicy}-${autoResumption}`, options);
    try {
      const runId = await runToAction(h);
      await waitFor(() => h.store.listDeliveries(runId).some((delivery) => delivery.state === "delivered"), "no PR packet");
      const parent = h.store.listSubmissions(runId)[0]!;
      const parentEvidence = WorkflowContextSnapshotSchema.parse(parent.context).evidence;
      assert.equal(parentEvidence.publication !== undefined, parentProof === "publication");
      assert.equal(parentEvidence.contentTreeOid != null, parentProof !== "missing");
      // Some children were already captured before the upgrade; others get publication proof.
      // Both must honor the immutable parent review, even when the packaging result is clean.
      options.localReport = childProof === "publication";
      options.omitContentTree = childProof === "missing";
      if (changed) h.contentTree.oid = h.full("omitted-required-file");
      h.head.sha = "packaged";
      h.runActionTurn();
      const key = `owner/repo#${number}`;
      const url = `https://github.com/owner/repo/pull/${number}`;
      h.adoptPr({ atHead: h.head.sha, key, url, number });
      await h.manager.sweepSessionActions(SETTLED());
      await waitFor(() => h.store.getRun(runId)?.gateState != null, "the Inspector gate never started");
      let child = h.store.latestSubmission(runId)!;
      assert.equal(child.parentSubmissionId, parent.id);
      const childEvidence = WorkflowContextSnapshotSchema.parse(child.context).evidence;
      assert.equal(childEvidence.publication !== undefined, childProof === "publication");
      assert.equal(childEvidence.contentTreeOid != null, childProof !== "missing");
      const now = Date.now();
      const head = h.full(h.head.sha);
      await observeCleanInspectorReview(h, number, head, now);
      const mustWait = changed || parentProof === "missing" || childProof === "missing";
      await waitFor(() => ["waiting_for_session", "completed"].includes(h.store.getRun(runId)?.status ?? ""),
        "the Inspector gate never decided the publication proof");
      assert.equal(h.store.getRun(runId)?.status, mustWait ? "waiting_for_session" : "completed",
        mustWait ? "shipping escaped the accepted parent proof" : "matching accepted content prevented completion");
      if (mustWait) assert.equal(
        WorkflowInspectorGateStateSchema.parse(h.store.getRun(runId)?.gateState).waitReason,
        changed ? "reviewed_tree_changed" : "working_tree_not_pushed",
      );
      if (changed) {
        const gate = WorkflowInspectorGateStateSchema.parse(h.store.getRun(runId)?.gateState);
        assert.deepEqual(gate.reviewedContent, {
          submissionId: parent.id,
          headSha: parentEvidence.headSha,
          treeOid: parentEvidence.publication?.treeOid ?? parentEvidence.contentTreeOid,
          publishedTreeOid: h.contentTree.oid,
        });
        h.registry.inspectionUpdated(key, head, "OPEN", now + 1);
        await waitFor(() => WorkflowInspectorGateStateSchema.parse(h.store.getRun(runId)?.gateState)
          .lastObservedAt === now + 1, "a second observation must update the persisted reviewed-tree gate");
        // A persisted hold from an older build is reclassified on the next observation.
        h.store.setRunState(runId, "waiting_for_session", "inspector_working_tree_not_pushed",
          { ...gate, waitReason: "working_tree_not_pushed" }, now);
        // Another observation of the same pushed head cannot spend or bypass review.
        h.registry.inspectionUpdated(key, head, "OPEN", now + 2);
        await waitFor(() => WorkflowInspectorGateStateSchema.parse(h.store.getRun(runId)?.gateState)
          .waitReason === "reviewed_tree_changed", "the historical publication hold must be reclassified");
        assert.equal(h.store.latestSubmission(runId)?.id, child.id);
        assert.equal(h.store.getRun(runId)?.status, "waiting_for_session");
        assert.equal(WorkflowInspectorGateStateSchema.parse(h.store.getRun(runId)?.gateState).waitReason,
          "reviewed_tree_changed");
        if (autoResumption) {
          assert.equal(h.store.listDeliveries(runId).filter((delivery) => delivery.kind === "inspector_feedback").length, 0);
          h.runActionTurn();
          await h.manager.sweepResumptions(SETTLED());
          assert.equal(h.store.latestSubmission(runId)?.id, child.id,
            "an unrelated settled turn must not spend a round on the operator-owned reviewed-tree hold");
          assert.equal(h.store.getRun(runId)?.currentPhase, "inspector_reviewed_tree_changed");
          const withheld = h.store.listEvents(runId).filter((event) => event.kind === "resumption_withheld").at(-1);
          assert.deepEqual(withheld?.payload, {
            submissionId: child.id, round: child.round, reason: "repository_unchanged",
          });
          assert.equal(h.store.listEvents(runId).some((event) => event.kind === "resumption_started"), false);
        }
        if (findingsPolicy) {
          upsertInspectorComment({
            id: `unposted-${number}`, prKey: key, fingerprint: `unposted-${number}`,
            path: "src/edge.ts", line: 15, title: "Unposted finding on the published head",
            body: "This draft has not reached GitHub.", severity: "major",
            round: 7, status: "drafted", replies: 0, answeredCommentId: null, createdAt: now, updatedAt: now,
            githubUrl: null, postedAt: null,
          });
          const deliveriesBeforeDraft = h.injected.length;
          h.registry.inspectionUpdated(key, head, "OPEN", now + 3);
          await h.settle();
          assert.equal(h.store.listDeliveries(runId).filter((d) => d.kind === "inspector_feedback").length, 0,
            "an unposted current-head finding must not prepare a feedback packet across the reviewed-tree hold");
          assert.equal(h.injected.length, deliveriesBeforeDraft, "unposted feedback must not reach the owning session");
          assert.equal(WorkflowInspectorGateStateSchema.parse(h.store.getRun(runId)?.gateState).waitReason,
            "reviewed_tree_changed");
          upsertInspectorComment({
            id: `posted-${number}`, prKey: key, fingerprint: `posted-${number}`,
            path: "src/edge.ts", line: 12, title: "Posted finding on the published head",
            body: "Verify the Go toolchain behavior and reply to this thread.", severity: "major",
            round: 7, status: "open", replies: 0, answeredCommentId: null, createdAt: now, updatedAt: now,
            githubUrl: `${url}#discussion_r1576`, postedAt: now,
          });
          updateInspectorPr(key, { headSha: h.full("older-review") }, now);
          h.registry.inspectionUpdated(key, head, "OPEN", now + 4);
          await waitFor(() => WorkflowInspectorGateStateSchema.parse(h.store.getRun(runId)?.gateState)
            .lastObservedAt === now + 4, "the stale-review observation did not settle");
          assert.equal(h.store.listDeliveries(runId).filter((d) => d.kind === "inspector_feedback").length, 0,
            "a previous head's review must not deliver findings as current");
          updateInspectorPr(key, { headSha: head }, now);
          h.registry.inspectionUpdated(key, head, "OPEN", now + 5);
          await waitFor(() => h.store.listDeliveries(runId).some((d) => d.kind === "inspector_feedback"),
            "the published-tree hold swallowed the current-head finding");
          await waitFor(() => h.store.listDeliveries(runId).some((d) => d.kind === "inspector_feedback" && d.state === "delivered"),
            "the current-head finding never reached the session");
          const packet = h.store.listDeliveries(runId).find((d) => d.kind === "inspector_feedback")!;
          assert.match(packet.payload, /Posted finding on the published head/);
          assert.doesNotMatch(packet.payload, /Unposted finding on the published head/);
          assert.ok(packet.payload.includes(`${url}#discussion_r1576`));
          assert.match(packet.payload, /fresh full workflow review/);
          assert.doesNotMatch(packet.payload, /permits bypassing Personas/);
          assert.ok(h.injected.includes(packet.payload));
          const findingGate = WorkflowInspectorGateStateSchema.parse(h.store.getRun(runId)?.gateState);
          assert.deepEqual(findingGate.findingFingerprints, [`posted-${number}`]);
          assert.deepEqual(findingGate.reviewedContent, gate.reviewedContent);
          assert.equal(h.store.getRun(runId)?.status, "waiting_for_session", "publication mismatch forbids Inspector-only bypass");
          assert.ok(packet.deliveredAt !== null);
          assert.ok((h.registry.getSession(h.sessionId)?.lastActivity ?? 0) <= packet.deliveredAt);
          await h.manager.sweepResumptions(SETTLED());
          assert.equal(h.store.latestSubmission(runId)?.id, child.id,
            "idle from before feedback delivery must not start the fresh review before the session acts");
          assert.equal(h.store.listDeliveries(runId).filter((d) => d.kind === "inspector_feedback").length, 1);
          // Resolving by reply on the same head must not complete the old review or send twice.
          upsertInspectorComment({
            id: `posted-${number}`, prKey: key, fingerprint: `posted-${number}`,
            path: "src/edge.ts", line: 12, title: "Posted finding on the published head",
            body: "Verified and withdrawn", severity: "major", round: 7, status: "resolved",
            replies: 1, answeredCommentId: null, createdAt: now, updatedAt: now + 5,
          });
          h.registry.inspectionUpdated(key, head, "OPEN", now + 6);
          // Parked findings do not advance lastObservedAt. Wait for the observation even
          // if it has already finished by the time the harness reaches this barrier.
          await h.settle();
          assert.equal(h.store.getRun(runId)?.status, "waiting_for_session");
          assert.equal(h.store.listDeliveries(runId).filter((d) => d.kind === "inspector_feedback").length, 1);
        }
        // Make reuse eligibility explicit rather than relying on the machine default.
        const previousPolicy = getWorkflowPolicy();
        t.after(() => setWorkflowPolicy(previousPolicy));
        setWorkflowPolicy({ ...previousPolicy, skipPassedJudges: true });
        assert.equal(getWorkflowPolicy().skipPassedJudges, true);
        const earned = h.store.listAttempts(parent.id).find((attempt) => attempt.nodeId === "upstream");
        assert.ok(earned);
        assert.equal(earned.state, "completed");
        assert.notEqual(earned.runner, null, "the earlier pass must come from an executed reviewer");
        assert.equal(PersonaVerdictSchema.parse(earned.verdict).verdict, "pass");
        assert.equal(h.store.priorPassedJudge(runId, "upstream", child.round + 1)?.id, earned.id,
          "the earlier pass must be eligible before the fresh published-head review boundary");
        if (disableInspector) {
          setInspectorConfig({ enabled: false });
          t.after(() => setInspectorConfig({ enabled: true }));
          h.registry.inspectionUpdated(key, head, "OPEN", now + 3);
          await waitFor(() => h.store.getRun(runId)?.currentPhase === "inspector_disabled",
            "disabling Inspector must replace the visible hold reason");
          assert.deepEqual(WorkflowInspectorGateStateSchema.parse(h.store.getRun(runId)?.gateState).reviewedContent,
            gate.reviewedContent, "disabling Inspector must retain the outstanding review obligation");
        }
        if (parentProof === "legacy" && childProof === "publication") {
          // Preview grants retain round_limit, with the review obligation carried in its gate.
          h.store.updateBinding(h.store.getRun(runId)!.bindingId, { deliveryMode: "preview" }, now);
          // Place the same captured publication at the exhausted budget boundary.
          h.store.setRunState(runId, "running", "persona_review", null, now);
          const exhausted = h.store.createRepairSubmission({
            id: `exhausted-${number}`, runId, round: 4, triggerSource: "manual",
            triggerKey: `exhausted-${number}`, context: {}, evidence: {}, now,
          });
          child = h.store.updateSubmissionCapture(exhausted.submission.id, {
            context: child.context, evidence: child.evidence, fingerprint: child.evidenceFingerprint,
            repositoryFingerprint: child.repositoryFingerprint ?? undefined, status: "running",
          }, now);
          h.store.setRunState(runId, "waiting_for_session", "inspector_reviewed_tree_changed", { ...gate }, now);
          h.store.blockForRoundLimit(h.store.getRun(runId)!, now);
          const granted = h.manager.grantRepairRounds(runId, { requestId: "review-budget", rounds: 1 });
          assert.equal(granted.ok, true, JSON.stringify(granted));
          assert.equal(h.store.getRun(runId)?.currentPhase, "round_limit");
        }
        const result = parentProof === "legacy" && childProof === "legacy"
          ? await (async () => {
            const run = h.store.getRun(runId)!;
            const binding = h.store.getBinding(run.bindingId)!;
            const claimed = h.store.claimForemanCompletion({
              binding, completionKind: "drain", marker: "published-head-review",
              expectedWorkCycle: null, expectedIntent: null, retireGuard: false,
              summary: "Review the published head", evidenceFingerprint: "published-head",
              runId, submissionId: `foreman-published-${number}`, intent: run.intent!, now: now + 3,
            });
            assert.equal(claimed.result.claimed, true);
            assert.equal(claimed.created, true);
            assert.equal(h.store.priorPassedJudge(runId, "upstream", child.round + 1), null,
              "Foreman must record the same pass-reuse boundary as manual review");
            // Exercise the capture method used by manager.claimCompletion, including its
            // unchanged check; no manual allowUnchanged flag reaches this path.
            return (h.manager as unknown as {
              captureAndActivate: (...args: unknown[]) => Promise<{ ok: boolean }>;
            }).captureAndActivate(binding, claimed.run, claimed.submission, claimed.previousFingerprint);
          })()
          : findingsPolicy ? await (async () => {
            // The agent answered and resolved the thread without another edit or push.
            h.runActionTurn();
            await h.manager.sweepResumptions(SETTLED());
            const freshSubmission = h.store.latestSubmission(runId)!;
            assert.equal(freshSubmission.round, child.round + 1,
              "an unchanged published tree still needs its outstanding full review");
            assert.equal(freshSubmission.triggerSource, "session");
            assert.equal(h.store.submissionRequiresFreshPublishedReview(freshSubmission.id), true);
            assert.equal(h.store.priorPassedJudge(runId, "upstream", freshSubmission.round), null);
            assert.equal(h.head.sha, "packaged", "automatic review must not require another push");
            return { ok: true };
          })() : await h.manager.resubmit(runId, {
            requestId: `fresh-published-${number}`, resubmitUnchanged: false,
          });
        assert.equal(result.ok, true, JSON.stringify(result));
        await waitFor(() => h.store.listSubmissions(runId).some((submission) =>
          submission.round === child.round + 1
          && h.store.listAttemptsForRun(runId).some((attempt) => attempt.submissionId === submission.id
            && attempt.nodeId === "upstream" && attempt.state === "completed")),
        "fresh published-head review must finish the Persona without another edit or push");
        const fresh = h.store.listAttemptsForRun(runId).find((attempt) =>
          attempt.nodeId === "upstream" && attempt.id !== earned.id && attempt.state === "completed");
        assert.ok(fresh);
        assert.notEqual(fresh.runner, null,
          "reuse is enabled, but the fresh published-head review must execute instead of reusing the earlier pass");
      }
    } finally {
      await h.stop();
    }
  });
}

for (const changed of [false, true]) {
  test(`a plan's previously merged PR ${changed ? "does not cover new work" : "satisfies a later Pull Request action"}`, async () => {
    const { adoptInspectorPr } = await import("../src/server/db.ts");
    const { mkTask } = await import("./helpers/session-fixture.ts");
    const h = await harness(`old-merge-${changed}`, { pullRequest: true, realLedger: true });
    try {
      h.repository.root = `/repo/old-merge-${changed}`;
      h.registry.upsertTask(mkTask({ id: `plan-${changed}`, kind: "plan", status: "running", sessionId: h.sessionId }));
      const head = h.full(h.head.sha);
      const key = `owner/repo#${changed ? 1571 : 1570}`;
      h.commitTrees.set(head, h.contentTree.oid);
      const url = `https://github.com/owner/repo/pull/${changed ? 1571 : 1570}`;
      adoptInspectorPr({ key, url, owner: "owner", repo: "repo", number: changed ? 1571 : 1570,
        repoRoot: h.repository.root, cwd: "/repo", sessionId: h.sessionId, source: "hook", state: "closed",
        headSha: head, reviewPosture: "live", round: 1, lastReviewedAt: 1, lastError: null,
        failCount: 0, lastFailKind: null, nextAttemptAt: null, lastAttemptSha: head,
        mergedAt: 1, mergeBlock: null, observedHeadSha: head, observedState: "MERGED", observedAt: 1,
        headRefName: "feature", title: "Published plan", adoptedAt: 1, updatedAt: 1 });
      const runId = await runToAction(h, true);
      await waitFor(() => h.store.listDeliveries(runId).some(d => d.state === "delivered"), "no PR action packet");
      const attemptId = waitingActionAttemptId(h, runId);
      const delivery = h.store.listDeliveries(runId).find(d => d.state === "delivered")!;
      assert.ok(h.injected.includes(delivery.payload), "the session received the action packet");
      if (changed) h.contentTree.oid = h.full("unpublished-plan");
      h.reportPrompt(delivery.payload);
      const report = `The plan is already published through merged pull request ${url}. Nothing remains to publish; no new pull request is needed.`;
      const transcriptPath = join(home, `${h.sessionId}-response.jsonl`);
      writeFileSync(transcriptPath, [
        { type: "user", uuid: "pull-request-packet", timestamp: new Date(delivery.deliveredAt!).toISOString(),
          message: { role: "user", content: delivery.payload } },
        { type: "assistant", uuid: "publication-report", timestamp: new Date().toISOString(),
          message: { role: "assistant", content: [{ type: "text", text: report }] } },
      ].map(record => `${JSON.stringify(record)}\n`).join(""));
      h.reportIdle(transcriptPath);
      const located = sessionMessages(h.registry.getSession(h.sessionId)!);
      assert.ok(located, "the Stop hook attached the session's response transcript");
      const response = located.read.window(located.path, 12, 68).messages.at(-1)!;
      assert.equal(response.role, "assistant");
      assert.equal(response.text, report);
      assert.ok(response.ts > delivery.deliveredAt!, "the report follows action delivery");
      await h.manager.sweepSessionActions(SETTLED());
      if (changed) {
        await waitFor(() => h.store.getRun(runId)?.currentPhase === "session_action_blocked",
          "unpublished continuation content must block historical publication");
        assert.match(JSON.stringify(h.store.getAttempt(attemptId)), /published_content_changed/);
      } else {
        await waitFor(() => h.store.getRun(runId)?.status === "completed", "old merge stranded the run");
        const attempt = h.store.getAttempt(attemptId)!;
        assert.match(JSON.stringify(attempt), /Already published through merged pull request/);
        assert.match(JSON.stringify(attempt), /1570/);
        assert.equal(h.store.listDeliveries(runId).length, 1);
        assert.equal(h.store.runSummary(runId)?.actionWait, null);
        const [parent, continuation] = h.store.listSubmissions(runId);
        assert.ok(parent && continuation);
        assert.equal(WorkflowContextSnapshotSchema.parse(parent.context).evidence.transcript.length, 0,
          "the prompted completion preceded the action response");
        assert.ok(WorkflowContextSnapshotSchema.parse(continuation.context).evidence.transcript
          .some(message => message.role === "assistant" && message.content === report),
        "the continuation captures the session's post-delivery no-publication report");
      }
    } finally { await h.stop(); }
  });
}

for (const repeatPacket of [false, true]) test(`workflow delivery owns only its consumed prompt, human repeats packet=${repeatPacket}`, async () => {
  const { forgetInjections } = await import("../src/server/injections.ts");
  const h = await harness(`prompt-receipt-${repeatPacket}`, { pullRequest: true });
  try {
    const runId = await runToAction(h);
    await waitFor(() => h.store.listDeliveries(runId).some(d => d.state === "delivered"), "no delivered action");
    const delivery = h.store.listDeliveries(runId).find(d => d.state === "delivered")!;
    h.reportPrompt(delivery.payload);
    h.reportIdle();
    const episode = h.registry.recordedWorkEpisodeForSession(h.sessionId)!;
    assert.ok(episode.promptedAt);
    const restored = new WorkflowStore();
    const revision = h.registry.getGoal(h.sessionId)?.promptRevision ?? null;
    forgetInjections(h.sessionId);
    assert.equal(restored.deliveredActionOwnsPrompt(runId, h.sessionId, episode.episodeId, episode.promptedAt, revision), true,
      "the exact receipt survives loss of in-memory authorship and a store restart");
    assert.equal(restored.deliveredActionOwnsPrompt(runId, "other-session", episode.episodeId, episode.promptedAt, revision), false);
    h.reportPrompt(repeatPacket ? delivery.payload : "Now also handle X", episode.promptedAt);
    h.reportIdle();
    const followUp = h.registry.recordedWorkEpisodeForSession(h.sessionId)!;
    assert.equal(restored.deliveredActionOwnsPrompt(runId, h.sessionId, followUp.episodeId, followUp.promptedAt!,
      h.registry.getGoal(h.sessionId)?.promptRevision ?? null), false,
      "a later operator prompt cannot borrow the workflow's receipt");
  } finally { await h.stop(); }
});

for (const restart of [false, true]) for (const humanFollowUp of [false, true]) {
  test(`cancelled workflow settles only its own post-merge turn: restart=${restart}, human follow-up=${humanFollowUp}`, async () => {
    const { TaskManager } = await import("./helpers/task-manager-fixture.ts");
    const { mkTask } = await import("./helpers/session-fixture.ts");
    const { setShippingConfig } = await import("../src/server/shipping/config.ts");
    setShippingConfig({ closeSessionAfterMerge: false });
    const h = await harness(`settle-receipt-${restart}-${humanFollowUp}`, { pullRequest: true });
    const deps = { resetWouldDestroyWork: async () => null, kill: async () => ({ ok: true as const }),
      mergedPublicationCoversCheckout: async () => true };
    let tasks = new TaskManager(h.registry, deps);
    try {
      const taskId = `task-${h.sessionId}`;
      h.registry.upsertTask(mkTask({ id: taskId, kind: "plan", status: "running", sessionId: h.sessionId,
        worktreePath: null }));
      h.registry.bindTaskToWorkEpisode(taskId, h.sessionId);
      const runId = await runToAction(h);
      await waitFor(() => h.store.listDeliveries(runId).some(d => d.state === "delivered"), "no delivered action");
      const delivery = h.store.listDeliveries(runId).find(d => d.state === "delivered")!;
      const before = h.registry.recordedWorkEpisodeForSession(h.sessionId)!;
      h.registry.reconcilePrs(new Map([[h.sessionId, {
        url: "https://github.com/owner/repo/pull/1570", number: 1570, state: "merged" as const,
        checks: "passing" as const, branch: "feature", agentSessionId: `agent-${h.sessionId}`,
        episodeId: before.episodeId, createdAt: before.startedAt, mergedAt: Date.now(),
        headSha: h.full(h.head.sha), worktreeHeadSha: h.full(h.head.sha),
      }]]), new Set());
      h.reportPrompt(delivery.payload);
      assert.notEqual(h.registry.recordedWorkEpisodeForSession(h.sessionId)?.episodeId, before.episodeId);
      h.reportIdle();
      if (humanFollowUp) { h.reportPrompt("Now also handle X"); h.reportIdle(); }
      if (restart) await tasks.stop();
      assert.equal(h.manager.cancel(runId, `cancel-${h.sessionId}`).ok, true);
      if (restart) tasks = new TaskManager(h.registry, deps);
      if (humanFollowUp) {
        for (let i = 0; i < 10; i++) await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(h.registry.getTask(taskId)?.status, "running");
      } else {
        await waitFor(() => h.registry.getTask(taskId)?.status === "done", "workflow-owned merged task did not settle");
      }
    } finally { await tasks.stop(); await h.stop(); }
  });
}

test("historical merge lookup bounds Git concurrency and reaches a later page's matching publication", async () => {
  const { adoptInspectorPr } = await import("../src/server/db.ts");
  let active = 0;
  let peak = 0;
  const lookedUp = new Set<string>();
  const h = await harness("paged-historical-merges", { pullRequest: true, realLedger: true,
    resolveCommitTree: async (_root, oid) => {
      active++;
      peak = Math.max(peak, active);
      lookedUp.add(oid);
      await new Promise<void>(resolve => setImmediate(resolve));
      active--;
      return oid === h.full("historical-54") ? h.contentTree.oid : h.full("different-content");
    },
  });
  h.repository.branch = "paged-historical-merges";
  try {
    for (let i = 0; i < 55; i++) {
      adoptInspectorPr({ key: `paged/repo#${100 + i}`, owner: "paged", repo: "repo", number: 100 + i,
        url: `https://github.com/paged/repo/pull/${100 + i}`, sessionId: h.sessionId,
        repoRoot: h.repository.root, cwd: h.repository.root, headRefName: h.repository.branch,
        source: "hook", state: "closed", observedState: "MERGED", headSha: null,
        reviewPosture: "live", round: 1, lastReviewedAt: 1, lastError: null, failCount: 0,
        lastFailKind: null, nextAttemptAt: null, lastAttemptSha: null, mergedAt: 1,
        mergeBlock: null, title: "Historical publication", updatedAt: 1,
        observedHeadSha: h.full(`historical-${i}`), adoptedAt: 1, observedAt: 1 });
    }
    const runId = await runToAction(h);
    await waitFor(() => h.store.listDeliveries(runId).some(d => d.state === "delivered"), "no action delivery");
    const attemptId = waitingActionAttemptId(h, runId);
    h.runActionTurn();
    await h.manager.sweepSessionActions(SETTLED());
    await waitFor(() => h.store.getRun(runId)?.status === "completed", "later-page publication was lost");
    assert.ok(Array.from({ length: 55 }, (_, i) => h.full(`historical-${i}`))
      .every(oid => lookedUp.has(oid)), "every historical candidate remains eligible");
    assert.equal(peak, 1, "one action must not burst Git processes for its entire history");
    assert.match(JSON.stringify(h.store.getAttempt(attemptId)), /paged\/repo\/pull\/154/);
  } finally { await h.stop(); }
});

for (const proof of ["known", "unknown", "missing-review"] as const) {
  test(`historical publication tree reuse: ${proof}`, async (t) => {
    const { adoptInspectorPr, retargetInspectorPrCheckout } = await import("../src/server/db.ts");
    const warnings: string[] = [];
    t.mock.method(console, "warn", (...args: unknown[]) => warnings.push(args.join(" ")));
    const candidate = "a".repeat(40);
    let reads = 0;
    const h = await harness(`tree-cache-${proof}`, { pullRequest: true, realLedger: true,
      omitContentTree: proof === "missing-review",
      resolveCommitTree: async (_root, oid) => {
        if (oid !== candidate) return h.contentTree.oid;
        reads++;
        if (proof === "unknown") {
          if (reads === 1) throw Object.assign(new Error("private checkout detail"), { code: "ENOENT" });
          return h.contentTree.oid;
        }
        return h.full("different-tree");
      },
    });
    h.repository.branch = `tree-cache-${proof}`;
    const key = `cache-${proof}/repo#1`;
    try {
      adoptInspectorPr({ key, owner: `cache-${proof}`, repo: "repo", number: 1,
        url: `https://github.com/cache-${proof}/repo/pull/1`, sessionId: h.sessionId,
        repoRoot: h.repository.root, cwd: h.repository.root, headRefName: h.repository.branch,
        source: "hook", state: "closed", observedState: "MERGED", headSha: candidate,
        reviewPosture: "live", round: 1, lastReviewedAt: 1, lastError: null, failCount: 0,
        lastFailKind: null, nextAttemptAt: null, lastAttemptSha: null, mergedAt: 1,
        mergeBlock: null, title: "Cached publication", updatedAt: 1,
        observedHeadSha: candidate, adoptedAt: 1, observedAt: 1 });
      const runId = await runToAction(h);
      await waitFor(() => h.store.listDeliveries(runId).some(d => d.state === "delivered"), "no action delivery");
      h.runActionTurn();
      const firstProofRead = SETTLED();
      await h.manager.sweepSessionActions(firstProofRead);
      assert.equal(h.store.getRun(runId)?.status, "waiting_for_action");
      if (proof === "missing-review") {
        await h.manager.sweepSessionActions(firstProofRead + 60_000);
        assert.equal(h.store.runSummary(runId)?.actionWait, "awaiting_pull_request");
      }
      await h.manager.sweepSessionActions(SETTLED());
      assert.equal(reads, proof === "missing-review" ? 0 : 1);
      const failures = warnings.filter(line => line.includes("event=session_action_publication_tree_unavailable"));
      assert.equal(failures.length, proof === "unknown" ? 1 : 0, "failed lookups log once during their cooldown");
      if (proof === "unknown") {
        assert.ok(failures[0]?.includes(`call=${key}`));
        assert.match(failures[0]!, /error=ENOENT/);
        assert.doesNotMatch(failures[0]!, /private checkout detail/);
        await h.manager.sweepSessionActions(SETTLED() + 60_001);
        await waitFor(() => h.store.getRun(runId)?.status === "completed", "unknown tree must retry after it becomes available");
        assert.equal(reads, 2, "missing objects retry after their cooldown, not every sweep");
      } else if (proof === "known") {
        h.repository.root = "/different-checkout";
        assert.equal(retargetInspectorPrCheckout(key, h.repository.root, h.repository.root, Date.now()), true);
        await h.manager.sweepSessionActions(SETTLED());
        assert.equal(reads, 2, "the immutable tree cache is scoped to repository identity");
      }
    } finally { await h.stop(); }
  });
}

test("missing publication cooldown survives more candidates than the successful-tree cache holds", async () => {
  const { adoptInspectorPr } = await import("../src/server/db.ts");
  const candidates = new Set<string>();
  let reads = 0;
  let available = false;
  const h = await harness("missing-tree-overflow", { pullRequest: true, realLedger: true,
    resolveCommitTree: async (_root, oid) => {
      if (!candidates.has(oid)) return h.contentTree.oid;
      reads++;
      if (available && oid === h.full("missing-256")) return h.contentTree.oid;
      throw new Error("commit has not been fetched");
    },
  });
  h.repository.branch = "missing-tree-overflow";
  try {
    for (let i = 0; i < 257; i++) {
      candidates.add(h.full(`missing-${i}`));
      adoptInspectorPr({ key: `missing-overflow/repo#${1000 + i}`, owner: "missing-overflow", repo: "repo", number: 1000 + i,
        url: `https://github.com/missing-overflow/repo/pull/${1000 + i}`, sessionId: h.sessionId,
        repoRoot: h.repository.root, cwd: h.repository.root, headRefName: h.repository.branch,
        source: "hook", state: "closed", observedState: "MERGED", headSha: null,
        reviewPosture: "live", round: 1, lastReviewedAt: 1, lastError: null, failCount: 0,
        lastFailKind: null, nextAttemptAt: null, lastAttemptSha: null, mergedAt: 1,
        mergeBlock: null, title: "Unavailable publication", updatedAt: 1,
        observedHeadSha: h.full(`missing-${i}`), adoptedAt: 1, observedAt: 1 });
    }
    const runId = await runToAction(h);
    await waitFor(() => h.store.listDeliveries(runId).some(d => d.state === "delivered"), "no action delivery");
    h.runActionTurn();
    const now = SETTLED();
    await h.manager.sweepSessionActions(now);
    assert.equal(reads, 257);
    assert.equal(h.store.getRun(runId)?.status, "waiting_for_action");
    await h.manager.sweepSessionActions(now + 1);
    assert.equal(reads, 257, "all missing heads retain their cooldown across the next scan");
    available = true;
    await h.manager.sweepSessionActions(now + 60_001);
    await waitFor(() => h.store.getRun(runId)?.status === "completed", "the last candidate must retry after expiry");
    assert.equal(reads, 514, "expired misses retry, including the candidate beyond cache capacity");
  } finally { await h.stop(); }
});

test("overlapping sweep and Inspector observations share a pending publication-tree lookup", async (t) => {
  const { adoptInspectorPr } = await import("../src/server/db.ts");
  const candidate = "b".repeat(40);
  const root = "/repo/pending-publication";
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let treeReads = 0;
  let identityReads = 0;
  const errors = t.mock.method(console, "error");
  const options: HarnessOptions = { pullRequest: true, realLedger: true, resumptionSettleMs: 0,
    readRepositoryId: async value => { if (value === root) identityReads++; return value; },
    resolveCommitTree: async (_root, oid) => {
      if (oid === candidate) { treeReads++; await gate; }
      return h.contentTree.oid;
    },
  };
  const h = await harness("pending-publication", options);
  h.repository.root = root;
  h.repository.branch = "pending-publication";
  const key = "pending/repo#1";
  try {
    adoptInspectorPr({ key, owner: "pending", repo: "repo", number: 1,
      url: "https://github.com/pending/repo/pull/1", sessionId: h.sessionId,
      repoRoot: root, cwd: root, headRefName: h.repository.branch,
      source: "hook", state: "closed", observedState: "MERGED", headSha: candidate,
      reviewPosture: "live", round: 1, lastReviewedAt: 1, lastError: null, failCount: 0,
      lastFailKind: null, nextAttemptAt: null, lastAttemptSha: null, mergedAt: 1,
      mergeBlock: null, title: "Pending publication", updatedAt: 1,
      observedHeadSha: candidate, adoptedAt: 1, observedAt: 1 });
    const runId = await runToAction(h);
    await waitFor(() => h.store.listDeliveries(runId).some(d => d.state === "delivered"), "no action delivery");
    h.runActionTurn();
    const sweep = h.manager.sweepSessionActions(SETTLED());
    await waitFor(() => treeReads === 1, "the periodic sweep did not start its lookup");
    h.registry.inspectionUpdated(key, candidate, "MERGED");
    await waitFor(() => identityReads >= 2, "the background observation did not reach publication proof");
    for (let i = 0; i < 5; i++) await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(treeReads, 1, "the second observation must await the first lookup");
    const attempt = waitingAttempt(h, runId)!;
    options.beforeReadContext = async () => {
      // Also observe after reservation, while the sweep still holds the capture lock.
      h.registry.inspectionUpdated(key, candidate, "MERGED");
      await new Promise<void>(resolve => setImmediate(resolve));
    };
    release();
    await sweep;
    await h.settle();
    await waitFor(() => h.store.getRun(runId)?.status === "completed", "shared proof did not complete the action");
    assert.equal(h.store.getAttempt(attempt.id)?.state, "completed");
    const submissions = h.store.listSubmissions(runId);
    assert.equal(submissions.length, 2);
    const child = submissions[1]!;
    assert.equal(child.continuationNodeAttemptId, attempt.id);
    assert.deepEqual(h.store.listReceipts(child.id).filter(r => r.edgeId === "e-act").map(r => r.sourceAttemptId), [attempt.id]);
    assert.equal(h.store.listEvents(runId).filter(e => e.kind === "session_action_completed").length, 1);
    assert.doesNotMatch(errors.mock.calls.map(c => c.arguments.join(" ")).join("\n"), /session_action_continuation_failed/);
  } finally { release(); await h.stop(); }
});


test("a shared capture rejection releases the reserved child for retry on the same manager", async (t) => {
  const { adoptInspectorPr } = await import("../src/server/db.ts");
  const options: HarnessOptions = { pullRequest: true, realLedger: true, resumptionSettleMs: 0 };
  const h = await harness("shared-capture-retry", options);
  h.repository.root = "/repo/shared-capture-retry";
  h.repository.branch = "shared-capture-retry";
  const errors = t.mock.method(console, "error");
  try {
    const runId = await runToAction(h);
    await waitFor(() => h.store.listDeliveries(runId).some(d => d.state === "delivered"), "no action delivery");
    const attempt = waitingAttempt(h, runId)!;
    const key = "retry/repo#1";
    const head = h.full(h.head.sha);
    const now = Date.now();
    adoptInspectorPr({ key, owner: "retry", repo: "repo", number: 1,
      url: "https://github.com/retry/repo/pull/1", sessionId: h.sessionId,
      repoRoot: h.repository.root, cwd: h.repository.root, headRefName: h.repository.branch,
      source: "hook", state: "open", observedState: "OPEN", headSha: head,
      reviewPosture: "live", round: 1, lastReviewedAt: null, lastError: null, failCount: 0,
      lastFailKind: null, nextAttemptAt: null, lastAttemptSha: null, mergedAt: null,
      mergeBlock: null, title: "Shared capture retry", updatedAt: now,
      observedHeadSha: head, adoptedAt: now, observedAt: now });
    h.runActionTurn();

    // Both observers need the reserved capture's result. Lose access to the run while
    // reading evidence, so even the capture error handler cannot read its durable status.
    // This rejects the shared promise instead of returning a classified capture result.
    const reservations = t.mock.method(h.store, "reserveSessionActionContinuation");
    options.beforeReadContext = async () => {
      h.registry.inspectionUpdated(key, head, "OPEN");
      await new Promise<void>(resolve => setImmediate(resolve));
      t.mock.method(h.store, "getRun", () => {
        throw new DOMException("Run temporarily unreadable", "NotReadableError");
      });
    };
    await h.manager.sweepSessionActions(SETTLED());
    await h.settle();
    assert.equal(reservations.mock.callCount(), 1, "the observers must share one capture");
    const observerErrors = errors.mock.calls.filter(c => c.arguments.join(" ").includes(
      `event=session_action_observe_failed call=${attempt.id} error=NotReadableError`,
    ));
    assert.equal(observerErrors.length, 2, "both observers must report the rejected capture");

    t.mock.restoreAll();
    delete options.beforeReadContext;
    const reserved = h.store.latestSubmission(runId)!;
    assert.equal(reserved.status, "capturing");
    assert.equal(reserved.continuationNodeAttemptId, attempt.id);
    assert.equal(h.store.listReceipts(reserved.id).length, 0);
    await h.manager.sweepSessionActions(SETTLED());

    assert.equal(h.store.getRun(runId)?.status, "completed");
    assert.equal(h.store.getAttempt(attempt.id)?.state, "completed");
    assert.deepEqual(h.store.listSubmissions(runId).map(s => s.id), [attempt.submissionId, reserved.id]);
    assert.deepEqual(h.store.listReceipts(reserved.id).filter(r => r.edgeId === "e-act").map(r => r.sourceAttemptId), [attempt.id]);
    assert.equal(h.store.listEvents(runId).filter(e => e.kind === "session_action_completed").length, 1);
  } finally {
    t.mock.restoreAll();
    await h.stop();
  }
});

test("cancelling a session action during continuation capture reports the conflict", async (t) => {
  const options: HarnessOptions = {};
  const h = await harness("cancel-continuation-capture", options);
  const errors = t.mock.method(console, "error");
  try {
    const runId = await runToAction(h);
    await waitFor(() => h.store.listDeliveries(runId).some(d => d.state === "delivered"), "no action delivery");
    const attempt = waitingAttempt(h, runId)!;
    options.beforeReadContext = () => { h.manager.cancel(runId, "cancel-during-capture"); };
    h.runActionTurn();
    await h.manager.sweepSessionActions(SETTLED());
    assert.equal(h.store.getRun(runId)?.status, "cancelled");
    assert.ok(errors.mock.calls.some(c => c.arguments.join(" ").includes(
      `event=session_action_continuation_failed call=${attempt.id} error=conflict`,
    )));
    assert.equal(h.store.listEvents(runId).some(e => e.kind === "session_action_completed"), false);
  } finally { await h.stop(); }
});

for (const proof of ["verified", "missing-base", "missing-tree"] as const) test(`an unchanged PR action releases sibling feedback with ${proof} proof`, async () => {
  const h = await harness(`no-change-queue-${proof}`, { pullRequest: true, unchangedRepository: true,
    omitContentTree: proof === "missing-tree",
    unchangedRepositoryProblem: proof === "missing-base" ? "The default base could not be resolved." : undefined });
  try {
    h.repository.branch = null;
    const runId = await runToAction(h);
    await waitFor(() => h.store.listDeliveries(runId).some(d => d.state === "delivered"), "action not sent");
    const attempt = waitingAttempt(h, runId)!;
    const parent = h.store.latestSubmission(runId)!;
    const binding = h.store.getBinding(h.store.getRun(runId)!.bindingId)!;
    const sibling = h.store.insertBinding({ ...binding, id: `no-change-sibling-${proof}`, sessionId: h.sessionId, repoRoot: "/sibling",
      sessionCwd: "/sibling", sessionRepoRoot: "/sibling", now: Date.now() });
    h.setVerdict(() => "fail");
    const submitted = await h.manager.submit(sibling.id, { requestId: "sibling-feedback" });
    assert.ok(submitted.ok, JSON.stringify(submitted));
    const siblingRun = submitted.value.run.id;
    await waitFor(() => h.store.listDeliveries(siblingRun).length > 0, "sibling feedback not prepared");
    const packet = h.store.listDeliveries(siblingRun)[0]!;
    assert.equal(h.store.getDelivery(packet.id)?.state, "prepared");
    assert.equal(h.store.conversationDeliveryHold(packet)?.runId, runId);
    await h.manager.sweepSessionActions(SETTLED());
    assert.equal(h.store.getAttempt(attempt.id)?.state, "waiting", "pre-pickup idle is not completion");
    h.runActionTurn();
    const firstProofRead = SETTLED();
    await h.manager.sweepSessionActions(firstProofRead);
    if (proof !== "verified") {
      assert.equal(h.store.runSummary(runId)?.actionWait, "awaiting_proof");
      await h.manager.sweepSessionActions(firstProofRead + 15_000);
      await h.manager.stop();
      h.manager.start();
      await h.manager.sweepSessionActions(firstProofRead + 59_999);
      const state = h.store.sessionActionState(h.store.getAttempt(attempt.id)!);
      assert.equal(state?.wait, "awaiting_proof", "a transient read must retain its grace period across restart");
      assert.equal(state?.settledAt, firstProofRead, "later sweeps must not reset the retry deadline");
      await h.manager.sweepSessionActions(firstProofRead + 60_000);
    }
    await h.settle();
    assert.equal(h.store.getAttempt(attempt.id)?.state, proof === "verified" ? "completed" : "error");
    if (proof === "verified") {
      assert.equal((h.store.getAttempt(attempt.id)!.output as { expectation: { kind: string } }).expectation.kind, "no_change");
    } else {
      assert.ok(h.store.runSummary(runId)?.recovery?.operations.includes("resubmit"));
      const detail = h.store.sessionActionState(h.store.getAttempt(attempt.id)!)?.blocked?.detail;
      assert.match(detail ?? "", proof === "missing-base" ? /default base/ : /accepted content tree/);
    }
    assert.equal(h.store.latestSubmission(runId)?.round, parent.round);
    assert.equal(h.store.conversationDeliveryHold(packet), null);
    assert.equal(h.store.getDelivery(packet.id)?.state, "delivered");
    await h.manager.sweepSessionActions(SETTLED());
    assert.equal(h.store.listSubmissions(runId).length, proof === "verified" ? 2 : 1, "no duplicate continuation");
  } finally { await h.stop(); }
});

test("proof retry starts on a new failure, resets on recovery, and allows a delayed PR adoption", async () => {
  const options: HarnessOptions = { pullRequest: true };
  const h = await harness("transient-pr-proof", options);
  try {
    const runId = await runToAction(h);
    await waitFor(() => h.store.listDeliveries(runId).some(d => d.state === "delivered"), "action not sent");
    const attempt = waitingAttempt(h, runId)!;
    h.runActionTurn();
    const first = SETTLED();
    await h.manager.sweepSessionActions(first);
    assert.equal(h.store.runSummary(runId)?.actionWait, "awaiting_pull_request");
    options.unchangedRepositoryProblem = "Git timed out";
    await h.manager.sweepSessionActions(first + 120_000);
    assert.equal(h.store.runSummary(runId)?.actionWait, "awaiting_proof", "an old settled turn gets a fresh read retry window");
    options.unchangedRepositoryProblem = undefined;
    await h.manager.sweepSessionActions(first + 120_001);
    assert.equal(h.store.runSummary(runId)?.actionWait, "awaiting_pull_request");
    options.unchangedRepositoryProblem = "HEAD changed while reading";
    await h.manager.sweepSessionActions(first + 240_000);
    assert.equal(h.store.sessionActionState(h.store.getAttempt(attempt.id)!)?.settledAt, first + 240_000);
    h.adoptPr();
    await h.manager.sweepSessionActions(first + 240_001);
    await waitFor(() => h.store.getRun(runId)?.status === "completed", "late adoption did not complete during proof retry");
    assert.equal(h.injected.length, 1, "retry must never repeat the action instruction");
  } finally { await h.stop(); }
});

test("known changed detached work completes after adoption arrives on a later sweep", async () => {
  const h = await harness("detached-changed-pr", { pullRequest: true });
  try {
    h.repository.branch = null;
    h.head.sha = "detached-ahead";
    const runId = await runToAction(h);
    await waitFor(() => h.store.listDeliveries(runId).some(d => d.state === "delivered"), "action not sent");
    h.runActionTurn();
    const now = SETTLED();
    await h.manager.sweepSessionActions(now);
    await h.manager.sweepSessionActions(now + 120_000);
    assert.equal(h.store.runSummary(runId)?.actionWait, "awaiting_pull_request");
    h.adoptPr();
    await h.manager.sweepSessionActions(now + 120_001);
    await waitFor(() => h.store.getRun(runId)?.status === "completed", "late detached adoption did not complete");
    assert.equal(h.store.listSubmissions(runId).length, 2);
    assert.equal(h.injected.length, 1);
  } finally { await h.stop(); }
});


for (const changed of [false, true]) test(`missing accepted-tree proof allows late adoption with known changed work=${changed}`, async () => {
  const h = await harness(`missing-accepted-tree-adoption-${changed}`, { pullRequest: true, omitContentTree: true, unchangedRepository: !changed });
  try {
    h.repository.branch = null;
    h.head.sha = "detached-ahead";
    const runId = await runToAction(h);
    await waitFor(() => h.store.listDeliveries(runId).some(d => d.state === "delivered"), "action not sent");
    h.runActionTurn();
    const now = SETTLED();
    await h.manager.sweepSessionActions(now);
    const later = now + (changed ? 120_000 : 59_999);
    await h.manager.sweepSessionActions(later);
    assert.equal(h.store.runSummary(runId)?.actionWait, changed ? "awaiting_pull_request" : "awaiting_proof");
    h.adoptPr();
    await h.manager.sweepSessionActions(later);
    await waitFor(() => h.store.getRun(runId)?.status === "completed", "late adoption with missing accepted tree did not complete");
    assert.equal(h.store.listSubmissions(runId).length, 2);
    assert.equal(h.injected.length, 1);
  } finally { await h.stop(); }
});


test("clean checkout returned to base completes when adoption arrives on a later sweep", async () => {
  const h = await harness("returned-to-base-adoption", { pullRequest: true, unchangedRepository: true });
  try {
    const runId = await runToAction(h);
    await waitFor(() => h.store.listDeliveries(runId).some(d => d.state === "delivered"), "action not sent");
    // Publication can finish before its adoption hook arrives, with the checkout back on main.
    h.repository.branch = "main";
    h.head.sha = "base-head";
    h.contentTree.oid = h.full("base-tree");
    h.runActionTurn();
    const now = SETTLED();
    await h.manager.sweepSessionActions(now);
    await h.manager.sweepSessionActions(now + 59_999);
    assert.equal(h.store.runSummary(runId)?.actionWait, "awaiting_proof");
    h.adoptPr();
    await h.manager.sweepSessionActions(now + 59_999);
    await waitFor(() => h.store.getRun(runId)?.status === "completed", "late adoption after checkout returned to base did not complete");
    assert.equal(h.store.listSubmissions(runId).length, 2);
    assert.equal(h.injected.length, 1);
  } finally { await h.stop(); }
});

test("a short active turn between sweeps resets proof retry without replacing pickup", async (t) => {
  const h = await harness("short-proof-retry", { pullRequest: true, resumptionSettleMs: 0,
    unchangedRepositoryProblem: "Git timed out" });
  try {
    const runId = await runToAction(h);
    await waitFor(() => h.store.listDeliveries(runId).some(d => d.state === "delivered"), "action not sent");
    let clock = Date.now() + 1_000;
    t.mock.method(Date, "now", () => clock++);
    h.runActionTurn();
    const first = clock;
    await h.manager.sweepSessionActions(first);
    const attemptId = waitingAttempt(h, runId)!.id;
    const initial = h.store.sessionActionState(h.store.getAttempt(attemptId)!)!;
    assert.equal(initial.wait, "awaiting_proof");
    clock = first + 60_001;
    h.runActionTurn(); // Both lifecycle events occur before the next sweep.
    const afterActivity = h.store.sessionActionState(h.store.getAttempt(attemptId)!)!;
    assert.equal(afterActivity.wait, "working");
    assert.equal(afterActivity.settledAt, null);
    assert.deepEqual(afterActivity.anchor, initial.anchor);
    assert.equal(afterActivity.pickedUpAt, initial.pickedUpAt);
    const restarted = clock;
    await h.manager.sweepSessionActions(restarted);
    await h.manager.sweepSessionActions(restarted + 59_999);
    const retried = h.store.sessionActionState(h.store.getAttempt(attemptId)!)!;
    assert.equal(retried.wait, "awaiting_proof");
    assert.equal(retried.settledAt, restarted, "idle sweeps retain the new deadline");
    assert.equal(h.store.listEvents(runId).filter(e => e.kind === "session_action_picked_up").length, 1);
    await h.manager.sweepSessionActions(restarted + 60_000);
    assert.equal(h.store.getRun(runId)?.status, "blocked", "a new turn must not remove the retry bound");
    assert.equal(h.injected.length, 1);
  } finally { await h.stop(); }
});

for (const publication of ["none", "adopted", "candidate"]) test(`Inspector completion policy handles no-change continuation with PR=${publication}`, async () => {
  const h = await harness(`no-change-inspector-${publication}`, { pullRequest: true, unchangedRepository: true, inspector: true });
  try {
    const runId = await runToAction(h);
    await waitFor(() => h.store.listDeliveries(runId).some(d => d.state === "delivered"), "action not sent");
    h.runActionTurn();
    if (publication === "adopted") h.adoptPr();
    if (publication === "candidate") {
      h.registry.applyHook({ agent: "claude", event: "PostToolUse", sessionId: `agent-${h.sessionId}`,
        cwd: "/repo", transcriptPath: null, env: { tmuxPane: `%${h.sessionId.length}` },
        prUrl: "https://github.com/owner/repo/pull/8", prCreated: true });
      h.reportIdle();
      assert.equal(h.registry.getSession(h.sessionId)?.prUrl, "https://github.com/owner/repo/pull/8");
    }
    await h.manager.sweepSessionActions(SETTLED());
    await h.settle();
    assert.equal(h.store.getRun(runId)?.status, publication === "none" ? "completed" : "waiting_for_pr");
    assert.equal(h.store.listEvents(runId).some(e => e.kind === "inspector_gate_entered"), publication !== "none");
    assert.equal(h.store.listSubmissions(runId).length, 2);
  } finally { await h.stop(); }
});

for (const retryAge of [null, 5_000, 60_000]) test(`activity during proof read discards a stale sweep: retry age ${retryAge}`, async (t) => {
  let hold: { started: () => void; released: Promise<void> } | null = null;
  let release: (() => void) | undefined;
  let pending: Promise<void> | undefined;
  const h = await harness(`concurrent-proof-${retryAge}`, { pullRequest: true, resumptionSettleMs: 0,
    readUnchangedRepository: async () => {
      if (hold) { hold.started(); await hold.released; }
      throw new Error("Git timed out");
    } });
  try {
    const runId = await runToAction(h);
    await waitFor(() => h.store.listDeliveries(runId).some(d => d.state === "delivered"), "action not sent");
    let clock = Date.now() + 1_000;
    t.mock.method(Date, "now", () => clock++);
    h.runActionTurn();
    const first = clock;
    if (retryAge !== null) await h.manager.sweepSessionActions(first);
    const attemptId = waitingAttempt(h, runId)!.id;
    let started!: () => void;
    const reading = new Promise<void>(resolve => { started = resolve; });
    hold = { started, released: new Promise<void>(resolve => { release = resolve; }) };
    clock = first + (retryAge ?? 0);
    pending = h.manager.sweepSessionActions(clock);
    await reading;
    h.runActionTurn(); // This whole turn occurs while the earlier observation is awaiting Git.
    const restarted = clock;
    release!();
    await pending;
    const state = h.store.sessionActionState(h.store.getAttempt(attemptId)!)!;
    assert.equal(h.store.getRun(runId)?.status, "waiting_for_action");
    assert.equal(state.wait, "working", "stale proof must not overwrite newer lifecycle state");
    assert.equal(state.settledAt, null);
    hold = null;
    await h.manager.sweepSessionActions(restarted);
    const retry = h.store.sessionActionState(h.store.getAttempt(attemptId)!)!;
    assert.equal(retry.wait, "awaiting_proof");
    assert.equal(retry.settledAt, restarted);
    await h.manager.sweepSessionActions(restarted + 60_000);
    assert.equal(h.store.getRun(runId)?.status, "blocked");
  } finally { release?.(); await pending; await h.stop(); }
});

for (const prompt of ["pane", "review"] as const) for (const outcome of ["complete", "block"] as const) {
  test(`${prompt} prompt during proof read prevents ${outcome} until the operator answers`, async () => {
    let hold: { started: () => void; released: Promise<void> } | null = null;
    let release: (() => void) | undefined;
    let pending: Promise<void> | undefined;
    const h = await harness(`proof-prompt-${prompt}-${outcome}`, { pullRequest: true,
      readUnchangedRepository: async () => {
        if (hold) { hold.started(); await hold.released; }
        if (outcome === "block") throw new Error("Git timed out");
        return null;
      } });
    const setPrompt = (open: boolean) => {
      if (prompt === "pane") {
        h.registry.applyDiscovery([{ ...discovered(h.sessionId), paneDialog: open ? {
          prompt: "Continue?", options: [{ number: 1, label: "Yes" }], highlighted: 1,
        } : null }]);
      } else {
        h.registry.upsertReview({ id: `question-${h.sessionId}`, sessionId: h.sessionId,
          kind: "input", title: "Continue?", body: "Continue?", status: open ? "pending" : "answered",
          response: open ? null : "Yes", createdAt: 1, resolvedAt: open ? null : 2 });
      }
    };
    try {
      const runId = await runToAction(h);
      await waitFor(() => h.store.listDeliveries(runId).some(d => d.state === "delivered"), "action not sent");
      h.runActionTurn();
      const first = SETTLED();
      if (outcome === "block") await h.manager.sweepSessionActions(first);
      else h.adoptPr();
      const attemptId = waitingAttempt(h, runId)!.id;
      const before = h.registry.getSession(h.sessionId)!;
      let started!: () => void;
      const reading = new Promise<void>(resolve => { started = resolve; });
      hold = { started, released: new Promise<void>(resolve => { release = resolve; }) };
      pending = h.manager.sweepSessionActions(first + 60_000);
      await reading;
      setPrompt(true);
      const asking = h.registry.getSession(h.sessionId)!;
      assert.equal(asking.state, before.state);
      assert.equal(asking.lastActivity, before.lastActivity, "operator gates can change without lifecycle activity");
      release!();
      await pending;
      assert.equal(h.store.getRun(runId)?.status, "waiting_for_action");
      assert.equal(h.store.sessionActionState(h.store.getAttempt(attemptId)!)?.wait, "needs_operator");
      assert.equal(h.store.listSubmissions(runId).length, 1, "no continuation can capture through the operator gate");
      hold = null;
      setPrompt(false);
      h.adoptPr();
      await h.manager.sweepSessionActions(first + 60_001);
      await waitFor(() => h.store.getRun(runId)?.status === "completed", "answering the prompt should allow publication to complete");
      assert.equal(h.injected.length, 1);
    } finally { release?.(); await pending; await h.stop(); }
  });
}
