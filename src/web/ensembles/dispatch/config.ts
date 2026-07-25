import type { EnsembleCreateInput, EnsembleStrategyId } from "@shared/ensemble.ts";
import { ENSEMBLE_STRATEGY_INFO } from "@shared/ensemble-strategies.ts";

/**
 * The unsent Ensemble launch draft, lifted onto `DispatchLayer` beside the Single compose draft
 * so switching mode or closing the modal loses neither. `requestId` is the create idempotency
 * key (`sourceKey`): it is minted once and REUSED across previews and retries - a response lost
 * on the way back must not launch a second fleet - and rotates only after an accepted creation or
 * an explicit Clear.
 */
export interface EnsembleDispatchDraft {
  requestId: string;
  strategyId: EnsembleStrategyId;
  /** null means "this build's current version for that strategy". */
  strategyVersion: number | null;
  /** The strategy config blob, validated by the strategy's own schema at preview/create. */
  config: unknown;
  /** Optional post-selection Workflow placement, or null. */
  workflow: { workflowId: string; workflowVersion: number } | null;
  /** The fingerprint of the last input the operator reviewed; any change invalidates the launch. */
  previewFingerprint: string | null;
}

/** A fresh draft for a strategy, with the strategy's own fully-defaulted config. */
export function freshEnsembleDraft(strategyId: EnsembleStrategyId = "best_of_n"): EnsembleDispatchDraft {
  return {
    requestId: crypto.randomUUID(),
    strategyId,
    strategyVersion: null,
    config: defaultConfigFor(strategyId),
    workflow: null,
    previewFingerprint: null,
  };
}

/** The strategy's defaulted config, parsed through its own schema (the same shape create validates). */
export function defaultConfigFor(strategyId: EnsembleStrategyId): unknown {
  return ENSEMBLE_STRATEGY_INFO[strategyId].configSchema.parse({});
}

/** Read a dotted path (`evaluator.anonymizeSubjects`) out of a config blob. */
export function getConfigPath(config: unknown, key: string): unknown {
  let cursor: unknown = config;
  for (const part of key.split(".")) {
    if (cursor && typeof cursor === "object" && !Array.isArray(cursor)) {
      cursor = (cursor as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cursor;
}

/** Return a new config with one dotted path set, never mutating the input. */
export function setConfigPath(config: unknown, key: string, value: unknown): unknown {
  const clone = structuredClone(config) as Record<string, unknown>;
  const parts = key.split(".");
  let cursor: Record<string, unknown> = clone;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i]!;
    if (!cursor[part] || typeof cursor[part] !== "object") cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]!] = value;
  return clone;
}

/** The create/preview body for a draft, with attachments already folded into `intent`. */
export function buildEnsembleCreateInput(
  compose: { repoRoot: string; title: string },
  intent: string,
  draft: EnsembleDispatchDraft,
): EnsembleCreateInput {
  const title = compose.title.trim() || intent.trim().slice(0, 80) || "Ensemble";
  return {
    sourceKey: draft.requestId,
    title,
    intent,
    repoRoot: compose.repoRoot.trim(),
    strategyId: draft.strategyId,
    ...(draft.strategyVersion ? { strategyVersion: draft.strategyVersion } : {}),
    strategyConfig: draft.config,
    workflow: draft.workflow,
  };
}

/**
 * A stable fingerprint of everything the launch depends on EXCEPT the idempotency key. Preview
 * records it; a later edit changes it, which is what invalidates a stale confirmation.
 */
export function ensemblePreviewFingerprint(input: EnsembleCreateInput): string {
  return JSON.stringify({
    title: input.title,
    intent: input.intent,
    repoRoot: input.repoRoot,
    strategyId: input.strategyId,
    strategyVersion: input.strategyVersion ?? null,
    strategyConfig: input.strategyConfig,
    workflow: input.workflow ?? null,
  });
}
