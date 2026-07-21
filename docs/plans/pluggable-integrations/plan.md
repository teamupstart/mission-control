# Pluggable integrations: harnesses, multiplexers, terminals

Mission Control hardcodes three vendors: Claude Code, tmux, and WezTerm. Adding a fourth
agent (`pi`), a different multiplexer (`cmux`, `zellij`), or a different terminal (Ghostty,
iTerm2) currently means editing dozens of unrelated files and hoping you found them all.

This plan defines the interfaces those integrations should sit behind, and sequences the
migration of the existing code onto them.

## The finding, in one sentence

There is no abstraction today - `src/server/harnesses.ts` is a 24-line settings blob, not a
harness registry - and the ~35 `if (agent !== "claude")` guards plus ~20 open-coded
`if (session.tmux) … else if (session.wezterm) …` branches mean **a new integration degrades
silently rather than failing to compile**.

## Evidence

### Agent coupling (claude / codex)

| Capability | Where it is hardcoded |
|---|---|
| Process detection | ~~`discovery/processes.ts:47-90` - literal argv signatures per agent~~ **closed**: `Harness.detect` |
| Binary resolution | ~~**three** independent paths: `config.ts` `AGENT_BINS`, `claude-cli.ts:26`, `main/integrations.ts:184`~~ **two of three closed**: `Harness.bin` + one `resolveAgentBin`. `main/integrations.ts:184` belongs to the hooks/MCP-install row |
| Transcript | `transcript.ts:51` hard `return null` for non-Claude; Anthropic JSONL shape throughout (`:115-155`, `:500-505`, `:584`) |
| Rollout (codex) | `codex-rollout.ts` - metadata only, no message parsing |
| Dispatch point | `runtime-meta.ts:43-58` - an explicit `if claude … else if codex`. This is where the interface belongs. |
| ~~Hook -> state~~ | **Closed.** `Harness.hooks` - see "`hooks`, as landed" below |
| TUI mode line | **Closed.** `harness.tui.modeLine`; `pane-mode.ts` keeps the scan |
| TUI dialogs | **Closed.** `harness.tui.dialog`; the grammar was never Claude-specific - see below |
| Paste settle | `actions.ts:311` `PASTE_SETTLE_MS = 400`, measured against Claude Code 2.1.215 |
| Paste placeholder | `discovery/pane-paste.ts:37` - Claude's `[Pasted text #N]` |
| Skills | ~~`skills/reconcile.ts:48-53`, `shared/skills.ts:73` `/reload-skills`~~ - **closed**, `Harness.skills` |
| Hooks + MCP install | **closed** - the event vocabulary is `Harness.hooks`, the MCP registration is `Harness.mcp`. `hooks/install.mjs` still writes `~/.claude/settings.json` because that path is Claude's, not ours. |
| Model windows | `shared/model.ts:96-101` - only Claude families get a non-200k default |

The union itself was written out **three** times (`shared/types.ts`, `shared/protocol.ts`,
`web/lib/api.ts`) and `AGENT_LABEL` **twice**, holding different values for the same key -
`session-bits.tsx` said "Claude Code" where `TranscriptPanel.tsx` said "claude". **Phase 0
collapsed both**: `AGENT_TYPES` (`shared/types.ts`) is the one source the zod enum and the
dashboard's dispatch input now derive from, and `AGENT_NAMES` (`shared/agent.ts`) holds the
two registers as named fields (`label`, `speaker`) so neither can be mistaken for drift.

**The first five rows, the hook row, and skills / MCP / permission modes are closed.**
`Harness.transcript` (`server/harness/types.ts`) owns transcript, rollout, and the dispatch
point between them: `runtime-meta.ts` names no agent, Claude's JSONL shape lives in
`harness/claude/`, the rollout in `harness/codex/`, and the byte windowing that belongs to
neither sits in `transcript.ts` behind a supplied line parser. `Harness.detect` and
`Harness.bin` then closed the first two: `discovery/processes.ts` iterates the registry, and
one `resolveAgentBin` serves both things that spawn an agent CLI. See "`transcript`, as
landed", "`hooks`, as landed", "Capability guards, as landed" and "`detect` and `bin`, as
landed" below.

**The paste settle and paste placeholder rows are closed too.** `Harness.control`
(`ControlSpec`) owns both: the measured settle window and Claude's `[Pasted text #N]` regex
live in `harness/claude/control.ts`, Codex declares `pastePlaceholder: null` instead of
inheriting a regex it could never match, and `actions.ts` holds no per-agent constant -
`hasPendingPaste` is handed the placeholder rather than owning one. See "`control`, as
landed" below.

Before Phase 0, only **four** `Record<AgentType, …>` maps would fail to compile on a new
agent. Everything else silently does nothing, and that asymmetry is the core problem. Phase 0
took it to **six** - `shared/agent.ts`, `shared/cost.ts`, `shared/goal.ts`, `shared/model.ts`,
`server/config.ts`, `server/goal/source.ts` - which is the list `session-contracts.test.ts`
pins by adding a probe agent id and asserting each one fails to typecheck. The transcript
item swapped one of those for `server/harness/index.ts`: the per-agent `GoalSource` record
WAS that capability spelled twice, and one `Harness` entry forces a decision about every
capability at once rather than about one reader. The detection/bin item folded
`server/config.ts` in the same way - `AGENT_BINS` was the bin capability spelled where the
harnesses could not see it - so the list is `shared/agent.ts`, `shared/cost.ts`,
`shared/goal.ts`, `shared/model.ts`, `server/harness/index.ts`, plus
`shared/harness-capabilities.ts`, which the capability-guards item added beside it: the two
harness records are a purity split, not a second vocabulary; see "Capability guards, as
landed". The rows still marked silent in the table above are the ones nothing yet forces.

