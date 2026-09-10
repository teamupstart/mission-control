import { AGENT_TYPES } from "@shared/types.ts";
import type { AgentType, PermissionMode, Session } from "@shared/types.ts";
import { HARNESS_CAPABILITIES } from "@shared/harness-capabilities.ts";
import { MODEL_CATALOG } from "@shared/model.ts";
import { resolveBinSpec } from "./bin.ts";
import type {
  ControlSpec,
  DialogSpec,
  Harness,
  HookSpec,
  ModeLineSpec,
  ResumeSpec,
  SdkSpec,
  TranscriptMessages,
  TranscriptSpec,
  TuiSpec,
  UsageSpec,
} from "./types.ts";
import { claudeHooks } from "./claude/hooks.ts";
import { claudeTranscript } from "./claude/transcript.ts";
import { claudeTui } from "./claude/tui.ts";
import { claudeDetect } from "./claude/detect.ts";
import { claudeBin } from "./claude/bin.ts";
import { claudeControl } from "./claude/control.ts";
import { claudeSdk } from "./claude/sdk.ts";
import { codexTranscript } from "./codex/transcript.ts";
import { codexTui } from "./codex/tui.ts";
import { codexDetect } from "./codex/detect.ts";
import { codexBin } from "./codex/bin.ts";
import { codexControl } from "./codex/control.ts";
import { codexHooks } from "./codex/hooks.ts";
import { codexUsage } from "./codex/usage.ts";
import { codexSdk, codexResumeModeArgs } from "./codex/sdk.ts";
import { discoverCodexModels } from "./codex/model-catalog.ts";
import { piTranscript } from "./pi/transcript.ts";
import { piUsage } from "./pi/usage.ts";
import { piDetect } from "./pi/detect.ts";
import { piBin } from "./pi/bin.ts";
import { piControl } from "./pi/control.ts";
import { discoverConfiguredPiModels } from "./pi/model-catalog.ts";
import { resolveBinPath } from "../util/exec.ts";

// The registry of agent harnesses. Extend this; do not start a parallel list.
//
// `Record<AgentType, Harness>` is the enforcement mechanism, the same one `LLM_RUNNERS`
// and `SESSION_FIELD_COMPARATORS` use: adding an id to `AGENT_TYPES` and stopping there
// does not compile. Every capability then has to be either implemented or explicitly
// declared `null`, so "I forgot transcripts existed" stops being a possible outcome for
// the next harness - which is exactly how Codex ended up with capabilities that silently
// did nothing.
//
// Not to be confused with `src/server/harnesses.ts`, which is the settings blob behind the
// Harnesses panel - operator choices, not capabilities.
//
// Server-side, because a spec reads the filesystem or a wire payload. The capabilities
// that DON'T - permission modes, skills, the work queue, context clearing, MCP
// registration - live in `@shared/harness-capabilities.ts`, because the dashboard has to
// answer them in the browser, and are spread in below. So this record forces the decisions
// that need a `node:` import (what a harness records on disk, and how it pushes its
// lifecycle at us) and the shared one forces the rest; neither is a copy of the other, and
// `Harness extends HarnessCapabilities` means a call site holding a harness still reads
// every slot off one object. Naming still comes from `@shared/agent.ts`.
//
// Test: `session-contracts.test.ts` pins both records, `harness-transcript.test.ts` and
// `harness-capabilities.test.ts` pin the degradations.

// The six modes Claude's own footer, hooks, and driver can report - the only values a
// Claude session's `permissionMode` can actually hold. The shared `PermissionMode` union
// also carries Codex's four profiles, and `--permission-mode readOnly` would abort the
// resume instead of opening it, so anything outside this set rides as "no flag" rather
// than as a guess - the mirror of `codexPosture` returning null for a Claude mode.
const CLAUDE_MODES: ReadonlySet<PermissionMode> = new Set([
  "default",
  "plan",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypassPermissions",
]);

/**
 * The flags that re-assert `mode` on a `claude --resume` argv, or nothing when the mode is
 * null or not Claude's. Rendered through the capability's own `launchArgs` - the same
 * renderer the dispatch path spends - so the `default` -> `manual` spelling bridge lives
 * exactly once. Verified against 2.1.222: `--permission-mode` is a global option and rides
 * with `--resume`, choices acceptEdits, auto, bypassPermissions, manual, dontAsk, plan.
 */
