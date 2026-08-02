# Multi-Agent Ensembles: Best-of-N First

Status: implementation-ready investigation\
Date: 2026-07-23\
Source idea: docs/plans/feature-ideas/plan.html from the brainstorming checkout\
Workflow compatibility audit: main at 57ea5bc, with Workflow Phases 1–3 implemented\
Recommended foundation: one versioned Ensemble engine; first strategy is 2–5 isolated
implementation candidates, one tool-less comparative evaluator, and human-confirmed promotion

## Executive recommendation

Build a reusable Ensemble orchestration layer above the existing Task and Dispatcher machinery.
Ship Best-of-N as its first versioned strategy, not as the name or schema of the engine. Do not make
an Ensemble another Task status or a node inside the new Workflow graph.

Each participating agent should still be a normal Task. That preserves all of the hard-won behavior
around harness selection, worktree provisioning, terminal launch, session discovery, hooks,
cost capture, cancellation, and restart reconciliation. A generic EnsembleRun owns group-level
facts that a Task cannot express: a versioned strategy snapshot, launch waves, member roles,
information-sharing rules, submitted artifacts, evaluations, advancement decisions, budgets,
terminal outcomes, and idempotent cleanup.

The implemented Workflow design changes the integration point, not that ownership boundary. A Workflow is
deliberately a review/repair loop over exactly one selected Session. An ensemble is the preceding
exploration/selection stage over N Sessions. They should compose at promotion: N candidates become
one exact winning Session, then an optional immutable Workflow version binds to and immediately
reviews that winner. This preserves Workflow's one-Session context, delivery, Foreman, Inspector,
Reset, and Shipping invariants.

For the Best-of-N strategy, the critical product safety decision is that the comparative evaluator
recommends; it does not promote.
An operator sees the evidence and confirms a winner. Promotion then keeps or rematerializes
that candidate at its exact submitted snapshot and reaps the other worktrees. Loser evidence
remains recoverable through private Git refs until the ensemble is explicitly deleted.

The first release should implement only the Best-of-N strategy, with implementation candidates,
default three and maximum five. The underlying persistence, API, events, session projection, and
execution loop should already use Ensemble/Member/Artifact/Stage/Evaluation vocabulary. It should
offer an optional published Workflow Preview handoff through the implemented Phase 3 engine after
the external-source compatibility slice in this plan lands. Live delivery and Foreman-triggered
repair remain disabled until Workflow Phase 4. It should not run
arbitrary repository commands, open candidate pull requests, auto-promote, treat an idle hook as
completion, or expose a general-purpose user-authored orchestration language before the primitives
have been proven.

## What changed since the brainstorm

The brainstorming file got the opportunity right: dispatch already creates isolated
worktrees and the Board already puts sessions side by side. It also identified useful
ranking inputs such as tests, diff size, and review notes. The current checkout has since
added foundations that make the feature stronger:

The implemented Workflow contracts make this separation load-bearing:

- exactly one Session node exists in every published graph;
- bindings and capture locks use one durable noteKey;
- every submission has one session context/evidence snapshot;
- capture already records headSha, workingTreeDirty, repository fingerprints, and a stable
  before/after boundary;
- feedback delivery has one terminal target;
- Foreman claims one session completion;
- Inspector pins one adopted PR/head; and
- Reset removes one session-scoped workflow family.

An Ensemble node would force all seven contracts to become multi-subject and would turn finalization into
an implicit graph mutation. Ensemble therefore keeps its own store and lifecycle, reuses Persona,
review-prompt, model-runner, and scheduling primitives, and calls a narrow WorkflowManager handoff
only after a human selects one winner.

## Product contract

### Operator flow

### Release decisions

These are resolved design decisions, not launch-time configuration questions.

## Comparison and collaboration patterns worth supporting

Best-of-N is only one point in a larger design space. The engine should not assume that every run
launches all members at once, compares all artifacts in one prompt, selects exactly one, or even
ends with a winner.

| Strategy pattern | Launch shape | Information topology | Evaluation and terminal result | New primitive beyond Best-of-N |
|---|---|---|---|---|
| Best-of-N | Fixed roster, usually 2–5 | Isolated | One comparative rank; select one | First-release baseline |
| Deterministic gate then rank | Fixed roster | Isolated | Tests/static evidence eliminate ineligible artifacts; rank survivors | Evaluator pipeline and eligibility filter |
| Persona panel vote | Fixed roster plus M headless judges | Isolated candidates; independent judges | Approval/ranking aggregation, disagreement visible | Parallel evaluator panel and vote aggregation |
| Pairwise tournament | Fixed roster, potentially larger N | Isolated | Bracket, Swiss, or round-robin pair comparisons; select top one/K | Pair scheduler and accumulated standings |
| Successive halving | Fixed or matrix roster in waves | Isolated | Cheap first evaluation, advance top fraction to deeper work/review | Multiple waves and top-K advancement |
| Adaptive sampling | Start small; add batches until stop rule or hard cap | Isolated | Stop on sufficient agreement/margin or exhaust budget | Deterministic strategy driver and spawn-more command |
| Critique then revise | N proposals, cross-assigned critiques, one revision round | Artifact-mediated sharing only | Compare revised artifacts; select one/K | Feedback delivery, revision artifact, bounded rounds |
| Proposer–critic–verifier | Role roster rather than identical candidates | Directed artifact visibility | Verifier accepts, rejects, or requests bounded repair | Role-specific prompts and directed dependencies |
| Red-team / defender | One builder plus one or more adversarial reviewers | Reviewers see builder artifact; builder sees bounded findings | Patched artifact plus residual-risk report | Role topology and repair loop |
| Top-K synthesis | N proposals, then a fresh synthesizer | Synthesizer sees selected artifacts | Produce a new combined artifact rather than choosing an original | Synthesis member and derived-artifact lineage |
| Consensus / no-consensus | N independent answers | Optional blind voting | Return agreement, minority report, or no consensus; retain all | Non-destructive terminal outcome |
| Map–reduce | Role/shard roster | Shards isolated; reducer sees all outputs | One synthesized result; comparison may be absent | Different task intents and report artifacts |

The first six are natural comparison strategies. The latter patterns show why the core must use
member, artifact, evaluation, stage, and outcome rather than candidate, diff, judge, and winner as
its only durable nouns.

### How many agents to launch

Make launch count a strategy policy, separate from evaluator and finalization:

    type LaunchPolicy =
      | { kind: "fixed_roster"; members: MemberTemplate[] }
      | { kind: "replicated"; template: MemberTemplate; count: number }
      | { kind: "matrix"; axes: MemberAxis[]; repetitions: number }
      | {
          kind: "adaptive_waves";
          initial: MemberTemplate[];
          batch: MemberTemplate[];
          maxMembers: number;
          stop: StopPolicy;
        }
      | { kind: "roles"; roles: Array<{ role: string; count: number; template: MemberTemplate }> };

Total launches and concurrent launches are different controls. Every strategy snapshot carries:

- maxMembers: hard lifetime cap, including retries/replacements;
- maxConcurrentMembers: local process/worktree ceiling;
- maxWaves and maxStageAttempts;
- optional wall-clock deadline;
- a visible estimated launch count/range before confirmation;
- cost as advisory unless every participating harness reports authoritative live cost.

Best-of-N version 1 validates fixed_roster with 2–5 members. A future tournament may allow eight
with concurrency four. Adaptive sampling may show 2–8 and start only two. No strategy driver may
spawn past the persisted hard caps, even if an LLM asks it to.

### Information topology is explicit

Default informationPolicy is isolated: members receive the shared task, their own role/approach,
and no sibling identities or artifacts. A strategy that needs critique or synthesis declares a
directed artifact-sharing policy. The daemon renders bounded, attributed prompts from immutable
artifacts; agents do not browse sibling worktrees or private refs.

This separates useful collaboration from accidental filesystem visibility and makes every
cross-member influence visible in the run timeline.

## Reusable Ensemble strategy model

### Compose policies, do not multiply run types

An immutable strategy recipe composes seven independent questions:

    interface EnsembleStrategyRecipe {
      launch: LaunchPolicy;
      information: InformationPolicy;
      artifact: ArtifactPolicy;
      stages: EnsembleStageSpec[];
      stop: StopPolicy;
      finalization: FinalizationPolicy;
      memberWorkflow: MemberWorkflowPolicy;
    }

| Policy | Answers | Best-of-N v1 |
|---|---|---|
| LaunchPolicy | Which roles/configurations start, in which waves, under what caps? | Fixed explicit roster of 2–5 |
| InformationPolicy | Which immutable artifacts may each member see? | Isolated |
| ArtifactPolicy | What counts as a submission and how is it snapshotted/compared? | Git working-tree snapshot |
| Stage plan | In what order do collect, evaluate, advance, revise, synthesize, and decide occur? | Spawn → collect-all → compare-all → await decision |
| StopPolicy | When is there enough evidence, and what happens on failures/timeouts? | All members settled; at least two eligible |
| FinalizationPolicy | Select one/K, synthesize, retain all, or return no consensus? | Human-confirmed select one and reap others |
| MemberWorkflowPolicy | Does a one-Session Workflow review each member, the selected result, or neither? | Optional Workflow after selection |

Invalid combinations fail at creation. Examples: pairwise evaluation needs at least two comparable
artifacts; a pre-comparison member Workflow cannot include an Inspector final gate because
candidates may not create N PRs; synthesis requires an artifact adapter the synthesizer can read;
and top-K finalization cannot feed a handoff that requires exactly one Session.

### Versioned strategy registry

Put append-only built-in ids in src/shared/ensemble.ts:

    export const ENSEMBLE_STRATEGY_IDS = [
      "best_of_n",
      // append future persisted ids
    ] as const;

Split browser-safe description from daemon execution:

    interface EnsembleStrategyDescriptor<C> {
      id: EnsembleStrategyId;
      latestVersion: number;
      label: string;
      description: string;
      configSchema: ZodType<C>;
      defaults: C;
      form: StrategyFormSpec;
      capabilities: StrategyCapabilities;
      summarize(config: C): LaunchEstimate;
    }

    interface EnsembleStrategyCompiler<C> {
      id: EnsembleStrategyId;
      version: number;
      compile(config: C, context: CreationContext): EnsembleExecutionPlan;
    }

    interface EnsembleStrategySnapshot {
      id: EnsembleStrategyId;
      version: number;
      label: string;
      config: EnsembleJson;
      plan: EnsembleExecutionPlan;
      capabilities: StrategyCapabilities;
      launchEstimate: LaunchEstimate;
    }

