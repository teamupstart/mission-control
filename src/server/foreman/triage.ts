import { z } from "zod";
import type { Session, TranscriptMessage } from "@shared/types.ts";
import type { ForemanConfig } from "@shared/protocol.ts";
import { buildTriagePrompt } from "./triage-prompt.ts";
import type { ReviewInput } from "./prompt.ts";
import { parseModelJson } from "./review.ts";
import { VerdictSchema } from "./verdict.ts";
import type { Verdict } from "./verdict.ts";
import type { Pending } from "./pending.ts";

// The cheap tier that sits in front of Foreman's full `claude -p` reviewer (see
// docs/plans/foreman-watcher/plan.md). It disposes the structurally-determined and
// the easy cases without an Opus call, and routes only the genuine judgment calls
// up to the full reviewer. Its guarantee is asymmetric: it may route DOWN to skip
// (leave it for you) or escalate (ask you) freely, but it may only take a
// substantive auto-answer for a tightly-bounded, allowlisted category - and even
// that answer flows through the SAME `planFromVerdict` gate the full path uses, so
// it can never send under a looser config than Opus would. The worst a mistake here
// can do is waste one Opus call (routed up needlessly) or hand you a session Foreman
// could have handled - never a wrong action.

/** Tier 1's cheap router model, unless overridden by config or FOREMAN_TRIAGE_MODEL. */
export const DEFAULT_TRIAGE_MODEL = "claude-haiku-4-5";
/**
 * The RECENT turns Tier 1 works from - a smaller window than the full reviewer's 48.
 *
 * The endpoint's `turns` query param is a BYTE-bound hint, NOT a turn bound: under its
 * head+tail byte budget `readTranscriptWindow` returns the file WHOLE, and over it returns
 * head(12)+tail(turns). So the real bound has to be applied on this side, after the fetch -
 * see `triageSession`.
 */
export const TIER1_TURNS = 12;
/**
 * The OPENING turns added on top of the recent ones for the router's prompt only - enough to
 * carry the goal the user set. See `promptWindow` for why the prompt and the scan differ.
 */
export const TIER1_HEAD_TURNS = 4;
/**
 * Below this, a bucketing of ANY kind is not trusted and routes up to Opus - the guard sits
 * above the bucket dispatch, so it catches a human-only escalate exactly as it catches a
 * routine-access answer or a quiet skip. Routing up a low-confidence escalate is a deliberate
 * trade: it could have been disposed for free, but an unsure router writes a poor brief.
 */
export const TIER1_MIN_CONFIDENCE = 0.6;

/** How the cheap tier resolved a session: it either disposed it or routed it up. */
export type TriageOutcome =
  | { kind: "dispose"; tier: 0 | 1; verdict: Verdict; reason: string }
  | { kind: "route-up"; reason: string };

/** The bucketing a Tier 1 router (Haiku) returns - it buckets the ask, it does not solve it. */
export const TriageReportSchema = z.object({
  /** 1-2 sentence purpose, always required (shown on the card even when routed up). */
  purpose: z.string().min(1),
  bucket: z.enum(["human-only", "routine-access", "needs-judgment"]),
  /** For human-only: escalate (needs you) or skip (can't tell what's asked). */
  disposition: z.enum(["escalate", "skip"]).optional(),
  /** For routine-access: the one-line approval reply to deliver. */
  answer: z.object({ text: z.string().min(1) }).optional(),
  /** Optional short decision-brief markdown for a human-only escalation. */
  brief: z.string().optional(),
  /** Optional suggested answer for a human-only escalation. */
  recommendation: z.string().optional(),
  /**
   * Required: an omitted confidence must fail validation and route up as
   * `tier1-unparseable` (an honest diagnosis of a broken router), rather than defaulting
   * to 0 and masquerading as a considered low-confidence deferral on every single session.
   */
  confidence: z.number().min(0).max(1),
});
export type TriageReport = z.infer<typeof TriageReportSchema>;

/**
 * Destructive / irreversible operation patterns, enumerated from the reviewer POLICY.
 * Used as a hard CODE backstop after the router: a match forces an escalation no matter
 * what the router bucketed. Because escalate is always the safe direction, this is
 * deliberately allowed to over-match - a false positive only hands a safe ask back to
 * you (lost automation), it can never wave a risky one through.
 */
