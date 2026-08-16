// WHO spent the tokens, when the spender is not a card.
//
// Every other row in `usage_ledger` is keyed on a session: a human asked for the work, and
// the note key ties the dollars to the card they can see. The two autonomous loops have no
// such key. The Foreman and the Inspector spend on their own schedule, from a fresh process
// with no conversation and no card, and until this file existed that spend reached the
// ledger either not at all (the codex runner exports nothing) or as an orphan row under a
// uuid matching no card (the claude runner, whose headless runs still export OTel).
//
// A ROLE is the answer: a stable synthetic note key naming the subsystem AND the job. Not
// one `foreman` bucket, because the questions worth asking are per job - "is shadow triage
// worth what it costs", "did the review prompt fix land" - and a single bucket answers none
// of them. Six keys is what makes those separately answerable.
//
// Pure, and in `shared`, for the reason `llm.ts` is: the daemon WRITES these keys, the
// Foreman worker REPORTS them over a route, and the cost strip RENDERS them. Three readers
// of one tuple; a fourth spelling would be a fourth answer.

/**
 * Every headless spender, as the note key its usage lands under.
 *
 * APPEND-ONLY, and persisted: these strings are written into `usage_ledger.note_key` and
 * queried back by exact value, so renaming one silently orphans every historical row it
 * ever wrote. Add to the end; never reorder, never reuse. See the persisted-identifier
 * contract in `docs/agent-guides/change-contracts.md`.
 *
 * The `<subsystem>:<job>` shape is deliberate on both halves. The colon namespaces these
 * away from a real note key - `noteKeyFor` yields an agent session uuid or a synthetic
 * `proc:<tty>:<pid>:<startMs>` / `sdk:<uuid>`, so no card can ever mint `foreman:review` -
 * and the prefix is what lets a reader group by subsystem without a second table saying
 * which role belongs to whom.
 */
export const LLM_SPEND_ROLES = [
  "foreman:triage",
  "foreman:review",
  "foreman:verify",
  "foreman:backlog",
  "inspector:review",
  "inspector:reply",
  // Not one of this app's own loops, and the only member that is not. An observed pipeline
  // engine spends on its own schedule in its own worktrees, under no card and no dispatch -
  // which is the property this tuple selects for, and the only one it selects for. The
  // subsystem half is `pipeline` rather than `conductor` so a second engine appends a
  // sibling here instead of a second vocabulary; `PIPELINE_SPEND_ROLES` in `pipeline.ts` is
  // what stops a provider shipping without one.
  "pipeline:ai-conductor",
] as const;

export type LlmSpendRole = (typeof LLM_SPEND_ROLES)[number];

/** Whether a string names a role this build knows. The route's validation, and the UI's. */
export function isLlmSpendRole(value: string): value is LlmSpendRole {
  return (LLM_SPEND_ROLES as readonly string[]).includes(value);
}

/**
 * What a human reads instead of the key.
 *
 * A `Record<LlmSpendRole, ...>` rather than a lookup with a fallback, so a seventh role
 * cannot ship with the raw key showing in the strip - the same enforcement
 * `Record<LlmRunnerId, LlmRunner>` gives a new runner.
 */
export const LLM_SPEND_ROLE_LABELS: Record<LlmSpendRole, string> = {
  "foreman:triage": "Foreman triage",
  "foreman:review": "Foreman review",
  "foreman:verify": "Foreman verify",
  "foreman:backlog": "Foreman backlog",
  "inspector:review": "GitHub Inspector review",
  "inspector:reply": "GitHub Inspector reply",
  "pipeline:ai-conductor": "ai-conductor pipelines",
};

/**
 * What to show for a role, including one this build has never heard of.
 *
 * The Record above is exhaustive at COMPILE time, which is the enforcement worth having,
 * but the ledger outlives the build that wrote it: a role retired in a later version still
 * has rows, and reading its key back through the Record alone would render `undefined` in
 * the strip. Falling back to the stored key shows something true instead.
 */
export function spendRoleLabel(role: string): string {
  return isLlmSpendRole(role) ? LLM_SPEND_ROLE_LABELS[role] : role;
}