Use Record<EnsembleStrategyId, ...> for both registries, following the Harness/LLM/terminal
registry pattern. A new strategy id fails typecheck until it describes its configuration, launch
estimate, capabilities, compiler, and tests. Existing ids and versions are append-only because
durable runs reference them.

The compiled execution plan is snapshotted into EnsembleRun. Runtime recovery executes generic
stage primitives from that plan; it does not recompile with newer defaults. A compiler version can
therefore evolve without changing an active or historical run.

If a strategy needs an adaptive driver, store driverKey as id@version in the plan and keep a
separate append-only runtime registry for every persisted driver version. Removing an old driver
while a nonterminal run references it is a startup health error, not permission to invoke the
latest driver. Fixed plans need no strategy-specific runtime after compilation.

### Small durable stage vocabulary

Start with a deliberately bounded union and append primitives only when a real strategy requires
them:

    type EnsembleStageSpec =
      | { kind: "spawn"; launch: LaunchPolicy }
      | { kind: "collect"; artifact: ArtifactPolicy; barrier: BarrierPolicy }
      | { kind: "evaluate"; evaluator: EvaluatorPolicy; subjects: SubjectPolicy }
      | { kind: "advance"; selection: AdvancementPolicy }
      | { kind: "feedback"; assignment: FeedbackAssignment; maxRounds: number }
      | { kind: "synthesize"; actor: MemberTemplate; inputs: SubjectPolicy }
      | { kind: "decision"; decision: DecisionPolicy }
      | { kind: "finalize"; finalization: FinalizationPolicy };

This is not arbitrary JavaScript or a second React Flow builder. Every primitive has bounded Zod
configuration, durable input/output, idempotency rules, and a generic renderer. Best-of-N needs
spawn, collect, evaluate, decision, and finalize. Tournament later adds repeated evaluate/advance;
critique adds feedback; top-K synthesis adds synthesize.

### Deterministic engine, optional adaptive driver

EnsembleEngine executes the immutable plan and owns generic scheduling, transactions, recovery,
events, and side-effect ordering. Most strategies compile to a fixed stage plan.

Adaptive strategies may additionally register a pure driver:

    interface EnsembleStrategyDriver {
      decide(snapshot: EnsembleDecisionSnapshot): EnsembleCommand[];
    }

Allowed commands are a closed union such as spawnWave, scheduleEvaluation, advanceMembers,
requestFeedback, requestHumanDecision, finalize, or fail. The engine validates each command against
the plan and hard budgets, persists a deterministic command key before side effects, and then acts.
The driver receives validated durable summaries only and performs no I/O. An LLM result may be
evidence to a driver, never executable commands by itself.

### Pluggable artifact and evaluator contracts

Do not bake Git diffs into every member:

    interface ArtifactAdapter {
      kind: EnsembleArtifactKind;
      capture(member: EnsembleMember): Promise<CapturedArtifact>;
      summarize(artifact: CapturedArtifact): ArtifactSummary;
      materializeForEvaluation(artifact: CapturedArtifact, budget: number): EvaluationMaterial;
      restore?(artifact: CapturedArtifact): Promise<Task>;
    }

First implement git_snapshot. Later adapters can add markdown_report, structured_answer, or plan
without changing member/stage tables. Artifact kind ids and persisted format versions are
append-only.

EvaluatorPolicy is likewise a union:

- deterministic evidence gate;
- one all-at-once comparative LLM;
- pairwise LLM;
- independent Persona panel plus aggregation;
- human-only decision;
- hybrid pipeline with deterministic filters before model judgment.

Evaluations always record subject artifact ids, evaluator snapshot/version, actual runner/model,
bounded inputs, structured output, provenance, and attempt state. Scores and ranks belong to
evaluation results, not EnsembleMember, because one artifact may participate in several panels,
pairs, rounds, or rubrics.

### What adding a strategy should cost

After the kernel exists, a normal built-in strategy should require:

1. Append one strategy id and descriptor/config schema/defaults.
2. Compose existing policies and stages in one compiler.
3. Add a generic-form description or, only when necessary, one focused config panel.
4. Add pure compiler/validation fixtures and engine scenario tests.
5. Add README copy and a preset card.

It should not require a database migration, new HTTP route family, new ServerEvent variant, a
useEventStream branch, new session props, or new layout-specific mark vocabulary. A proposed mode
that needs those surfaces is evidence that it introduces a genuinely new primitive, not merely a
new strategy.

## End-to-end architecture

    flowchart LR
      UI[Dispatch: strategy plus configuration] -->|POST /api/ensembles| SM[EnsembleManager]
      SM -->|snapshot strategy plan, budgets, base| DB[(SQLite)]
      SM --> ENG[EnsembleEngine]
      ENG -->|spawn stage creates members| TM[TaskManager]
      TM --> D[Dispatcher]
      D --> W1[Member Task 1]
      D --> W2[Member Task 2]
      D --> WN[Member Task N or later wave]
      W1 -->|submit_candidate_result| SNAP[Artifact adapter]
      W2 -->|submit_candidate_result| SNAP
      WN -->|submit_candidate_result| SNAP
      SNAP -->|immutable artifacts and evidence| DB
      DB --> EVAL[Evaluation stages]
      EVAL -->|ranking, vote, advancement, synthesis| DETAIL[Ensemble detail]
      DETAIL -->|human confirms winner| P[Finalization transaction]
      P --> KEEP[Keep or rematerialize exact winner]
      P --> REAP[Cancel and reap losers]
      KEEP --> WH{Workflow handoff pinned?}
      WH -->|no| NORMAL[Normal Task and shipping flow]
      WH -->|yes| WM[WorkflowManager: bind and submit]
      WM --> WR[One-session Persona repair loop]
      WR --> IG[Optional Inspector final gate]
      IG --> NORMAL

Boundary rules:

- EnsembleManager owns creation, policy, and external adapters. EnsembleEngine owns generic durable
  stages and listens to Task changes. TaskManager remains the owner of individual Task transitions.
- Dispatcher accepts a pinned base override but does not learn Ensemble semantics.
- Artifact adapters own capture/materialization. The first git_snapshot adapter uses the private
  Git snapshot helper.
- Evaluators receive supplied evidence only. The Best-of-N model evaluator has no repository,
  shell, network, GitHub, or terminal tools.
- WorkflowManager receives only the finalized session, pinned version, expected snapshot SHA, and an
  idempotency source key. It never reads ensemble tables or ranks members.
- SQLite remains single-writer state. Git refs preserve large artifacts; SQLite stores
  metadata and verdicts, not full patches.

## Workflow integration contract

### Compatibility audit against Workflow Preview at 57ea5bc

The Ensemble architecture is compatible with the Workflow engine that is now on main, but the
handoff cannot call the current browser-oriented methods unchanged. The audit found these exact
seams:

| Shipped Workflow contract | Compatibility result | Required Ensemble-facing change |
|---|---|---|
| Published graphs accept only Session, Persona, all-pass Join, and End, and validation requires exactly one Session | Compatible | Keep the graph union and validators unchanged; do not add an Ensemble node |
| workflow_bindings has one active owner per note_key, and WorkflowManager resolves live Session/noteKey identity | Compatible with an additive seam | Add one transactional external claim that creates or returns the same binding; never bypass the active-note conflict |
| WorkflowManager.submit creates manual:&lt;binding&gt;:&lt;request&gt; keys, while WorkflowStore currently writes trigger_source = manual in both run and submission inserts | Requires refactoring before handoff | Make trigger source/key explicit store inputs, preserve manual at existing call sites, and append ensemble as a source |
| Stable capture retries once across Session, noteKey, HEAD, repository fingerprint, and transcript boundary; the context includes headSha and workingTreeDirty | Strong reusable base | Add an external capture expectation and require both the selected snapshot SHA and a clean working tree before evidence is persisted or an LLM starts |
| WorkflowEngine owns a per-engine concurrency-three limiter; context compaction calls runJobStructured outside that limiter | Not yet a shared daemon budget | Inject one daemon-owned review scheduler into Workflow review/compaction and Ensemble evaluation while leaving the separate Foreman process and unrelated background jobs alone |
| WorkflowRunDetail has no source relation, and WorkflowTab/hash routing is a closed workflows/personas/runs union | Additive UI work | Join an optional external source in Run detail and append Ensembles list/detail routes to the existing shell |
| resetForNoteKey deletes the complete binding/run family | Compatible only if the new relation participates | Delete external claims with their binding during Workflow Reset; retain Ensemble audit/ref history and render a missing linked run as reset/removed |

This is a local extension of the shipped Phase 3 boundary. It does not reopen graph execution,
Persona verdicts, recovery, SSE ownership, or Preview semantics.

### The Best-of-N cardinality boundary

For Best-of-N, treat promotion as an explicit N-to-one boundary:

| Before promotion: Ensemble owns | After promotion: Workflow owns |
|---|---|
| N Tasks, sessions, worktrees, candidate prompts, and costs | One active binding and one selected Session |
| One pinned base and N immutable snapshot refs | One immutable Workflow version and per-round evidence snapshots |
| Comparative score/rank/recommendation | Persona pass/fail verdicts and repair feedback |
| Candidate withdrawal and loser teardown | Session repair, resubmission, and round limits |
| No PR creation or shipping | Optional Inspector final gate and Shipping veto |

An Ensemble terminal outcome does not mean the work is approved or shipped. Workflow completion does not
retroactively choose a different candidate. The Ensemble detail links to the Workflow run, and the
Workflow run links back to its source ensemble, but each engine remains authoritative for its own
states.

Other strategies may finalize to top K, a newly synthesized Task, retained independent results, or
no consensus. Only a finalization that materializes exactly one live Session can request the
post-selection Workflow handoff described below. This is expressed as a strategy capability and
validated at creation rather than assumed by EnsembleRun.