### Terminal coupling (tmux / wezterm)

`wezterm.ts` and `tmux.ts` are **not parallel** - they diverge in shape, in where their
code lives, and in which capabilities exist at all:

| | wezterm.ts | tmux.ts |
|---|---|---|
| bin resolution | `resolveWeztermBin()`, `WEZTERM_BIN` | literal `"tmux"` at ~19 inline call sites |
| pane id type | `number` | `string` (`"%3"`) |
| cwd | `file://` URL, needs `weztermCwdToPath` | plain path |
| spawn | `spawnWeztermTab` (used only as a focus fallback) | lives in `dispatcher.ts:449-468`, not in `tmux.ts` |
| retitle | `setWeztermTabTitle` | inline in `actions.ts:1090` |
| copy-mode probe | none - no such concept | `readTmuxPaneMode:57-71` |
| focus | `activateWeztermPane:83-87` | cannot focus alone |
| kill group | none - SIGTERM only (`actions.ts:1234`) | `kill-session` |

Duplicated pane-token functions, in **two spellings**: `actions.ts` (the write lock) and
`pane-mode.ts` (the capture-miss counter) emitted `wezterm:`; `registry.ts` (the hook
overlay) and `foreman/queue-apply.ts` (the pane-recreated guard) emitted `wez:`. Each
subsystem was internally consistent, so there was no live defect - but it was four copies of
one function waiting for a fifth backend. **Phase 0 collapsed them** into `paneToken`
(`shared/pane.ts`) on the `wezterm:` spelling, tmux being unabbreviated too; no token is
persisted, so the format was free to change. `test/pane-lock.test.ts` pins the agreement.

## The design

### Three axes, not one

The request was "one interface per integration point". The investigation says there are
**three** axes, and folding them together would be the design error:

1. **Harness** - the agent process. Detection, transcript, live state, TUI grammar, skills,
   hook/MCP installation. (`claude`, `codex`, `pi`)
2. **Terminal** - which itself splits in two (below).
3. **Headless runner** - the `claude -p` calls behind Foreman triage, goal refinement, task
   titling, away digests and the Inspector (`claude-cli.ts`, plus their per-caller model
   constants). This is a *model provider* axis, orthogonal to which agent the observed
   session runs. Keep it separate; conflating it would mean you cannot review a Pi session
   with Claude, or a Claude session with a cheaper local model.

#### `LlmRunner` must guarantee context isolation, not just shape

"One-shot text completion with a model id and a prompt" describes the signature and misses
the contract. Today the guarantee comes from three flags that are **absent** in
`claude-cli.ts` - no `--resume`, no `--continue`, no `--session-id` - which is why that
file now carries a comment saying so. Without one of those, every run mints a new session
with an empty context.

That is a correctness property, because the Foreman reviews *many* sessions. Any
implementation that carried context between calls would grow it monotonically across every
session it ever looked at, and let session A's transcript influence the verdict on session
B. The tempting version is a warm held-open process to skip the spawn: measured, that is
~1.8-2.4s of a 4-6s call, and the prompt cache is server-side so a cold process still gets
a cache read. Almost nothing to buy, a correctness property to lose.

So the interface states isolation explicitly, and offers the only safe form of memory as a
named opt-in:

```ts
interface LlmRunner {
  /** Fresh context every call. The default, and what Foreman requires. */
  run(prompt: string, opts: RunOpts): Promise<string>;
  /**
   * Optional: one conversation per SUPERVISED SESSION, never one shared across sessions.
   * `claude -p --session-id <uuid>` then `--resume`. Null when unsupported.
   */
  runInThread: ((threadKey: string, prompt: string, opts: RunOpts) => Promise<string>) | null;
}
```

`RunOpts` cannot be just `{ model, timeoutMs }`. The Inspector already grants tools and
pays for it with a working directory and a `--settings` deny-list (`ClaudeRunOptions.tools`
/ `cwd` / `settings`), so the interface has to carry a *sandboxing* shape, not only a model
id - and a runner backed by something other than `claude -p` has to be able to say it
cannot honour one. Treat `tools` as the capability boundary it is: the default of every
tool disabled is what makes it safe to embed untrusted transcript and repo text in a
prompt, and that default must survive being put behind an interface.

Also note the naming collision to avoid: phase 4 was titled "Headless", and this plan means
*which model does offline work*. It does not mean driving an agent without a terminal -
that is the `control` capability on the Harness axis. Rename one of them before both exist
in the codebase.

**Resolved, that way round.** The phase is renamed to "LLM runner" below and the new code
says `llm`, never `headless`. "Headless" keeps the meaning it already has on disk -
`HEADLESS_CWD`, `MISSION_HEADLESS`, `headlessTranscriptDir`, `goal/prune.ts` - which is an
offline run of the app's own, and one of those is read by a hook script installed globally
from a checkout that may lag this code, so it was never the cheap side to rename. The
Harness-axis capability stays `control`; it must not acquire "headless" as a nickname.

#### As landed

`@shared/llm.ts` holds the contract (pure, no `node:` imports - the web bundle imports it),
`src/server/llm/claude.ts` the `claude -p` implementation, `src/server/llm/index.ts` the
`Record<LlmRunnerId, LlmRunner>`. Three deltas from the sketch above, each forced by a real
caller:

- **`RunOpts.grant`, one object, not three sibling options.** `tools` / `cwd` / `denyPaths`
  are one decision - the tools are what make an untrusted prompt dangerous, the cwd is what
  bounds them, the deny list is what carves the credential stores back out - so a shape that
  let a caller pass one without the others would make the unsafe call the easy one. A
  runner declares `sandbox: LlmSandboxSpec | null`, and a grant it cannot fully honour is
  refused before the spawn rather than partly applied (`grantRefusal`). `denyPaths` are
  provider-neutral globs; rendering them into `claude`'s `--settings` is the runner's job,
  and `llm-runner-contract.test.ts` pins that rendering byte-for-byte against the
  Inspector's live constant so migrating that call site is a provable no-op.
