import { HEADLESS_CWD, killLiveClaudeRuns, runClaudeText } from "../claude-cli.ts";
import { killLiveClaudeSdkRuns, runClaudeSdkOneShot } from "./claude-sdk.ts";
import { unwrapEnvelope } from "./structured.ts";
import { headlessTranscriptDir } from "../goal/prune.ts";
import { grantRefusal } from "@shared/llm.ts";
import { reportLlmSpend, spendReportIsRecordable } from "./spend.ts";
import { claudeEnvelopeModels } from "../harness/claude/envelope.ts";
import type { ClaudeTransport, LlmRunOptions, LlmRunner, LlmToolGrant } from "@shared/llm.ts";
import type { LlmSpendReport, LlmSpendRole } from "@shared/llm-spend.ts";

// Claude's `LlmRunner`: one provider identity with print and SDK wire transports.
//
// The print adapter remains in `claude-cli.ts`; the SDK one-shot is beside this module in
// `claude-sdk.ts`. Both keep their transport-specific arguments next to the code they
// constrain, while this module owns the invariant shared above them: grant validation,
// spend reporting, runner identity, litter, and shutdown coverage.
//
// The direction of the remaining import is the same story: `HEADLESS_CWD` and
// `headlessTranscriptDir()` stay where they are and are surfaced here, so the cwd a run
// spawns in and the directory its transcript lands in continue to come from ONE
// derivation. They disagree silently if they are ever computed twice - the sweep cleans an
// empty directory while the real one grows forever.

/**
 * The tools a caller may be granted, and nothing else.
 *
 * Read-only by construction. Today exactly one caller holds any tools at all - the
 * Inspector, which needs to read source to review a diff honestly and carries four other
 * defence layers because of it - and this is the same three it holds. A caller wanting
 * `Bash` or `Write` has to edit this line, which is where that argument should have to be
 * made rather than in a call site's options object.
 */
export const CLAUDE_GRANTABLE_TOOLS = ["Read", "Grep", "Glob"] as const;

/**
 * Render a grant's deny globs into a `--settings` payload.
 *
 * Every path is denied for EVERY tool the run holds, not just `Read`. That is not padding:
 * `Grep` takes an absolute path and prints the matching lines, so a `Read(...)`-only list
 * protects nothing it names, and `Glob` confirms the files exist. The grant is what pays
 * for the tool access, so the denial has to cover the whole grant.
 *
 * Path-major, tool-minor, to reproduce byte-for-byte what the Inspector builds today.
 * `llm-runner-contract.test.ts` asserts that equality against the Inspector's own
 * constants, so the item that migrates it is provably a no-op rather than hopefully one.
 */
export function claudeGrantSettings(grant: LlmToolGrant): string {
  return JSON.stringify({
    permissions: {
      deny: grant.denyPaths.flatMap((p) => grant.tools.map((t) => `${t}(${p})`)),
    },
  });
}

/**
 * The cwd a run without a grant spawns in.
 *
 * Exported from the runner because it is a CLAUDE property rather than a general one, and
 * the interface is right not to carry it: with no tools a working directory is meaningless
 * to the run itself, but Claude derives the directory it writes the run's transcript to
 * from the spawner's cwd, so this constant alone decides where they all pile up.
 */
export { HEADLESS_CWD };

/**
 * Turn either Claude transport's result envelope into a spend report.
 *
 * The envelope is READ rather than routed, and that is the whole design. Both transports
 * hand back everything the ledger wants - the run's own `session_id`, a cost figure Claude
 * calculated itself, and a per-model token breakdown - so accounting for a headless run
 * needs no exporter, no endpoint and no session identity invented for it. The alternative
 * considered and rejected was OTel: these runs DO export it, but every run mints a fresh
 * uuid (deliberately - see the flags-that-are-absent note in `claude-cli.ts`), so the rows
 * land under a key matching no card and no role. Making that attributable would have meant
 * `--session-id`, which is precisely the flag that would give these runs a resumable
 * conversation and cost the context isolation the whole subsystem depends on.
 *
 * The token reading itself lives in `claudeEnvelopeModels`, not here, because the Agent SDK
 * driver reads the SAME payload off its `result` frame - the CLI serializes one struct for
 * both transports. What stays here is the part that is genuinely this caller's: unwrapping
 * stdout, and the `role`/`runId` framing a headless run needs and a driven session does not.
 */
export function claudeSpendReport(
  raw: string,
  role: LlmSpendRole,
  requestedModel: string,
  ts: number,
): LlmSpendReport | null {
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!envelope || typeof envelope !== "object") return null;
  const runId = typeof envelope.session_id === "string" ? envelope.session_id : "";
  const models = claudeEnvelopeModels(envelope, requestedModel);
  if (models.length === 0) return null;
  const report: LlmSpendReport = { role, runner: "claude", runId, ts, models };
  return spendReportIsRecordable(report) ? report : null;
}

