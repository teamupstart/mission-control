import type { HookIngest } from "@shared/protocol.ts";
import type {
  AgentType,
  MetaSource,
  PaneDialog,
  PaneOption,
  PermissionMode,
  SdkSendDisposition,
  Session,
  SessionRequestQuestion,
  SessionState,
  ThinkingLevel,
  TranscriptMessage,
} from "@shared/types.ts";
import type { HarnessCapabilities } from "@shared/harness-capabilities.ts";
import type { StandingInstructionsMechanism } from "@shared/standing-instructions.ts";
import type {
  HarnessModelCatalogChoice,
  HarnessModelCatalogProblem,
} from "@shared/protocol.ts";
// Type-only, so this file keeps its no-`node:`-imports rule: the import is erased at emit
// (verbatimModuleSyntax). The descriptor is named here rather than restated because
// launch-scoped MCP is declared ONCE, in `mission-mcp.ts`.
import type { MissionMcpDescriptor } from "../mission-mcp.ts";

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
  /** Source revision; only orderable revisions can release a verified effort change. */
  effortRevision: string | null;
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
  /**
   * Permission posture observed from the harness-owned file, when that format records
   * it. Omitted by harnesses whose passive source carries no such field; null means this
   * read could not map a custom/newer posture and must not clear the last known value.
   */
  permissionMode?: PermissionMode | null;
  /**
   * Timestamp/revision of the record that supplied `permissionMode`. A live menu change
   * is newer than the rollout until Codex writes its next turn context, so the registry
   * uses this to keep the verified menu result from being overwritten by that stale tail.
   */
  permissionModeRevision?: string | null;
  /** Cumulative, harness-native token counters; deliberately not written to the daily ledger. */
  usage?: import("@shared/types.ts").SessionCost | null;
  rateLimits?: import("@shared/types.ts").RateLimitSource | null;
}

/** Durable byte position for an append-only harness usage source. */
export interface UsageCursor {
  offset: number;
  modelId: string | null;
  /** True while advancing past a record that exceeded the bounded read size. */
  discardPartial: boolean;
  /** Device/inode generation of the file this byte position belongs to. */
  fileId: string | null;
}

/** One billable request observed in a harness-owned local record. */
export interface HarnessUsageEvent {
  /**
   * Harness-reported request cost where Mission Control has no price table (Pi).
   * Explicitly null for locally priced Codex events; existing pricing stays authoritative.
   */
  vendorCostUsd: number | null;
  identity: string;
  ts: number;
  modelId: string | null;
  querySource: "main" | "subagent" | "auxiliary";
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoningOutput: number;
}

export interface UsageRead {
  events: HarnessUsageEvent[];
  cursor: UsageCursor;
  /** Proven session id from the source header, or null while the header is unreadable. */
  sourceId: string | null;
  more: boolean;
  reset: boolean;
}

export interface PricedUsage {
  costUsd: number;
  pricingModel: string;
  pricingVersion: string;
}

/** Reading and valuing request-level usage from a harness's append-only local source. */
export interface UsageSpec {
  read(path: string, cursor: UsageCursor, maxBytes: number): UsageRead;
  estimate(event: HarnessUsageEvent): PricedUsage | null;
}

