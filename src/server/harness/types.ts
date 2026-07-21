import type { HookIngest } from "@shared/protocol.ts";
import type {
  AgentType,
  MetaSource,
  PermissionMode,
  Session,
  SessionState,
  ThinkingLevel,
  TranscriptMessage,
} from "@shared/types.ts";
import type { HarnessCapabilities } from "@shared/harness-capabilities.ts";

// The Harness axis: one object per agent, holding what the daemon needs FROM that agent.
//
// This exists because the alternative was ~35 `if (session.agent !== "claude") return null`
// guards, each of which silently does nothing for a new harness rather than failing to
// compile. `HARNESSES` (index.ts) is a `Record<AgentType, Harness>`, so a new agent id
// cannot compile until every capability below is either implemented or explicitly declared
// `null` - the same trick `SESSION_FIELD_COMPARATORS` plays on a new `Session` field.
//
// Capabilities are OPTIONAL SUB-OBJECTS rather than methods on one fat interface, and
// `null` is a first-class answer meaning "this harness genuinely does not have this",
// not a stub. A flat interface would force every adapter to stub the capabilities it
// lacks, and stubs are where silent breakage lives: an empty array reads as "there are no
// messages" when the truth is "this file never carried messages".
//
// Types only, no `node:` imports and no implementations - the specs live in
// `harness/<agent>/`, and `transcript.ts` supplies the format-agnostic machinery they
// build on. Naming (`label`, `speaker`) is deliberately NOT here: `AGENT_IDENTITY`
// (`@shared/agent.ts`) already owns it and the web bundle imports that.

/** What a passive read yields about a session's live runtime, all optional. */
export interface RuntimeMetaRead {
  modelId: string | null;
  /** Tokens occupying the context window (input + cache), excludes output. */
  contextTokens: number | null;
  contextWindow: number | null;
  /** 0-100, rounded; null when tokens/window couldn't be determined. */
  contextPct: number | null;
  longContext: boolean;
  thinkingLevel: ThinkingLevel | null;
}

/** What a passive read yields about a session's liveness. */
export interface SessionActivityRead {
  /**
   * `idle` ONLY when the newest main-chain record is an assistant turn that ended
   * cleanly; everything else - a pending tool call, a tool result the agent hasn't
   * answered yet, a bare user prompt - reads `working`. The bias is deliberate: a
   * false `working` merely makes the queue wait, a false `idle` types into a busy
   * session, so the ambiguous tails all fall to `working`.
   */
  state: "idle" | "working";
  /** Epoch ms of that newest datable main-chain record. */
  lastActivity: number;
}

/**
 * One bounded passive read of a session's file, feeding both axes the poller wants.
 *
 * One call rather than two because for a JSONL transcript both answers come out of the
 * same tail read, and a poller that asked twice would double the I/O of its own hot loop.
 */
export interface TranscriptPassiveRead {
  /** Runtime metadata, or null when this read found none. */
  meta: RuntimeMetaRead | null;
  /**
   * Idle/working, or null when this harness's passive source carries no liveness signal
   * at all - as distinct from "carried none this tick". Both are a no-op at the registry
   * (a briefly unreadable file must never clear a good reading), so the two collapse
   * safely here; what must NOT collapse is a harness that cannot answer looking like one
   * that answered "nothing yet" forever.
   */
  activity: SessionActivityRead | null;
  /** Cumulative, harness-native token counters; deliberately not written to the daily ledger. */
  usage?: import("@shared/types.ts").SessionCost | null;
  rateLimits?: import("@shared/types.ts").RateLimitSource | null;
}

export interface TranscriptWindow {
  /** Opening turns then recent turns, de-duped; empty when unreadable. */
  messages: TranscriptMessage[];
  /** True when turns between the head and the tail were dropped for size. */
  truncated: boolean;
  /**
   * How many leading `messages` came from the opening slice - the boundary of the elided
   * middle. Non-zero only when `truncated`, where `messages[headCount - 1]` and
   * `messages[headCount]` sit next to each other in the array but far apart in the session.
   * A reader that wants the genuinely recent turns must therefore slice forward from here
   * rather than back from the end: the tail's turn count is byte-bounded, so when it yields
   * fewer turns than the head, slicing from the end runs back into the opening. 0 when the
   * file was returned whole and every turn is contiguous.
   */
  headCount: number;
}