const DESTRUCTIVE: RegExp[] = [
  /\brm\s+-[a-z]*[rf]/i, // rm -rf / -r / -f / -fr
  /\bgit\s+push\b[^\n]*(--force|-f\b|\s\+)/i, // force push
  /\bforce[-\s]?(push|merge)/i,
  /--force\b/i,
  /--no-verify\b/i,
  /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)/i,
  /\breset\s+--hard\b/i,
  /\bdrop\b[^\n]{0,24}\b(table|database|schema|collection|index)\b/i, // "drop table" / "drop the users table"
  /\btruncate\s+(table\b|\w)/i,
  /\bdelete\s+from\b/i,
  /\bdelete\s+(all|everything|every\b|the\s+(database|table|repo|branch|volume))/i,
  /\b(wipe|destroy|nuke|obliterate)\b/i,
  /\bchmod\s+777\b/i,
  /\bsudo\b/i,
  /\b(curl|wget)\b[^\n]*\|\s*(sh|bash|zsh)/i, // curl … | sh
  /\b(prod|production)\b[^\n]*\bdeploy/i,
  /\bdeploy[^\n]*\b(prod|production)\b/i,
  /\b(secret|credential|password|private\s+key|api[_\s-]?key|access\s+token)\b/i,
  /\.env\b/i,
  /\bexfiltrat/i,
  /\bskip\s+ci\b/i,
];

/** True when the text mentions a destructive/irreversible operation. Pure, over-matches safely. */
export function isDestructive(text: string): boolean {
  return DESTRUCTIVE.some((re) => re.test(text));
}

/**
 * Flatten the Tier 1 window (each turn's prose + its tool calls, names AND inputs) into
 * one blob for the denylist to scan. This is what gives the backstop something real to
 * match on the terminal surface: there, `Pending.question` is only the generic
 * notification line ("Claude needs your permission" - see the Notification branch of
 * registry.ts's `hookToState`), which never names the command being approved, so the
 * child's own recent window is the only code-level view of what it is about to run.
 * Callers must pass an already-trimmed window (see TIER1_TURNS): scanning a whole
 * session's history matches ambient prose unrelated to the pending ask.
 *
 * Tool INPUTS are scanned, not just names, so `Bash(rm -rf …)` is caught as the command
 * it is. Before they were carried, a `TranscriptMessage` held names only and a command
 * that never appeared in prose was invisible here - the router's own bucketing was the
 * sole thing in front of it. Prose remains in scope precisely because it is a weaker,
 * different signal: an agent narrating "then I'll force-push" trips this before it ever
 * reaches for the tool.
 *
 * Turns are joined with newlines because several patterns are `[^\n]`-bounded and must
 * not match across two unrelated turns; a call's name and input are joined with a space
 * for the same reason - `Bash` and its command are one utterance, not two.
 */
function riskContextFrom(messages: TranscriptMessage[]): string {
  return messages
    .map((m) => [m.text, ...m.tools.map((t) => (t.input ? `${t.name} ${t.input}` : t.name))].join(" "))
    .join("\n");
}

/**
 * Whether the window carried any prose at all - from EITHER role. There is no role filter and
 * none is implied: the gate proves nothing about who spoke or whether they spoke about the
 * pending ask. Backstop 3 keys on this rather than on `messages.length` because a turn survives
 * `toMessage` on its tool calls alone, so a window can be non-empty and still carry nothing
 * worth scanning; counting that as "scanned and clean" would be exactly the fail-open the
 * backstop exists to prevent.
 *
 * DELIBERATELY NARROWER than `riskContextFrom`, which also scans tool inputs. The two used to
 * mirror each other exactly and no longer do, because the asymmetry only errs one way: prose is
 * a STRICTER precondition than "something was scannable", so a window of prose-free tool calls
 * routes UP to the full reviewer that would have been Tier 1's to answer. That costs an Opus
 * call and can never wave anything through. Widening this to count tool inputs would be a real
 * saving now that they are carried - but it LOOSENS a safety gate, so it belongs in its own
 * change with its own reasoning, not smuggled in alongside the one that made it possible.
 */
function hasProse(messages: TranscriptMessage[]): boolean {
  return messages.some((m) => m.text.trim().length > 0);
}