/**
 * One role's headless spend over a window, as the strip reads it.
 *
 * `costUsd` is null when the window holds a row whose model had no verified price - the
 * same refusal `FleetCost.estimatedCostToday` makes, for the same reason: a subtotal of the
 * priced rows presented as the role's cost is a confident wrong number.
 */
export interface AutomationRoleCost {
  /** The role key. Typed as a string, not `LlmSpendRole`: see `spendRoleLabel`. */
  role: string;
  costUsd: number | null;
  tokens: number;
  /** Distinct headless runs behind these figures, not ledger rows. */
  runs: number;
}

/**
 * One model's usage inside one headless run.
 *
 * Per model rather than per run, because a single run is not necessarily one model: a
 * `claude -p` envelope reports `modelUsage` keyed by the model that actually served each
 * request, and a run that quietly fell back to a different id would otherwise be recorded
 * under the id we ASKED for. The ledger has a `model_id` column for exactly this, and a
 * row per model is what keeps it honest.
 *
 * Token fields carry the ledger's convention, NOT any provider's: `input` EXCLUDES cached
 * and cache-write tokens. Codex reports the opposite (its `input_tokens` is inclusive), so
 * its runner subtracts before it gets here - the same subtraction `parseRecord` already
 * does for rollout rows, from the same helper, so the two cannot drift.
 */
export interface LlmSpendModelUsage {
  /** Resolved model id as the provider named it. Empty string when it named none. */
  modelId: string;
  input: number;
  output: number;
  reasoningOutput: number;
  cacheRead: number;
  cacheWrite: number;
  /**
   * Cost the PROVIDER reported, or null when it reported none and the daemon must price
   * the tokens itself.
   *
   * The distinction survives into `usage_ledger.cost_basis` as `reported` vs
   * `api-equivalent`, and it is worth keeping: `claude -p` returns a figure it calculated
   * from its own rates, while a Codex run returns tokens only and is valued here against a
   * versioned price snapshot that may not know the model at all.
   */
  reportedCostUsd: number | null;
}

/**
 * One finished headless run, as the runner that spawned it observed it.
 *
 * This is the wire shape between a runner and the ledger, and it crosses a process
 * boundary: the Foreman worker POSTs it, the daemon writes it. It therefore says nothing
 * about SQL and carries no session - a run has no card by construction.
 */
export interface LlmSpendReport {
  role: LlmSpendRole;
  /** Which provider ran it. Lands in `usage_ledger.agent`. */
  runner: string;
  /**
   * The run's own identity, from the provider: `claude -p`'s `session_id`, `codex exec`'s
   * `thread_id`.
   *
   * The DEDUP KEY, which is the whole reason it is required rather than nice to have. It
   * lands in `window_end_ns` - the ledger's "identity of this datapoint" column - so a
   * report the worker retried after a failed POST replaces its own row instead of adding a
   * second one. A run that reports no id is dropped rather than guessed at: losing one row
   * is recoverable, double-counting silently is not.
   *
   * It is also what lets a claude run's OTel twin be recognised and excluded from session
   * spend - see `automationTwinKeys` in `db.ts`.
   */
  runId: string;
  /** Epoch ms the run finished. The ledger's `ts`, so range queries work. */
  ts: number;
  models: LlmSpendModelUsage[];
}

/**
 * What one model's usage was worth, and who did the arithmetic.
 *
 * `null` from a runner's `price` is a real answer meaning "I cannot value this" - an
 * unrecognised model id, or a provider that reported no cost and has no price snapshot.
 * It lands as `cost_known = 0`, which is what makes the fleet estimate refuse to present a
 * known subtotal as a complete total rather than quietly treating unpriced as free.
 */
export interface LlmSpendPrice {
  costUsd: number;
  /** `reported` when the provider calculated it; `api-equivalent` when we did. */
  basis: "reported" | "api-equivalent";
  /** Immutable identity of the price snapshot used. Empty for a provider-reported figure. */
  pricingVersion: string;
}

/** Total tokens across every tier of a report, for logging and the route's sanity check. */
export function spendReportTokens(report: LlmSpendReport): number {
  return report.models.reduce(
    (n, m) => n + m.input + m.output + m.cacheRead + m.cacheWrite,
    0,
  );
}