/**
 * A window read forward from a byte offset.
 *
 * `reset: true` means the file is now SHORTER than the offset - the transcript was
 * cleared (a `/clear`), so the anchor is meaningless. Callers must treat that as a
 * verify-infrastructure failure and escalate, NOT judge the item against a near-empty
 * window and invent gaps.
 */
export interface TranscriptSince extends TranscriptWindow {
  reset?: boolean;
}

/** Turns plus the byte offset a live stream resumes from. */
export interface TranscriptStreamRead {
  messages: TranscriptMessage[];
  pos: number;
}

/**
 * Reading a harness's file as CONVERSATION.
 *
 * Split from `TranscriptSpec` because "there is a file we can read runtime facts out of"
 * and "that file contains the turns" are separate claims, and Codex is the live proof:
 * its rollout carries model / effort / token counts and no messages. Folding the two
 * would have that harness answering every window read with `[]`, which reads as "this
 * session has said nothing" - a wrong answer that no caller can tell from a right one.
 */
export interface TranscriptMessages {
  /**
   * The opening `headTurns` (so the goal the user set is always present) plus the most
   * recent `tailTurns`. A small file comes back whole; a large one comes back head+tail
   * with the middle elided (`truncated`).
   */
  window(path: string, headTurns?: number, tailTurns?: number): TranscriptWindow;
  /** Turns appended after a byte offset - how the work queue scopes a window to one item. */
  since(path: string, offset: number, maxBytes?: number): TranscriptSince;
  /**
   * The file's current byte size - the anchor `since` reads from, recorded when a work
   * item is delivered. Null when the file is missing.
   */
  size(path: string): number | null;
  /** Recent history for a live stream, plus the offset to resume from. Throws if unreadable. */
  initial(path: string): TranscriptStreamRead;
  /** Whatever complete turns were appended since `pos`. Throws if unreadable. */
  appended(path: string, pos: number): TranscriptStreamRead;
  /**
   * The "what's happening now" narration for the no-mistakes strip, or null when there
   * is none. Null is also the right answer for a harness with no such notion - it is a
   * one-line status, so absence degrades to showing nothing rather than to being wrong.
   */
  narration(path: string): string | null;
}

/**
 * Reading a harness's own record of a session off disk.
 *
 * `null` on `Harness` means the harness writes nothing we can read: no transcript pane,
 * no passive runtime metadata, no hook-free idle signal - by declaration rather than by a
 * guard somewhere returning null for reasons the call site has to guess at.
 */
export interface TranscriptSpec {
  /**
   * Where a reading from this source came from, for `applyRuntimeMeta`'s provenance -
   * which is what lets a fresh statusLine reading outrank a passive one.
   */
  metaSource: MetaSource;
  /**
   * The file backing this session, or null when there isn't one (yet). Callers must
   * treat null as "nothing to read", never as an error.
   *
   * May be expensive: a harness that has to SEARCH for its file caches that inside the
   * spec (see `retain`). Check the capability you actually need first - asking a
   * messages-less harness to locate a file it only holds metadata in is a directory walk
   * for an answer nobody uses.
   */
  locate(session: Session): string | null;
  /** One bounded read of that file for the passive poller. Cheap enough for a hot loop. */
  passiveRead(path: string): TranscriptPassiveRead;
  /** Conversation reading, or null when the file carries metadata but no messages. */
  messages: TranscriptMessages | null;
  /**
   * Drop cached per-session state for sessions that are no longer live; `null` when
   * `locate` keeps none.
   *
   * The poller calls this each tick with the ids it still sees. It lives on the spec so
   * that a harness whose lookup is a filesystem walk can cache it WITHOUT the generic
   * poller growing a per-vendor cache - which is where that cache started.
   */
  retain: ((live: ReadonlySet<string>) => void) | null;
}

/** What one ingested hook event says about the session that fired it. */
export interface HookReading {
  state: SessionState;
  /** One line for the card's ticker, or null when the event says nothing worth showing. */
  activity: string | null;
}