### Why Ensemble is not a Workflow node

The shipped Workflow contracts intentionally compile against only Session, Persona, all-pass Join, and
End nodes. Adding Ensemble to that union would not be a cosmetic palette addition. It would require:

- multiple note keys and session identities in one binding;
- a multi-subject WorkflowContextSnapshot;
- candidate launch, completion, and snapshot ports;
- fan-in that selects a mutable delivery target rather than aggregates verdicts;
- Reset and reattach rules across N sessions;
- multiple potential PRs before one Inspector gate; and
- new Shipping semantics while the graph still has no selected session.

That is a second orchestration engine hidden inside the review engine. Keep the Phase 2 graph union
and its negative no-extra-node tests unchanged. A future guided builder can display an Ensemble-to-
Workflow composition as two linked products without storing it as one graph.

### Compatibility changes required in the shipped Workflow engine

Land these changes as a focused compatibility slice before Ensemble Workflow handoff:

1. Replace the hand-written WorkflowTriggerSource union with an append-only
   WORKFLOW_TRIGGER_SOURCES tuple and append ensemble. Do not add it to WorkflowTriggerMode: Manual
   and Foreman-complete are recurring binding behavior, while ensemble is the server-owned source
   of one initial submission.
2. Add a generic workflow_binding_claims table with non-null source_kind, source_key, source_id,
   binding_id, and created_at. source_key is the primary key and binding_id is unique. source_id is
   display/deep-link identity; consumers never parse the opaque idempotency key. Delete claims in
   the existing resetForNoteKey transaction before deleting their bindings.
3. Parameterize WorkflowRunInsert, WorkflowSubmissionInsert, createInitialSubmission, and the
   submission insert helper with triggerSource. Existing manual manager methods explicitly pass
   manual, preserving their current keys and stored rows byte-for-byte.
4. Add WorkflowStore.ensureExternalBindingClaim as one transaction, then add
   WorkflowManager.ensureExternalBinding and WorkflowManager.submitExternal. They resolve the live
   Session/noteKey server-side and reuse immutable version validation, active-note conflicts, stable
   capture, engine activation, recovery, and SSE publication.
5. submitExternal accepts a capture expectation containing expectedHeadSha and
   requireCleanWorktree: true. Check both after stable capture and before raw evidence persistence or
   compaction. A mismatch blocks visibly. A retry after Ensemble restores the artifact resumes the
   same initial external submission; it never creates a second binding, run, or round.
6. Introduce a daemon-owned review scheduler and inject it from src/server/index.ts. Workflow
   context compaction, Workflow Persona attempts, and Ensemble evaluator calls share it. Do not make
   createLimiter module-global: Foreman is a separate process, and unrelated daemon background jobs
   have different degradation and latency contracts.
7. Factor reusable intent-priority wording, untrusted-evidence fencing, and field/byte-cap helpers
   out of Workflow-specific prompt code. Workflow Persona calls and the Ensemble comparator use
   those helpers; their prompts and output schemas remain distinct.
8. Keep WorkflowContextSnapshot session-shaped. Generalizing it to N candidates or a synthetic
   artifact subject is unnecessary for the winner handoff.
9. Extend Workflow Run detail with an optional external source kind/id link and extend the closed
   WorkflowTab/MissionRoute union with Ensembles list/detail variants. Compact run summaries remain
   unchanged unless a source badge proves necessary.

Suggested pure/shared seams:

    src/shared/review.ts
    src/server/review/prompt.ts
    src/server/llm/review-scheduler.ts
    src/server/workflows/external-binding.ts

The binding claim transaction resolves the winner session and noteKey server-side. If an active
binding already owns that noteKey, it returns a typed conflict; it never replaces or silently adopts
the existing binding. WorkflowManager should receive a narrow binding-eligibility guard from
EnsembleManager so active ensemble members refuse ordinary manual binding until the compiled
MemberWorkflowPolicy allows it. Workflow modules do not import the Ensemble store.

### Pinned handoff

Ensemble creation may include:

    interface EnsembleWorkflowHandoff {
      workflowId: WorkflowId;
      workflowVersionId: WorkflowVersionId;
      workflowVersion: number;
      workflowName: string;
      bindingDefaults: WorkflowBindingDefaults;
      completionPolicy: WorkflowCompletionPolicy;
      state: "pending" | "binding" | "submitted" | "failed";
      sourceKey: string | null;
      expectedHeadSha: string | null;
      requireCleanWorktree: true;
      bindingId: WorkflowBindingId | null;
      runId: WorkflowRunId | null;
      error: string | null;
    }

Resolve this from an immutable published version at ensemble creation and store the display snapshot in
the new ensemble row. Reject an archived definition, missing version, unsupported binding mode, or Live
delivery that is not currently authorized for repoRoot. Never replace Live with Preview silently.

At promotion, derive the source key entirely server-side:

    ensemble:<ensemble-id>:result:<member-or-artifact-id>:workflow:<version-id>

ensureExternalBinding and submitExternal use that same key. A response loss or daemon restart
returns the existing binding/run. Ensemble finalization reaches completed after the handoff
submission is durably captured and activated, not after the Workflow completes. Before activation,
stable capture must observe expectedHeadSha and a clean working tree; matching HEAD with uncommitted
changes is not the selected artifact.

If no Workflow is selected, nothing changes in Workflow state. The operator can still bind one
later through the normal UI.

### Optional Workflows per member

The generic MemberWorkflowPolicy reserves a future before_comparison mode:

- Each member remains a normal one-Session Workflow binding/run.
- The member is eligible to submit its comparison artifact only after the pinned Workflow reaches
  its configured terminal outcome.
- Pre-comparison Workflows must use completionPolicy none; an Inspector gate would require N
  candidate PRs and violate candidate publishing/provenance rules.
- The external binding source key includes ensemble, member, and Workflow version.
- Evaluation consumes the member's final immutable artifact plus Workflow verdict evidence.

Best-of-N version 1 implements only after_selection. before_comparison should ship only after the
normal Workflow engine is proven and the N-times Persona cost/concurrency is explicit in the launch
estimate. This composes multiple one-Session Workflows without turning the Workflow graph itself
multi-session.

### Persona reuse without conflating verdicts

The ensemble comparator may use one active Persona as optional judging guidance. Snapshot its exact
revision at ensemble creation, just as Publish snapshots Persona nodes. The shared intent/evidence
contract remains above that Markdown.

Do not execute PersonaVerdict for comparison. Workflow Personas answer pass/fail about one subject;
the Best-of-N comparator must rank all eligible artifacts in one typed BestOfNComparisonResult. Resolve blank
runner/model overrides through the same Persona ladder at attempt time and record the actual values
used. This matches Workflow retry semantics while preserving exact guidance.

Do not use the selected Workflow's Persona nodes automatically as the comparator. That would make
the cost N times the graph width, mix pass/fail with ranking, and activate repair/Inspector semantics
before there is a winner. A future evaluation-only Workflow mode can be designed from real demand.

### Workflow phase impact matrix

| Workflow phase | Status in this checkout | Ensemble impact |
|---|---|---|
| Phase 1 — foundation/Personas | Implemented | Reuse PersonaSnapshot, model ladders, table parsing discipline, Workflows page shell, and existing front-loaded run family. Add no Persona fork. The new binding-claim table can be created normally because it is a new table. |
| Phase 2 — builder/publishing | Implemented | No graph/schema/port change. Keep exactly one Session and the negative no-Ensemble-node contract. Published versions are already the immutable handoff target. Append Ensembles route awareness to the shell only. |
| Phase 3 — preview engine | Implemented | Reuse its binding conflict, stable capture, evidence, engine, retry/recovery, SSE, Reset, and Run detail paths. Add the external claim/source, clean exact-snapshot expectation, shared daemon review scheduler, and source deep link as the Phase 0A compatibility slice. |
| Phase 4 — live/Foreman | Implementation-ready | An ensemble starts only the first submission. If the pinned binding uses Foreman, later repair completion still travels through the planned Foreman claim endpoint. Live delivery repeats global/per-binding/repo consent; Ensemble adds no terminal delivery path. |
| Phase 5 — Inspector gate | [See phase owner](../workflow-builder/phase-5-inspector-gate.md) | Candidate prompts forbid PRs before promotion. After handoff, the Workflow's normal adopted-PR, fresh-observation, exact-head, finding, and Shipping-veto rules apply. Ensemble never adopts, polls, posts, pushes, or merges. |
| Phase 6 — hardening | Implementation-ready | Keep Workflow and Ensemble model-call ledgers and retention families distinct, but present linked totals honestly. Workflow retention never removes ensemble refs; Ensemble refs remain manual-delete in v1. Add ensemble transitions to the shared alert engine rather than a separate notifier. |

Phase 0A must now change implemented code rather than a future Phase 3 plan. Keep it additive and
prove that manual Preview behavior, stored manual trigger identity, restart recovery, and Reset are
unchanged while the external path enters through the same engine.

## Durable data model

Add shared wire types in src/shared/ensemble.ts and a store under
src/server/ensembles/store.ts. Use new tables rather than columns on tasks, so no migration
addColumn calls are needed.

### EnsembleRun

    type EnsembleStatus =
      | "planning"
      | "running"
      | "waiting"
      | "evaluating"
      | "awaiting_decision"
      | "finalizing"
      | "completed"
      | "cancelled"
      | "failed";

    interface EnsembleRun {
      id: string;
      requestId: string;
      strategy: EnsembleStrategySnapshot;
      title: string;
      intent: string;
      repoRoot: string;
      baseSha: string;
      baseBranch: string | null;
      status: EnsembleStatus;
      activeStageId: string | null;
      budget: EnsembleBudgetSnapshot;
      outcome: EnsembleOutcome | null;
      workflowHandoff: EnsembleWorkflowHandoff | null;
      error: string | null;
      createdAt: number;
      updatedAt: number;
      completedAt: number | null;
      members: EnsembleMemberSummary[];
      stageSummaries: EnsembleStageSummary[];
    }

request_id must be NOT NULL UNIQUE. The UI creates a stable UUID for one submission and
reuses it on retries. This prevents a response-loss retry from launching another N agents.
All columns used by a UNIQUE or ON CONFLICT target must be non-null.