/**
 * The router's PROMPT window: the opening turns (the goal the user set) plus the recent ones
 * (the pending ask). De-duped by record id, since the two slices overlap on a short transcript.
 *
 * This is deliberately WIDER than the denylist's scan window (the recent turns alone), and the
 * two must not be re-fused - they have opposite requirements:
 *
 *  - The router must SEE the opening turns. `purpose` ("what this session is for") is the one
 *    field Tier 1 always produces and it lands on the card, so a prompt built from the last 12
 *    turns alone describes the last ten minutes instead of the task - which is exactly what
 *    `readTranscriptWindow`'s head slice exists to prevent.
 *  - The denylist must NOT scan them. Its patterns over-match on purpose, so ambient prose from
 *    forty turns ago ("I'll read the API key from .env") would escalate every routine ask for
 *    the rest of the session, collapsing Tier 1's only substantive disposal.
 *
 * Handing the router more context than the scan weakens no backstop: `mapTriage` re-derives
 * `risky` from the scan window it is given, whatever the prompt happened to show.
 */
function promptWindow(all: TranscriptMessage[], recent: TranscriptMessage[]): TranscriptMessage[] {
  const head = all.slice(0, TIER1_HEAD_TURNS);
  const seen = new Set(head.map((m) => m.id));
  return [...head, ...recent.filter((m) => !seen.has(m.id))];
}

/** A skip verdict (leaves it for the human), reusing the full reviewer's Verdict shape. */
function skipVerdict(purpose: string, brief?: string): Verdict {
  return VerdictSchema.parse({ purpose, classification: "other", action: "skip", brief });
}

/** An escalate verdict (asks the human) with an optional brief + recommendation. */
function escalateVerdict(purpose: string, brief?: string, recommendation?: string): Verdict {
  return VerdictSchema.parse({
    purpose,
    classification: "design-fork",
    action: "escalate",
    brief,
    recommendation,
  });
}

/**
 * An access-approval answer verdict. Classification is "access" ON PURPOSE, so the
 * downstream `planFromVerdict` applies the exact same gate the full reviewer's access
 * answers get (live + repo allowlist + autoApproveAccess before it sends; a draft or
 * escalation otherwise).
 */
function accessAnswerVerdict(purpose: string, text: string): Verdict {
  return VerdictSchema.parse({
    purpose,
    classification: "access",
    action: "answer",
    answer: { text, submit: true },
  });
}

/**
 * Tier 0 - the structural gate. Pure, zero model: it disposes the cases whose outcome
 * is fixed by structure alone, and returns `continue` only for a genuinely answerable
 * surface (an input review, or a terminal with a pane) that Tier 1 should look at.
 */
export function tier0(pending: Pending): TriageOutcome | { kind: "continue" } {
  switch (pending.situation) {
    case "non-input-review": {
      // A plan/diff review is structurally human-only: Foreman can't auto-approve a
      // review. Today this still spends a full review just to write a purpose - Tier 0
      // short-circuits it with a purpose named straight from the review, no model call.
      const what = pending.reviewTitle
        ? `${pending.reviewKind ?? "code"} review "${pending.reviewTitle}"`
        : `${pending.reviewKind ?? "code"} review`;
      return {
        kind: "dispose",
        tier: 0,
        reason: "non-input-review",
        verdict: skipVerdict(
          `This session posted a ${what} for your approval; Foreman can't auto-approve reviews, so it's left for you.`,
        ),
      };
    }
    case "terminal-no-pane": {
      // A real question with no tmux/wezterm pane to type an answer into, so Foreman would
      // escalate regardless. The plan has Tier 0 escalate directly when the question is short
      // AND self-contained - but on this surface it never is, so this routes up instead. That
      // is the faithful reading of the plan's bullet given the real shape of the data:
      // `awaiting_input` is set in exactly one place (the Notification branch of registry.ts's
      // `hookToState`), whose activity line is a generic, 120-char-capped notification -
      // "Claude needs your permission" - that never names what is being approved. An escalation
      // built from it would tell you neither the session's goal nor the ask, where the full
      // reviewer reads the transcript and frames both. No-pane sessions are rare, so the Opus
      // call costs little; a content-free card costs you the read.
      return { kind: "route-up", reason: "terminal-no-pane" };
    }
    case "no-question": {
      // Needs-you for some other state with no answerable question - leave it for you.
      //
      // The activity line is deliberately NOT interpolated into the purpose: on THIS branch it
      // is a state label, not context. A session reaching here is `idle`, which the Stop hook
      // labels "idle" verbatim - and "The session needs you: idle" is worse than saying plainly
      // what happened. Tier 0 has no model, so it cannot do better than an honest canned line.
      //
      // A parked no-mistakes gate used to land here and be disposed exactly like this, which
      // was the bug: its question was sitting in the transcript and nothing ever read it. Those
      // now classify as `gate-parked` and route to the reviewer. What remains here genuinely has
      // no question - an idle session that is needs-you for some other reason.
      return {
        kind: "dispose",
        tier: 0,
        reason: "no-question",
        verdict: skipVerdict(
          "The session needs you, but it posted no answerable question - Foreman left it for you.",
        ),
      };
    }
    case "input-review":
    case "terminal-pane":
    // A parked gate is answerable prose-to-prose: the child relayed the finding and stopped, so
    // the reviewer reads the ask from the transcript and Foreman types the decision back. It
    // gets no Tier 0 shortcut precisely because the call needs a model - which was the whole
    // complaint about disposing it here.
    case "gate-parked":
      return { kind: "continue" };
  }
}

