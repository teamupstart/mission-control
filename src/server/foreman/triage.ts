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
/** A smaller transcript window than the full reviewer's 48 - the router only buckets. */
export const TIER1_TURNS = 12;
/** Below this, a routine-access/skip call is not trusted: it routes up to Opus instead. */
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
  confidence: z.number().min(0).max(1).optional(),
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

/** A short terminal question can be escalated with a self-made brief; a long one routes up. */
function isShortSelfContained(question: string): boolean {
  const q = question.trim();
  return q.length > 0 && q.length <= 400;
}

/**
 * Tier 0 - the structural gate. Pure, zero model: it disposes the cases whose outcome
 * is fixed by structure alone, and returns `continue` only for a genuinely answerable
 * surface (an input review, or a terminal with a pane) that Tier 1 should look at.
 */
export function tier0(pending: Pending): TriageOutcome | { kind: "continue" } {
  switch (pending.situation) {
    case "non-input-review": {
      // A plan/diff/gate review is structurally human-only: Foreman can't auto-approve a
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
      // There's a real question but no tmux/wezterm pane to type an answer into, so
      // Foreman would escalate regardless. Escalate directly when the question is short
      // and self-contained; otherwise route up so the full reviewer can read the whole
      // transcript and frame a proper brief.
      if (isShortSelfContained(pending.question)) {
        return {
          kind: "dispose",
          tier: 0,
          reason: "terminal-no-pane-short",
          verdict: escalateVerdict(
            "The session is waiting on a terminal prompt, but there's no pane for Foreman to answer through.",
            `The session is blocked on:\n\n> ${collapse(pending.question, 400)}\n\nThere's no tmux/wezterm pane for Foreman to reply through, so it needs you.`,
          ),
        };
      }
      return { kind: "route-up", reason: "terminal-no-pane-long" };
    }
    case "no-question":
      // Needs-you for some other state with no answerable question - leave it for you.
      return {
        kind: "dispose",
        tier: 0,
        reason: "no-question",
        verdict: skipVerdict("The session needs you, but no explicit question was found to answer."),
      };
    case "input-review":
    case "terminal-pane":
      return { kind: "continue" };
  }
}

/**
 * Tier 1 - the pure mapping from a router's bucketing to a triage outcome, with the two
 * hard CODE backstops the router cannot override. Kept free of I/O so the whole safety
 * contract is unit-tested: the model buckets (the report); this decides what that is
 * allowed to become.
 */
export function mapTriage(report: TriageReport, pending: Pending): TriageOutcome {
  // Backstop 1: a destructive/irreversible ask (or reply) forces an escalation no matter
  // what the router said - it can only route DOWN to "ask the human", never wave it through.
  const risky =
    isDestructive(pending.question) || (report.answer ? isDestructive(report.answer.text) : false);

  // needs-judgment always routes up: Tier 1 never invents a substantive answer.
  if (report.bucket === "needs-judgment") return { kind: "route-up", reason: "needs-judgment" };

  // Backstop 2: low confidence defaults to routing up (never a cheap skip of an
  // answerable surface), so an unsure router defers to Opus instead of guessing.
  if ((report.confidence ?? 0) < TIER1_MIN_CONFIDENCE) {
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

/** The daemon reads the cheap tier needs: a trimmed transcript + the router subprocess. */
export interface TriageDeps {
  transcript(id: string, turns: number): Promise<{ messages: TranscriptMessage[]; truncated: boolean }>;
  runModel(prompt: string, model: string): Promise<string>;
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

  let window: { messages: TranscriptMessage[]; truncated: boolean };
  try {
    window = await deps.transcript(session.id, TIER1_TURNS);
  } catch {
    window = { messages: [], truncated: false };
  }
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
    transcript: window.messages,
    truncated: window.truncated,
  };

  let raw: string;
  try {
    raw = await deps.runModel(buildTriagePrompt(input), triageModel(cfg));
  } catch (err) {
    return { kind: "route-up", reason: `tier1-failed: ${String(err)}` };
  }
  const report = parseModelJson(raw, TriageReportSchema);
  if (!report) return { kind: "route-up", reason: "tier1-unparseable" };
  return mapTriage(report, pending);
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

/** Collapse whitespace and cap a string to one short line. */
function collapse(s: string, max = 400): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
