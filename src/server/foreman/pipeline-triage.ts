import { createHash } from "node:crypto";

import type {
  PipelineActionResult,
  PipelineForemanView,
  PipelineRun,
} from "@shared/pipeline.ts";
import type { RecordEpisode } from "@shared/protocol.ts";

/** The synthetic episode owner for one external pipeline run. */
export function pipelineEpisodeKey(
  run: Pick<PipelineRun, "provider" | "repoRoot" | "slug">,
): string {
  return `pipeline:${run.provider}:${run.repoRoot}:${run.slug}`;
}

/**
 * Identity for one exact halt observation.
 *
 * `updatedAt` is intentionally absent because the file watcher refreshes it on quiet reads.
 * Step state is included so a later recurrence of the same reason after progress is new work.
 */
export function pipelineHaltMarker(run: PipelineRun): string {
  const observation = JSON.stringify({
    provider: run.provider,
    repoRoot: run.repoRoot,
    slug: run.slug,
    halt: run.halt,
    lastStep: run.lastStep,
    steps: run.steps,
  });
  return `pipeline-halt:${createHash("sha256").update(observation).digest("hex")}`;
}

/**
 * The mechanical-only automation boundary.
 *
 * Exact equality is the fail-closed default: every known non-mechanical class and any value
 * sent by a newer daemon returns null without needing an allowlist that can go stale.
 */
export function pipelineAutomationAction(
  haltClass: string | null | undefined,
): "unpark" | null {
  return haltClass === "mechanical" ? "unpark" : null;
}

/** The HTTP-only capabilities pipeline triage needs from the Foreman client. */
export interface PipelineTriageActions {
  pipelineForeman(): Promise<PipelineForemanView>;
  recordPipelineEpisode(run: PipelineRun, episode: RecordEpisode): Promise<void>;
  pipelineAction(run: PipelineRun, action: "unpark"): Promise<PipelineActionResult>;
}

/**
 * Act on at most one mechanical halt per pass.
 *
 * The pending episode is written first. If the action response is lost, the next pass sees
 * the marker as handled and escalates by silence rather than risking a duplicate provider
 * command. Every other class is never handed to the action client at all.
 */
export async function runPipelineTriage(client: PipelineTriageActions): Promise<boolean> {
  const view = await client.pipelineForeman();
  if (!view.enabled) return false;
  for (const item of view.items) {
    if (item.handled || !item.run.halt) continue;
    const action = pipelineAutomationAction(item.run.halt.class);
    if (!action) continue;

    const base: RecordEpisode = {
      marker: item.marker,
      situation: "pipeline-halt",
      surface: "pipeline",
      question: item.run.halt.reason,
      purpose: `Triage ${item.run.provider} pipeline ${item.run.slug}`,
      classification: item.run.halt.class,
      confidence: 1,
      tier: 0,
      triageReason: "mechanical-only pipeline automation gate",
      disposition: "pending",
      lastAction: `reserved ${action} for ${item.run.slug}`,
    };
    await client.recordPipelineEpisode(item.run, base);
    const result = await client.pipelineAction(item.run, action);
    await client.recordPipelineEpisode(item.run, {
      ...base,
      disposition: result.ok ? "answered" : "escalated",
      lastAction: `${action}: ${result.detail}`,
      brief: result.ok
        ? `Foreman released the mechanical halt for the engine to retry through its ${action} action.`
        : `The engine refused Foreman's ${action} action: ${result.detail}`,
    });
    return true;
  }
  return false;
}

/** Turn a worker-owned wire episode into the daemon-owned database write. */
export function pipelineEpisodeWrite(
  run: PipelineRun,
  episode: RecordEpisode,
  now = Date.now(),
) {
  const resolved = episode.disposition === "answered" || episode.disposition === "skipped";
  return {
    noteKey: pipelineEpisodeKey(run),
    sessionId: pipelineEpisodeKey(run),
    marker: episode.marker,
    situation: episode.situation,
    surface: episode.surface,
    question: episode.question,
    pane: episode.pane ?? null,
    menu: episode.menu ?? null,
    reviewId: episode.reviewId ?? null,
    purpose: episode.purpose ?? null,
    brief: episode.brief ?? null,
    recommendation: episode.recommendation ?? null,
    classification: episode.classification ?? null,
    confidence: episode.confidence ?? null,
    tier: episode.tier ?? null,
    cheapAction: episode.cheapAction ?? null,
    divergence: episode.divergence ?? null,
    triageReason: episode.triageReason ?? null,
    skipReason: episode.skipReason ?? null,
    disposition: episode.disposition,
    lastAction: episode.lastAction ?? null,
    sentText: episode.sentText ?? null,
    sentOption: episode.sentOption ?? null,
    sentBy: episode.sentBy ?? null,
    createdAt: now,
    resolvedAt: resolved ? now : null,
    resolvedBy: resolved ? ("foreman" as const) : null,
  };
}