export interface TranscriptWindow {
  /** Returned turns in chronological order; empty when unreadable. */
  messages: TranscriptMessage[];
  /** True when older or middle turns were omitted from the returned window. */
  truncated: boolean;
  /**
   * How many leading `messages` came from the opening slice - the boundary of the elided
   * middle. Non-zero only when `truncated`, where `messages[headCount - 1]` and
   * `messages[headCount]` sit next to each other in the array but far apart in the session.
   * A reader that wants the genuinely recent turns must therefore slice forward from here
   * rather than back from the end: a short conversation or the scan ceiling can leave the
   * tail smaller than requested, so slicing from the end can run back into the opening.
   * 0 when every returned turn is contiguous.
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
 * A contiguous run of turns, and the exact byte range they were read from.
 *
 * The range is what makes paging possible at all. A turn count cannot anchor the next
 * read - the caller would have to say "the 80 turns before turn 80", which nothing on
 * disk is indexed by - and a timestamp cannot either, because turns share them. Bytes
 * are the only anchor an append-only file offers for free.
 *
 * `start` is a LINE boundary, and both halves of that matter. Handed back as the next
 * read's `before` it yields a range that abuts this one exactly: no gap, so no turn is
 * skipped, and no overlap, so no turn arrives twice. Overlap is not a cosmetic concern
 * here - a harness whose records carry no id of their own synthesizes one per parse
 * batch (see `parseSeq` in the Codex parser), so two overlapping reads de-dupe against
 * nothing and the same turn is rendered twice.
 */
export interface TranscriptPage {
  /** Turns in chronological order; empty when there is nothing older to read. */
  messages: TranscriptMessage[];
  /** Byte offset of the first returned turn - the anchor for the NEXT page back. */
  start: number;
  /** Byte offset just past the last returned turn. Equals the requested `before`. */
  end: number;
  /** True when `start` is the top of the file, so there is nothing older to ask for. */
  atStart: boolean;
}

/**
 * A contiguous run of turns read FORWARD from a byte anchor, and the range they came from.
 *
 * `TranscriptPage`'s mirror, and the two differ in which edge the caller supplies. A
 * backward page is handed its `end` and discovers its `start`; a forward page is handed
 * its `start` and discovers its `end`. Chaining either one walks a whole file with the
 * same no-gap, no-overlap guarantee, because each page's discovered edge is the next
 * call's anchor.
 *
 * The direction matters for what a walk can promise. Backward paging exists to show an
 * operator history that scrolled off, so stopping early is a cosmetic loss. Forward paging
 * exists to COLLECT - to reach every turn after a recorded boundary without reading the
 * remainder of the file into memory - so a walk that silently stopped short would archive
 * an incomplete record of what a session was told.
 */
export interface TranscriptForwardPage {
  /** Turns in chronological order; empty when this page crossed no complete turn. */
  messages: TranscriptMessage[];
  /** Byte offset the page began at. Equals the requested anchor, clamped to the file. */
  start: number;
  /**
   * Byte offset just past the last COMPLETE record this page read - the anchor for the
   * next page forward.
   *
   * Always a line boundary, and never inside a record a writer is still appending: a
   * partial trailing line is left for the next call, exactly as `appended` leaves it.
   */
  end: number;
  /**
   * True when no complete record remains after `end`, so the walk is finished.
   *
   * Not the same as `end === size`. A file whose final line has no newline yet has bytes
   * past `end` that are not a turn, and reporting that as more to read would spin a
   * collector against a record that may never be completed.
   */
  atEnd: boolean;
}

/** A live stream's opening history: turns, where to resume, and where to page back from. */
export interface TranscriptInitialRead extends TranscriptStreamRead {
  /**
   * Byte offset of the first returned turn.
   *
   * The panel's back-paging anchor, and the reason this read may NOT trim its result to
   * a turn count: a trimmed array's first turn no longer begins at the offset reported
   * here, so the next page back would re-read - and re-render - everything trimmed.
   */
  start: number;
  /** True when this window reaches the top of the file, so there is no older history. */
  atStart: boolean;
}

/**
 * Reading a harness's file as CONVERSATION.
 *
 * Split from `TranscriptSpec` because "there is a file we can read runtime facts out of"
 * and "that file contains turns" are separate claims. Folding the two would force a
 * harness with passive runtime metadata but no conversation reader to answer every
 * window read with `[]`, which reads as "this session has said nothing" - a wrong answer
 * that no caller can tell from a right one.
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
  initial(path: string): TranscriptInitialRead;
  /**
   * The turns immediately BEFORE a byte offset - how the conversation panel scrolls back
   * through history the tail window did not reach.
   *
   * The counterpart to `since`, and the direction that was missing. Every other read here
   * is a tail or a forward walk, so the oldest turn the dashboard could display was
   * whatever `initial` happened to reach; on a long session that is a small fraction of a
   * file that still holds all of it, and the operator sees history the agent appears to
   * have lost.
   *
   * Returns an empty page with `atStart` when `before` is already the top of the file.
   */
  before(path: string, before: number, wantTurns?: number): TranscriptPage;
  /**
   * The turns immediately AFTER a byte offset - `before` run the other way, and the only
   * bounded read that can reach EVERY turn past an anchor.
   *
   * The other three forward reads each answer a different question and none of them
   * answers this one. `window` keeps a head and a tail, so a long conversation's middle is
   * elided by design. `since` keeps the NEWEST turns after the offset and drops a prefix
   * to stay inside its budget, which is right for a prompt and wrong for a record. And
   * `appended` reads to EOF in one allocation, which is exactly what a bounded walk must
   * not do.
   *
   * Chaining it - each page's `end` becoming the next call's `after` - walks forward from
   * a recorded boundary to the last complete turn without ever holding more than one page.
   * Returns an empty page with `atEnd` when the anchor is already past the last complete
   * record.
   */
  after(path: string, after: number, wantTurns?: number): TranscriptForwardPage;
  /** Whatever complete turns were appended since `pos`. Throws if unreadable. */
  appended(path: string, pos: number): TranscriptStreamRead;
  /**
   * The current active narration, or null when there is none. Null is also the right
   * answer for a harness with no such notion. It is a
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

/** Generic lifecycle edge produced by a hook adapter or an SDK driver event. */
export type WorkCycleSignal = "work_started" | "turn_completed";

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
  /** Whether hooks cover every process on the machine or only launches we instrument. */
  scope: "machine" | "launch";
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
   * Translate this harness's raw hook vocabulary into the Registry's lifecycle contract.
   * Null means the event neither arms nor completes a work cycle.
   */
  workCycleSignal(evt: HookIngest): WorkCycleSignal | null;
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
  /**
   * The same prompt exactly as the harness received it, before any scaffolding grammar is
   * applied - or null for an event carrying no prompt at all.
   *
   * `promptText` answers "what did a human ask for", and reshaping is the whole point of it:
   * Claude's strips scaffolding tags and collapses runs of whitespace, so a multi-line
   * payload comes back as one line. That is right for a goal and wrong for the only other
   * question asked of a prompt event - "did this daemon type this?" - which is answered by
   * matching the text against what was delivered, byte for byte. Reshaped text matches
   * nothing.
   *
   * Kept on the spec rather than reading `evt.prompt` at the one call site, for the reason
   * `promptText` is here: which event carries a prompt stays the harness's answer, so a
   * harness that fires none answers null everywhere instead of the registry testing an event
   * name it does not own.
   */
  submittedPromptText(evt: HookIngest): string | null;
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
 * (`resolveBinPath`). The daemon locator now owns both paths; this type still describes the
 * harness-specific configured command that is handed to that shared boundary.
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

/** A bounded, non-secret outcome from a harness-owned catalog discoverer. */
export type ModelCatalogDiscoveryResult =
  | { ok: true; choices: HarnessModelCatalogChoice[] }
  | { ok: false; problem: HarnessModelCatalogProblem };

export type ModelCatalogDiscover = (signal: AbortSignal) => Promise<ModelCatalogDiscoveryResult>;

/** Shipped failure data plus an explicit answer about live discovery support. */
export interface ModelCatalogSpec {
  shipped: readonly HarnessModelCatalogChoice[];
  discover: ModelCatalogDiscover | null;
}

/**
 * How a turn is DELIVERED to a session. Required - every session must have an answer.
 *
 * The harness's `control` slot is the pane-backed answer: an operator-started session and
 * a terminal-runtime dispatch use that harness's keystroke grammar. `controlFor(session)`
 * projects an SDK-runtime session to `stream-json`, because its driver is the delivery
 * channel and no pane grammar applies. Keeping that projection in this union makes the
 * two pane-only refusal sites truthful backstops if an SDK session ever reaches them;
 * ordinary SDK delivery routes through `SdkSupervisor` before either is consulted.
 *
 * This is separate from the TUI grammar on purpose. Delivery used to live half in the
 * terminal axis and half in constants beside the paste code, which quietly made "you talk
 * to an agent by TYPING INTO ITS TERMINAL" a permanent architectural assumption - and
 * made a settle window measured against one Claude build a property of the daemon rather
 * than of the harness it was measured on.
 *
 * Required rather than nullable for the reason `Multiplexer.write` is: a harness we
 * cannot talk to is not a harness we can dispatch to, so there is no meaningful `null`
 * to degrade to. See `docs/plans/agent-sdk-sessions/phase-5-keystroke-deprecation.md`.
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
 * How this harness runs EMBEDDED - driven over its own programmatic interface, with no
 * terminal pane anywhere in the picture.
 *
 * `null` on `Harness` means no driver exists for this harness yet, which is a real absence
 * with a tested degradation rather than a stub: `HarnessCapabilities.runtimes` does not
 * offer `"sdk"`, so no toggle renders, dispatch stays on the terminal path, and the
 * sentence the panel shows is composed from the capability. The two halves are ONE FACT in
 * two files and `harness-sdk.test.ts` fails until they agree.
 *
 * This is the sibling of `ControlSpec`, not a replacement for it: `control` says how a turn
 * reaches a PANE-backed session of this harness, and a session an operator started is
 * pane-backed whatever this slot says. See `docs/plans/agent-sdk-sessions/plan.md`.
 */
export interface SdkSpec {
  /**
   * Start (or resume) an embedded session.
   *
   * REJECTS rather than degrades. A driver that cannot honour what it was asked for - a
   * model this build cannot select, a resume id the harness no longer holds - must throw,
   * because the alternative is a card that looks dispatched and is running something else.
   */
  launch(opts: SdkLaunchOptions): Promise<SdkSessionHandle>;
}

/**
 * How a conversation this harness already holds is CONTINUED interactively, in a terminal.
 *
 * This exists because every vendor here keeps one session store behind its programmatic and
 * its interactive surfaces: a session writes the file (`~/.claude/projects/…`,
 * `~/.codex/sessions/…`, pi's session dir) that `claude --resume <id>`, `codex resume <id>`
 * and `pi --session <id>` read back. So "let me drive" is a handoff rather than a lost
 * conversation, which is what stops an embedded session from being a trap.
 *
 * It lived on `SdkSpec` and was WRONG THERE, which is the reason to read this comment
 * before moving it back. Only a harness with an embedded driver could answer it, so pi -
 * whose session id and `--session` CLI are sufficient - could not say how to continue
 * itself. Those are two unrelated capabilities: whether a harness can be driven
 * programmatically, and whether its CLI can reopen a conversation. Every shipped harness
 * answers this one; Claude and Codex currently answer the other.
 *
 * On the SPEC rather than composed at a route, for the rule the whole harness axis rests
 * on: reach a capability through the registry, never by testing `s.agent`.
 *
 * `null` is a real answer - a harness whose CLI cannot reopen a conversation - and it is
 * ONE FACT IN TWO FILES with `HarnessCapabilities.resumes`, which the browser reads to
 * shape the control. `harness-resume.test.ts` fails until the two agree.
 */
export interface ResumeSpec {
  /**
   * The argv AFTER this harness's own binary that continues `agentSessionId`.
   *
   * Measured against a real install for each harness, never read off release notes - the
   * `HARNESSES.codex.tui` correction is what assuming costs. Claude takes a flag, Codex a
   * subcommand, pi a different flag; the shape is not shared and must not be guessed.
   *
   * `permissionMode` is the mode the session was RUNNING in, or null when nobody measured
   * one. It rides along because it is the one setting neither CLI restores from the
   * conversation itself: an embedded session's mode lived in driver options and turn
   * parameters, and a terminal one reopens on the operator's own defaults - so without it
   * a session the operator was running in auto comes back in manual and they have to
   * notice and re-set it by hand. Model and effort deliberately still do NOT ride along:
   * the resumed conversation carries those, and re-stating them would silently change a
   * conversation the operator asked to CONTINUE. Each harness renders only its own mode
   * vocabulary and drops the rest - the union is shared, and a flag rendered from another
   * harness's mode would abort the resume instead of opening it.
   */
  argv(agentSessionId: string, permissionMode: PermissionMode | null): readonly string[];
}

export interface SdkLaunchOptions {
  cwd: string;
  /** Disposable Mission Control state home shared by this session's agent and MCP children. */
  stateHome: string;
  /** The task intent, delivered as turn one - there is no separate "type the prompt" step. */
  prompt: string;
  model: string | null;
  effort: ThinkingLevel | null;
  /** From `dispatchPermissionMode` - the same source the terminal path renders as argv. */
  permissionMode: PermissionMode | null;
  /** Rendered from `mission-mcp.ts`'s single descriptor, or null to register nothing. */
  mcp: MissionMcpDescriptor | null;
  /**
   * Absolute paths, beyond `cwd`, this session must be able to WRITE to - the secondary
   * worktrees of a multi-repo task. Empty on every ordinary dispatch.
   *
   * A launch-time grant on both drivers because neither can be widened afterwards: Claude's
   * runtime directory control refuses anything that is not under cwd or a launch-time
   * directory, and a Codex thread's sandbox is fixed once it starts. A driver that ignored
   * this would produce a session holding an intent naming repositories it cannot write to,
   * which is why `MultiRepoDispatchSpec.sdk` is a measured flag rather than an assumption.
   */
  extraDirs: readonly string[];
  /**
   * The operator's REPOSITORY STANDING INSTRUCTIONS, for the harnesses whose embedded
   * driver has a channel for text that is not a conversation turn - Claude's
   * `systemPrompt.append`, Codex's `developerInstructions`.
   *
   * `""` means send nothing, and it is the value every pair without such a channel gets:
   * on those the text has already been composed into `prompt`, and delivering it here as
   * well would have the agent read the same rule twice in its first turn. Which case a
   * launch is in is decided once, by `standingInstructionsChannel`, and never re-derived
   * inside an adapter.
   */
  standingInstructions: string;
  /**
   * What to SEND as prose when the out-of-band channel above turns out to be unusable.
   *
   * On a fresh launch this is turn one with the block already composed into it, in the same
   * slot the channel-less pairs put it: below the repository manifest, which names the
   * checkouts the rules are about, and above the request they govern. On a RESUME it is the
   * block by itself, because the intent is already in the conversation being reopened and
   * re-sending it would make the agent start its task over.
   *
   * Empty whenever there is nothing to fall back to: no standing instructions at all, or a
   * pair with no out-of-band channel, where the block is already inside `prompt`.
   *
   * Composed by the CALLER rather than by the adapter, because only the caller knows which of
   * those two cases this is and where in turn one the block belongs. An adapter prepending to
   * `prompt` would invert that order at exactly the moment nobody is watching.
   */
  standingInstructionsPrompt: string;
  /** Harness-native session/thread id to continue, for a restart. Null starts fresh. */
  resume: string | null;
}

/** An image accompanying a turn. A PATH, because that is what an upload durably is. */
export interface SdkImage {
  /** Absolute path on the daemon's host. The adapter reads and encodes it. */
  path: string;
  /** MIME type when the upload recorded one; null lets the adapter decide. */
  mediaType: string | null;
}

/** One turn of user input. */
export interface SdkTurn {
  text: string;
  images?: readonly SdkImage[];
}

/**
 * A live embedded session: the supervisor's ONLY view of it.
 *
 * Everything a caller can do to an SDK session is a method here, which is what keeps the
 * protocol inside the adapter. Nothing above this interface knows whether it is talking to
 * a stream-json subprocess, a JSON-RPC server or a JSONL pipe.
 */
export interface SdkSessionHandle {
  /** Structured lifecycle. The supervisor pumps this until it ends. */
  events: AsyncIterable<SdkEvent>;
  /**
   * Deliver a user turn, resolving when the harness ACCEPTED it.
   *
   * That ack is the thing `injectPrompt` never had: no settle window, no paste
   * placeholder to read back, no Enter that a mention popup may have eaten. A driver that
   * cannot ack must reject - "probably landed" is the failure mode this replaces. The
   * disposition keeps "accepted into a busy driver's FIFO" distinct from "started" and
   * "steered into the active turn", because those can look identical in the transcript
   * until the current turn finishes.
   */
  send(turn: SdkTurn): Promise<SdkSendDisposition>;
  /**
   * Start a new turn only while the driver is positively idle.
   *
   * Null is a measured busy result. It is used by Mission Control's editable outbox so a
   * pending message never becomes a Codex steer or enters Claude's internal FIFO between
   * an idle observation and the driver's own acceptance boundary.
   */
  sendIfIdle(turn: SdkTurn): Promise<"started" | null>;
  interrupt(): Promise<void>;
  /** Resolve a pending `SessionRequest` (permission, question, plan, approval). */
  answer(requestId: string, answer: SessionRequestAnswer): Promise<void>;
  /**
   * Live controls, or `null` when this driver genuinely cannot offer one.
   *
   * The capability-null doctrine, at method granularity: null here is an ANSWER ("this
   * transport has no way to change the mode of a running session"), never a stub. A stub
   * that resolved would report a mode change that never happened, which is exactly the
   * silent lie `pastePlaceholder: null` exists to prevent on the pane side. Declare one
   * null only after pointing the driver at a real install.
   */
  setPermissionMode: ((mode: PermissionMode) => Promise<void>) | null;
  setEffort: ((effort: ThinkingLevel) => Promise<void>) | null;
  setModel: ((model: string) => Promise<void>) | null;
  clearContext: (() => Promise<void>) | null;
  /** Stop the session's driver. Graceful; the handle must then emit `exited`. */
  stop(): Promise<void>;
  /**
   * How this launch ACTUALLY carried the operator's standing instructions, when that is not
   * what the caller asked for. Undefined means it did what was asked.
   *
   * A driver only learns at launch whether its out-of-band channel is usable - Codex has to
   * read the operator's configured developer instructions before it can merge into them, and
   * that read can fail - so "which channel carried this" is not fully answerable before the
   * process exists. Reported rather than assumed, because the answer is written into the
   * session's launch snapshot and an assignment later reads it to decide whether the rule is
   * still installed on the process or has to be repeated. Recording the requested mechanism
   * for a launch that fell back would make that decision on a fact that is not true.
   */
  readonly standingInstructionsMechanism?: StandingInstructionsMechanism;
}

/**
 * An ask a driver is BLOCKED on, in harness-neutral form.
 *
 * Projected into `PaneDialog` (`sdk/dialog.ts`) rather than being a second wire shape, so
 * every surface that already renders a menu, buckets a session as `needs-you`, or lets
 * Foreman answer one keeps working with no new arm. What a driver adds over a screen is
 * everything the screen could not say: a correlation id, what kind of ask this is, and -
 * for `AskUserQuestion` - all of its questions at once instead of the one visible tab.
 */
export interface SessionRequest {
  /** Correlation id. An answer must echo it; the driver resolves the callback it names. */
  id: string;
  kind: NonNullable<PaneDialog["kind"]>;
  /** What is being asked, in the words the human sees. */
  prompt: string;
  /**
   * The rows offered for a single ask, ascending from 1. Empty when this request is a
   * form - `questions` carries the rows then, one set per question.
   */
  options: readonly PaneOption[];
  /** The questions of a multi-question form; absent for a single ask. */
  questions?: readonly SessionRequestQuestion[];
}

/** One question's answer inside a form submission. */
export interface SessionRequestFormAnswer {
  /** The question this answers, verbatim, so the driver can match it back. */
  question: string;
  /** Chosen row labels - one for a single-select question, several for a multi-select. */
  labels: readonly string[];
  /** Free text, which a driver form admits and a pane form has to refuse. */
  text?: string;
}

/**
 * How a pending request is answered.
 *
 * A row number alone is never authoritative: it is a position on a list that may have
 * been re-read since, and the label check (`optionRowMiss`) is what has always caught a
 * miscounting caller. `option` carries both because that is what `/select-option` sends on
 * either runtime (C3) - the number identifies, the label verifies.
 */
export type SessionRequestAnswer =
  | { kind: "option"; number: number; label: string }
  | { kind: "form"; answers: readonly SessionRequestFormAnswer[] }
  /** Prose: a deny-with-message, or a free-text reply where the harness admits one. */
  | { kind: "text"; text: string };

/**
 * Per-turn token usage as a driver reports it.
 *
 * The flat fields are the display view: one turn flattened to one model, which is what a
 * card's chip can show. `models` and `turnId` are the LEDGER view, and a driver populates
 * them only when it can answer both questions the ledger asks - which model actually served
 * each request, and what identity makes re-recording this turn a no-op.
 *
 * That split is why they are optional rather than required. A driver whose harness owns a
 * different ledger writer supplies the flat view alone and nothing is written: Codex's spend
 * comes from the rollout reader, which sees files this driver does not, so a Codex turn
 * reporting `models` here would double-count against it. Claude's driver supplies both,
 * because for Claude there is no second reader - see `applyOtelMetrics`.
 */
export interface SdkUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoningOutput?: number;
  modelId: string | null;
  /** The harness's own cost figure for the turn, when it reports one. */
  costUsd: number | null;
  /**
   * This turn's dedup identity, when the harness mints one that survives a restart.
   *
   * Written to `usage_ledger.window_end_ns`, so it must be stable for the turn and unique
   * across them. Absent means "do not write this turn", never "invent a key".
   */
  turnId?: string;
  /**
   * The per-model breakdown the ledger stores a row each for.
   *
   * Present alongside `turnId` or not at all: a breakdown with no identity cannot be
   * deduplicated, and the registry writes neither half on its own.
   */
  models?: readonly import("@shared/llm-spend.ts").LlmSpendModelUsage[];
}

