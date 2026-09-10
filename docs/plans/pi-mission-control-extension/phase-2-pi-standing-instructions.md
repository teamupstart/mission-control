# Phase 2: standing instructions on Pi's terminal runtime

Part of [Pi parity](plan.md) - see [phased-plan.md](phased-plan.md) for the graph.

## Outcome

An operator's repository standing instructions reach a dispatched Pi session **out of band**,
as a system-prompt append, instead of being composed into turn one above the intent. Pi stops
being the harness that proves the prefix path works and becomes one that has a channel of its
own - on the runtime it actually has.

## Entry criteria and dependencies

- **Direct prerequisite:** the planning session's pull request.
- Concurrent with Phases 1 and 3. The only file shared with them is
  `src/shared/harness-capabilities.ts`, where all three add disjoint slots to the same record.

## Scope

1. `"pi-append-system-prompt"` appended to `STANDING_INSTRUCTIONS_MECHANISMS`.
2. `HARNESS_CAPABILITIES.pi.standingInstructions.outOfBand.terminal` set to it.
3. The dispatch launch rendering the flag for that mechanism.
4. Tests, including the launch-argv shape and the snapshot's recorded mechanism.

### Non-goals

- **A channel for a hand-run Pi session.** The extension's `before_agent_start` can modify the
  system prompt for a turn, which is the equivalent channel, but it is a second delivery of the
  same text and must be gated on the launch not already having carried it. That gate belongs
  with the extension, in Phase 4.
- Any change to how Claude or Codex carries the text.
- The `sdk` runtime, which Pi does not have.

## Repository findings

### `pi --append-system-prompt` is repeatable, unlike Claude's

The measurement that makes this phase possible, and it is the opposite of Claude's behavior:

```
$ pi --mode rpc --no-session \
    --append-system-prompt "MISSION-STANDING-INSTRUCTION-PROBE-A" \
    --append-system-prompt "MISSION-STANDING-INSTRUCTION-PROBE-B"
$ grep -c PROBE-A system-prompt.txt   ->  1
$ grep -c PROBE-B system-prompt.txt   ->  1
```

Both present, once each, read back from `ctx.getSystemPrompt()`. `pi --help` documents the flag
as "Append text or file contents to the system prompt (can be used multiple times)".

Claude's is single-valued and its CLI carries no guard against repetition, so a second flag
silently discards the first - which is why the Claude terminal launch composes **one** value
from every contributor (`systemPromptAppendArgs` in `src/server/ask-channel.ts:244`, and the
comment at `dispatcher.ts:626`). **Pi must not reuse that folding.** It has no other contributor
on this runtime today - the ask-channel redirect returns the off contribution for any agent that
is not `claude` - and folding would import a constraint Pi does not have.

### The mechanism vocabulary is append-only and persisted

`STANDING_INSTRUCTIONS_MECHANISMS` (`src/shared/standing-instructions.ts`) is written into
`session_standing_instructions.mechanism` at launch and read back **by exact value** for the
life of the row. Its own comment: "Rename one and every historical row becomes unreadable."
Append `"pi-append-system-prompt"` at the **end**; never reorder. This is a change-contract
item - see `docs/agent-guides/change-contracts.md`.

### One reading of the channel, three readers

`standingInstructionsChannel(agent, runtime)` (`src/shared/harness-capabilities.ts`) is
deliberately the single reading, consumed by the launch composer
(`src/server/instructions/compose.ts:103`), the resolved route's preview, and the snapshot. Its
comment states the hazard directly: two independent readings are how a harness ends up either
double-delivered or silently undelivered. Setting the capability slot is therefore the whole of
the routing change; the rendering is the only new code.

Note `compose.ts:103` falls back to `"prompt-prefix"` when the channel is null. Once Pi's
terminal channel exists, a dispatched Pi session stops taking that fallback - so the launch
**must** render the flag, or the text is dropped entirely. That is the one way this phase can
regress something that works today, and it is what the test below exists for.

### `registry.ts:7335` downgrades a snapshot toward `prompt-prefix`

There is an existing correction path that rewrites a recorded mechanism to `"prompt-prefix"`
(`src/server/registry.ts:7335`, and the note at `db.ts:1087` explaining that a mechanism may be
corrected afterwards, and only in that direction). Check whether a resumed Pi session reaches
it. If it does, the correction is right for Pi too - a resume that does not carry the flag did
not deliver out of band - and no change is needed; if it is Codex-specific, leave it alone.

## Implementation steps

### 1. `src/shared/standing-instructions.ts`