- **`run()` returns the model's text, envelope already off.** The envelope exists because
  the runner passed `--output-format json`; a caller unwrapping it is undoing its own
  runner's flag.
- **`litter: LlmLitterSpec | null` and `killLiveRuns()`.** What a run leaves behind is part
  of the contract, not an implementation detail: nothing read or deleted these transcripts
  until `goal/prune.ts` existed, by which point 153 of 250 sampled on one machine were the
  app's own.

`runInThread` is `null` for `claude`, matching today's behaviour exactly - the shape is
`--session-id <uuid>` then `--resume`, and nothing wants it yet.

#### Which model, as opposed to how it is called

Deliberately NOT in `@shared/llm.ts`, because a third spelling of this is the actual mess:

- `@shared/foreman-models.ts` is already the right shape - four roles, each resolving
  config key -> env var -> shipped fallback, and *reporting which of the three won* so the
  settings panel cannot display a default the worker does not spawn with. Pure and in
  `shared` for the same reason `cost.ts` is: the worker spawns with the answer and the
  panel renders it.
- `task-title.ts:20`, `away/digest.ts:17`, `goal/refiner.ts:39` are bare
  `envVar(…) ?? "claude-haiku-4-5"` - no config key, nothing surfacing them in the UI.
- `inspector/worker.ts:92` is `cfg.model ?? envVar("INSPECTOR_MODEL")`, a third spelling.

The next item generalises `foreman-models.ts` to hold every role and moves those four onto
it. It does not start a second list under `llm.ts`; a runner answers "how is a model
called", a role answers "which model", and only the first one is the runner's.

### Terminal is two interfaces, because tmux and wezterm are not peers

A tmux pane lives *inside* a wezterm pane. `wezterm.ts:117-140` exists solely to join them
by shared tty, and `actions.ts:1149-1185` shows focus for a tmux session is a **composition**:
select-pane, then select-window, then find the hosting wezterm tab, then activate it, then
fall back to spawning `tmux attach` in a new tab.

So:

- **`Multiplexer`** - named persistent sessions, panes, splits, detach/reattach, copy-mode.
  Can address a pane; generally *cannot* raise a window. (tmux, zellij, screen, cmux)
- **`TerminalEmulator`** - windows and tabs, focus/raise, spawn, tab titles. No persistence,
  no session names. (wezterm, Ghostty, iTerm2, kitty, Terminal.app)

Plus a documented composition rule: a session may hold a multiplexer handle, an emulator
handle, or both; writes prefer the innermost (multiplexer), focus walks outward.

**Landed** in `src/server/terminal/` - `types.ts` (both interfaces, the `Key` vocabulary,
`BinSpec`), `registry.ts` (`MULTIPLEXERS` / `EMULATORS`, plus `bindPane` and `hostPanesFor`,
which are the composition rule made executable), `tmux.ts` and `wezterm.ts`, `exec.ts` (the
subprocess seam the adapters are testable through) and `bin.ts`. No call site is migrated
yet; the adapters are mechanism only, and the copy-mode refusal, pane lock, paste settle and
submit read-back stay in `actions.ts` as the policy that composes them.

`bin.ts` closes the first row of the divergence table rather than adding to it:
`resolveWeztermBin` moved its body there as `resolveBin(BinSpec)` and `config.ts` keeps a
one-line wrapper for the call sites this phase does not reach, so the change whose purpose is
to stop copies multiplying does not land a fifth copy of bin resolution. Behavior is
unchanged (env override, then the first existing candidate, then the bare name on PATH), and
no `TMUX_BIN` env var was invented, because tmux has no such convention.

Three refinements the sketch above did not have, each forced by the existing code:

- **Keys are named, not written.** tmux takes `BTab`/`Up`, wezterm takes `\x1b[Z`/`\x1b[A`,
  and each adapter renders a `Record<Key, string>` - so a new key fails typecheck in every
  backend rather than being typed as literal text into someone's session.
- **`SpawnResult` splits "a tab opened" from "we can address it".** `spawnWeztermTab`
  returns a nullable pane id today and the focus fallback reads null as failure, which would
  make Ghostty - which opens tabs perfectly well and cannot say what it made - look broken.
  The adapter reads `spawnWeztermTabResult` instead, which reports the spawn's own
  `RunResult` beside the id, so a spawn that was killed rather than answering is not
  reported as proof that no tab exists.
- **`TerminalResult.outcomeUnknown` is required**, for the reason `RunResult` carries it: a
  `paste-buffer` that died rather than answering may be sitting in the composer, and
  `injectPrompt` re-pastes only on positive evidence of non-delivery.

Two things the migration commits will carry that a reader of their diffs must not mistake
for a pure move:

- **The adapters terminate flag parsing; the inline call sites do not.** `send-keys`,
  `new-session` and `wezterm send-text` all parse their trailing arguments as options, so a
  reply beginning with a dash (`-v is what broke it`) dies in the arg parser and never
  reaches the pane. Verified on tmux 3.6b and wezterm's clap parser; both fixed by `--`, and
  the terminator changes nothing about how what follows is read.
- **Every wezterm command in the adapter goes through `cli --no-auto-start` with
  `weztermEnv()`.** The writes in `actions.ts` and the captures in `discovery/pane-capture.ts`
  use neither, so they inherit `WEZTERM_UNIX_SOCKET` while the pane ids they are given came
  from `listWeztermPanes`, which drops it. Routing them through the adapter puts commands and
  ids on the same mux.