function claudeResumeModeArgs(mode: PermissionMode | null): string[] {
  const spec = HARNESS_CAPABILITIES.claude.permissionModes;
  if (!mode || !spec?.launchArgs || !CLAUDE_MODES.has(mode)) return [];
  return [...spec.launchArgs(mode)];
}

export const HARNESSES: Record<AgentType, Harness> = {
  claude: {
    ...HARNESS_CAPABILITIES.claude,
    transcript: claudeTranscript,
    usage: null,
    hooks: claudeHooks,
    detect: claudeDetect,
    bin: claudeBin,
    models: { shipped: MODEL_CATALOG.claude, discover: null },
    tui: claudeTui,
    control: claudeControl,
    // The `@anthropic-ai/claude-agent-sdk` adapter. Non-null here and `"sdk"` in
    // `runtimes` above are ONE fact in two files; `harness-sdk.test.ts` fails until they
    // agree, so a driver cannot ship invisible and a toggle cannot advertise one that does
    // not exist. What it changes is only how a session WE dispatch is driven, and only
    // when the operator turns it on: `control` above is still how a Claude session someone
    // else started is reached, because we do not own their pty.
    sdk: claudeSdk,
    // `claude --resume <id>`, plus the mode the session was running in - the one setting
    // the reopened CLI does not restore itself (see `ResumeSpec`). This argv used to live
    // INSIDE `claudeSdk`, which made it reachable only for a harness that also had an
    // embedded driver - see `ResumeSpec`.
    resume: {
      argv: (agentSessionId, permissionMode) => [
        "--resume",
        agentSessionId,
        ...claudeResumeModeArgs(permissionMode),
      ],
    },
  },
  // `hooks` was null here, as a statement rather than a gap - "Codex pushes nothing at
  // us". The spike that was supposed to test that claim did, and refuted it: Codex takes
  // per-launch `-c hooks.<Event>=[...]` overrides, so `codexHooks` lands here as a spec,
  // not as a second pipeline. That is the shape the null was holding open.
  //
  // What it did NOT buy is a Codex card that is always instrumented. The overrides are
  // spent at launch (`codex/launch.ts`), so a session an operator started themselves
  // still pushes nothing and is still read passively - discovery, the rollout, and the
  // pane. Every "hookless session" path below is therefore live for Codex too; what
  // changed is that it is a property of the LAUNCH rather than of the harness.
  //
  // Which is why `tui` being NOT null is still this registry earning its keep. For an
  // uninstrumented Codex session, reading its screen remains the only evidence of "parked
  // and waiting" it can produce at all - and the guard this capability replaced meant
  // nobody had ever pointed the parser at a Codex pane to find out whether it could. It
  // can; see `codex/tui.ts`. Note this is independent of `permissionModes`: Codex now
  // declares its `/permissions` menu there, but option dialogs remain a separate screen
  // grammar and must never be gated on whether a permission control exists.
  codex: {
    ...HARNESS_CAPABILITIES.codex,
    transcript: codexTranscript,
    usage: codexUsage,
    hooks: codexHooks,
    detect: codexDetect,
    bin: codexBin,
    // Resolve inside the closure for the same reason Pi's does: every probe observes the
    // current override chain rather than one captured when this module loaded.
    models: {
      shipped: MODEL_CATALOG.codex,
      discover: (signal) => discoverCodexModels(resolveAgentBin("codex"), { signal }),
    },
    tui: codexTui,
    control: codexControl,
    // `codex app-server` over stdio - the only Codex interface whose approvals are
    // ANSWERABLE rather than merely readable: a pane can show the numbered prompt, but
    // nothing on that screen carries a correlation id, so an answer is a keystroke aimed at
    // whatever is highlighted now. See `codex/sdk.ts`. Paired with `runtimes` in
    // `HARNESS_CAPABILITIES.codex` (`harness-sdk.test.ts` fails until they agree).
    sdk: codexSdk,
    // `codex resume <uuid>` - a SUBCOMMAND, not a flag, and the id is positional. Codex's
    // interactive and programmatic surfaces share the same session store, so an app-server
    // thread id reopens the same rollout in the TUI. No model or effort flags ride along:
    // the resumed rollout carries those itself. The permission POSTURE is the exception -
    // an embedded session's sandbox, approval policy, and reviewer were turn parameters on
    // the app-server, nothing the reopened TUI reads back, so `codexResumeModeArgs`
    // re-asserts them as flags rather than letting `~/.codex/config.toml` decide. This
    // remains separate from `sdk`; Pi's non-null `resume` beside `sdk: null` demonstrates
    // why the split is load-bearing.
    resume: {
      argv: (agentSessionId, permissionMode) => [
        "resume",
        agentSessionId,
        ...codexResumeModeArgs(permissionMode),
      ],
    },
  },
  // Pi (`@earendil-works/pi-coding-agent`), the Phase 5 acceptance harness. The mirror image
  // of Codex on this axis: `hooks: null` (pi pushes nothing - its extensions are in-process
  // TS, not a shell-out hook), but `transcript` is non-null WITH `messages`, because pi writes
  // a Claude-shaped per-line JSONL that reads back as turns AND carries a clean idle/working
  // signal. Dispatched sessions bind it through pi's native launch session id; sessions
  // discovered without that identity degrade safely to no transcript.
  //
  // `tui: null`, and it is MEASURED, not assumed: pi's screen IS readable (its footer and its
  // `/model` selector were captured live, cursor glyph `→` U+2192), but pi has no
  // permission-mode footer to read (Shift+Tab cycles thinking, not a mode) and its
  // approval-dialog grammar could not be captured (login-blocked, the same blocker Codex's
  // spike hit), so nothing is wired to read off its screen today. The codebase spells "nothing
  // to parse" as `tui: null` deliberately - `harness-tui.test.ts` forbids a spec with both
  // sub-capabilities null, because `annotatePaneState` would then capture the pane every tick
  // to run no parses. The `→` cursor is recorded in `todo/pi-harness.md` so the follow-up, once
  // pi is logged in, is the one-token confirmation Codex's turned out to be.
  pi: {
    ...HARNESS_CAPABILITIES.pi,
    transcript: piTranscript,
    usage: piUsage,
    hooks: null,
    detect: piDetect,
    bin: piBin,
    // Resolve inside the closure so every probe observes the same current override chain
    // as dispatch, without making the Pi adapter import this registry back.
    models: {
      shipped: MODEL_CATALOG.pi,
      discover: (signal) => discoverConfiguredPiModels(resolveAgentBin("pi"), { signal }),
    },
    tui: null,
    control: piControl,
    // Phase 6 fills this with pi's `--mode rpc` adapter, which is also where pi first gains
    // structured needs-you evidence: its `hooks: null` and absent work lifecycle are both
    // consequences of having no push channel, and the driver IS one.
    sdk: null,
    // `pi --session <id>`. NOT `--resume`, which opens pi's interactive picker and takes no
    // id, and NOT `--fork`, which branches rather than continues. Three adjacent flags in
    // `pi --help`, one of which is the right answer. The mode parameter is deliberately
    // unread: pi declares `permissionModes: null`, so there is no mode to carry and no
    // flag to spell one with.
    resume: { argv: (agentSessionId) => ["--session", agentSessionId] },
  },
};

