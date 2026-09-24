import { tmpdir } from "node:os";

import {
  HARNESS_MODEL_CATALOG_LIMITS,
  ModelIdSchema,
  type HarnessModelCatalogChoice,
  type HarnessModelCatalogProblem,
} from "@shared/protocol.ts";
import { MODEL_CATALOG, modelLabel } from "@shared/model.ts";
import type { ModelCatalogDiscoveryResult } from "../types.ts";
import { claudeExecutable, sdkSubprocessEnv, startClaudeModelQuery } from "./sdk-deps.ts";
import type { ClaudeSdkUserMessage } from "./sdk-types.ts";

/** The cold SDK handshake was measured above five seconds; allow slow CLI startup. */
export const CLAUDE_MODEL_CATALOG_BOUNDS = {
  timeoutMs: 20_000,
  responseBytes: 262_144,
  rows: HARNESS_MODEL_CATALOG_LIMITS.choices,
} as const;

type ClaudeModelCatalogBounds = { [K in keyof typeof CLAUDE_MODEL_CATALOG_BOUNDS]: number };

type CatalogQuery = { supportedModels(): Promise<unknown> };

export interface ClaudeModelCatalogDeps {
  query?: typeof startClaudeModelQuery;
  executable?: () => Promise<string>;
  env?: () => Record<string, string | undefined>;
  bounds?: Partial<ClaudeModelCatalogBounds>;
}

function failure(problem: HarnessModelCatalogProblem): ModelCatalogDiscoveryResult {
  return { ok: false, problem };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized ? normalized.slice(0, max) : null;
}

/**
 * Claude's list mixes stable ids, family aliases, the account default, and modes.
 * Use resolved wire ids for family aliases, and never persist the moving default or a mode.
 */
function choice(value: unknown): HarnessModelCatalogChoice | null {
  const row = record(value);
  if (!row) return null;
  const alias = row.value;
  if (typeof alias !== "string") return null;
  const isModelId = alias.startsWith("claude-") && ModelIdSchema.safeParse(alias).success;
  const isFamilyAlias = /^(opus|sonnet|haiku|fable)(?:\[1m\])?$/.test(alias);
  if (!isModelId && !isFamilyAlias) return null;
  const resolved = row.resolvedModel;
  const rawId = typeof resolved === "string" ? resolved.replace(/\[1m\]$/i, "") : isModelId ? alias : null;
  if (!rawId || !rawId.startsWith("claude-") || !ModelIdSchema.safeParse(rawId).success) return null;
  return {
    id: rawId,
    label: text(row.displayName, HARNESS_MODEL_CATALOG_LIMITS.labelChars) ?? modelLabel(rawId) ?? rawId,
    hint: text(row.description, HARNESS_MODEL_CATALOG_LIMITS.hintChars),
    provider: null,
    contextWindow: null,
    reasoning: null,
    inputModes: [],
  };
}

function mapModels(value: unknown, bounds: ClaudeModelCatalogBounds): ModelCatalogDiscoveryResult {
  if (!Array.isArray(value)) return failure("invalid_response");
  if (value.length > bounds.rows) return failure("output_limit");
  let bytes: number;
  try { bytes = Buffer.byteLength(JSON.stringify(value), "utf8"); }
  catch { return failure("invalid_response"); }
  if (bytes > bounds.responseBytes) return failure("output_limit");

  const choices: HarnessModelCatalogChoice[] = [];
  const seen = new Set<string>();
  for (const row of value) {
    const mapped = choice(row);
    if (!mapped || seen.has(mapped.id)) continue;
    seen.add(mapped.id);
    choices.push(mapped);
  }
  if (choices.length === 0) return failure("unavailable");
  // The SDK lists an account's aliases, not every id Claude accepts. Keep the shipped
  // choices visible and mark those the account did not report instead of losing them.
  // A dated wire id and its undated shipped alias are one displayed version.
  const liveLabels = new Set(choices.map((entry) => entry.label));
  for (const shipped of MODEL_CATALOG.claude) {
    if (seen.has(shipped.id) || liveLabels.has(shipped.label)) continue;
    choices.push({ ...shipped, hint: "Built-in choice; not reported by this Claude installation" });
  }
  if (choices.length > bounds.rows) return failure("output_limit");
  return { ok: true, choices };
}

/** Ask the configured Claude CLI for its models without sending a user turn. */
export async function discoverClaudeModels(
  signal: AbortSignal,
  deps: ClaudeModelCatalogDeps = {},
): Promise<ModelCatalogDiscoveryResult> {
  if (signal.aborted) return failure("process_failed");
  const bounds = { ...CLAUDE_MODEL_CATALOG_BOUNDS, ...deps.bounds };
  let executable: string;
  try { executable = await (deps.executable ?? claudeExecutable)(); }
  catch { return failure("process_failed"); }
  if (signal.aborted) return failure("process_failed");

  const controller = new AbortController();
  let closeInput: (() => void) | null = null;
  let rejectAbort: (error: Error) => void = () => {};
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const prompt: AsyncIterable<ClaudeSdkUserMessage> = {
    [Symbol.asyncIterator]() {
      return {
        next: () => controller.signal.aborted
          ? Promise.resolve({ done: true as const, value: undefined })
          : new Promise<IteratorResult<ClaudeSdkUserMessage>>((resolve) => {
            closeInput = () => resolve({ done: true, value: undefined });
          }),
      };
    },
  };
  const abort = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    closeInput?.();
    rejectAbort(new Error("aborted"));
  };
  signal.addEventListener("abort", abort, { once: true });
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; abort(); }, bounds.timeoutMs);
  let phase: "start" | "models" = "start";
  try {
    const query: CatalogQuery = await Promise.race([(deps.query ?? startClaudeModelQuery)({
      prompt,
      options: {
        cwd: tmpdir(),
        pathToClaudeCodeExecutable: executable,
        env: (deps.env ?? (() => sdkSubprocessEnv(process.env, tmpdir())))(),
        settingSources: ["user"],
        tools: [],
        abortController: controller,
      },
    }), aborted]);
    phase = "models";
    const models = await Promise.race([query.supportedModels(), aborted]);
    return mapModels(models, bounds);
  } catch {
    return failure(timedOut ? "timeout" : phase === "models" ? "rpc_failed" : "process_failed");
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
    abort();
  }
}