Append to the tuple, with a comment naming the flag and the measured repeatability:

```ts
/**
 * `pi --append-system-prompt <value>`, repeated once per contributor.
 *
 * Repeated, not folded, and that is the difference from Claude's spelling above: measured
 * against pi 0.85.1, two flags each land in the system prompt exactly once, where Claude's
 * single-valued flag silently discards whichever value came first.
 */
"pi-append-system-prompt",
```

### 2. `src/shared/harness-capabilities.ts`

```ts
standingInstructions: { outOfBand: { terminal: "pi-append-system-prompt" } },
```

Replace the `{ outOfBand: {} }` at line 851 and rewrite its comment: Pi is no longer the harness
that proves the prefix path works. Say which harness/runtime pairs still do, so the prefix path
keeps a named live prover the way `harness-capabilities.test.ts` requires of every null path -
`codex · terminal` is the remaining one.

### 3. `src/server/dispatcher.ts`

Render the flag beside where Claude's is rendered (around line 635). Keep it a separate
expression rather than extending `systemPromptAppendArgs`, whose whole purpose is Claude's
single-value fold:

```ts
const piStandingArgs =
  standing.mechanism === "pi-append-system-prompt"
    ? ["--append-system-prompt", standing.text]
    : [];
```

Add it to `agentArgs` alongside `piLaunch.args`. Mind `preparePiLaunch`'s ordering constraint:
Pi has no `--` end-of-options marker and the prompt travels as a positional, so every flag must
precede it. `piLaunch.args` currently ends with the positional message, so the standing flag
must be spliced **before** `piLaunch.args`, not after.

### 4. Tests

- `test/standing-instructions.test.ts` (or wherever the mechanism vocabulary is pinned) - assert
  the tuple's last element and that no earlier index moved. The append-only contract deserves a
  positional assertion, not just a membership one.
- Assert `standingInstructionsChannel("pi", "terminal") === "pi-append-system-prompt"` and that
  `("pi", "sdk")` is still null.
- A dispatcher argv test: a Pi launch with standing instructions carries
  `--append-system-prompt <text>` **before** the positional prompt, and the prompt is still the
  final argument. This is the assertion that catches the regression named above.
- A Pi launch with **no** standing instructions renders byte-identical argv to today.
- The composed turn one for a dispatched Pi no longer carries the prefix - the text moved
  channels, and a test that only checked delivery would pass while the agent read it twice.

## Data and compatibility

`session_standing_instructions.mechanism` gains one new value. Rows written before this phase
keep their existing values and stay readable, because nothing was renamed or reordered. A row
recorded as `"prompt-prefix"` for a Pi session remains accurate history: that is how the text
was delivered at the time.

No migration. No column change.

## Verification

```sh
npm run typecheck
npm run lint
npm test
```

Plus a live check, because the flag's behavior is the whole phase: dispatch a Pi task with a
repository standing instruction configured, and read the value back out of the running session
rather than off the argv. `ctx.getSystemPrompt()` is not reachable without the extension, so
use the session's own transcript or ask the agent to quote its instructions - and record which
method was used.

## Merge and exit criteria

- A dispatched Pi session receives the operator's standing instructions out of band, once.
- Turn one no longer carries the prefix for Pi, and the snapshot records
  `"pi-append-system-prompt"`.
- A Pi launch with no standing instructions is argv-identical to before.
- Typecheck, lint and `npm test` pass.

## Downstream handoff

Later phases may rely on:

- `"pi-append-system-prompt"` existing at the end of `STANDING_INSTRUCTIONS_MECHANISMS`.
- `standingInstructionsChannel("pi", "terminal")` being non-null, and being the **single**
  reading of the question.

Phase 4 must not:

- Deliver standing instructions from the extension's `before_agent_start` without first asking
  whether the launch already carried them. A dispatched session gets the flag; delivering again
  from inside would have the agent read the operator's rule twice, which is exactly the
  double-delivery `standingInstructionsChannel`'s comment warns about.

## Cross-phase audit record

- After Phase 1: no contradiction. Different capability slot, different call sites; the shared
  file is a textual merge only.
- After Phase 3: no contradiction. Phase 3 touches `dispatcher.ts` too - the Mission MCP guard
  around line 667, where this phase touches argv composition around line 635. Adjacent, not
  overlapping; whichever merges second rebases.
- After Phase 4: one contract added here rather than left implicit - the double-delivery gate
  above. It was going to be discovered in Phase 4 as "the agent read the instruction twice",
  which is a defect found by reading a transcript rather than by a test, so the constraint is
  stated here where the channel is defined.
