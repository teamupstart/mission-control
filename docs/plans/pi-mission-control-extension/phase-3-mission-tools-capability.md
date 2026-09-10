# Phase 3: `MissionToolsSpec` and the dispatcher guard

Part of [Pi parity](plan.md) - see [phased-plan.md](phased-plan.md) for the graph.

## Outcome

A Pi task that declares required Mission MCP tools is refused **before** its worktree is cut,
with a message that names the real reason, instead of failing afterwards with one that
misdirects toward rebuilding a bundle. The dispatcher stops branching on two concrete agent
names to answer "did this launch carry our tools", and reads a capability instead - so the
answer exists for Pi at all, which is the precondition for Phase 4.

## Entry criteria and dependencies

- **Direct prerequisite:** the planning session's pull request.
- Concurrent with Phases 1 and 2. It touches `dispatcher.ts` around line 667, where Phase 2
  touches argv composition around line 635 - adjacent, not overlapping.
- **Phase 4 depends on this phase**, because the guard is what decides whether a Pi launch may
  declare Mission tools.

## Scope

1. A new `MissionToolsSpec` capability declaring the mechanism and scope per harness.
2. `AskChannelContribution` reporting its registration as a boolean rather than leaving the
   dispatcher to sniff `--mcp-config` out of argv.
3. `dispatcher.ts`'s `missionMcpRegistered` expression replaced with a capability read.
4. A pre-worktree refusal for a harness whose mechanism cannot be satisfied, and the sentence
   it gives.
5. Tests, including the one that pins the refusal happening before a worktree exists.

### Non-goals

- Making Pi able to carry the tools. That is Phase 4. This phase makes the refusal honest and
  early, and gives Phase 4 a slot to fill.
- Any change to `mcp: null` for Pi. Pi still has no MCP client; `MissionToolsSpec` answers a
  different question and the two must not be folded together.
- Any change to what Claude or Codex carries.

## Repository findings

### The guard as it stands, and why it survived

`src/server/dispatcher.ts:667`:

```ts
const missionMcpRegistered =
  codexLaunch.missionMcp || askChannel.args.includes("--mcp-config");
if (missionMcp && !missionMcpRegistered) {
  throw new Error(
    `the launch could not carry the required Mission MCP tools ` +
      `${missionMcp.tools.join(", ")} (is the MCP bundle built?), so this ${task.agent} ` +
      `session could not submit its result`,
  );
}
```

Two concrete agents in one expression, no third arm, so `missionMcpRegistered` is **always
false** for Pi and every Pi dispatch declaring a required tool fails here - after the task was
accepted and the worktree cut, asking whether a bundle is built when rebuilding it would change
nothing. The repository's code style forbids this shape; it survived because there was no answer
to read for a harness with no MCP client.

Its comment defends the argv sniff as "the only reading a builder which failed halfway cannot
contradict", and that instinct is right and is preserved below - the fix is not to trust the
agent id, it is to have each builder **report** rather than to infer from its output.

### One builder already reports; the other does not

`prepareCodexLaunch` returns `missionMcp: boolean` (`src/server/harness/codex/launch.ts:15`,
set from `descriptor !== null` at lines 78 and 87). `AskChannelContribution`
(`src/server/ask-channel.ts:180`) returns only `{ args, redirect }`, which is why the sniff
exists. Adding the same boolean there removes the string search without weakening the
"ask the argv, not the agent" property: the builder that produced the argv is the thing
reporting.

Note the ask channel returns the off contribution for **any** agent that is not `claude`
(line 195), and warns and returns off when the bundle is missing (line 199) - so the boolean is
`false` in exactly the cases the sniff currently gets right.

### The bundle-content check is separate and already harness-neutral

Immediately after the guard, `verifyMissionMcpTools` runs a real `initialize` + `tools/list`
against the bundle (`dispatcher.ts:691`). That check asks a different question - not "did the
launch carry a registration" but "does the file that registration names publish these tools" -
and it names no harness. It stays exactly as it is, and Phase 4's bridge keeps it working
because the bridge interrogates the same bundle the same way.

