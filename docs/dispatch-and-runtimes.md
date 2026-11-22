# Dispatch and runtimes

Dispatch turns a task or operator request into a reachable agent session. Its main job is
to choose one runtime once, provision the appropriate execution surface, and deliver the
initial intent without hiding a failed choice behind an unrelated fallback.

The [dispatcher](../src/server/dispatcher.ts) coordinates launch. Runtime selection lives
with the [harness configuration](../src/server/harnesses.ts), while the [SDK supervisor](../src/server/sdk/supervisor.ts)
owns embedded turns after launch. Terminal execution uses a home and waits for discovery;
an SDK turn has no terminal home or discovery wait.

This split lets the dashboard offer one task experience without pretending the runtimes are
identical. A terminal runtime is controlled through a pane. An SDK runtime is driven by
the supervisor and emits agent events directly. Both ultimately report into the Registry
and its event stream.

Read [Dispatch, backlog, and task sources](dispatch-and-backlog.md) for the operator flow.
For the precise runtime-selection and failure rules, use the authoritative
[dispatch runtime contract](agent-guides/architecture.md#dispatch-runtime). Capability
boundaries are described in [Harnesses and terminal backends](harnesses-and-terminals.md).

For managed terminal preparation, launch ownership and recovery, see
[Managed terminal resumes](harnesses-and-terminals.md#managed-terminal-resumes).

## Turn one

Every dispatched session's first prompt is composed once, before the runtime fork, in this
order:

1. The dependency-claim note, only when a claim failed in one of the task's worktrees.
2. The repository manifest and, on a pair without an out-of-band channel, the standing
   instructions.
3. The operator's prompt, verbatim.
4. The kind contract.
5. The task context section, only when [task shaping](task-shaping.md) is on and a shaper
   added something. It is appended by one helper, so the normal turn one and the
   standing-instructions fallback carry identical text.
6. Repository task skills, only with the `headless-mode` flag on and a skill the repository
   ships for the task's kind (`.claude/skills/{kind}/SKILL.md`).

Shaping budgets against the turn one with the skills included, so the section never pushes the
whole prompt past its delivery path. Pi receives turn
one as its launch argument, with the repository memory pointer in front of it; every other
pair receives it through the embedded driver or a pane paste. How each path bounds the size of
turn one is in [Where the section lands](task-shaping.md#where-the-section-lands).