/**
 * What a driver tells the daemon about its session.
 *
 * The counterpart of a hook ingest, with one difference that removes a whole class of
 * guard: the supervisor OWNS the binding it reports here, so there is no attribution
 * question to answer. `applyHook`'s `discoveredIdentity` check exists because a hook is a
 * claim about a process we read separately; a driver event comes from the handle the
 * supervisor owns, whether or not that handle has a separate subprocess.
 */
export type SdkEvent =
  | {
      /** Identity, as soon as the harness mints it. This is what keeps the READ path working. */
      kind: "bound";
      agentSessionId: string;
      transcriptPath: string | null;
      /**
       * The model the harness actually bound, not merely the launch-time request.
       *
       * Required even when unknown so a new driver cannot accidentally leave an idle or
       * resumed card blank while waiting for a transcript record that may never arrive.
       */
      modelId: string | null;
      /**
       * The subprocess the driver spawned, or null when there is no separate process to
       * name. This is the ONE place a pid can arrive for a driver-run session.
       */
      pid: number | null;
      /**
       * True when this identity is the one a `clearContext()` asked for.
       *
       * The driver's answer to the hook path's `SessionStart { source: "clear" }`, and the
       * reason it has to come from HERE: a rotation looks identical from outside whether the
       * agent was cleared or merely reported a new id, and the only party that knows which is
       * the one that issued the command. Without it, `resetSession`'s pre-armed rebind waits
       * out its five seconds and reports `workIdentityReady: false` on a reset that worked -
       * which leaves the work episode, and with it the task's ownership of its branch, on the
       * dead identity.
       *
       * Optional, and absent means "an ordinary binding", so a driver that never clears (and
       * every event a driver already emits) is unchanged.
       */
      cleared?: true;
    }
  | { kind: "state"; state: "working" | "idle"; activity: string | null }
  /**
   * Account-global subscription windows learned through a pane-less driver.
   *
   * Interactive Claude sessions report these through statusLine. An embedded session has
   * no status line, so its driver has to carry the same fact explicitly or a daemon restart
   * leaves the fleet runway blank until an interactive session happens to render.
   */
  | { kind: "rate_limits"; rateLimits: import("@shared/types.ts").RateLimits }
  | { kind: "request"; request: SessionRequest }
  | { kind: "request_resolved"; requestId: string }
  | { kind: "turn_done"; usage: SdkUsage | null }
  /**
   * `gh pr create` observed on the tool stream - authorship evidence, not a url sniff.
   *
   * A LIST because one command can open one pull request per repository a multi-repo task
   * attached, and each of them needs announcing separately. The first is also the one that
   * decorates the card, which is the scalar this used to carry.
   */
  | { kind: "pr_created"; urls: string[] }
  | { kind: "exited"; reason: string; resumable: boolean };