strategy contains the append-only strategy id/version, validated config, compiled primitive plan,
capabilities, and display summary. A run never reloads current registry defaults to recover.

### EnsembleMember

    type EnsembleMemberStatus =
      | "launching"
      | "active"
      | "submitted"
      | "reviewing"
      | "advanced"
      | "eliminated"
      | "failed"
      | "withdrawn"
      | "retained";

    interface EnsembleMember {
      id: string;
      ensembleId: string;
      ordinal: number;
      wave: number;
      role: string;
      parentMemberId: string | null;
      taskId: string;
      agent: AgentType;
      requestedModel: string | null;
      requestedEffort: string | null;
      observedModel: string | null;
      approach: string | null;
      inputArtifactIds: string[];
      status: EnsembleMemberStatus;
      workflowBindingId: string | null;
      workflowRunId: string | null;
      error: string | null;
      createdAt: number;
      updatedAt: number;
    }

The member row snapshots identity and launch configuration. taskId remains historical even if the
Task is later removed. Adaptive strategies may append later waves, so ordinal is stable creation
order rather than a promise that all members existed at run creation.

Do not store score, rank, diff, or one winner directly on a member. Those facts belong to artifacts,
evaluations, and the terminal outcome and may occur several times.

### EnsembleArtifact

    interface EnsembleArtifact {
      id: string;
      ensembleId: string;
      memberId: string;
      parentArtifactIds: string[];
      kind: EnsembleArtifactKind;
      formatVersion: number;
      attempt: number;
      status: "capturing" | "ready" | "failed" | "superseded";
      locator: EnsembleArtifactLocator;
      summary: string;
      reportedClaims: string[];
      observedEvidence: EnsembleObservedEvidence;
      fingerprint: string;
      createdAt: number;
      readyAt: number | null;
    }

For git_snapshot, locator contains snapshot SHA/ref, base SHA, diff summary, and truncation metadata.
For a later report artifact it may contain a bounded content/blob locator instead. Artifact
adapters validate their own versioned locator union.

### Stage attempts, evaluations, and outcome

    interface EnsembleStageAttempt {
      id: string;
      ensembleId: string;
      stageId: string;
      stageKind: EnsembleStageSpec["kind"];
      attempt: number;
      state: "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";
      input: EnsembleJson;
      output: EnsembleJson | null;
      commandKey: string;
      error: string | null;
      createdAt: number;
      updatedAt: number;
    }

    interface EnsembleEvaluation {
      id: string;
      ensembleId: string;
      stageAttemptId: string;
      method: EvaluatorPolicy["kind"];
      subjectArtifactIds: string[];
      evaluatorSnapshot: EnsembleJson;
      result: EnsembleJson | null;
      state: "queued" | "running" | "succeeded" | "failed" | "interrupted";
      createdAt: number;
      updatedAt: number;
    }

    type EnsembleOutcome =
      | { kind: "selected"; memberIds: string[]; artifactIds: string[]; materializedTaskId: string | null }
      | { kind: "synthesized"; memberId: string; artifactId: string; materializedTaskId: string | null }
      | { kind: "retained"; memberIds: string[]; artifactIds: string[] }
      | { kind: "no_consensus"; artifactIds: string[]; reason: string };

For Best-of-N, the comparative guidance is snapshotted inside the evaluate stage's
evaluatorSnapshot. The typed result contains recommendation, rank, scores, strengths, risks,
rationale, confidence, and caveats. Other strategies may store pair verdicts, vote ballots,
eligibility reports, standings, or synthesis provenance without widening EnsembleMember.

### SQLite tables

Add ensemble_runs, ensemble_members, ensemble_artifacts, ensemble_stage_attempts,
ensemble_evaluations, ensemble_llm_calls, ensemble_events, and the generic
workflow_binding_claims table inside openDb. Keep comments in that SQL block free of backticks.
Store structured fields as JSON using the same parsing discipline as Tasks and Workflows.
Suggested constraints:

- ensemble_runs.request_id is NOT NULL UNIQUE.
- ensemble_members.ensemble_id plus ordinal is NOT NULL UNIQUE.
- ensemble_members.task_id is NOT NULL UNIQUE.
- ensemble_artifacts.ensemble_id, member_id, kind, attempt are NOT NULL UNIQUE.
- ensemble_stage_attempts.ensemble_id, stage_id, attempt are NOT NULL UNIQUE.
- ensemble_stage_attempts.command_key is NOT NULL UNIQUE.
- ensemble_evaluations.stage_attempt_id plus a non-null evaluation key is NOT NULL UNIQUE.
- ensemble_llm_calls has non-null ensemble_id, purpose, runner_id, model_id, attempt, and timestamps;
  monetary cost remains nullable and authoritative-only.
- workflow_binding_claims has non-null source_kind, source_key, source_id, binding_id, and
  created_at; source_key is the primary key and binding_id is unique.
- Foreign-key deletion should not cascade through Tasks. Ensemble history outlives task cleanup.
- Full patches are never stored in SQLite or sent in the SSE snapshot.

The handoff snapshot and its binding/run ids live in ensemble_runs JSON/columns because that table is
new. Do not add ensemble columns to workflow_bindings. The generic claim table is the Workflow-owned
idempotency seam for this and future external orchestrators.

## State machines and invariants

    stateDiagram-v2
      [*] --> planning
      planning --> running: compiled plan and first wave durable
      planning --> failed: invalid/unlaunchable plan
      running --> waiting: barrier or member input
      waiting --> running: input/member completion
      running --> evaluating: evaluation stage ready
      evaluating --> running: advance, feedback, or later wave
      evaluating --> failed: evaluator retries exhausted
      evaluating --> awaiting_decision: strategy requests human authority
      running --> finalizing: automatic non-destructive terminal
      awaiting_decision --> finalizing: human confirms outcome
      finalizing --> completed: artifacts/tasks exact and cleanup/handoff durable
      finalizing --> finalizing: restart or side-effect retry
      planning --> cancelled
      running --> cancelled
      waiting --> cancelled
      evaluating --> cancelled
      awaiting_decision --> cancelled
      completed --> [*]
      cancelled --> [*]
      failed --> [*]

Required invariants:

- An EnsembleRun with its immutable strategy/config/compiled plan and hard budgets is persisted
  before any member Task is created.
- Every member input is explicit: run base SHA or immutable parent artifact ids. Best-of-N members
  all verify the same run base; a synthesis/revision member may deliberately start from an artifact.
- Every member in one launch wave is persisted in backlog before the first Task in that wave is
  dispatched. Adaptive later waves append members without rewriting earlier ordinals.
- At most one member row points at a Task, and every Task is owned by at most one active Ensemble.
- Artifact attempts are immutable. Repeated identical submissions return the prior artifact;
  conflicting repeats require a new attempt or are rejected by strategy policy.
- A ready artifact always has a validated versioned locator, fingerprint, observed evidence, and
  readyAt.
- A stage starts only when its persisted dependency/barrier predicate is true.
- An evaluation contains every and only its declared ready subject artifacts, never live worktrees.
- Scores, ranks, votes, and eligibility never mutate member identity; each result stays attached to
  its evaluation attempt.
- A driver command is accepted only if its deterministic commandKey is new, the compiled plan
  permits it, and every hard budget remains satisfied.
- An LLM output can supply evidence but cannot directly spawn members, send feedback, select, reap,
  publish, or finalize.
- Any destructive finalization requires human confirmation, regardless of strategy.
- completed is not persisted until the declared terminal artifacts/tasks are exact, cleanup is
  complete, and any selected Workflow handoff is durable.
- A Workflow handoff has one immutable version and one stable source key; restart cannot bind or
  submit it twice.
- Workflow capture for a handoff requires HEAD equal to the selected artifact snapshot SHA and a
  clean working tree.
- No automatic transition deletes a restorable artifact ref.

Best-of-N adds strategy-specific validation: fixed roster 2–5, at least two eligible ready
git_snapshot artifacts, one validated comparative result containing each eligible artifact once,
rank 1 recommendation, human selection of an eligible artifact, and select-one finalization.

Use database transactions for every aggregate transition. Side effects are handled with the
persist-before-act pattern: persist a stage attempt/command and finalization intent, perform
idempotent Task/Git/terminal/Workflow operations, then persist the result. A daemon restart can
safely resume the middle state.

## Pinned-input dispatch

Current worktree provisioning uses current HEAD or a Treehouse pool lease at the moment of
each dispatch. N calls can therefore diverge if the source checkout moves or a warm lease
has a different head.

### Creation preflight

Before inserting the EnsembleRun:

1. Canonicalize and validate repoRoot using the existing repository policy.
2. Resolve git rev-parse HEAD^{commit} once and store the full SHA.
3. Record the display branch separately; it is informational.
4. Parse the selected strategy id/version/config and compile its immutable execution plan.
5. Resolve every distinct initial member agent binary and validate model/effort combinations.
6. Validate artifact/evaluator/finalization/Workflow capability compatibility and hard budgets.
7. Fail without launching anything if the repository, plan, or all required harnesses are invalid.

Partial launch remains possible after preflight because processes can fail. Persist every member
Task in the current wave first, then dispatch through the plan's maxConcurrentMembers ceiling.
Strategy barriers decide whether enough members/artifacts remain to continue.

### Dispatcher seam

Add an internal DispatchOptions object:

    interface DispatchOptions {
      defaultModel?: string;
      baseSha?: string;
      launchMcp?: MissionMcpLaunchConfig;
    }

TaskManager.dispatch passes it to Dispatcher. Normal dispatch omits baseSha and keeps
existing behavior. An Ensemble member with run-base input requires it. A later revision/synthesis
member may instead receive a verified artifact commit selected by its stage input.

Extend provisionWorktree with an optional pinned base:

- Git fallback: git worktree add PATH -b BRANCH BASE_SHA.
- Treehouse lease: verify the lease belongs to the same repository, then reset the worktree
  and branch to BASE_SHA and remove nonignored untracked files before prompt injection.
- Preserve intentionally ignored warm dependencies. Do not use a clean mode that erases
  ignored caches.