/** The harness for an agent. Total by construction - the Record cannot have a hole. */
export function harnessFor(agent: AgentType): Harness {
  return HARNESSES[agent];
}

/**
 * Resolve the CLI to run for a harness: the `MISSION_`/`FLEET_`/`HARNESS_` chain first,
 * then any legacy names the harness still honours, then its own fallback command.
 *
 * THE one resolver, for both of the things that spawn an agent CLI - a dispatched session
 * (`dispatcher.ts`) and a headless `claude -p` (`claude-cli.ts`, which read a second,
 * differently-ordered chain of its own). Two resolvers meant an operator pointing
 * `MISSION_CLAUDE_BIN` at a wrapper got it in one path and not the other, with no error
 * either way. Resolution lives here rather than in `config.ts` because the spec is the
 * harness's; what `config.ts` kept was the map, which is what let the two drift.
 *
 * An empty value counts as unset throughout: `MISSION_CLAUDE_BIN=` is an operator clearing
 * an override, not a request to spawn "". Test: `harness-bin.test.ts`.
 *
 * The chain itself lives in `harness/bin.ts` so a module this record IMPORTS can resolve a
 * spec it already holds without importing the record back - see the note there.
 */
export function resolveAgentBin(agent: AgentType): string {
  return resolveBinSpec(HARNESSES[agent].bin);
}