// Process-local on purpose. The daemon installs its config-backed resolver after opening
// the database; the separate Foreman worker does not, so Phase 2 cannot make that worker a
// database reader by importing `llm/config.ts` from this shared runner. Phase 4 will give
// the worker its own transport input over its existing process boundary.
let resolveTransport: () => ClaudeTransport = () => "print";

/** Install this process's per-call Claude transport resolver, returning a restore hook. */
export function configureClaudeRunnerTransport(
  resolver: () => ClaudeTransport,
): () => void {
  const previous = resolveTransport;
  resolveTransport = resolver;
  return () => {
    resolveTransport = previous;
  };
}

export const claudeRunner: LlmRunner = {
  id: "claude",
  label: "Claude Code",

  async run(prompt: string, opts: LlmRunOptions = {}): Promise<string> {
    const grant = opts.grant ?? null;
    if (grant) {
      const refusal = grantRefusal(claudeRunner.sandbox, grant);
      // Refused BEFORE the spawn, and loudly. A grant this runner would only partly honour
      // must not run at all: a caller that asked for a deny list and silently did not get
      // one cannot tell the difference until something it named leaks into a prompt.
      if (refusal) throw new Error(`claude runner refused the tool grant: ${refusal}`);
    }
    // Phase 2 adopts only tool-less daemon work. A granted Inspector review stays on its
    // proven print sandbox until Phase 3 implements the same grant in SDK options. The SDK
    // adapter also refuses a grant directly, so bypassing this routing guard fails loudly.
    const transport = grant ? "print" : resolveTransport();
    if (transport === "sdk") {
      const result = await runClaudeSdkOneShot(prompt, opts);
      if (opts.role) {
        const report = claudeSpendReport(
          JSON.stringify(result.envelope),
          opts.role,
          opts.model ?? "",
          Date.now(),
        );
        if (report) reportLlmSpend(report);
      }
      return result.text;
    }
    // No grant means no `tools`, no `cwd` and no `settings` - so `runClaudeText` applies
    // its own defaults: every tool disabled, and the temp dir above. That is the safe
    // shape for every caller that embeds untrusted text, which is all of them but one.
    const raw = await runClaudeText(prompt, {
      model: opts.model,
      timeoutMs: opts.timeoutMs,
      schema: opts.schema ? JSON.stringify(opts.schema) : undefined,
      ...(grant
        ? { tools: grant.tools.join(","), cwd: grant.cwd, settings: claudeGrantSettings(grant) }
        : {}),
    });
    // Read for accounting BEFORE the envelope is discarded below - the usage lives in the
    // wrapper, not the text, so this is the only moment it exists.
    if (opts.role) {
      const report = claudeSpendReport(raw, opts.role, opts.model ?? "", Date.now());
      if (report) reportLlmSpend(report);
    }
    // Unwrapped here, so no caller ever sees the `{ result: "…" }` envelope. It exists
    // because THIS runner passes `--output-format json`; a caller that parsed it would be
    // undoing its own runner's flag, and a different provider's envelope would break it.
    return unwrapEnvelope(raw);
  },

  /**
   * Not implemented, and `null` rather than a throwing stub so the absence is a value the
   * caller can branch on.
   *
   * `claude -p` could do it - `--session-id <uuid>` then `--resume` - and the day it is
   * wanted the key must be one supervised session. Nothing here needs it: every caller
   * today summarises one window of one session and is better off with a clean context.
   */
  runInThread: null,

  /**
   * Claude Code prices its own runs, so this only forwards the figure the envelope carried.
   *
   * No local rate table, deliberately. The CLI bills through whatever account it is logged
   * in as and calculates from rates it knows and this repo does not; a second table here
   * would be a slower-moving copy that disagrees the first time either side changes, and
   * the disagreement would be invisible - two plausible dollar figures. `reported` is the
   * ledger's word for exactly this provenance.
   */
  price(usage) {
    if (usage.reportedCostUsd === null) return null;
    return { costUsd: usage.reportedCostUsd, basis: "reported", pricingVersion: "" };
  },

  structuredOutput: { guaranteesInputShape: true },

  sandbox: { tools: CLAUDE_GRANTABLE_TOOLS, enforcesDenyPaths: true },

  /**
   * Every run mints a session id and writes a real transcript, exactly as an interactive
   * session does - the litter `goal/prune.ts` sweeps by age. `.jsonl` only, because the
   * directory is not exclusively ours: a human running `claude` from `$TMPDIR` lands in
   * the same encoded project dir.
   */
  litter: { dir: headlessTranscriptDir, ext: ".jsonl" },

  killLiveRuns() {
    killLiveClaudeRuns();
    killLiveClaudeSdkRuns();
  },
};