/**
 * PUSH instrumentation: an agent that runs a script of ours on its own lifecycle events.
 *
 * The transport is deliberately NOT here, because it is not the agent's. `HookIngest`
 * (`@shared/protocol.ts`), `POST /hooks/:event` and the registry's pane-keyed overlay
 * carry an event from any bridge to any card and name no vendor - which
 * `todo/codex-instrumentation.md` established before this interface existed and is the
 * reason a second harness's bridge is a payload mapper plus this spec, not a pipeline.
 *
 * What IS here is everything only the agent can answer: which events it fires, what each
 * of them means about the session, and which of them carries the human's ask.
 *
 * `null` on `Harness` means the agent pushes nothing at us. That is a load-bearing
 * declaration rather than an absence:
 *
 * - The session stays on the PASSIVE path - discovery plus whatever
 *   `transcript.passiveRead` can see - instead of a hook overlay from a neighbouring
 *   card's harness pinning it to a state it never reported. `applyHook` refuses an
 *   ingest for such a harness, and the overlay is agent-scoped so the pane a Claude
 *   session just vacated cannot speak for the Codex session that replaced it.
 * - The dispatcher skips the 20-second wait for a first hook (`awaitReady`) rather than
 *   spending it on a signal that is never coming.
 */
export interface HookSpec {
  /**
   * Every event the bridge registers for, in install order.
   *
   * Declared ONCE, here, because it used to be hand-kept in two installers
   * (`hooks/install.mjs` and `src/main/integrations.ts`) with nothing catching drift -
   * and half an event list is a capability that works in the repo and not in the
   * packaged app, or the reverse.
   */
  events: readonly string[];
  /**
   * The subset whose settings-file group needs a tool matcher. Claude's per-tool events
   * take `matcher: "*"`; a harness whose config format has no such notion declares `[]`.
   */
  matcherEvents: readonly string[];
  /**
   * What an event means for the card: the state it implies, and the line it puts in the
   * ticker. Every discriminator - the event vocabulary, and any wording inside a payload
   * field - is this agent's, version by version.
   */
  toState(evt: HookIngest): HookReading;
  /**
   * The human's own ask, if this event carries one; null for every event that does not,
   * which is the COMMON case (see `substantivePrompt` for how much of what arrives on a
   * prompt event no human typed).
   *
   * Both halves of the question belong to the agent - which event carries a prompt, and
   * what inside it is scaffolding - so a harness that never fires one simply answers null
   * everywhere rather than the registry testing an event name it does not own.
   */
  promptText(evt: HookIngest): string | null;
}

/**
 * How to recognise this harness's process in a `ps` snapshot.
 *
 * NOT nullable on `Harness`, unlike every capability above it: a harness nothing can find
 * has no card, no transcript and no queue - it simply is not there, and nothing reports a
 * problem. Detection is what "a harness" means.
 *
 * Data rather than a `match(command)` function, because the tests are the point: a spec
 * that hid its rules inside a predicate could not be audited, while a declared one lets
 * `detection.test.ts` assert every claim about every harness - so a new one inherits the
 * coverage instead of needing its own tests written.
 */
export interface DetectSpec {
  /**
   * Command names this harness is invoked as, matched two ways: as argv0's basename (the
   * real binary, `/opt/homebrew/bin/codex`), and as a bare token under a known wrapper
   * (`make claude`, `sh -c codex`). One list rather than two, because they are the same
   * fact - a launcher runs the command by its name - and two would drift.
   *
   * The bare-token reading counts only under a wrapper, which is what keeps
   * `git commit -m "fix claude bug"` from being read as a session.
   */
  commands: readonly string[];
  /**
   * Substrings anywhere in argv that prove the real binary through a disguise: the
   * `claude` launcher re-execs a version-named binary (`.../claude/versions/2.1.195`) and
   * `codex` runs as a node script (`node .../@openai/codex/bin/codex.js`), so neither has
   * its own name in argv0.
   *
   * Strong signals: a match here counts as native. Keep them specific enough that no
   * ordinary command line contains one.
   */
  argvSignatures: readonly string[];
  /** This harness's own background roles, which are not sessions. */
  background: BackgroundSpec;
}