/** Every harness, in declaration order. For anything enumerating agents. */
export function allHarnesses(): Harness[] {
  return AGENT_TYPES.map((id) => HARNESSES[id]);
}

/** A session's transcript capability, or null when its harness records nothing readable. */
export function transcriptFor(session: Session): TranscriptSpec | null {
  return HARNESSES[session.agent].transcript;
}

/** A session's durable request-usage capability, if its harness records one locally. */
export function usageFor(session: Session): UsageSpec | null {
  return HARNESSES[session.agent].usage;
}

/**
 * An agent's push-instrumentation capability, or null when it pushes nothing.
 *
 * Null is what every hook-shaped caller degrades on: the ingest is refused rather than
 * interpreted by another agent's vocabulary, and the dispatcher skips a wait for a
 * signal that is never coming. Ask this rather than `agent === "claude"`, which says
 * nothing about why.
 */
export function hooksFor(agent: AgentType): HookSpec | null {
  return HARNESSES[agent].hooks;
}

/**
 * How to run this agent embedded, or null when no driver exists for it yet.
 *
 * Beside `hooksFor` because it answers the same shape of question and degrades the same
 * way: null means the runtime is not offered at all, so the toggle does not render and
 * dispatch stays on the terminal path. Ask this rather than testing `agent === "claude"`,
 * and never test the `sdk:` id prefix - `Session.runtime` is the axis.
 */
export function sdkFor(agent: AgentType): SdkSpec | null {
  return HARNESSES[agent].sdk;
}

const STREAM_JSON_CONTROL: ControlSpec = { kind: "stream-json" };

/**
 * How to continue one of this agent's conversations in a terminal, or null when its CLI
 * cannot reopen one.
 *
 * Beside `sdkFor` and deliberately NOT part of it: the two answer different questions and
 * every harness here answers this one while only Claude and Codex answer the other. See
 * `ResumeSpec` for what welding them together cost.
 */
export function resumeFor(agent: AgentType): ResumeSpec | null {
  return HARNESSES[agent].resume;
}

/**
 * The full argv - binary included - that reopens `agentSessionId` for this agent, or null
 * when the harness cannot. `permissionMode` is the mode the session was running in, so the
 * reopened CLI starts where the operator left it rather than on its own default - see
 * `ResumeSpec` for why it is the one setting that has to ride along.
 *
 * The one composer, so a caller never pairs `resolveAgentBin` with a hand-written flag.
 * Both readers (the embedded handoff, and the conversation pane's agent launcher) go
 * through here, which is what keeps them spawning the same command line.
 */
export async function resumeArgvFor(
  agent: AgentType,
  agentSessionId: string,
  permissionMode: PermissionMode | null,
): Promise<string[] | null> {
  const spec = resumeFor(agent);
  if (!spec) return null;
  const configured = resolveAgentBin(agent);
  const executable = await resolveBinPath(configured);
  if (!executable) throw new Error(`agent binary "${configured}" not found on PATH`);
  return [executable, ...spec.argv(agentSessionId, permissionMode)];
}