### Where the early refusal belongs

`tasks.ts:3120` and `task-repository-preparation.ts:78` already refuse a multi-repo task for a
harness without `multiRepoDispatch`, at task-acceptance time rather than at dispatch. That is
the precedent for where a capability refusal goes, and the shape to copy: a required Mission
tool on a harness that cannot carry one should be refused there, so no worktree is cut.

`kindMissionMcpRequirement` (`src/server/mission-mcp.ts`) derives the requirement from
`Task.kind`, so `plan` and `scout` kinds require tools unconditionally. That means a Pi **plan**
or **scout** task is refusable at creation on kind alone, which is the case worth covering
first: it is the one `159cdeca` hit.

## Implementation steps

### 1. `src/shared/harness-capabilities.ts` - the capability

```ts
/**
 * How Mission Control's OWN tools reach this harness's model.
 *
 * Distinct from `mcp`, and the distinction is the whole point of the slot. `mcp` describes
 * registering our server with a vendor's MCP CLIENT through that vendor's CLI - it is null
 * for a harness that has no such client, which is a fact about the vendor. This asks
 * whether our tools reach the model AT ALL, and by what route, which is a fact about
 * Mission Control's integration. Pi answers null to the first and non-null to the second.
 *
 * `scope` is the half a dispatch cannot infer: a registration that rides the launch argv is
 * verifiable from that launch and reaches nothing else, while a machine-wide install reaches
 * a session an operator started themselves and cannot be seen in any argv.
 */
export interface MissionToolsSpec {
  mechanism: "mcp-client" | "installed-extension";
  scope: "launch" | "machine";
}
```

Add `missionTools: MissionToolsSpec | null` to `HarnessCapabilitiesBase`. Null is a real answer
and means our tools cannot reach this harness's model by any route - no shipped harness declares
it, so it needs a `withCapabilityNull` fixture in `harness-capabilities.test.ts` (see that test's
`BY_FIXTURE` discipline).

Declarations:

- `claude`: `{ mechanism: "mcp-client", scope: "launch" }`
- `codex`: `{ mechanism: "mcp-client", scope: "launch" }`
- `pi`: `{ mechanism: "installed-extension", scope: "machine" }`

Pi declares the mechanism **now**, before Phase 4 exists, and that is deliberate: the
capability says how the tools would reach Pi, and the guard below asks separately whether they
currently do. Conflating "this harness has no route" with "the route is not installed on this
machine" is the same mistake as the current message asking about a bundle.

Also add the composed refusal sentence beside `workQueueUnsupportedWhy`, for the reason that
function gives - one sentence, three surfaces:

```ts
export function missionToolsUnavailableWhy(agent: AgentType): string | null
```

### 2. `src/server/ask-channel.ts`

Add `missionMcp: boolean` to `AskChannelContribution`, `false` on `ASK_CHANNEL_OFF`, and
`descriptor !== null` on the success path - mirroring `prepareCodexLaunch` exactly, including
the field name, so the dispatcher reads one name from both builders.

### 3. `src/server/dispatcher.ts`

```ts
// Which question to ask depends on HOW our tools reach this harness, and the harness is the
// only thing that knows. A launch-scoped registration is verifiable from the launch that
// built it - so ask the builder, which is the reading a half-failed builder cannot
// contradict. A machine-wide install rides no argv at all, so the launch has nothing to
// report and the honest question is whether the install is there.
const missionTools = capabilitiesFor(task.agent).missionTools;
const missionMcpRegistered =
  missionTools?.mechanism === "mcp-client"
    ? codexLaunch.missionMcp || askChannel.missionMcp
    : missionTools?.mechanism === "installed-extension"
      ? await this.deps.piExtensionInstalled()   // Phase 4/6 supply the probe
      : false;
```

Until Phase 6's check exists, the `installed-extension` arm has nothing to consult. Rather than
stub it optimistically, this phase makes it answer **false** and refuse with the right sentence.
That is the same refusal Pi gets today, moved earlier and correctly worded - and it is a
deliberate no-op-in-effect for Claude and Codex, whose argv is unchanged.