/**
 * The recent turns the denylist scans, plus why there might be none of them. `unavailable` is
 * the daemon reporting that the session has no resolvable transcript file AT ALL, which is a
 * different diagnosis from a window that simply came back empty - both route up, but the
 * worker log is this feature's only audit surface, so the two must not read alike there.
 */
export interface ScanWindow {
  /** Trimmed to the recent turns by the caller - see `recentTurns`. */
  messages: TranscriptMessage[];
  unavailable?: boolean;
  /** The caller could not place these turns in the session at all - see `recentTurns`. */
  boundaryUnknown?: boolean;
}

/**
 * Tier 1 - the pure mapping from a router's bucketing to a triage outcome, with the hard
 * CODE backstops the router cannot override: a destructive ask, low confidence, and a
 * window with no prose for the first to have scanned. Kept free of I/O so the whole safety
 * contract - including its diagnoses - is unit-tested in one place: the model buckets (the
 * report); this decides what that is allowed to become.
 */
export function mapTriage(report: TriageReport, pending: Pending, scan: ScanWindow): TriageOutcome {
  // Backstop 1: a destructive/irreversible ask (or reply, or recent prose) forces an
  // escalation no matter what the router said - it can only route DOWN to "ask the human",
  // never wave it through. The window matters most on the terminal surface, where
  // `question` is only a generic notification line and never names the command itself.
  // The window is taken whole (rather than a pre-flattened string) so that "scanned and
  // clean" stays distinguishable from "there was nothing to scan" - see backstop 3.
  const risky =
    isDestructive(pending.question) ||
    isDestructive(riskContextFrom(scan.messages)) ||
    (report.answer ? isDestructive(report.answer.text) : false);

  // needs-judgment always routes up: Tier 1 never invents a substantive answer.
  if (report.bucket === "needs-judgment") return { kind: "route-up", reason: "needs-judgment" };

  // Backstop 2: low confidence defaults to routing up (never a cheap skip of an
  // answerable surface), so an unsure router defers to Opus instead of guessing.
  if (report.confidence < TIER1_MIN_CONFIDENCE) {
    return { kind: "route-up", reason: "low-confidence" };
  }

  if (report.bucket === "human-only") {
    // A quiet skip is only allowed for a non-risky ask; anything risky is surfaced (escalated).
    if (report.disposition === "skip" && !risky) {
      return { kind: "dispose", tier: 1, reason: "human-only-skip", verdict: skipVerdict(report.purpose, report.brief) };
    }
    return {
      kind: "dispose",
      tier: 1,
      reason: risky ? "human-only-risky" : "human-only-escalate",
      verdict: escalateVerdict(report.purpose, report.brief, report.recommendation),
    };
  }

  // report.bucket === "routine-access"
  if (risky) {
    // The router thought it routine, but the denylist disagrees: escalate, keeping the
    // drafted reply as the recommendation so you can still act fast.
    return {
      kind: "dispose",
      tier: 1,
      reason: "access-risky-escalated",
      verdict: escalateVerdict(report.purpose, report.brief, report.answer?.text ?? report.recommendation),
    };
  }
  // Backstop 3: the auto-answer is the only outcome that ACTS, so it is the only one gated on
  // whether backstop 1 actually had a real view of the ask. Route up and let the full reviewer,
  // which fetches its own window, decide. Skip and escalate above are the safe directions and
  // stay allowed however little was scanned.
  //
  // (a) Nothing scannable in the window - but only where the question can't carry the command
  // itself. The two answerable surfaces genuinely differ here, and this must not be re-broadened
  // to cover both: on `terminal-pane` the question is the Notification hook's generic line
  // ("Claude needs your permission") and the reply is the router's own "Approve - go ahead.", so
  // the window's prose is the ONLY text backstop 1 could match a command in - with none,
  // `risky === false` means "unknown" rather than "safe". On `input-review` the question IS the
  // child's own review body, scanned in full above: the window corroborates it, it is not the
  // only witness, so its absence proves nothing and gating on it would route up asks that were
  // perfectly scannable.
  if (pending.situation === "terminal-pane" && !hasProse(scan.messages)) {
    return { kind: "route-up", reason: scan.unavailable ? "no-transcript-file" : "no-transcript-context" };
  }
  // (b) The window's shape could not be established (see `recentTurns`), so these turns can't be
  // placed in the session - a clean scan over them is not evidence about the PENDING ask on
  // either surface, however much prose they hold. Not scoped by situation for that reason.
  if (scan.boundaryUnknown) return { kind: "route-up", reason: "no-window-boundary" };

  if (!report.answer?.text) {
    // Bucketed routine-access but produced no reply to send - don't guess; route up.
    return { kind: "route-up", reason: "access-without-answer" };
  }
  return {
    kind: "dispose",
    tier: 1,
    reason: "routine-access",
    verdict: accessAnswerVerdict(report.purpose, report.answer.text),
  };
}

