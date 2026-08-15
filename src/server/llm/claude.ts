import { HEADLESS_CWD, killLiveClaudeRuns, runClaudeText } from "../claude-cli.ts";
import { killLiveClaudeSdkRuns, runClaudeSdkOneShot } from "./claude-sdk.ts";
import {
  CLAUDE_SANDBOX,
  claudeGrantSettings,
} from "./claude-grant.ts";
import { unwrapEnvelope } from "./structured.ts";
import { headlessTranscriptDir } from "../goal/prune.ts";
import { DEFAULT_CLAUDE_TRANSPORT, grantRefusal } from "@shared/llm.ts";
import { reportLlmSpend, spendReportIsRecordable } from "./spend.ts";
import { claudeEnvelopeModels } from "../harness/claude/envelope.ts";
import type { ClaudeTransport, LlmRunOptions, LlmRunner } from "@shared/llm.ts";
import type { LlmSpendReport, LlmSpendRole } from "@shared/llm-spend.ts";
import type { ClaudeSdkOneShotDeps } from "../harness/claude/sdk-types.ts";

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

// Preserve the runner module's public contract while the pure grant policy lives outside
// either transport. Both print and SDK import the same renderer, so there is still exactly
// one derivation of Claude's permission payload and no circular transport dependency.
export { CLAUDE_GRANTABLE_TOOLS, claudeGrantSettings } from "./claude-grant.ts";

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
// the database; the separate Foreman worker installs the value it learns over HTTP, so it
// stays a database non-reader. The fallback covers direct use before either process installs
// its resolver and must match the shipped default.
let resolveTransport: () => ClaudeTransport = () => DEFAULT_CLAUDE_TRANSPORT;
let sdkDeps: ClaudeSdkOneShotDeps | undefined;

/**
 * Install this process's per-call Claude transport resolver, returning a restore hook.
 *
 * The optional dependency is the contract-test seam for the routed SDK branch. Production
 * omits it and `runClaudeSdkOneShot` uses the pinned binary and lazy vendor import.
 */
export function configureClaudeRunnerTransport(
  resolver: () => ClaudeTransport,
  deps?: ClaudeSdkOneShotDeps,
): () => void {
  const previous = resolveTransport;
  const previousDeps = sdkDeps;
  resolveTransport = resolver;
  sdkDeps = deps;
  return () => {
    resolveTransport = previous;
    sdkDeps = previousDeps;
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
    const transport = resolveTransport();
    if (transport === "sdk") {
      const result = await runClaudeSdkOneShot(prompt, opts, sdkDeps);
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
      images: opts.images,
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

  /**
   * Provider-validated input shape, and true of BOTH transports - but only because the SDK
   * one is now allowed the turns it takes to keep the promise.
   *
   * It was flatly false for `sdk` while `runClaudeSdkOneShot` capped a schema run at one
   * turn: the run died `error_max_turns` before any validated value existed. The honest fix
   * was the cap, not this declaration. What backs it on each side is different and worth
   * naming - `claude -p --json-schema` validates before printing, while the SDK path is
   * validated by the `StructuredOutput` tool, which Ajv-checks the WHOLE schema even where
   * the provider fell back to non-strict. Both therefore hand back a value of the declared
   * shape or fail loudly; neither ever returns unvalidated prose, because `resultText`
   * refuses to read `result` on a schema run.
   *
   * This is only ever a claim about INPUT shape. Every caller still runs its own Zod parse,
   * which is where transforms and refinements no JSON Schema can express get applied.
   */
  structuredOutput: { guaranteesInputShape: true },

  sandbox: CLAUDE_SANDBOX,

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