- Re-read HEAD after provisioning and reject the member if it is not exactly its persisted input
  commit.

This is a mechanism change in dispatcher/worktree code. Ensemble policy remains in
EnsembleManager.

### Role-aware member prompt

Generate a harness-neutral member appendix from the compiled strategy/stage and append it to the
ordinary Task intent. Best-of-N version 1 says:

- This is candidate ordinal of total in ensemble id.
- Work independently from the pinned base and follow the optional approach hint.
- Implement and test the complete task.
- Do not inspect sibling worktrees or ensemble refs.
- Do not push, create a PR, or run the shipping gate.
- When the work is ready for comparison, call submit_candidate_result with a concise summary
  and the checks actually run.
- Do not claim checks that were not run.

Sibling isolation is behavioral, not a security boundary. Worktrees and private refs share
one Git repository, and a local agent can discover them. The UI and docs must not describe
the members as adversarially isolated.

Critique/synthesis strategies add only server-rendered, stage-authorized input artifacts to this
appendix. Member prompts never expose ref namespaces or invite arbitrary sibling discovery.

## Explicit submission and immutable snapshots

### Why hooks are insufficient

Add submit_candidate_result as an MCP tool and a matching manual Submit result action in
the Ensemble detail. The MCP request contains summary and checks, but never a caller-supplied
ensemble/member/artifact id. The compiled stage decides which ArtifactAdapter captures the result.

The daemon attributes the request using the authenticated MCP environment, session id, and
working directory:

1. Resolve the live session through the same attribution boundary used by other MCP calls.
2. Resolve its current Task.
3. Find the active member row whose taskId matches.
4. Reject if the session, cwd, Task, or ensemble state does not match.
5. Ask the stage's ArtifactAdapter to capture and validate.
6. Persist the immutable artifact first; only then mark the member submitted and wake barriers.

This prevents one member from submitting a sibling by guessing its id. The initial tool shape is
intentionally a readiness signal plus bounded claims; future artifact adapters can extend the
duplicated protocol schema with a discriminated, strategy-authorized result payload.

### Launch-scoped MCP availability

Submission must work even if an operator did not previously install the Mission MCP
integration.

- Claude: reuse the existing launch-scoped mcp-config mechanism used by the ask channel.
- Codex: add launch overrides for mcp_servers.mission-control.command, args, and env. A local
  probe against Codex 0.145.0 confirmed that repeated -c TOML overrides register a per-launch
  MCP server.
- Build one shared launch-scoped Mission MCP descriptor so the command, token, session
  attribution, and server path cannot drift between harnesses.
- Keep the existing global integration behavior unchanged for normal sessions.

The MCP argument schema must be implemented twice, in src/shared/protocol.ts and
src/mcp/server.ts, because that duplication is an existing contract.

### git_snapshot adapter

Do not commit through the member's real index or mutate its branch merely to evaluate it.
Create an immutable commit through a temporary Git index:

1. Create a temporary index path.
2. Set GIT_INDEX_FILE only for the snapshot subprocesses.
3. git read-tree HEAD.
4. git add -A from the member worktree. This includes tracked changes and untracked,
   nonignored files.
5. git write-tree.
6. git commit-tree TREE -p HEAD with a generated local message.
7. git update-ref refs/mission-control/ensembles/ENSEMBLE_ID/ARTIFACT_ID COMMIT.
8. Delete the temporary index in a finally block.
9. Re-read the ref and commit before persisting submission.

Use the existing argument-array process runner, never a shell command. Ref components are
generated UUIDs, not user text.

The algorithm preserves the member's real staged/unstaged split and HEAD. It captures
the complete submitted worktree. Add tests for tracked, staged, unstaged, deleted, renamed,
and untracked files, and prove that the real index is byte-for-byte unchanged.

### Exact Git artifact diff

Compare baseSha directly with snapshotSha. Do not route this through the existing explicit
source ancestry guard: a member may amend or rebase before submission, while the
snapshot commit is still an exact artifact. The new helper should emit:

- file list and add/delete counts,
- binary markers,
- full patch up to a configured per-artifact budget,
- truncation flag and omitted byte count,
- snapshot and base ids.

The Ensemble detail fetches materialized artifact evidence on demand. For git_snapshot this is an
exact diff endpoint. SSE carries only
the small summary.

### Evidence provenance

Record evidence in separate fields and label it in the UI and prompt:

The first release does not execute an arbitrary validation command. A follow-up can add
repo-owned evaluation profiles with an explicit command, timeout, sandbox policy, and
artifact contract.

## Best-of-N comparative evaluator

### Input assembly

The best_of_n v1 compiler emits one all-at-once comparative evaluate stage after every member is
submitted, failed, or withdrawn. Require at least two eligible ready git_snapshot artifacts.

Build one evidence packet with:

Anonymize agent, model, and member ordinal in the evaluator input. Those attributes are
useful to the operator but invite brand and order bias. The mapping back to artifact/member ids
stays server-side.

Cap total patch input at approximately 400 KiB for the first implementation and
allocate it evenly across eligible artifacts. Always retain file-level statistics and a
truncation disclosure. Reject rather than silently evaluating an artifact with no usable diff
or evidence.

### Rubric

The built-in guidance should rank in this order:

1. Correctness against the task and acceptance criteria.
2. Strength of observed evidence and quality of relevant reported checks.
3. Maintainability, clarity, and fit with repository conventions.
4. Scope discipline, regression surface, and security risk.
5. Diff size as a tie-breaker, never a smallest-diff-wins rule.

The evaluator should explicitly surface uncertainty caused by truncation, missing tests, binary
changes, or incomparable approaches.

### Execution boundary

Use the provider-neutral LlmRunner structured-call path with a fresh context and no tools. Schedule
the call through the daemon review scheduler introduced in Phase 0A, so Workflow context
compaction, Persona attempts, and an Ensemble evaluator cannot independently exceed the local
concurrency budget.
Do not give the evaluator a repository path, shell, web, GitHub, or terminal access. Candidate
diffs are untrusted input and may contain prompt injection. Delimit each evidence object as
data with the shared review fence, repeat that instructions in candidate content are not
executable, and validate all output through Zod.

Suggested result:

    interface BestOfNComparisonResult {
      recommendedArtifactId: string;
      comparison: string;
      caveats: string[];
      subjects: Array<{
        artifactId: string;
        score: number;
        rank: number;
        strengths: string[];
        risks: string[];
        rationale: string;
        confidence: number;
      }>;
    }

After parsing:

- require exactly the eligible artifact ids, each once;
- require integer scores from 0 through 100;
- require unique contiguous ranks;
- require confidence from 0 through 1;
- require the recommendation to exist and have rank 1;
- cap text and array lengths before persistence and SSE;
- map anonymous labels back only after validation.

Insert an ensemble_llm_calls row before each call and finalize actual runner/model, duration, byte
counts, outcome, and nullable authoritative cost afterward. An invalid or interrupted result marks
the evaluation attempt failed and exposes bounded retry; infrastructure failure never becomes a
ranking. Retry uses the same immutable subjects and evaluator snapshot.

## Finalization, cleanup, and recoverability

Every strategy declares a FinalizationPolicy and terminal EnsembleOutcome. Any finalization that
resets a branch, types a continuation, creates a Workflow binding, cancels members, reaps
worktrees, publishes, or deletes requires explicit human confirmation. Model recommendations,
panel votes, test scores, and strategy drivers remain advisory.

### Best-of-N select-one transaction

1. In one database transaction, verify awaiting_decision, persist a selected outcome intent and
   status finalizing, and clear prior cleanup errors.
2. Verify that the selected ready artifact ref still resolves to its snapshot SHA.
3. If the winning Task, session, and worktree are live, return that branch to the exact
   snapshot with a hard reset and removal of nonignored untracked files. Refuse if the
   session is actively running or waiting on an approval; retry when idle.
4. If the winner cannot be rebound after restart, create exactly one replacement normal
   Task from snapshotSha, store materializedTaskId, and launch it with a continuation prompt.
   requestId-derived identity prevents duplicate replacement Tasks.
5. Cancel every loser Task through TaskManager so terminal and worktree teardown remain
   centralized.
6. Persist retained/eliminated member states as each side effect succeeds.
7. If no Workflow handoff is pinned, inject a winner continuation message that includes the
   original task, candidate summary, caveats, and instruction to inspect and ship normally.
8. If a handoff is pinned, call ensureExternalBinding with the immutable version and stable source
   key, then submitExternal with expectedHeadSha equal to snapshotSha and requireCleanWorktree true.
   Persist bindingId/runId after each idempotent result. Do not send the generic shipping
   continuation before review.
9. Persist outcome selected and status completed only after the exact winner is available, all
   loser teardowns finish, and the optional initial Workflow submission is captured and activated.

If any side effect fails, remain in finalizing with an actionable error. Restart
reconciliation resumes the same steps. Never report completed while a loser still owns a
live worktree unless the store records an explicit retryable cleanup state.

Workflow execution is not part of finalizing. Once its initial submission exists, the engines
advance independently: the Ensemble is completed and the linked Workflow run may be running, waiting
for repair, blocked, at Inspector, completed, or cancelled. Cancelling/deleting old Ensemble history
must never cancel or prune the linked Workflow family.

### Snapshot retention

Finalization reaps worktrees only when its policy says so; it does not reap evidence. Keep every
restorable artifact ref after completion or cancellation. The UI exposes the ref and a Restore
member/result action can create a normal Task
from that commit.

Delete refs only through an explicit Delete ensemble/history action with confirmation. Do not
add time-based pruning in the first release; it would turn a cleanup optimization into a
data-loss policy without a storage budget or retention setting.

### Cancellation and withdrawal

- Cancel ensemble cancels all launching or active member Tasks through TaskManager.
- Submitted refs survive cancellation.
- Cancel member marks that member withdrawn after Task cleanup.
- Strategy eligibility decides how failed/withdrawn members affect barriers.
- For Best-of-N, if all work settles with fewer than two eligible artifacts, mark the ensemble
  failed with an explanation and offer Retry member, Restore result, or Cancel. Do not manufacture
  a competition from one artifact.

## API, MCP, and live events