/**
 * Whether Foreman may automate this session.
 *
 * TWO ARMS, split by RUNTIME rather than by agent, and the split is the whole of it: the
 * question underneath is "can we see this session's lifecycle well enough to drive it?",
 * and the two runtimes answer it from different evidence.
 *
 * An EMBEDDED session is instrumented by construction. Its push channel is the handle the
 * supervisor is holding - pickup and completion arrive as `state` / `turn_done` events, and
 * delivery is an acked `send()` that either happened or definitively did not. So the hook
 * capability is not merely satisfied here, it is the wrong question: `harness.hooks` is
 * about a script a harness installs on this machine, and a driver-run session's evidence
 * does not come from one. That is exactly why this arm is runtime-scoped - phase 6's pi
 * driver lands against it unchanged, and pi declares `hooks: null` (its extensions are
 * in-process TS, not a shell-out), so an arm written as `agent === "claude"`, or one that
 * kept requiring `hooks`, would silently refuse every pi session that had a working driver.
 *
 * A TERMINAL session is unchanged: it needs a hook capability, and - unless those hooks are
 * installed machine-wide - it needs to have actually reported one, because a session that
 * has never pushed anything is one whose idleness we would be guessing at.
 *
 * `workQueue` gates both, because that is a claim about the HARNESS (does Foreman know how
 * to hand this agent work at all) and is true or false whichever way the session is driven.
 * The human-visible half of the same decision is `workQueueBlockedReason`.
 */
export function foremanAutomationAuthorized(session: Session): boolean {
  const harness = HARNESSES[session.agent];
  if (!harness.workQueue) return false;
  if (session.runtime === "sdk") return true;
  if (!harness.hooks) return false;
  return harness.hooks.scope === "machine" || session.hooksSeen;
}

/**
 * How a turn reaches this session's agent. Never null.
 *
 * A function rather than a harness field read at each call site so the answer can include
 * the SESSION's runtime. Pane-backed sessions use their harness's keystroke declaration;
 * SDK sessions use the driver and therefore report `stream-json`. Normal SDK delivery
 * reaches `SdkSupervisor` before pane actions ask this question, while the projection keeps
 * those actions safe if a future caller sends an SDK session to them by mistake.
 */
export function controlFor(session: Session): ControlSpec {
  return session.runtime === "sdk" ? STREAM_JSON_CONTROL : HARNESSES[session.agent].control;
}

/**
 * An agent's TUI-reading capability, or null when we cannot read its screen at all.
 *
 * Ask this rather than `agent === "claude"`. The guard it replaces is the one that hid
 * whether Codex renders readable dialogs for the entire life of the parser.
 */
export function tuiFor(agent: AgentType): TuiSpec | null {
  return HARNESSES[agent].tui;
}

/**
 * How to read this agent's option dialogs, or null when it draws none we can read.
 *
 * Two nulls collapse here on purpose - "we cannot read this screen at all" and "we can read
 * this screen but it draws no menus" - because every caller degrades identically: no dialog
 * is reported, and the session keeps whatever state its other signals gave it. What must
 * NOT collapse into them is a harness that CAN be read being skipped by an agent check,
 * which is exactly the defect this function exists to make impossible to write again.
 */
export function dialogSpecFor(agent: AgentType): DialogSpec | null {
  return HARNESSES[agent].tui?.dialog ?? null;
}

/**
 * How to read and drive this agent's Shift+Tab permission-mode footer, or null when it
 * changes permissions some other way (Codex's `/permissions` menu) or has no modes.
 *
 * This is only the cycle mechanism. The card's capability and named-mode action read
 * `permissionModes.liveControl`, so a null footer does not suppress a menu-based picker.
 */
export function modeLineSpecFor(agent: AgentType): ModeLineSpec | null {
  return HARNESSES[agent].tui?.modeLine ?? null;
}

/** A located file and the capability that can read its CONVERSATION. */
export interface SessionMessages {
  read: TranscriptMessages;
  path: string;
}

/**
 * The way to read a session's turns: the message capability plus the file it applies to,
 * or null when there is nothing to read.
 *
 * One helper rather than a `locate` at each call site, because null has three causes that
 * every caller degrades the same way - the harness keeps no record, it keeps one with no
 * messages in it (Codex), or it has not written the file yet - and a call site that
 * checked only the last of those is how a capability-less harness gets a directory walk
 * and an empty array instead of its declared "unavailable".
 *
 * Order matters: the capability is checked BEFORE the file is located, so a harness that
 * cannot answer never pays for the search.
 */
export function sessionMessages(session: Session): SessionMessages | null {
  const spec = transcriptFor(session);
  if (!spec?.messages) return null;
  const path = spec.locate(session);
  return path ? { read: spec.messages, path } : null;
}