```mermaid
flowchart LR
  subgraph N["nesting today"]
    direction LR
    E["wezterm pane<br/>(emulator)"] --> M["tmux pane<br/>(multiplexer)"] --> A["agent process<br/>(harness)"]
  end
  A -. "writes: innermost first" .-> M
  M -. "focus: walks outward" .-> E
```

### How the call graph changes

Today `correlate.ts` and `actions.ts` import the two backend modules directly, so every
new backend edits both. After the migration they resolve an adapter from a registry and
never name a vendor.

```mermaid
flowchart TB
  subgraph B["before"]
    direction TB
    c1[correlate.ts] --> t1[tmux.ts]
    c1 --> w1[wezterm.ts]
    a1[actions.ts] --> t1
    a1 --> w1
  end
  subgraph AF["after"]
    direction TB
    c2[correlate.ts] --> reg[["MULTIPLEXERS / EMULATORS<br/>registries"]]
    a2[actions.ts] --> reg
    reg --> t2[tmux adapter]
    reg --> w2[wezterm adapter]
    reg --> g2[ghostty adapter]
  end
```

### Capability objects, not fat interfaces

This is the load-bearing decision. The candidate backends have genuinely different
capabilities:

- Ghostty has no scripting CLI at all - it can be *launched into*, but not enumerated or
  captured.
- iTerm2 scripts via AppleScript/Python, not a flag-parsing CLI.
- tmux has copy-mode; wezterm has no equivalent.
- wezterm can raise a window; tmux cannot.
- Codex has no permission modes, no skills, no `/clear`.

A flat interface with fifteen required methods forces every adapter to stub eight of them,
and stubs are where silent breakage lives. Instead: a small required core plus **optional
capability sub-objects**, where `null` is a first-class, meaningful value.

```ts
interface Harness {
  id: HarnessId;
  label: string;                  // "Claude Code"
  accent: string;                 // CSS custom property name
  detect: DetectSpec;             // argv signatures, background-process exclusions
  bin: BinSpec;                   // env vars, fallback, launch argv

  control:    ControlSpec;             // how a turn is DELIVERED - see below
  transcript: TranscriptSpec | null;   // null => no transcript pane, by declaration
  hooks:      HookSpec | null;         // null => no push instrumentation; skip the 20s wait
  tui:        TuiSpec | null;          // mode line, dialog grammar - PARSING only
  permissionModes: PermissionModeSpec | null;
  skills:     SkillSpec | null;
  mcp:        McpSpec | null;
  models:     ModelSpec;               // label(id), defaultWindow(id)
}
```

#### `control` is separate from `tui`, and not nullable

An earlier draft of this interface had no `control` slot: prompt delivery lived partly in
the Terminal axis and partly inside `tui`, whose spec carried the paste placeholder and
`PASTE_SETTLE_MS`. That is wrong in a way worth stating, because the whole point of this
refactor is to outlive the current backends.

`PASTE_SETTLE_MS = 400` was a measured property of an undocumented input-coalescing window
in one Claude build (the measurements now live in `harness/claude/control.ts`, beside the
value they justify). Putting it in the harness contract makes "you talk to an agent by
typing into its terminal" a permanent architectural assumption - and every live third-party
tool that drives Claude Code programmatically has already stopped doing that, in favour of
`claude -p --input-format stream-json --output-format stream-json`, which takes follow-up
turns on a live process with no keystrokes involved. Codex exposes the same thing as a
JSON-RPC `turn/steer`.

So delivery gets its own capability, and it is **required** - every harness must say how
you talk to it:

```ts
type ControlSpec =
  | { kind: "keystroke"; settleMs: number; pastePlaceholder: RegExp | null }
  | { kind: "stream-json" };
```

`tui` keeps mode-line and dialog *parsing*, which is about reading a screen; `settleMs` is
about writing to one and moves here. The split means a second `ControlSpec` variant is a
new implementation behind an existing slot, rather than an interface change every migrated
call site has to absorb.

Note this is the seam that makes headless dispatch possible later; it is not a commitment
to build it now. Sessions a human owns will keep `kind: "keystroke"` regardless, because
we do not own their pty.

The win is mechanical: every `if (session.agent !== "claude") return null` becomes
`if (!harness.transcript) return null`. The guard now states *why*, and a new harness that
genuinely lacks transcripts gets the identical, already-tested degradation path instead of a
code change.

#### `transcript`, as landed

`HARNESSES` (`src/server/harness/index.ts`) is the `Record<AgentType, Harness>`;
`harness/types.ts` holds the interface; `harness/claude/` and `harness/codex/` hold the two
specs. Four deltas from the sketch, each forced by something real:

- **No `label` / `accent` on `Harness`.** `AGENT_NAMES` (`@shared/agent.ts`) already owns
  naming and the web bundle imports it; a second register on a server-only object is the
  exact defect Phase 0 collapsed, re-created one layer down. The remaining slots arrive
  with their phases rather than landing as `null` placeholders nobody has designed.
- **The capability splits in two: `TranscriptSpec` and its `messages`.** "There is a file
  we can read runtime facts out of" and "that file contains the turns" are separate claims,
  and Codex is the proof - its rollout carries model / effort / tokens and no conversation.
  `messages: null` is that stated once, where every reader sees it; the alternative was a
  window read answering `[]`, which says "this session has said nothing" and is a wrong
  answer no caller can distinguish from a right one.
- **One `passiveRead` per tick, not one call per axis.** Claude's runtime metadata and its
  hook-free idle/working signal come out of the same tail read, and the poller would
  otherwise double the I/O of its own hot loop.