/**
 * The tokens that name a background ROLE - the harness's own daemon, its MCP server, the
 * workers it keeps alive beside a session. A process matching one is infrastructure, not
 * somebody's session.
 *
 * Per harness rather than one global list, because this is the vendor's own subcommand
 * grammar: `bg-pty-host` is a Claude Code internal, and a global list is how one vendor's
 * exclusion silently starts hiding another vendor's real sessions.
 *
 * TOKENS, never substrings, and this is the load-bearing part. A dispatched session's argv
 * carries a state-dir path and a ~1.2KB inline prompt, so a spec written as patterns over
 * the raw command line hands the decision to text nobody controls: an operator whose
 * `MISSION_HOME` is `~/daemon-state`, or a prompt whose prose quotes `--bg-pty-host`, made
 * every dispatched agent undetectable. Both were observed. See `isBackgroundAgent`
 * (`discovery/processes.ts`) for which argv positions are consulted, and
 * `process-background-filter.test.ts` for the real `ps` lines that pin it.
 *
 * APPEND-ONLY as new roles appear. A mistake is costly in both directions: a form missed
 * becomes a phantom session on the dashboard, and a form matched too eagerly makes a real
 * agent silently disappear from it.
 */
export interface BackgroundSpec {
  /**
   * Subcommands naming a background role. One token (`daemon`), or two where the vendor
   * spells it that way (`mcp serve`).
   */
  subcommands: readonly string[];
  /**
   * The same roles as flags, for the forms spawned with no subcommand at all
   * (`.../ClaudeCode.app/Contents/MacOS/claude --bg-pty-host <sock>`).
   */
  flags: readonly string[];
}

/**
 * Which binary this harness launches, and how an operator overrides it.
 *
 * Names, not values, and no resolution here: `resolveAgentBin` (`index.ts`) is the one
 * resolver, so a dispatched session and a headless run of the same harness cannot disagree
 * about what `claude` means on this machine.
 *
 * Not to be confused with the terminal axis's `BinSpec` (`server/terminal/bin.ts`), which
 * is a different rule for a different problem: a raw env key plus an ordered list of
 * absolute candidates probed with `existsSync`, because a terminal emulator hides inside a
 * `.app`. An agent CLI is bare on PATH, and validated separately at dispatch
 * (`resolveBinPath`). Do not unify them without a reason beyond the shared word "bin".
 */
export interface BinSpec {
  /**
   * Suffix of the `MISSION_` / `FLEET_` / `HARNESS_` env chain that overrides the binary,
   * resolved through `envVar` (`@shared/harness-runtime.mjs`).
   */
  env: string;
  /**
   * Raw env names kept for compatibility, consulted after the chain above.
   *
   * Append-only, for the same reason that chain is: these are read by processes installed
   * into an environment once, so dropping one does not fail loudly - it quietly stops
   * honouring a setting that is still set.
   */
  legacyEnv: readonly string[];
  /** What to run when the operator has set no override. Bare, so PATH resolves it. */
  command: string;
}

/**
 * How a turn is DELIVERED to this harness. Required - every harness must answer it.
 *
 * This slot is what lets the interface outlive its current backends, and it is separate
 * from the TUI grammar on purpose. Delivery used to live half in the terminal axis and
 * half in constants beside the paste code, which quietly made "you talk to an agent by
 * TYPING INTO ITS TERMINAL" a permanent architectural assumption - and made a settle
 * window measured against one Claude build a property of the daemon rather than of the
 * harness it was measured on.
 *
 * It is not one. `claude -p --input-format stream-json --output-format stream-json` takes
 * follow-up turns on a live process with no keystrokes involved, and Codex exposes the
 * same as a JSON-RPC `turn/steer`. Declaring the seam is NOT a commitment to build
 * headless dispatch: a session a human owns stays `keystroke` regardless, because we do
 * not own their pty. The point is that a second delivery becomes a new variant behind an
 * existing slot rather than an interface change every migrated call site has to absorb.
 *
 * Required rather than nullable for the reason `Multiplexer.write` is: a harness we
 * cannot talk to is not a harness we can dispatch to, so there is no meaningful `null`
 * to degrade to. See `docs/plans/pluggable-integrations/plan.md`.
 */