/**
 * Reading the agent's own permission-mode footer off a pane.
 *
 * Null on `TuiSpec` means the pane has no permission-mode footer grammar - not that the
 * harness has no permission modes. The capability and its live control are declared
 * separately in `PermissionModeSpec`: Codex, for example, reads modes from its rollout
 * and drives its native menu without exposing a footer cycle here.
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
  /** Reading the permission-mode footer, or null when the pane exposes no mode line. */
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
export type Harness = HarnessCapabilities & HarnessDaemonSlots;

/**
 * The daemon-only half of `Harness`, intersected rather than `extends`-ed because
 * `HarnessCapabilities` now carries a union (`ModelDiscoverySpec`) and an interface cannot
 * extend one. Nothing else changes: a call site holding a `Harness` still sees every
 * capability and every daemon slot on one flat object.
 */
interface HarnessDaemonSlots {
  /** Matches this harness's key in `HARNESSES`. */
  id: AgentType;
  /** How this harness records a session on disk, or null when it records nothing. */
  transcript: TranscriptSpec | null;
  /** Durable request-usage reader, or null when usage arrives through another transport. */
  usage: UsageSpec | null;
  /** How this harness pushes its lifecycle at us, or null when it pushes nothing. */
  hooks: HookSpec | null;
  /** How to find this harness's process. Required - see `DetectSpec`. */
  detect: DetectSpec;
  /** Which CLI to launch, and what overrides it. Required - a harness runs something. */
  bin: BinSpec;
  /** How this harness supplies dispatch-time model choices. Required and exhaustive. */
  models: ModelCatalogSpec;
  /** How this harness's screen READS, or null when we cannot read it at all. */
  tui: TuiSpec | null;
  /** How a turn reaches this harness. Not nullable - see `ControlSpec`. */
  control: ControlSpec;
  /** How to run this harness embedded, or null when no driver exists (yet). See `SdkSpec`. */
  sdk: SdkSpec | null;
  /**
   * How to continue one of this harness's conversations in a terminal, or null when its CLI
   * cannot reopen one. See `ResumeSpec` - notably why this is NOT part of `sdk`.
   */
  resume: ResumeSpec | null;
}