- **`retain`, because the cache belongs to the spec.** Finding a rollout is a dated
  directory walk, so it is cached - and that cache used to sit in the generic poller as a
  `Map<string, CodexBinding>` plus a Codex rescan constant. A third harness that also has
  to search would have added a second map beside it. The poller now hands each harness the
  live ids and lets it prune its own.

#### Capability guards, as landed

The `if (agent !== "claude")` guards named in the evidence table are gone, and the win was
the mechanical one predicted above - `if (!harness.skills)`, `if (!harness.permissionModes)`,
`if (!capabilitiesFor(agent).workQueue)`. One structural delta, forced by where the
guards actually live:

- **The registry splits by PURITY, not by capability.** Most of these guards are answered
  in the BROWSER - the dashboard decides whether to draw a mode picker, whether a
  work-queue box can exist, and what sentence to show when it cannot - and the web bundle
  cannot import a spec whose `locate` calls `statSync`. So the pure capabilities live in
  `@shared/harness-capabilities.ts` as `HARNESS_CAPABILITIES`, and `Harness extends
  HarnessCapabilities` with `HARNESSES` spreading that record in. A server call site
  holding a harness still reads every slot off one object; the two records force disjoint
  questions (the shared one asks for permission modes, skills, work queue, context
  clearing and MCP; the server one asks only for `transcript`), so neither is a copy of
  the other and a new harness that fills in one and not the other does not compile.
  `session-contracts.test.ts` pins both.
- **Absences that reach a human carry their sentence.** `workQueueUnsupportedWhy`
  composes from `AGENT_NAMES`, so the panel's refusal, `ensureQueue`'s refusal and the
  re-attach button's refusal are one sentence - and a fourth harness gets a true one
  rather than inheriting Codex's. Same for the mode routes' 400 and the skills panel's
  per-row chip, which used to be three literals containing the word "Claude".
- **`permissionModes` carries `onDispatch`, not just `pickable`.** They answer different
  questions - what a human may choose, versus what "auto mode on dispatch" promises on
  the operator's behalf - and the dispatcher's guard was the literal `"auto"` sitting
  behind an agent id.
- **`ModePicker` owns its own absence**, so the three layouts mount it unconditionally
  and none of them carries an agent check. That is the layout-parity rule paying off: one
  guard in the leaf rather than the same guard in Cards, Console detail and Board detail,
  where the third one is always the one left behind.

The **`/clear` defect is fixed** by the same slot: `resetToOrigin` reads
`harness.clearContext` and a null lands on the byte-identical `cleared: false` a pane-less
session has always produced - and types nothing. `resetPreview.canClear` reflects it too,
so the modal stops offering a checkbox that would submit `/clear` as a prompt. The
read-back in `awaitClearProcessed` now checks for the bytes that were typed rather than a
literal `/clear`, so a harness whose command is spelled differently is not reported as
never having echoed anything. Test: `harness-capabilities.test.ts`, which pins each null
against the pre-existing degradation rather than against a new shape.

Two guards were deliberately NOT converted here, because their WHY belongs to a slot that
has not landed: `discovery/processes.ts`'s argv signatures (`detect`) and
`agents-shadow.ts`, which reads Claude's own `~/.claude` session-state files - a shadow
reader that has no slot yet and is not `hooks` (nothing is pushed) or `transcript`
(it is not the conversation).
`annotatePaneState` is gated on `permissionModes` as instructed, which is exactly today's
behaviour - but the dialog half of that function is really `tui`, and the Codex-reads-as-idle
defect below moves with it.

`transcript.ts` keeps what is about bytes rather than about a vendor - head/tail windows,
the forward-from-an-offset read, the stream reads - and takes the line parser from the
harness. `server/goal/source.ts`'s `Record<AgentType, GoalSource>` is gone: it was this
capability spelled a second time, and `session-contracts.test.ts` pins `HARNESSES` in its
place. Tests: `harness-transcript.test.ts` (the registry, and that a null capability
degrades to the byte-identical `{unavailable: true}` / `{size: null}` a missing file
produces), `session-contracts.test.ts`.

#### `hooks`, as landed

`HookSpec` (`harness/types.ts`) and `harness/claude/hooks.ts`. What moved off `registry.ts`
is `hookToState`'s nine-case switch, `isIdleNudge`'s match on Claude's literal notification
text, and goal capture's `evt.event !== "UserPromptSubmit"` gate - the last folded together
with `substantivePrompt` into one `promptText`, because "which event carries a prompt" and
"what inside it a human typed" are the same harness's answer and were being asked one layer
apart.

The transport did NOT move, deliberately and as `todo/codex-instrumentation.md` predicted:
`HookIngestSchema`, `POST /hooks/:event` and the pane-keyed overlay name no vendor and are
reused as-is. `hooks/harness-hook.mjs` keeps Claude's payload key mapping and the two PR
sniffs and hands the rest to `@shared/hook-bridge.mjs`, which is stdin, the POST, the
timeouts and exit 0. A second agent's bridge is another file that size.

Four things the sketch above did not have:

- **The ingest declares its agent.** `HookIngest.agent`, defaulted to `claude`, because an
  event has to be interpretable before a session is resolved and the pane it arrived on
  says nothing about who is in it now. Defaulted rather than required for the reason
  `harness-runtime.mjs`'s env chain is append-only: the bridge is installed into
  `~/.claude/settings.json` from a checkout that may lag this code by any amount.
- **The overlay is agent-scoped, which is a live bug fix.** Overlays are keyed by pane and
  a pane outlives the agent in it. Quit Claude, start Codex in the same tmux pane, and the
  Codex card inherited Claude's state, activity, permission mode, `agentSessionId` and
  `transcriptPath` - reported as `instrumented`, from an agent that pushes nothing, with
  the wrong key under its note and queue. `HookOverlay.agent` and the matching check in
  `findSessionForHook` are what keep a null `hooks` on the passive path rather than pinned.