export type ControlSpec =
  | {
      kind: "keystroke";
      /**
       * How long to let a bracketed paste settle before pressing Enter.
       *
       * A harness that coalesces input for a window after a paste absorbs an Enter that
       * arrives inside it, leaving the prompt pasted and unsubmitted. Measured per
       * harness, because the window is the harness's - undocumented, and free to move.
       *
       * A fast path, never the guarantee: `pastePlaceholder` is what actually settles it.
       */
      settleMs: number;
      /**
       * The placeholder this TUI collapses a paste into, or `null` when it renders none.
       * Which pastes those are is `collapses` below.
       *
       * Null is a CAPABILITY absence, not an answer: it means submit verification has no
       * on-screen evidence to read for this harness at all, which is a different claim
       * from "the composer is currently empty". Callers must not read one as the other -
       * a retry gated on evidence that can never appear is a keystroke spent blind, and
       * reporting a submit as confirmed on that basis is the silent lie this declaration
       * exists to end.
       */
      pastePlaceholder: RegExp | null;
      /**
       * Whether THIS text is one the composer will collapse into that placeholder.
       *
       * Inseparable from `pastePlaceholder`, and here for the same reason it is: a harness
       * that says what its placeholder LOOKS like has also to say when it APPEARS, or the
       * one reading that can establish a pending paste is taken on faith. The delivery
       * path must be left making no claim of its own about any composer - a guess about
       * one TUI applied to every agent is precisely the defect this capability closes, and
       * "a paste only collapses when it is multi-line" was the last of them.
       *
       * Neither wrong answer can produce a verified-in-error: say `false` for something
       * the composer does collapse and the reading is skipped, say `true` for something it
       * does not and the reading finds nothing. Both cost only an honest `submitVerified:
       * false`. Err toward `false` when you do not know.
       */
      collapses: (text: string) => boolean;
    }
  | { kind: "stream-json" };

/**
 * Reading the agent's own permission-mode footer off a pane.
 *
 * Null on `TuiSpec` means the agent has no permission-mode notion at all - not that we
 * failed to read one. The distinction is the whole point: an unread footer falls back to
 * the hook-reported mode, while a harness that has no modes must never have a mode chip
 * invented for it, and the Shift+Tab walk that drives one must never be pointed at it.
 */
export interface ModeLineSpec {
  /**
   * How many trailing non-empty lines may hold the mode line. The last one in practice;
   * the margin absorbs a trailing notice without opening the window wide enough for
   * transcript prose to be misread as a mode.
   */
  scanLines: number;
  /** The glyphs the agent prefixes the line with, stripped before the wording is matched. */
  glyphs: RegExp;
  /** This agent's footer wording for each mode, matched after the glyph is stripped. */
  modes: ReadonlyArray<readonly [RegExp, PermissionMode]>;
  /**
   * A glyph-prefixed line naming a mode THIS BUILD doesn't recognize - a newer agent's
   * wording, or a mode behind a flag we couldn't observe. Unlabelable, but still a real
   * position in the cycle, so the walk must be able to step through it rather than give up.
   */
  unknownMode: RegExp;
  /**
   * How many cycle keystrokes one walk may spend before giving up. A backstop against an
   * endless walk, NOT a count of the modes above: it must EXCEED the real cycle length, or
   * a mode this build has never heard of becomes the one nobody can reach.
   */
  maxCycleSteps: number;
}

/**
 * The multi-select FORM vocabulary - a dialog you fill in rather than answer.
 *
 * Null on `DialogSpec` means this agent's menus are all single-select, which is a claim
 * about its chrome and not a gap in ours. Every word here is one agent's own wording,
 * matched off a screen we can see rather than a state we can query, so a harness that
 * renders no such form declares null instead of inheriting another agent's nouns.
 */
export interface DialogFormSpec {
  /**
   * How many rows must carry a checkbox before the dialog reads as a form.
   *
   * Two, not one, for Claude: a real multi-select always clears it (the agent appends its
   * own free-text row with a box of its own), while a lone `[ ]` is as likely to be a
   * permission prompt quoting a command that contains one - and reading that as a form
   * strips the brackets out of a label a human is being asked to confirm.
   */
  minCheckboxRows: number;
  /** The box glyphs that mean ticked; anything else between the brackets is empty. */
  checkedBox: RegExp;
  /** The row that SENDS the form, as opposed to answering one of its questions. */
  submitRow: RegExp;
  /**
   * The trailing row that opens a text field. It renders a box and is NOT one - ticking it
   * selects nothing - so it is excluded from the form's answerable rows at the parse.
   */
  freeTextRow: RegExp;
  /** The banner saying some question still has no answer. A refusal condition for a walk. */
  unansweredWarning: RegExp;
}