Rewrite the error message so it names the mechanism instead of asking about a bundle:

- `mcp-client`: keep today's sentence, which is correct for that mechanism.
- `installed-extension`: say that the Pi integration is not installed on this machine and name
  what installs it. Do **not** mention `npm run build`; that is the other mechanism's remedy and
  it is exactly the misdirection this phase removes.

### 4. Refuse at acceptance, not only at dispatch

In `tasks.ts` beside the `multiRepoDispatch` refusal at line 3120, refuse a task whose
`kindMissionMcpRequirement` is non-empty when the agent's `missionTools` cannot be satisfied.
Cover the same ground in `task-repository-preparation.ts` if that is where the pre-worktree
boundary actually sits - verify which of the two runs first for a dispatched task rather than
assuming.

This is the part that delivers the phase's stated outcome. The dispatcher guard is the
backstop; this is the fix.

## Data and compatibility

No persisted change. `MissionToolsSpec` is an in-memory capability; the refusal is computed per
launch. No task row changes shape.

A `plan` or `scout` task already sitting in the backlog for Pi will now be refused at dispatch
with a better message rather than a worse one. Confirm it is refused rather than silently
dropped, and that the task's error is visible on its card.

## Verification

```sh
npm run typecheck
npm run lint
node --test --import ./test/setup-state.mjs --import tsx test/harness-capabilities.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/mission-mcp.test.ts
npm test
```

Tests to add:

- `missionTools` is non-null for all three shipped harnesses, and the null path has a fixture.
- Claude and Codex dispatches carry byte-identical argv to before this phase. This is the
  regression that matters: the guard changed, the argv must not.
- `askChannelContribution("claude", …).missionMcp` is true when the bundle exists and false when
  it does not, and `("pi", …)` is false.
- A Pi `plan` task is refused **at creation or preparation**, before a worktree exists. Assert
  on the absence of the worktree, not only on the error string - the whole point is where the
  refusal happens.
- The refusal sentence for `installed-extension` does not contain `npm run build`.

## Merge and exit criteria

- No expression in `dispatcher.ts` branches on a concrete agent id to answer whether our tools
  reached the launch.
- A Pi plan or scout task is refused before a worktree is cut, with a sentence naming the Pi
  integration rather than the MCP bundle.
- Claude and Codex dispatch argv is unchanged, proven by test.
- `verifyMissionMcpTools` is untouched.

## Downstream handoff

Phase 4 may rely on:

- `capabilitiesFor("pi").missionTools` being
  `{ mechanism: "installed-extension", scope: "machine" }`.
- A single place - the `installed-extension` arm above - to make answer true once the extension
  is installable. Phase 4 supplies the probe behind `deps.piExtensionInstalled`, and Phase 6
  replaces it with the environment check's own reading so there is one answer rather than two.

Phase 4 must not:

- Set `mcp` non-null for Pi.
- Add a second place that decides whether Pi can carry the tools.

## Cross-phase audit record

- After Phase 1: no contradiction. Different slot on the same record; `MultiRepoDispatchSpec`
  and `MissionToolsSpec` are independent, and both add a `BY_FIXTURE` entry to
  `harness-capabilities.test.ts` - whichever merges second must keep the other's entry rather
  than overwriting the list.
- After Phase 2: adjacent edits in `dispatcher.ts`, no shared expression.
- After Phase 4: one reconciliation moved here. The probe seam (`deps.piExtensionInstalled`) was
  originally going to be introduced in Phase 4, which would have left this phase's
  `installed-extension` arm as a bare `false` with no way to become true - a dead branch that a
  reviewer would reasonably ask to delete. Declaring the seam here, answering false, and
  documenting who fills it keeps the branch live and reviewable.
- **Noted for Phase 6:** two things must not both decide whether the extension is installed.
  Phase 6 owns the reading; Phase 4's probe is temporary and Phase 6 replaces it.