- **The event vocabulary is the spec's**, so `EVENTS` / `MATCHER_EVENTS` are gone from both
  installers. That was the one item in this plan whose duplication CLAUDE.md documented
  rather than fixed; `harness-hooks.test.ts` now fails if either installer names an event
  itself. `harness/claude/hooks.ts` is kept to types and pure functions because the Electron
  main bundle imports it.
- **[Phase 1 - hooks, FIXED]** `dispatcher.ts`'s `awaitReady` gates its 20-second wait on
  `hooksFor(agent)`. "Hooks aren't installed" is worth waiting out; "this agent has no
  hooks" is 20 seconds of certain silence, which Codex paid on every dispatch.

Tests: `harness-hooks.test.ts` (the three things a hookless harness is owed, plus the
installer drift guard), `hooks.test.ts` (the Claude vocabulary itself, now against the spec).
#### `detect` and `bin`, as landed

Two more slots on the same `Harness`, both **required** rather than nullable - a harness
nothing can find has no card at all, and one that names no binary cannot be dispatched.
`harness/<agent>/detect.ts` and `harness/<agent>/bin.ts` hold the specs;
`discovery/processes.ts` iterates the registry and names no vendor. Three deltas from the
sketch:

- **`detect` is data, not a predicate.** `commands` (matched two ways - argv0's basename,
  and a bare token under a `WRAPPERS` launcher, because those are the same fact),
  `argvSignatures` (substrings that see through a re-exec or a node shim), and
  `background`. A spec that hid its rules inside a `match(command)` could not be audited,
  and the audit is the point: `detection.test.ts` asserts every claim about every declared
  harness, so a new one inherits the coverage instead of needing its own tests written.
- **`background` is TOKENS, and it is per harness.** Both halves are load-bearing, and the
  first one is not this item's idea - it is the shape the ask-channel work arrived at after
  two rewrites, because a dispatched session's argv now carries a state-dir path and a
  ~1.2KB inline prompt, so anything decided by searching the raw command line can be
  reached by an operator's directory name (`~/daemon-state`) or by prompt prose quoting
  `--bg-pty-host`. Both were observed making real agents undetectable. The spec therefore
  declares `subcommands` and `flags`, matched at argv[1]/argv[2] only, and
  `isBackgroundAgent` keeps that logic exactly. What changed is WHOSE vocabulary is asked:
  it was one global list consulted BEFORE classification, so Claude Code's `bg-pty-host`
  was tried against every process on the machine - harmless with two harnesses, and the way
  one vendor's exclusion starts hiding another vendor's sessions with three. Now the
  command is classified first and its own harness is asked, which is why Codex declares
  `mcp serve` (it was in that global list) and not `daemon` / `bg-pty-host` / `bg-spare`
  (Claude Code internals, and a lie on a Codex spec). Answers for a real Claude line are
  unchanged, and `process-background-filter.test.ts` pins that against verbatim `ps`
  output.
- **`bin` names env vars, it does not read them.** `resolveAgentBin` (`harness/index.ts`)
  is the single resolver, for a dispatched session and a headless run alike. It could not
  stay in `config.ts`: the map was there while `claude-cli.ts` kept a second,
  differently-ordered chain beside it, so `MISSION_CLAUDE_BIN` pointed at a wrapper reached
  one and not the other. `legacyEnv` is the raw-key slot that let that second chain be
  deleted without dropping `FOREMAN_CLAUDE_BIN`, which cannot be spelled as a `MISSION_`
  suffix - it now resolves for dispatch too, which is what the README always said it
  aliased.

Verified as a no-op the only way that claim is worth anything: the old `nativeAgent` /
`classifyAgent` / `isBackgroundAgent` were run beside the new ones over every command line
on a live machine (~1,000 of them) plus the background and wrapper edge cases, with zero
differences except one, named rather than found: `codex daemon` was excluded by that
global list and is not excluded by Codex's own spec. Codex has no `daemon` subcommand, so
nothing on a real machine changes. Tests: `detection.test.ts` and `harness-bin.test.ts`,
table-driven off the registry, plus `process-background-filter.test.ts` unchanged.

#### `control`, as landed

`ControlSpec` sits on `Harness` exactly as sketched - required, never `null` - with the two
specs in `harness/claude/control.ts` and `harness/codex/control.ts` and `controlFor(session)`
as the one way the delivery path asks. Two deltas from the sketch:

- **The keystroke variant also carries `collapses(text)`.** Saying what the placeholder
  LOOKS like without saying when it APPEARS leaves the one reading that can establish a
  pending paste taken on faith, and "a paste collapses only when it is multi-line" was one
  more guess about a single TUI applied to every agent. The delivery path asks the two at
  different moments, so they are separate fields that have to move together.
- **`InjectResult.submitVerified` is required, not optional.** For the reason
  `TerminalResult.outcomeUnknown` is: an optional flag defaults the decision to whoever
  forgot it, and this is precisely the decision that was being defaulted - a verified Claude
  submit and an unverified Codex one used to be byte-identical at the call site.