/**
 * Reading an option dialog - a permission prompt, a trust check, a menu - off a pane.
 *
 * The GRAMMAR is not here, deliberately. `discovery/pane-dialog.ts` keeps it, because a
 * numbered block with one cursor on it, a question wrapped across a viewport's width and a
 * label compared across a hard wrap are facts about terminals rather than about a vendor -
 * the same split `transcript.ts` makes when it keeps byte windowing and takes the line
 * parser from the harness.
 *
 * What is here is the token that actually differs. Measured, not assumed: pointed at real
 * `codex-cli` captures, the existing grammar returns null on every one of them and parses
 * all three correctly the moment the cursor glyph is its own (`test/fixtures/codex-panes.ts`).
 */
export interface DialogSpec {
  /**
   * The glyph marking the row an Enter would land on, as a regex character class body.
   *
   * Load-bearing twice over: it is what separates a menu from prose that merely looks like
   * one, and it is the only way to know where an Enter lands - a caller cannot navigate
   * from an unknown position. Claude renders U+276F, Codex U+203A.
   */
  cursor: string;
  /** The multi-select form vocabulary, or null when this agent's menus are all single-select. */
  form: DialogFormSpec | null;
}

/**
 * Reading this agent's terminal UI off a pane capture. PARSING only.
 *
 * How a turn is DELIVERED is `control`'s question, not this one, and the split is load
 * bearing: `settleMs` and the paste placeholder are about writing to a screen, and putting
 * them here would make "you talk to an agent by typing into its terminal" a permanent
 * assumption of the TUI-reading capability.
 *
 * `null` on `Harness` means we cannot read this agent's screen at all. That is a strong
 * claim and it should be rare - it costs the session every hookless signal we have, since
 * `activePaneDialog` is the ONLY evidence of "parked and waiting" that needs no
 * instrumentation. Before declaring it, point the parser at a real capture: the last time
 * this was assumed rather than measured, it was wrong.
 */
export interface TuiSpec {
  /**
   * How long to let this agent's TUI repaint after a keystroke before re-reading the pane.
   *
   * On `TuiSpec` rather than on either capability below because BOTH walks need it - the
   * mode cycle waits for the footer to redraw, the dialog walks wait for the cursor to
   * move - and it is one fact about how fast the agent paints, not two.
   *
   * A read taken before the repaint lands sees the PREVIOUS screen, which for the mode
   * cycle means walking one step too far and for a dialog means confirming a row the
   * cursor has already left.
   */
  repaintTimeoutMs: number;
  /** Reading the permission-mode footer, or null when the agent has no modes. */
  modeLine: ModeLineSpec | null;
  /** Reading an option dialog, or null when the agent renders none we can read. */
  dialog: DialogSpec | null;
}

/**
 * One agent, and everything the daemon needs from it.
 *
 * Extends `HarnessCapabilities` (`@shared/harness-capabilities.ts`) rather than
 * re-declaring its slots, so a server call site holding a harness sees EVERY capability
 * on one object - `harness.permissionModes` and `harness.transcript` read the same way -
 * while the dashboard can still answer the pure ones in the browser. The split is by
 * PURITY, not by capability: what is here is what only the DAEMON can answer - because it
 * needs a `node:` import (`transcript`, `hooks`), or because it is about processes and
 * binaries that exist only on the machine (`detect`, `bin`, which are pure data the
 * browser has no question to ask of). `HARNESSES` spreads the shared record in, so each
 * record forces exactly its own questions and neither is a copy of the other.
 *
 * More capabilities land here as the pluggable-integrations migration proceeds
 * (`models` - see
 * `docs/plans/pluggable-integrations/plan.md`). Each arrives as its own slot, so adding
 * one is a new field every harness must answer rather than an interface change every
 * migrated call site has to absorb.
 */
export interface Harness extends HarnessCapabilities {
  /** Matches this harness's key in `HARNESSES`. */
  id: AgentType;
  /** How this harness records a session on disk, or null when it records nothing. */
  transcript: TranscriptSpec | null;
  /** How this harness pushes its lifecycle at us, or null when it pushes nothing. */
  hooks: HookSpec | null;
  /** How to find this harness's process. Required - see `DetectSpec`. */
  detect: DetectSpec;
  /** Which CLI to launch, and what overrides it. Required - a harness runs something. */
  bin: BinSpec;
  /** How this harness's screen READS, or null when we cannot read it at all. */
  tui: TuiSpec | null;
  /** How a turn reaches this harness. Not nullable - see `ControlSpec`. */
  control: ControlSpec;
}
