# Durable work-cycle completion

Status: approved for phased implementation

## Goal

Make automatic prompted completion react once to each genuine completed agent work cycle,
including a background-task continuation that finishes under the same human intent. Preserve the
current completion verifier, queue-drain ownership, workflow claims, Ask and Straight-to-PR modes,
and fail-closed delivery behavior.

This replaces the prompted trigger's current intent-revision re-arm. It is not another permanent
fallback layered beside that mechanism.

## Problem

Mission Control already has durable identities for neighboring facts:

- the intent episode says what the human currently wants;
- the work episode says which task, branch, agent identity, and pull requests own the work;
- evidence fingerprints say what repository and transcript evidence a review examined.

It does not have a first-class identity for a new completed agent turn. Prompted automatic
completion currently uses the intent episode for that purpose. After an incomplete verdict, it
retires that intent and assumes no relevant work can change until another human prompt is
reconciled.

Claude background-task notifications disprove that assumption. They correctly travel through the
working lifecycle without becoming human intent. A later `Stop` can therefore represent a new
completion opportunity while the intent revision remains unchanged, and the current guard suppresses
it.

The worker also rechecks intent after its verifier call, but not whether the same work cycle is still
current or whether the session is still settled idle. A new turn can begin during verification and
leave a stale positive verdict eligible to act.

## Approved design

### One normalized work-cycle fact

The Registry will normalize harness-specific lifecycle signals into one work-cycle state:

- substantive prompts, machine task notifications, tool activity, and SDK working state establish
  that work is active;
- a terminal harness's turn-end hook and an SDK driver's `turn_done` complete the active cycle;
- an idle notification, passive discovery refresh, transcript growth, or repository edit does not
  complete a cycle by itself;
- a duplicate turn-end signal with no work observed since the previous completion does not advance
  the cycle.

The harness registry owns raw hook vocabulary. Generic Registry, Foreman, Workflow, and task code
must not branch on agent names or concrete event strings.

### Durable latest generation

The daemon will persist the latest work-cycle state for the logical session key, including a
monotonic generation and completion time. It will keep current state rather than an unbounded event
backlog. If several cycles finish while Foreman is offline, the latest generation represents the
newest state worth judging.

This state must survive daemon and Foreman restarts. It must remain separate from
`session_events`, whose existing any-row query means every writer is currently interpreted as proof
that hooks were seen. It must also remain separate from `session_work_episodes`, which owns task and
pull-request identity rather than individual turns.

### Prompted completion consumes generations

For a session with no queue items, Foreman may verify only when:

- the prompted trigger is enabled and the session remains eligible under all existing gates;
- the session is settled idle;
- the latest intent is resolved;
- the latest completed work-cycle generation has not been consumed.

An empty diff, an ineligible artifact objective, an incomplete verdict, an Ask handoff, a workflow
claim, and direct wrap-up each consume that generation exactly once. A later completed cycle re-arms
the check even when the resolved intent did not change.

Intent remains an independent staleness guard. Evidence fingerprints remain proof and idempotency
material, and may remain a cheap no-change filter, but they do not identify lifecycle turns.

### Recheck after verification

Before consuming a generation or taking an action, Foreman must re-read the session and require:

- the same logical session key;
- the same completed work-cycle generation;
- the same resolved intent;
- a still-settled idle session with no human-attention state.

If any check fails, the verifier result is discarded without consuming the generation. The newest
settled generation can be evaluated on a later pass.

### Atomic action boundary

The existing mark-before-type and fail-closed rules remain. A workflow completion claim must consume
the matching generation in the same daemon transaction that creates or resumes the workflow. The
direct Ask and wrap-up paths must also use a compare-and-set write against the expected generation.

Workflow repair delivery no longer needs to clear the prompted intent guard to manufacture a re-arm.
The delivered work's eventual completed turn advances the work-cycle generation naturally. Queue
drain keeps its separate explicit re-arm because queue item state, not prompted work-cycle state,
owns that trigger.

## Flow

1. A terminal hook adapter or SDK driver reports work activity to the Registry.
2. The harness adapter normalizes a completed turn without exposing raw event vocabulary to
   consumers.
3. The daemon advances and persists the logical session's work-cycle generation.
4. Foreman observes a new generation at a settled idle session and gathers the existing diff,
   transcript, standards, and resolved objective.
5. The existing verifier decides whether the objective is complete.
6. Foreman rechecks work-cycle, intent, and idle currency.
7. The daemon atomically consumes the generation with a workflow claim or human/direct wrap-up
   handoff, or records a hold without acting.

## Compatibility and migration

- Use additive schema changes. Existing databases must open and upgrade safely.
- Do not reinterpret historical `session_events` rows as SDK lifecycle events.
- Preserve the historical `prompted_goal` column for database compatibility, but stop using it as
  the current prompted completion key after cutover.
- On first cutover read, a legacy row whose `prompted_goal` already matches the current resolved
  intent must initialize the current completion generation as consumed. This prevents an already
  retired session from replaying immediately after upgrade.
- A legacy row with no prompted guard remains eligible for its latest completed cycle, matching the
  existing behavior of a never-considered prompted session.
- Missing or inconsistent work-cycle state fails closed. Do not keep the legacy guard as a permanent
  parallel trigger.
- The existing direct-wrap-up payload recognition remains until injected prompt authorship is itself
  durable.

## Scope

In scope:

- cross-harness work-cycle normalization for supported terminal and SDK runtimes;
- durable work-cycle state and restart recovery;
- prompted completion selection, consumption, failure tracking, and post-verifier currency checks;
- workflow claim integration and removal of the prompted delivery reset;
- focused unit, database-migration, worker integration, and end-to-end regression coverage;
- behavior documentation for prompted completion and workflow repair cycles.

Out of scope:

- replacing the queue-drain state machine;
- forcing dispatched tasks into session work queues;
- merging Workflow, TaskManager, and Foreman policy into one state machine;
- requiring agents to call a completion tool;
- changing reviewer logic, workflow graphs, delivery authorization, or direct shipping policy;
- adding a dashboard control or other user-visible UI.

## Required behavior

- `Stop N` can be verified incomplete and consumed. A machine task notification may then resume work
  without changing intent. `Stop N+1` must cause exactly one new verification and at most one
  workflow claim.
- Idle notifications, passive refreshes, and external repository edits do not advance the
  work-cycle generation.
- A duplicate turn-end with no intervening work does not cause another verifier call.
- Work that starts or completes while verification is running makes the result stale and prevents
  action.
- A daemon or Foreman restart does not replay a consumed generation and does not lose an unconsumed
  one.
- Claude terminal, Codex terminal, and supported SDK sessions follow the same generic contract.
- Sessions with queue items remain owned by queue drain and cannot race prompted completion.
- Empty diffs continue to consume the opportunity without a model call.
- Verifier failures remain bounded and cannot hot-loop.
- One confirmed workflow repair delivery can lead to one later completion claim through the natural
  work-cycle transition, without clearing the legacy prompted intent guard.

## Delivery decision

The already-running tactical task `5439ebd4-e346-4d57-b778-ecb2ebec8e67` may land a narrower
incident fix first. The durable work-cycle implementation must rebase on that result, preserve any
valid regression coverage, and replace any evidence- or intent-based re-arm as the final mechanism.
It must not keep both mechanisms active indefinitely.

The phased implementation tasks are intentionally disabled, low priority, and pinned to Codex
`gpt-5.6-sol` at `xhigh` effort. A human must explicitly enable them.