`stream-json` is declared and deliberately unimplemented: `injectPrompt` and
`paneAcceptsPrompt` refuse a non-keystroke harness by name rather than falling through to
the pane paths and typing at nothing. Tests: `harness-control.test.ts` (every harness
declares a delivery; a null placeholder is a capability absence and not "the composer is
clear"; ok-without-evidence is reported as unverified), `inject-prompt-submit.test.ts`,
which now takes Claude's placeholder from its harness rather than restating the regex.

#### `tui`, as landed - and the assumption it overturned

This item was scoped as "move 397 lines of Claude menu grammar behind an interface". That
scoping was wrong, and the way it was wrong is the most useful thing this phase produced.

`annotatePaneState` opened with `if (s.agent !== "claude")`, and the comment directly above
it said Codex "doesn't render these dialogs". **Nobody had ever checked**, because the guard
guaranteed the parser was never pointed at a Codex pane. Driven live against codex-cli
0.144.1 in a tmux pane, all three dialogs it renders - command approval, directory trust,
update prompt - returned `null` from the existing parser and parsed *perfectly* once one
token changed. Not the numbering, not the prompt scan, not the wrap rejoining, not the
label compare: **the cursor glyph**, U+203A where Claude draws U+276F.

So the grammar is not Claude's. It is the same machinery/vendor split `transcript.ts`
already makes - a numbered block with one cursor on it, a question wrapped across a
viewport, a label compared across a hard wrap are facts about TERMINALS - and moving it
into `harness/claude/` would have buried a capability Codex could always have had inside the
one agent's directory. `discovery/pane-dialog.ts` therefore keeps the grammar and takes a
`DialogSpec`; the harness supplies the glyph and its own form vocabulary.

What that cost, for as long as it went unmeasured: Codex sends **no hooks**, so
`activePaneDialog` is the only "needs you" evidence a Codex card can ever produce. A Codex
session parked on a command-approval prompt - the most definitively blocked thing on a board
- was never once surfaced as needing anyone.

Three deltas from the sketch above:

- **`repaintTimeoutMs` sits on `TuiSpec`, not on the mode-line capability.** Both walks need
  it: the mode cycle waits for the footer to redraw, the dialog walks wait for the cursor to
  move. It is one fact about how fast an agent paints, and it was already being spent on
  dialogs while living in a constant named for Shift+Tab.
- **`DialogFormSpec` is its own nullable sub-capability**, the same shape as
  `TranscriptSpec.messages`. "This agent draws menus" and "this agent draws forms you fill
  in and submit" are separate claims, and every word of the form vocabulary
  (`submit answers`, `type something`, `have not answered all questions`) is one agent's
  own. Codex declares `form: null`, so a bracketed row keeps its brackets in the label -
  the same path a Claude permission prompt quoting a `[ ]` already took.
- **`modeLine: null` for Codex is a real refusal, not a gap.** `setPermissionMode` now
  answers "this agent has no permission modes" by declaration rather than walking a cycle
  that does not exist, and no mode chip is invented for a card that has no modes.

The ask channel (`docs/plans/ask-channel/plan.md`) landed first, which was the right order
and did not shrink this item the way it was expected to: it disallows `AskUserQuestion` only
on sessions the harness DISPATCHES, so human-started sessions still render those forms and
**every** permission prompt on every session still renders a menu. No grammar was deleted,
and none should be.

Tests: `harness-tui.test.ts`, with `test/fixtures/codex-panes.ts` holding the verbatim
captures. Note the fixture rule from `claude-panes.ts` applies: recapture, never hand-write.

### Compiler enforcement

The codebase already has this pattern - `SESSION_FIELD_COMPARATORS` (`registry.ts`) makes a
new `Session` field fail typecheck until it is given a comparator, and
`session-contracts.test.ts` guards it.

Apply the same shape here: `HARNESS_CAPABILITIES: Record<HarnessId, HarnessCapabilities>`,
`HARNESSES: Record<HarnessId, Harness>`, `MULTIPLEXERS: Record<MultiplexerId, Multiplexer>`,
`EMULATORS: Record<EmulatorId, TerminalEmulator>`.
A new id then cannot compile until every capability is either implemented or explicitly
declared `null`. "I forgot skills exist" stops being a possible outcome.

## Structural blockers

Three places assume exactly two backends as *named fields*, and no adapter work can land
cleanly until they become lists:

1. `DiscoveryInput` (`correlate.ts:78-82`) - `{ procs, tmux, wezterm }`, with
   `gatherDiscoveryInput` unconditionally `Promise.all`-ing both listers.
2. `Session.tmux` / `Session.wezterm` (`shared/types.ts:140-141`) - two nullable siblings,
   with per-field SSE comparators at `registry.ts:2237-2238` and ~20 call sites doing
   `Boolean(s.tmux || s.wezterm)` as a stand-in for "can we type here?".
3. `Task.tmuxSession` (`shared/types.ts:830`) - persisted as `tmux_session`
   (`db.ts:109`) and driving **destructive teardown** (`dispatcher.ts:408-421`). Generalizing
   it is a schema migration, not a rename, and needs an `addColumn` call in `migrate()`.

## Sequence

Phase 0 landed first because it shrinks every later diff and carries no behavior change.
Phase 3 is deliberately last: it is the only phase that can lose someone's worktree.

| Phase | Items |
|---|---|
| 0 - Seams **(landed)** | `AGENT_TYPES` + `AGENT_NAMES` as the one agent-union source (`shared/types.ts`, `shared/agent.ts`); one pane token (`shared/pane.ts`); the already-neutral helpers lifted out of the Claude modules into `server/util/file-tail.ts` (`readTailLines`) and `server/discovery/capture-tolerance.ts` (capture-miss tolerance) |
| 1 - Harness | Interface + registry **(landed)**; transcript **(landed)**; hooks **(landed)**; detection/bin **(landed)**; capability guards - skills, permission modes, work queue, context clearing, MCP **(landed)**; TUI **(landed)**; control **(landed)**; then UI |
| 2 - Terminal | `Multiplexer` + `TerminalEmulator` interfaces; enumeration, pane I/O, focus/spawn/kill |
| 3 - Structural | `Session` handle list; `Task.tmuxSession` migration; de-tmux user-visible strings |
| 4 - LLM runner | `LlmRunner` interface + registry (**landed**); then the model-role ladder, then the call sites: Foreman's four, the Inspector, goal refiner, task titling, away digest |
| 5 - Proof | A third adapter on each axis, written *only* against the interface |

### Decisions taken

- **All four candidate adapters are queued** (Ghostty, cmux, iTerm2, pi), not just one per axis.
  Ghostty and iTerm2 together are the real test of the emulator boundary: one has no
  scripting CLI, the other scripts via AppleScript/Python rather than a flag-parsing binary.
  If the interface only fits things shaped like `wezterm cli`, both will expose it.
- **The headless-runner axis is in scope** (Phase 4). Foreman should be able to triage a Pi
  session with Pi, or run titling on a cheaper local model. It stays a *separate* interface
  from `Harness` - the observed agent and the evaluating model are independent choices.
- **The six drive-by defects are folded into the migration items**, not queued separately.
  Each is fixed by the phase that rewrites its file, and the item says so explicitly, so the
  fix lands with a test rather than as a patch that the refactor later reverts.

## Acceptance

The migration is not done when the interfaces exist. It is done when a new implementation can
be added without touching shared code. Phase 5 is the test:

- A **`pi` harness** that discovers, names, focuses, and accepts typed input - and whose
  unsupported capabilities are visibly disabled in the UI rather than silently absent.
  Spike first, as `todo/codex-instrumentation.md` did for Codex.
- A **Ghostty** emulator adapter, which supports spawn and focus but **not** enumeration or
  capture - proving the capability-null path is real and not decorative.
- An **iTerm2** emulator adapter, driven by AppleScript/Python rather than a CLI - proving
  the boundary is not accidentally shaped like "a binary we pass flags to".
- A **cmux** multiplexer adapter - the same exercise on the multiplexer axis.

If any of the four requires editing a file outside its own adapter, the interface is wrong.

## Fixes found along the way

Real defects, each folded into the migration item that rewrites its file rather than queued
separately. The item that owns each fix is named in brackets.

- **[Phase 1 - TUI, FIXED]** `pane-mode.ts:126-133` - `annotatePaneState` filtered to
  Claude, so `paneDialog` was never set for Codex. Since `activePaneDialog` is the only
  hookless "needs-you" evidence (`shared/session.ts:172`), **a Codex session parked on a
  prompt was never surfaced as needing anyone**. The most user-visible of the six, and worse
  than the entry above assumed: the fix is not "degrade honestly because we cannot see", it
  is that we *could* see all along. Codex's dialogs parse with the existing grammar once the
  harness supplies its own cursor glyph. `annotatePaneState` now asks
  `dialogSpecFor(s.agent)`, and a harness that genuinely draws nothing readable leaves
  `paneDialog` untouched rather than asserting "no menu" about a screen it never read.
- **[Phase 1 - control, FIXED]** `pane-paste.ts:37` + `actions.ts:344-379` - submit
  verification looked for Claude's paste placeholder, so for Codex `hasPendingPaste` was
  always false and `awaitPasteSubmitted` returned `ok` after one Enter with zero evidence.
  The placeholder now lives on `harness.control` as `ControlSpec.pastePlaceholder`, which
  Codex declares `null`; `hasPendingPaste` takes it rather than owning one. The delivery path
  reads that absence and spends exactly ONE Enter - the retries are safe only because a
  visible placeholder proves the composer has focus - and reports the outcome as
  `submitVerified: false` instead of returning `ok` having proved nothing.
- **[Phase 1 - guards, FIXED]** `actions.ts:1418` - `resetToOrigin` sent `/clear`, a Claude
  slash command, to **every** agent type, ungated. It now reads `Harness.clearContext`, and
  a harness that declares none has its context left alone: `cleared: false`, zero
  keystrokes, and `canClear` false so the modal does not offer the checkbox. Test:
  `harness-capabilities.test.ts`.
- **[Phase 1 - hooks, FIXED]** `dispatcher.ts` - every dispatch waited `HOOK_READY_MS` (20s)
  for a hook, including for agents that will never send one. `awaitReady` now gates that wait
  on `hooksFor(agent)`; see "`hooks`, as landed".
- **[Phase 1 - transcript, FIXED]** `registry.ts:700` - `findSessionByEnv` hardcoded
  `s.agent === "claude"` inside an otherwise generic env->session fallback. The condition is
  gone: that branch's safety is UNIQUENESS (exactly one session in the cwd), and filtering
  by agent did not make the match safer - it hid the one ambiguity that matters, a Claude
  and a Codex session sharing a worktree, and bound the caller to the Claude card with full
  confidence.
- **[Phase 1 - UI]** `styles.css:2657` - `--claude` doubles as the Foreman accent colour; the
  comment admits it. `AgentDot` renders `agent-${agent}`, so a new harness gets an unstyled
  dot.

## Prior art in this repo

`todo/codex-instrumentation.md` is a parked spike on exactly the Phase 1 question for Codex
(hook-vs-wrapper, blocked on a Codex login). Its conclusion - that the
`HookIngestSchema` -> `POST /hooks/:event` -> registry-overlay pipeline is already
agent-agnostic and reusable - is confirmed by this investigation, and `HookSpec` was built
on it rather than around it: the pipeline is untouched, and what landed is the vocabulary
above it plus a payload mapper below it. Its "follow-on work once the path is chosen" list
now has homes rather than open questions - a Codex live-state mapping is
`HARNESSES.codex.hooks`, no longer null; the rollout parser is
`HARNESSES.codex.transcript.messages`, still null. The spike itself is unchanged: it decides
hook-vs-wrapper, and it is still blocked on a Codex login.