### HTTP routes

Add zod schemas in src/shared/protocol.ts and route every mutating body through parseBody.

| Method | Route | Purpose |
|---|---|---|
| GET | /api/ensembles | Paginated run summaries |
| POST | /api/ensembles | Idempotently create and launch one ensemble |
| GET | /api/ensembles/:id | Full bounded members/stages/artifacts/evaluations detail |
| GET | /api/ensembles/:id/artifacts/:artifactId | Materialize evidence/diff on demand |
| POST | /api/ensembles/:id/members/:memberId/submit | Manual result submission fallback |
| POST | /api/ensembles/:id/actions | Generic parsed operator decision/retry/withdraw/cancel/restore action |
| DELETE | /api/ensembles/:id | Explicitly delete history and private refs after confirmation |

POST /api/ensembles accepts:

- requestId, title, intent, repoRoot, priority, labels, attachments;
- strategy id plus optional explicit version and validated strategy config;
- strategy config containing roster/matrix/adaptive launch policy and any evaluator Persona;
- optional compatible Workflow placement/version.

Server-generated ids remain authoritative. Attachments use the existing dispatch
serialization and are included consistently according to the compiled member prompt policy. The
daemon resolves referenced Personas and Workflows to immutable snapshots during creation; it does
not trust client-supplied bodies.

EnsembleActionSchema is a discriminated union of generic engine authorities such as retry_stage,
withdraw_member, decide, resolve_finalization, cancel, and restore_artifact. A new strategy composed
from existing primitives adds no route. A genuinely new operator authority extends this schema and
the one actions route.

### MCP route and tool

Add token-authenticated POST /mcp/ensemble/submit and tool
submit_candidate_result(summary, checks?). The transport request also contains server-supplied
session attribution. Mirror validation in the MCP server and shared protocol.

Return the artifact kind/fingerprint, Git short SHA when applicable, and a durable acknowledgement
so the agent can stop. Late calls after the member's collect barrier closes return the existing
artifact if identical or a clear state error.

### SSE and Registry

Add ensembleSummaries as a top-level collection:

- Registry.snapshot() includes ensembleSummaries.
- MissionState includes ensembleSummaries.
- ServerEvent adds ensemble_upsert and ensemble_remove.
- src/web/useEventStream.ts handles both variants and the snapshot collection exhaustively.

Broadcast one compact EnsembleSummary containing strategy, status, active stage, member/artifact
counts, attention, budget usage, and terminal outcome summary. Full members, artifacts,
evaluations, stage outputs, and patches stay on HTTP. This remains bounded when a later strategy
launches more than five or generates pairwise evaluations.

### Session projection

Extend TaskSummary with a nested optional projection:

    ensemble?: {
      id: string;
      strategyId: EnsembleStrategyId;
      strategyLabel: string;
      memberId: string;
      ordinal: number;
      wave: number;
      role: string;
      launchedMembers: number;
      maxMembers: number;
      status: EnsembleMemberStatus;
      resultLabel: string | null;
    };

This avoids adding another denormalized top-level Session field. Session.task is already
compared structurally. resultLabel is a bounded strategy-derived human label such as rank 1,
advanced, critic, synthesis, or retained; components do not interpret strategy-specific JSON.
Keep the projection derived from the Ensemble store whenever Task
summaries are built.

## Dashboard design and parity

### Dispatch modal

Add Single and Ensemble modes only for new dispatches. A backlog Task edit remains single.
In Ensemble mode:

- keep the existing title, intent, repository, attachment, label, and priority controls;
- select a strategy from descriptor-driven preset cards; Best-of-N is the only enabled v1 card;
- render its generic StrategyFormSpec, with roster rows owning agent, model, effort, role, and
  optional approach;
- offer the evaluator Persona and compatible Workflow placement/version fields declared by strategy
  capabilities; show exact revisions/versions that will be pinned;
- when a Workflow is selected, show its trigger/delivery defaults, round cap, final gate, and any
  Live/Foreman prerequisites before launch;
- show launch estimate as exact or range, max concurrency, waves, artifact type, evaluation stages,
  finalization, and hard stop budgets before confirmation;
- show the strategy's information-sharing and publishing rules;
- allow duplicate rows;
- preserve all fields in DispatchLayer and lib/task-draft.ts across close/unmount;
- disable submit while attachments upload and reuse the current reset nonce behavior.

This change does not add a composer to TranscriptPanel, WorkQueue, or ActionBar, so those
compose surfaces remain unchanged. Dispatch is already its own attachment-capable layer.

### Ensembles inside the Workflows page

Extend the existing hash shell with #/workflows/ensembles and
#/workflows/ensembles/:id. Add Ensembles beside Workflows, Personas, and Runs. The page owns selected ensemble
state through the route, while App keeps the one fleet EventSource mounted exactly as the Workflow
plan requires.

Do not add an Ensemble overlay, OVERLAY_IDS entry, or separate top-bar button. The existing Workflows
top-bar entry is the home for durable orchestration. Dispatch remains the creation surface; the
Ensembles tab is monitoring, evidence, selection, recovery, and history.

The Ensemble detail should show:

- strategy/version, status, active stage, pinned inputs, elapsed time, launch/budget use, and
  aggregate member cost;
- member cards grouped by wave/role, with lineage and linked Workflow state;
- immutable artifacts and their provenance;
- stage timeline, barriers, retries, evaluations, advancement, and strategy decisions;
- reported versus observed evidence labels;
- on-demand artifact materialization/diff;
- focus session, manual submit, withdraw, retry stage, cancel, and generic pending decisions;
- evaluator identities and structured results;
- terminal outcome, retained/eliminated members, and recovery actions;
- pinned post-promotion Workflow version and settings;
- handoff state, linked binding/run, exact reviewed result SHA, and deep link to Workflow Run detail.

Best-of-N's strategy result renderer presents the familiar anonymous scorecards, recommendation,
caveats, Select candidate confirmation, snapshot refs, and Restore actions. A future panel renderer
can show judge agreement; a tournament renderer can show a bracket/standings; both consume generic
evaluation rows and add no new page route.

No new keyboard shortcut is needed in v1. Workflows page focus continues to stand down fleet
shortcuts, and Back/Forward owns detail navigation.

### Layout parity

Board already supplies the overview, but an ensemble signal must appear in every layout:

- SessionCard: a shared EnsembleChip leaf.
- ConsoleDetail: the same shared EnsembleChip.
- SessionTile: a tile flag with member ordinal/role and state.
- RailRow: a compact E mark plus bounded resultLabel.

Put the shared leaf in session-bits.tsx. Route onOpenEnsemble through SessionViewProps and
cardProps in layouts/types.ts so GridView cannot drop it. Update all three mark vocabularies
together and add parity coverage. Do not add an affordance only to SessionCard.

The Workflow Phase 3 marks and Ensemble marks may coexist on a selected/synthesized result. Do not collapse one
into the other or use a single ambiguous status:

- Ensemble mark answers strategy, member role/wave, and its current/result state.
- Workflow mark answers the selected Session's review/repair/gate state.
- Cards and details render both shared chips.
- Tile and rail vocabularies reserve distinct E and W marks with accessible labels.

Implement the shared chip row once so the order is stable. Clicking E opens the Ensemble detail;
clicking W opens the Workflow Run.

## Failure, race, and restart analysis

| Scenario | Required behavior |
|---|---|
| Duplicate create request | requestId returns the existing EnsembleRun; no new Tasks |
| Unknown/corrupt strategy plan | Fail visibly before launch or block recovery; never compile with current defaults |
| Source branch moves during launch | Every worktree still verifies its persisted input commit |
| One harness binary disappears | Member fails; strategy barrier decides whether others continue |
| Member process dies before submit | Member fails and no artifact is invented |
| Member calls submit twice | Same payload returns prior artifact; conflict is rejected/new attempt required |
| Member tries sibling id | Impossible through MCP schema; attribution comes from session Task |
| Artifact capture fails | Member stays active; no ready artifact is persisted |
| Daemon exits during a launch wave | Task reconciliation runs; durable stage/command keys prevent duplicate members |
| Driver requests too many agents | Engine rejects command against hard member/wave/concurrency caps |
| Barrier can no longer be satisfied | Stage/run fails with exact missing/failed subjects and recovery actions |
| Daemon exits during evaluator | LLM child becomes interrupted; evaluation retry is bounded and idempotent |
| Evaluator output is malformed | Preserve artifacts, fail the attempt, expose retry; never create a decision |
| Artifact contains prompt injection | Tool-less evaluator, data fencing, typed output validation |
| Daemon exits during finalization | finalizing is durable and side effects are idempotently resumed |
| Cleanup fails | Remain finalizing with the exact member error; retry cleanup |
| Winner session disappeared | Create one replacement Task at snapshotSha |
| Existing Workflow binding owns winner | Block handoff; require explicit keep-existing or remove-binding choice |
| Workflow is archived before handoff claims a binding | Block the new binding until restore; retain the pinned immutable-version display as archived history |
| Live Workflow consent was revoked | Do not downgrade; remain finalizing with an authorization recovery action |
| Winner HEAD differs or its working tree is dirty during Workflow capture | Refuse the handoff, restore snapshotSha cleanly, then resume the same external submission |
| Crash after binding but before ensemble update | Stable binding claim returns the same binding and submission |
| Linked Workflow later fails/cancels | Ensemble remains completed and links the true Workflow state |
| Artifact ref is missing | Refuse finalization/restore; do not clean remaining members |
| Best-of-N gets one artifact | No comparison; show insufficient-evidence failure and recovery actions |
| Pairwise evaluation partially completes | Preserve completed pairs; retry only missing attempts |
| Adaptive stop rule is inconclusive | Spawn next allowed wave or terminate no_consensus at hard cap |
| Operator cancels | Cancel active Tasks; keep existing refs and history |
| SSE reconnects | Snapshot contains bounded EnsembleSummary collection; detail refetches over HTTP |

### Restart reconciliation

On daemon start, after Tasks and sessions load:

1. Load nonterminal EnsembleRuns and validate their snapshotted plan/primitives.
2. Join members to current Tasks and artifacts without erasing immutable ready results.
3. Recover running LLM evaluations as interrupted and finalize durable Task/artifact observations.
4. Recompute stage readiness from attempts, barriers, evaluations, and command keys.
5. Recover WorkflowEngine/bindings before resuming a finalization with a handoff.
6. Resume finalizing from persisted outcome intent, cleanup progress, binding claim, and submission
   key.
7. Invoke the pure strategy driver only after the generic durable state is consistent; deduplicate
   every returned command.
8. Emit reconciled summary upserts after Registry holds one coherent run view.

Use a per-ensemble serialized queue or mutex for submit, Task updates, stage/evaluation completion,
driver decisions, operator actions, cancel, and finalization. The daemon is single-process but async
completions can otherwise race.

## Security and resource controls

- Creating an ensemble is explicit authorization to launch an exact count or bounded range of local
  agents; show initial, maximum, concurrency, waves, and Workflow/evaluator calls before submit.
- Reuse repository allowlisting and MCP token checks.
- Resolve identity from live session/Task state, never a user-supplied member/artifact id.
- Generate refs and branches from UUIDs and pass process arguments without a shell.
- Pre-finalization member prompts prohibit push and PR creation unless a future strategy explicitly
  introduces a separately consented publishing primitive. Finalization returns to the normal
  provenance-aware shipping flow.
- Active member sessions cannot acquire a normal Workflow binding except through the compiled
  MemberWorkflowPolicy and server-owned external-binding boundary.
- Workflow handoff identity, version, noteKey, expected HEAD, and clean-worktree requirement are
  resolved/rechecked by the daemon; the client cannot target another session.
- Model evaluators have no tools; their results and strategy-driver commands cannot delete or
  publish.
- Destructive finalization requires a human and preserves restorable artifacts before cleanup.
- Enforce persisted max members/concurrency/waves/stage attempts, cap artifact/prompt/result bytes,
  and reuse LLM timeout/cancellation.
- Member cost is the sum of session cost telemetry at submission. Label it agent cost. Evaluator and
  linked Workflow monetary costs appear only when their runner reports them authoritatively; call
  count, model, duration, and bytes remain visible otherwise.
- Do not promise adversarial isolation between worktrees in one local repository.

## Implementation sequence

Each phase should land with its tests and leave normal dispatch unchanged.

The dependency-linked implementation schedule has now been re-audited against main `57ea5bc` and
lives in [phased-plan.md](./phased-plan.md), with one complete implementation document per task.
That eight-phase schedule is authoritative for merge order and file ownership. The slices below
remain a compact architectural map; their older 0A/0B numbering must not be used to schedule work.

### Phase 0A — extend the shipped Workflow Preview boundary

Files:

- src/shared/workflow.ts
- src/shared/protocol.ts
- src/server/db.ts
- src/server/workflows/store.ts
- src/server/workflows/manager.ts
- src/server/workflows/context.ts
- src/server/workflows/engine.ts
- src/server/workflows/external-binding.ts
- src/server/llm/review-scheduler.ts
- src/server/index.ts
- src/web/workflows/WorkflowRuns.tsx
- targeted Workflow store, binding HTTP, context, recovery, Reset, and run-render tests

Work:

- Keep the published graph and one-Session context contracts unchanged.
- Append ensemble to WorkflowTriggerSource while leaving WorkflowTriggerMode unchanged; remove the
  store's manual-source literals by passing source explicitly from existing manual call sites.
- Add the transactional workflow_binding_claims seam and external bind/submit methods.
- Add stable expected-HEAD plus clean-worktree enforcement, including idempotent resume of the same
  external initial submission after a mismatch.
- Inject one daemon review scheduler into Workflow compaction/Persona calls and later Ensemble
  evaluators; preserve unrelated per-caller limits and the Foreman process boundary.
- Factor only reusable prompt fencing/cap helpers, not Persona or comparator result semantics.
- Delete claims with Workflow Reset while retaining Ensemble history and a visible removed-link state.

Exit: all existing manual Preview tests remain green, existing manual keys and rows retain their
meaning, and one finalized exact clean result can idempotently create and activate one externally
sourced Workflow run through the shipped engine.

This slice is a dependency of Ensemble Phase 5, not of core Phases 0B–4. Preview handoff can be
enabled after it lands because Workflow Phase 3 exists. Live/Foreman handoff choices remain disabled
until Workflow Phase 4 exists.

### Phase 0B — prove the two low-level ensemble seams

Files:

- src/server/git/ensemble-snapshot.ts, or a nearby focused Git helper
- src/server/dispatcher.ts
- src/server/tasks.ts
- src/server/ask-channel.ts
- src/server/mission-mcp.ts
- src/server/harness/codex/launch.ts

Work:

- Implement and exhaustively test temporary-index snapshots and exact base-to-snapshot diff.
- Add pinned base provisioning to Git and Treehouse paths and verify post-provision HEAD.
- Add a shared launch-scoped Mission MCP descriptor and Codex TOML overrides.
- Retain the local probe as a unit fixture around exact argv; do not depend on installed
  Codex in the test suite.

Exit: two temp worktrees start at one SHA, diverge, snapshot without index mutation, and
remain restorable after teardown.

### Phase 1 — contracts, store, and live state

Files:

- src/shared/ensemble.ts
- src/shared/protocol.ts
- src/server/db.ts
- src/server/ensembles/store.ts
- src/server/registry.ts
- src/shared/types.ts
- src/web/useEventStream.ts

Work:

- Add append-only strategy/artifact ids, policy/stage/outcome unions, Zod request schemas, generic
  tables, row parsing, idempotency, and transition contracts.
- Add browser-safe strategy descriptors and server compiler registries with exhaustive Records.
- Add compact summary snapshot/upsert/remove events and nested TaskSummary projection.
- Implement pure plan/capability/budget validation before side effects.

Exit: an EnsembleRun with members, artifacts, stage attempts, evaluations, and a compiled strategy
snapshot round-trips through SQLite; SSE remains compact and strategy-agnostic.

### Phase 2 — generic engine, member launch, and artifact submission

Files:

- src/server/ensembles/manager.ts
- src/server/ensembles/engine.ts
- src/server/ensembles/strategies/index.ts
- src/server/ensembles/artifacts/index.ts
- src/server/tasks.ts
- src/server/dispatcher.ts
- src/server/routes.ts
- src/mcp/server.ts
- harness launch builders

Work:

- Add generic plan execution, durable command keys, barriers, per-run serialization, hard budgets,
  restart recovery, and stage events.
- Add preflight, create-wave-before-launch orchestration, pinned input dispatch, and role-aware
  member prompt appendix.
- Add HTTP and MCP submission routes with session-derived attribution.
- Implement git_snapshot ArtifactAdapter, record evidence, and wake collect barriers.
- Add generic cancel/withdraw/retry/restore actions through TaskManager.

Exit: a test strategy can launch members in two waves, capture immutable artifacts, survive restart,
and advance stages without Best-of-N branches in EnsembleEngine.

### Phase 3 — Best-of-N v1 strategy and comparative evaluator

Files:

- src/shared/ensemble-strategies/best-of-n.ts
- src/server/ensembles/strategies/best-of-n.ts
- src/server/ensembles/evaluators/comparative.ts
- src/server/llm/structured.ts as needed
- src/server/workflows/personas.ts for reuse, not Ensemble coupling

Work:

- Implement the descriptor/schema/defaults/compiler for fixed roster 2–5, isolated information,
  git_snapshot artifacts, comparative evaluate, human decision, and select-one finalization.
- Resolve and snapshot built-in or Persona evaluator guidance.
- Assemble bounded anonymous artifact evidence.
- Run the tool-less structured evaluator, normalize the result, and implement retry.
- Persist results only in evaluation rows and derive scorecards/resultLabel.

Exit: deterministic fixture members produce a validated ranked evaluation; malformed, injected,
truncated, and interrupted responses fail closed, and EnsembleEngine contains no best_of_n id test.

### Phase 4 — generic finalization plus Best-of-N select-one

Files:

- src/server/ensembles/finalize.ts
- src/server/ensembles/manager.ts
- src/server/git/ensemble-snapshot.ts
- src/server/reset.ts

Work:

- Implement generic human decision/finalization authority and terminal outcomes.
- Implement select-one exact-reset, loser Task cancellation, restore, explicit delete, and
  private-ref cleanup through the finalization policy.
- Add finalizing restart reconciliation and replacement result Task fallback.
- Route exact selected-result restoration through resetSession's injected reset function so every
  session-scoped family is cleared once, while shared ensemble refs remain retained.

Exit: fault injection at every finalization step resumes without duplicate Tasks, lost refs,
or a false completed outcome.

### Phase 5 — Workflow handoff

Dependency: Ensemble Phase 0A plus the implemented Workflow Phase 3 for Preview; Workflow Phase 4
for Live/Foreman-triggered repair.

Files:

- src/shared/workflow.ts and src/shared/protocol.ts
- src/server/workflows/store.ts
- src/server/workflows/manager.ts
- src/server/workflows/external-binding.ts
- src/server/ensembles/finalize.ts
- src/server/ensembles/store.ts
- src/server/db.ts

Work:

- Use the Phase 0A workflow_binding_claims table, server-owned external source, and submitExternal
  exact-clean-snapshot capture.
- Pin an optional immutable Workflow version at ensemble creation.
- Extend compatible select-one/synthesis finalization with binding/submission handoff and recovery.
- Link Ensemble and Workflow details without merging lifecycle or retention.
- Keep active member sessions ineligible for ordinary Workflow binding except through declared
  MemberWorkflowPolicy.

Exit: one confirmed winner is reviewed by the exact pinned Workflow version at the exact submitted
snapshot; retry/restart cannot create a second binding or run, and later Workflow state does not
rewrite Ensemble state.

### Phase 6 — dashboard and layout parity

Files:

- src/web/components/DispatchModal.tsx
- src/web/lib/task-draft.ts
- src/web/App.tsx
- src/web/workflows/WorkflowPage.tsx
- src/web/workflows/EnsembleRuns.tsx
- src/web/ensembles/*
- src/web/components/session-bits.tsx
- all four session renderers and src/web/components/layouts/types.ts
- src/web/lib/api.ts and styles

Work:

- Add mode, strategy cards, descriptor-driven configuration, launch estimate, and Best-of-N roster
  editor to Dispatch.
- Add the Ensembles tab, generic stage/member/artifact/evaluation views, Best-of-N scorecards,
  Workflow handoff state, and hash routing.
- Add shared and layout-specific group signals across Cards, Console, and Board.
- Preserve attachment, Enter, Escape, draft, reset nonce, Workflow page focus, and Back/Forward
  contracts.

Exit: every layout can identify and open an ensemble, and the full operator flow works without
losing a draft or creating a second compose box.

### Phase 7 — extension proof, documentation, soak, and release

Files:

- README.md
- focused server and web tests
- docs describing refs, cost, recovery, and limits
- test-only fixed, adaptive-wave, pairwise, and synthesis strategy fixtures

Work:

- Document explicit local resource fan-out, no-push behavior, human promotion, recovery,
  snapshot retention, and the Ensemble-to-Workflow ownership boundary.
- Prove new strategies composed from existing primitives require no DB, HTTP, SSE, Session, or
  layout changes. Test a two-wave adaptive driver, pair scheduler, and synthesized outcome with fake
  Tasks/artifacts/evaluators even though their product presets remain disabled.
- Run fault-injection and restart soak with mixed Claude/Codex candidates.
- Verify packaged paths for MCP and hooks.

Exit: the acceptance suite, typecheck, build, package smoke paths, and restart soak pass.

## Verification matrix

### Pure contracts

- Strategy/artifact ids and versions are append-only and registry Records are exhaustive.
- Best-of-N roster count 1 and 6 rejected; 2 through 5 accepted.
- Invalid artifact/evaluator/finalization/Workflow capability combinations are rejected.
- Compiled plans round-trip and never change when descriptor defaults change.
- Fixed, matrix, role, and adaptive launch policies calculate bounded estimates correctly.
- Hard member/concurrency/wave/stage budgets cannot be exceeded by config or driver command.
- Unknown agents, models, effort, Persona, Workflow version, and repo rejected before launch.
- requestId, ensemble/member ordinal, task, artifact attempt, stage command, and evaluation
  uniqueness enforced.
- WorkflowTriggerSource accepts ensemble while WorkflowTriggerMode still rejects it.
- Workflow graph schemas and validators still reject an Ensemble node.
- Every state transition accepts only its legal predecessor.
- Best-of-N normalization rejects missing, duplicate, extra, out-of-range, or noncontiguous
  artifact subjects.
- Fake adaptive, pairwise, and synthesis strategies compile/drive through existing primitives
  without schema/route/event changes.
- Text, arrays, artifact material, evaluation results, and plan JSON are bounded.

### Git integration

- Every Best-of-N member begins at byte-identical baseSha even if source HEAD moves.
- Treehouse and Git fallback converge on the same pinned base.
- Snapshot includes committed changes after base, staged, unstaged, deletion, rename, binary,
  and untracked nonignored files.
- Snapshot does not mutate HEAD, branch, working tree, or real index.
- Exact diff reports truncation honestly.
- Ref survives Task cancellation and worktree teardown.
- Artifact lineage is stable; restore and selected-result reset reproduce the snapshot tree exactly.

### Manager and persistence

- Create retry launches one group.
- All Task rows in a wave exist before its first dispatch.
- Partial launch, member failure, manual withdrawal, barrier failure, and insufficient artifacts.
- Concurrent duplicate submit and submit-versus-cancel serialize correctly.
- Stage readiness/evaluation queues once from durable dependencies.
- Evaluation retry uses identical artifact ids and evaluator snapshot.
- Driver command keys deduplicate spawn/advance/finalize across concurrency and restart.
- Restart in planning, running, waiting, evaluating, awaiting_decision, and every finalization step.
- Human override selects a nonrecommended but eligible artifact.
- Cleanup failure stays visible and retryable.
- Restore creates one normal Task.
- No EnsembleEngine source branch tests strategyId.

### Workflow composition

- A pinned version is immutable even if its draft/Personas later change.
- External binding source key creates one claim and one binding under concurrent retry.
- An existing active binding produces a typed conflict and is never overwritten.
- submitExternal refuses a winner whose HEAD differs from snapshotSha or whose working tree is
  dirty.
- A crash before/after claim, binding insert, submission capture, or Ensemble update returns the same
  binding/run on recovery.
- Preview and Live prerequisites remain byte-identical to normal Workflow binding behavior.
- Live authorization removal blocks rather than downgrades.
- Workflow context compaction, Persona attempts, and Ensemble evaluator calls share one injected
  daemon review scheduler; Foreman and unrelated background-job limits remain independent.
- before_comparison rejects Inspector completion policy and accounts for per-member Workflow calls.
- Workflow run failure/cancellation/completion does not mutate a completed Ensemble.
- Ensemble deletion does not delete Workflow bindings, runs, Inspector ledgers, or Shipping state.
- Workflow Reset removes its session-scoped family and external binding claim but does not delete
  Ensemble history or refs; the linked run renders as reset/removed and a completed Ensemble does
  not recreate it.

### MCP and routing

- Shared and MCP schemas accept and reject the same arguments.
- Correct session Task is attributed.
- Wrong cwd, stale session, nonmember Task, sibling guess, late submission, and conflicting
  duplicate are rejected.
- Claude and Codex launch argv contain the scoped MCP configuration only when required.
- Every mutating route uses parseBody.

### Web and parity

- Ensemble draft survives modal close and resets only after successful creation.
- Strategy descriptor form, launch estimate/range, roster bounds, and per-agent model/effort
  derivation.
- Attachments follow compiled member prompt policy and uploading blocks submit/Enter.
- Summary snapshot and ensemble events are exhaustive in useEventStream; full detail stays HTTP.
- #/workflows/ensembles list/detail supports Back/Forward and keeps fleet SSE mounted.
- Evaluator Persona and pinned Workflow version/defaults render accurately in Dispatch and detail.
- SessionCard, ConsoleDetail, SessionTile, and RailRow all expose the ensemble signal.
- A selected/synthesized result can show distinct Ensemble and Workflow marks with correct links.
- Artifact evidence is fetched on demand and full material never appears in SSE.
- Best-of-N, fake panel, pairwise, adaptive-wave, and synthesis results render through generic
  member/stage/evaluation data.
- Evidence labels do not render a claim as observed fact.

### Commands before merge

Run the focused new tests first, then:

    npm run typecheck
    npm test
    npm run build
    npm run smoke

If the repository has a packaged Electron smoke command in the implementation branch, run
that too because the launch-scoped MCP server path is a packaged-build risk.

## Acceptance criteria

The feature is complete when:

- Best-of-N is stored/executed as strategy id best_of_n version 1 over the generic Ensemble model;
- one submission compiles a plan and launches 2–5 normal member Tasks from one verified commit SHA;
- members are visibly grouped in Cards, Console, and Board;
- Claude and Codex members can explicitly submit without a prior global MCP install;
- each submission produces a recoverable immutable artifact without mutating member Git
  state;
- the comparative evaluator compares at least two bounded, anonymous, provenance-labeled artifacts
  and persists a validated recommendation;
- no evaluation or strategy-driver result publishes, selects, spawns past budget, or deletes;
- an operator can inspect exact diffs, override the recommendation, and confirm finalization;
- select-one finalization leaves one exact result available, reaps loser worktrees through TaskManager,
  and preserves all snapshot refs;
- when selected, the exact immutable Workflow version binds once to that winner, captures only when
  HEAD equals the chosen snapshot and the working tree is clean, and creates one initial
  submission;
- the Workflow then owns Persona repair, Foreman, Inspector, and Shipping semantics without Ensemble
  code duplicating or weakening them;
- interruption at any durable state resumes or fails visibly without duplicate members, stages,
  evaluations, artifacts, or finalization effects;
- aggregate agent cost is visible and honestly excludes unknown evaluator cost;
- test-only fixed, adaptive-wave, pairwise, and synthesis strategies use the same tables, engine,
  API, SSE summary, session projection, and layout marks;
- adding a strategy composed only from existing primitives requires no migration, route,
  ServerEvent, useEventStream, or session-renderer change;
- normal single dispatch behavior and every existing layout/shortcut remain unchanged.

## Explicit non-goals for the first release

- Shipping more than the Best-of-N strategy in the first release.
- Arbitrary user-authored strategy graphs or executable plugins.
- Unmediated agent-to-agent communication; future collaboration is artifact-mediated.
- Scout or research ensembles with transcript-only artifacts.
- More than five members in Best-of-N v1 or cross-machine execution.
- Arbitrary repository validation commands.
- Automatic destructive finalization or automatic ref pruning.
- One PR per candidate.
- Replacing Tasks with a generic workflow engine.
- An Ensemble node or multi-session binding in the Workflow graph.
- Pre-comparison member Workflows in Best-of-N v1.
- Adversarial process or filesystem isolation.
- A new keyboard shortcut.

## Likely follow-ups

After real usage validates the lifecycle:

- repository-owned evaluation profiles with safe commands and timeouts;
- Persona panel voting as the smallest second product strategy;
- pairwise tournament/Swiss scheduling for larger rosters and smaller comparison prompts;
- successive-halving and adaptive-wave strategies under hard member/concurrency budgets;
- critique/revise and proposer–critic–verifier through artifact-mediated feedback;
- top-K synthesis with explicit artifact lineage and a fresh synthesis member;
- consensus/no-consensus output for questions where retaining dissent is better than one winner;
- a cost-versus-score comparison and evaluator cost once LlmRunner reports usage;
- blind A/B evaluator calibration;
- transcript/research artifact support for scout ensembles;
- configurable snapshot retention with storage accounting;
- reusable ensemble presets for candidate mixes and approach briefs;
- an evaluation-only Workflow mode for scoring each immutable candidate, if measured usage
  justifies N times the Persona calls and a new non-repair execution contract;
- a guided composition view that draws Ensemble then Workflow without changing either persistence
  model.

The first implementation should deliberately earn these extensions by making the generic stage
kernel, artifacts, evidence provenance, human finalization, hard budgets, and restart behavior
trustworthy first.