/** The daemon window as the cheap tier consumes it: the turns, plus where they came from. */
interface TriageWindow {
  messages: TranscriptMessage[];
  truncated: boolean;
  /** Boundary of the elided middle - see `TranscriptWindow` and `recentTurns`. */
  headCount?: number;
  /** A 200 carrying no window at all: the session has no resolvable transcript file. */
  unavailable?: boolean;
}

/** The daemon reads the cheap tier needs: a trimmed transcript + the router subprocess. */
export interface TriageDeps {
  transcript(id: string, turns: number): Promise<TriageWindow>;
  runModel(prompt: string, model: string): Promise<string>;
}

/**
 * The genuinely recent turns - the ask's neighbourhood, which is what the denylist scans and
 * what the no-context backstop keys on.
 *
 * `messages.slice(-TIER1_TURNS)` alone is NOT that. On the daemon's truncated path the response
 * is the opening turns followed by the closing ones with the middle ELIDED, so the two halves
 * are adjacent in the array but far apart in the session; the tail's turn count is byte-bounded,
 * so when it yields fewer turns than the head, slicing back from the end lands inside the
 * OPENING. That would re-open both gaps this window exists to close: ambient goal prose
 * ("read the API key from .env") escalating every routine ask for the rest of the session, and
 * - worse - opening prose satisfying `hasProse` while the actually-recent turns held nothing
 * scannable. So slice FORWARD from `headCount` instead. Re-ordering by `ts` would not help:
 * the array is already in chronological order, it is the adjacency that lies.
 *
 * `headCount` therefore carries the safety property, and it arrives over the wire on a response
 * this client casts rather than parses - so an absent one must NOT quietly become 0, which is
 * precisely the permissive answer (slice from the start = slice back into the opening). A
 * truncated window that won't say where its middle was elided is one whose turns cannot be
 * placed in the session at all: report that as unknown and let `mapTriage` withhold the only
 * outcome that acts. An untruncated window needs no boundary - every turn is contiguous.
 */
function recentTurns(window: TriageWindow): { messages: TranscriptMessage[]; boundaryUnknown: boolean } {
  if (window.truncated && window.headCount === undefined) {
    // Scanned whole rather than trimmed: the denylist over-matches on purpose, and with the
    // shape unknown, over-matching is the only reading that can't wave a risky ask through.
    return { messages: window.messages, boundaryUnknown: true };
  }
  return { messages: window.messages.slice(window.headCount ?? 0).slice(-TIER1_TURNS), boundaryUnknown: false };
}

/** Which posture the tier ladder runs one session in - see the `triage` config. */
export type TriagePosture = "off" | "shadow" | "on";

/**
 * Resolve the `triage` config to a posture. `on` - the ONE posture where Tier 1's verdicts are
 * APPLIED rather than merely logged - is reachable only by an exact match, and everything else,
 * including an absent or unrecognised value, lands on `shadow`, which still acts on the full
 * review. Unknown config must fail safe, never fail open: the whole feature rests on the cheap
 * tier only ever routing DOWN, so the permissive posture must never be the one reached by the
 * least specific condition. This mirrors `foremanMayActLive`, which reads an absent `mode` as
 * "not live" rather than as permission to send.
 *
 * The parameter is `unknown` on purpose. `ForemanClient.getConfig` parses the daemon's response
 * through `ForemanConfigSchema`, so a validated `cfg.triage` is the normal case and this returns
 * it unchanged - but this function exists for the case where that guarantee does not hold, and
 * typing it as the enum would be claiming the very thing it is here to stop depending on.
 */
export function triagePosture(triage: unknown): TriagePosture {
  switch (triage) {
    case "off":
    case "shadow":
    case "on":
      return triage;
    default:
      return "shadow";
  }
}

/** The triage model from config, then env, then the Haiku default. */
export function triageModel(cfg: ForemanConfig): string {
  return cfg.triageModel || process.env.FOREMAN_TRIAGE_MODEL || DEFAULT_TRIAGE_MODEL;
}

/**
 * Run the cheap tier for one session: Tier 0 first (pure), then - only for an answerable
 * surface - the Tier 1 router in a fresh cheap-model subprocess on a trimmed window.
 * Never throws: any router spawn/parse failure routes up to the full reviewer (fail-safe).
 */
export async function triageSession(
  deps: TriageDeps,
  pending: Pending,
  session: Session,
  cfg: ForemanConfig,
): Promise<TriageOutcome> {
  const t0 = tier0(pending);
  if (t0.kind !== "continue") return t0;

  let window: TriageWindow;
  try {
    // A failed fetch is an absent window, not an absent transcript file - the two stay
    // distinguishable in the log, so `unavailable` is deliberately left false here.
    window = await deps.transcript(session.id, TIER1_TURNS);
  } catch {
    window = { messages: [], truncated: false };
  }
  // The endpoint's `turns` only bounds BYTES (see TIER1_TURNS), so apply the real turn bound
  // here - see `recentTurns`. The router's prompt gets `recent` plus the opening turns; see
  // `promptWindow` for why the two windows differ. Eliding the middle is itself a truncation,
  // so say so rather than letting the router read a gapped window as the whole story.
  const recent = recentTurns(window);
  const messages = promptWindow(window.messages, recent.messages);
  const truncated = window.truncated || messages.length < window.messages.length;

  const input: ReviewInput = {
    session: {
      name: session.name,
      cwd: session.cwd,
      gitBranch: session.gitBranch,
      state: session.state,
      activity: session.activity,
    },
    surface: pending.surface,
    question: pending.question,
    transcript: messages,
    truncated,
  };

  let raw: string;
  try {
    raw = await deps.runModel(buildTriagePrompt(input), triageModel(cfg));
  } catch (err) {
    return { kind: "route-up", reason: `tier1-failed: ${String(err)}` };
  }
  const report = parseModelJson(raw, TriageReportSchema);
  if (!report) return { kind: "route-up", reason: "tier1-unparseable" };
  return mapTriage(report, pending, {
    messages: recent.messages,
    unavailable: window.unavailable,
    boundaryUnknown: recent.boundaryUnknown,
  });
}

/**
 * How the cheap tier's decision compares with the full reviewer's, for shadow-mode
 * telemetry. `deferred` = the cheap tier routed up (it asked for Opus, so there's nothing
 * to compare). `cheap-over-eager` is the one that matters: the cheap tier would have
 * auto-answered where Opus would not - that must stay near zero before flipping to `on`.
 * Pure.
 */
export type Divergence = "deferred" | "agree" | "cheap-over-eager" | "cheap-too-cautious" | "minor";

export function classifyDivergence(cheap: TriageOutcome, opus: Verdict): Divergence {
  if (cheap.kind === "route-up") return "deferred";
  const a = cheap.verdict.action;
  const b = opus.action;
  if (a === b) return "agree";
  if (a === "answer" && b !== "answer") return "cheap-over-eager";
  if (a !== "answer" && b === "answer") return "cheap-too-cautious";
  return "minor";
}
