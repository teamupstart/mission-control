import { createHash, randomUUID } from "node:crypto";

import type {
  EngineerLifecycleEvent,
  PipelineCommission,
  PipelineCommissionHandoff,
  PipelineCommissionSuccessorCandidate,
  PipelineEngineerCapabilities,
  PipelineRecoveryGuard,
  PipelineRecoveryResultCode,
} from "@shared/pipeline.ts";

import {
  getPipelineCommission,
  reservePipelineCommissionAdoption,
  reservePipelineCommissionRetry,
  updatePipelineCommissionRecovery,
} from "../db.ts";
import { configuredGitHubRepositories, fetchPr, parsePrUrl } from "../inspector/github.ts";
import { applyEngineerEvent, parseEngineerEvent } from "./commissions.ts";
import type { PipelineEngineerLifecycle, PipelineEngineerRunSnapshot } from "./types.ts";
import { resolvePipelineEvidenceCommit } from "./workspace.ts";
import { PIPELINE_RECOVERY_CONSENT_WITHDRAWN } from "./config.ts";

export type PipelineRecoveryResult =
  | { ok: true; commission: PipelineCommission; idempotent: boolean }
  | { ok: false; code: PipelineRecoveryResultCode; error: string; outcomeUnknown?: boolean };

export interface PipelineRecoverySink {
  upsertPipelineCommission(commission: PipelineCommission): void;
}

interface PipelineAdoptionIdentity {
  guard: PipelineRecoveryGuard;
  candidateEngineerRunId: string;
  candidateRevision: number;
  candidateFingerprint: string;
}

const CONSENT_WITHDRAWN = PIPELINE_RECOVERY_CONSENT_WITHDRAWN;

function fail(
  code: PipelineRecoveryResultCode,
  error: string,
  outcomeUnknown = false,
): PipelineRecoveryResult {
  return { ok: false, code, error: error.slice(0, 500), ...(outcomeUnknown ? { outcomeUnknown } : {}) };
}

/** Match an exact request to an adoption that is already durably complete. */
export function completedPipelineAdoptionMatches(
  commission: PipelineCommission,
  input: PipelineAdoptionIdentity,
): boolean {
  const recovery = commission.recovery;
  const attempt = recovery
    ? commission.attempts.find((candidate) => candidate.attempt === recovery.attempt)
    : null;
  return commission.id === input.guard.commissionId &&
    recovery?.kind === "adoption" && recovery.state === "complete" &&
    recovery.predecessorAttempt === input.guard.activeAttempt &&
    recovery.predecessorEngineerRunId === input.guard.engineerRunId &&
    recovery.predecessorProviderRevision === input.guard.providerRevision &&
    recovery.candidateFingerprint === input.candidateFingerprint &&
    commission.activeAttempt === recovery.attempt &&
    recovery.attempt === input.guard.activeAttempt + 1 &&
    attempt?.origin === "provider_reconciled" &&
    attempt.engineerRunId === input.candidateEngineerRunId &&
    attempt.previousEngineerRunId === input.guard.engineerRunId &&
    attempt.providerRevision >= input.candidateRevision;
}

/** The exact predecessor identity a browser must echo before any recovery write. */
export function pipelineRecoveryGuard(
  commission: PipelineCommission,
): PipelineRecoveryGuard | null {
  const attempt = commission.attempts.find((entry) => entry.attempt === commission.activeAttempt);
  if (!attempt?.engineerRunId || attempt.providerRevision < 1) return null;
  return {
    commissionId: commission.id,
    activeAttempt: attempt.attempt,
    engineerRunId: attempt.engineerRunId,
    providerRevision: attempt.providerRevision,
  };
}

/** Probe first, then reserve one durable successor under the database compare-and-swap. */
export async function preparePipelineRetry(input: {
  sink: PipelineRecoverySink;
  commission: PipelineCommission;
  guard: PipelineRecoveryGuard;
  lifecycle: PipelineEngineerLifecycle;
  capabilities: PipelineEngineerCapabilities;
  authorized: () => boolean;
}): Promise<PipelineRecoveryResult> {
  if (!input.authorized()) return fail("task_conflict", CONSENT_WITHDRAWN);
  if (!input.capabilities.readiness || !input.capabilities.ownedAttempts ||
      !input.lifecycle.readinessProbe) {
    return fail("unsupported_provider", "the provider does not expose safe owned-attempt recovery");
  }
  const recovery = input.commission.recovery;
  const resumesReservedRetry = recovery?.kind === "retry" &&
    recovery.predecessorAttempt === input.guard.activeAttempt &&
    recovery.predecessorEngineerRunId === input.guard.engineerRunId &&
    recovery.predecessorProviderRevision === input.guard.providerRevision;
  if (resumesReservedRetry && recovery.state === "provider_outcome_unknown") {
    return fail(
      "provider_outcome_unknown",
      recovery.error ?? "the provider reservation outcome is unknown",
      true,
    );
  }
  if (!resumesReservedRetry) {
    const checked = await input.lifecycle.readinessProbe({ repoRoot: input.commission.repoRoot });
    if (!input.authorized()) return fail("task_conflict", CONSENT_WITHDRAWN);
    if (!checked.ok) {
      return fail(
        checked.outcomeUnknown ? "provider_outcome_unknown" : "readiness_blocked",
        `could not verify provider readiness: ${checked.error}`,
        checked.outcomeUnknown,
      );
    }
    const permitted = checked.value.status === "ready" ||
      (checked.value.status === "inconclusive" &&
        checked.value.code === "push_authorization_unproven");
    if (!permitted) {
      return fail("readiness_blocked", checked.value.remedy
        ? `${checked.value.summary} ${checked.value.remedy}`
        : checked.value.summary);
    }
  }
  if (!input.authorized()) return fail("task_conflict", CONSENT_WITHDRAWN);
  const reserved = reservePipelineCommissionRetry({
    guard: input.guard,
    launchKey: randomUUID(),
  });
  if (!reserved.ok) return reserved;
  input.sink.upsertPipelineCommission(reserved.commission);
  return reserved;
}

function fingerprint(
  snapshot: PipelineEngineerRunSnapshot,
  events: readonly (EngineerLifecycleEvent | Record<string, unknown>)[],
): string {
  return createHash("sha256").update(JSON.stringify({
    engineerRunId: snapshot.engineerRunId,
    correlationId: snapshot.correlationId,
    attemptKey: snapshot.attemptKey,
    attempt: snapshot.attempt,
    previousEngineerRunId: snapshot.previousEngineerRunId,
    repoRoot: snapshot.repoRoot,
    idea: snapshot.idea,
    eventRevision: snapshot.eventRevision,
    state: snapshot.state,
    integrationOwner: snapshot.integrationOwner ?? null,
    events,
  })).digest("hex");
}

function invalidCandidate(
  snapshot: PipelineEngineerRunSnapshot,
  events: readonly (EngineerLifecycleEvent | Record<string, unknown>)[],
  reason: string,
  evidence: Partial<Pick<PipelineCommissionSuccessorCandidate,
    "branch" | "planSlug" | "handoff" | "evidenceCommit" | "evidenceCommitProvenance">> = {},
): PipelineCommissionSuccessorCandidate {
  return {
    engineerRunId: snapshot.engineerRunId,
    attempt: snapshot.attempt,
    previousEngineerRunId: snapshot.previousEngineerRunId ?? "",
    attemptKey: snapshot.attemptKey,
    providerRevision: snapshot.eventRevision,
    state: snapshot.state,
    integrationOwner: snapshot.integrationOwner ?? null,
    fingerprint: fingerprint(snapshot, events),
    validation: "invalid",
    validationReason: reason.slice(0, 500),
    branch: evidence.branch ?? null,
    planSlug: evidence.planSlug ?? null,
    handoff: evidence.handoff ?? null,
    evidenceCommit: evidence.evidenceCommit ?? null,
    evidenceCommitProvenance: evidence.evidenceCommitProvenance ?? null,
  };
}

function stateFromEvents(events: readonly EngineerLifecycleEvent[]): PipelineEngineerRunSnapshot["state"] {
  let state: PipelineEngineerRunSnapshot["state"] = "created";
  for (const event of events) {
    if (["engineer_run_started", "engineer_step_started"].includes(event.type)) state = "authoring";
    if (event.type === "engineer_spec_handoff") state = "awaiting_spec_merge";
    if (event.type === "engineer_run_failed") state = "failed";
    if (event.type === "engineer_run_cancelled") state = "cancelled";
    if (event.type === "engineer_run_settled") state = "settled";
  }
  return state;
}

async function validatePullRequest(
  repoRoot: string,
  handoff: PipelineCommissionHandoff,
  authorized: () => boolean,
): Promise<string | null> {
  if (!authorized()) return CONSENT_WITHDRAWN;
  if (!handoff.prUrl) return "the provider reported a pull request handoff without a URL";
  const parsed = parsePrUrl(handoff.prUrl);
  if (!parsed) return "the provider handoff pull request URL is invalid";
  const repositories = await configuredGitHubRepositories(repoRoot);
  if (!authorized()) return CONSENT_WITHDRAWN;
  if (!repositories.some((repo) => repo.owner.toLowerCase() === parsed.owner.toLowerCase() &&
      repo.repo.toLowerCase() === parsed.repo.toLowerCase())) {
    return "the provider handoff pull request belongs to another repository";
  }
  const fetched = await fetchPr(repoRoot, parsed.owner, parsed.repo, parsed.number);
  if (!authorized()) return CONSENT_WITHDRAWN;
  if (!fetched.ok || !fetched.value) {
    return `the provider handoff pull request could not be verified: ${fetched.ok ? "missing response" : fetched.error}`;
  }
  return fetched.value.headRefName === handoff.branch
    ? null
    : "the provider handoff pull request head does not match its branch";
}

/** Inspect and fully replay one exact direct successor without changing Mission Control history. */
export async function inspectPipelineSuccessor(input: {
  commission: PipelineCommission;
  lifecycle: PipelineEngineerLifecycle;
  authorized: () => boolean;
}): Promise<PipelineCommissionSuccessorCandidate | null> {
  if (!input.authorized()) return null;
  const active = input.commission.attempts.find(
    (entry) => entry.attempt === input.commission.activeAttempt,
  );
  if (!active?.engineerRunId || !["failed", "cancelled", "settled"].includes(active.state)) {
    return null;
  }
  const inspected = await input.lifecycle.inspectCorrelation({
    repoRoot: input.commission.repoRoot,
    correlationId: input.commission.correlationId,
  });
  if (!input.authorized()) return null;
  if (!inspected.ok) return null;
  const predecessor = inspected.value.find((run) => run.attempt === active.attempt);
  const successors = inspected.value.filter((run) =>
    run.attempt === active.attempt + 1 && run.previousEngineerRunId === active.engineerRunId);
  if (successors.length === 0) return null;
  const successor = successors[0]!;
  const noEvents: EngineerLifecycleEvent[] = [];
  if (successors.length !== 1 || !predecessor ||
      predecessor.engineerRunId !== active.engineerRunId ||
      predecessor.attemptKey !== active.launchKey ||
      predecessor.eventRevision !== active.providerRevision) {
    return invalidCandidate(successor, noEvents, "the provider lineage no longer matches the active failed attempt");
  }
  if (successor.repoRoot !== input.commission.repoRoot ||
      successor.correlationId !== input.commission.correlationId ||
      successor.previousEngineerRunId !== active.engineerRunId ||
      successor.attempt !== active.attempt + 1 || successor.idea !== predecessor.idea) {
    return invalidCandidate(successor, noEvents, "the provider successor identity does not match the failed attempt");
  }
  if ((successor.integrationOwner ?? null) !== (predecessor.integrationOwner ?? null)) {
    return invalidCandidate(successor, noEvents, "the provider successor does not preserve integration ownership");
  }
  const replay = await input.lifecycle.replay({ engineerRunId: successor.engineerRunId, afterRevision: 0 });
  if (!input.authorized()) return null;
  if (!replay.ok) return invalidCandidate(successor, noEvents, `the provider successor journal could not be replayed: ${replay.error}`);
  const known: EngineerLifecycleEvent[] = [];
  for (const raw of replay.value) {
    const parsed = parseEngineerEvent(raw);
    if (!parsed.ok || !parsed.known) {
      return invalidCandidate(successor, replay.value, "the provider successor journal uses an unsupported schema");
    }
    known.push(parsed.event);
  }
  if (known.length !== successor.eventRevision ||
      known.some((event, index) => event.revision !== index + 1 ||
        event.engineerRunId !== successor.engineerRunId ||
        event.correlationId !== successor.correlationId ||
        event.attemptKey !== successor.attemptKey || event.attempt !== successor.attempt ||
        event.previousEngineerRunId !== successor.previousEngineerRunId ||
        event.repoRoot !== successor.repoRoot)) {
    return invalidCandidate(successor, known, "the provider successor journal is discontinuous or changes identity");
  }
  const created = known[0];
  if (created?.type !== "engineer_run_created" || created.idea !== successor.idea ||
      (created.integrationOwner ?? null) !== (successor.integrationOwner ?? null)) {
    return invalidCandidate(successor, known, "the provider successor creation event conflicts with its snapshot");
  }
  if (stateFromEvents(known) !== successor.state) {
    return invalidCandidate(successor, known, "the provider successor terminal state conflicts with its journal");
  }

  const worktrees = known.filter((event) => event.type === "engineer_worktree_created");
  const handoffs = known.filter((event) => event.type === "engineer_spec_handoff");
  if (worktrees.length > 1 || handoffs.length > 1) {
    return invalidCandidate(successor, known, "the provider successor journal changes workspace or handoff identity");
  }
  const worktree = worktrees[0];
  const handoffEvent = handoffs[0];
  const branch = worktree?.type === "engineer_worktree_created" ? worktree.branch :
    handoffEvent?.type === "engineer_spec_handoff" ? handoffEvent.branch : null;
  const planSlug = worktree?.type === "engineer_worktree_created" ? worktree.planSlug :
    handoffEvent?.type === "engineer_spec_handoff" ? handoffEvent.planSlug : null;
  if (worktree?.type === "engineer_worktree_created" && handoffEvent?.type === "engineer_spec_handoff" &&
      (worktree.branch !== handoffEvent.branch || worktree.planSlug !== handoffEvent.planSlug)) {
    return invalidCandidate(successor, known, "the provider successor handoff conflicts with its workspace identity", { branch, planSlug });
  }
  const handoff: PipelineCommissionHandoff | null = handoffEvent?.type === "engineer_spec_handoff"
    ? { planSlug: handoffEvent.planSlug, branch: handoffEvent.branch, prUrl: handoffEvent.prUrl, outcome: handoffEvent.outcome }
    : null;
  const retirement = known.findLast((event) => event.type === "engineer_worktree_retired");
  const evidenceCommit = retirement?.type === "engineer_worktree_retired"
    ? retirement.retainedCommit
    : handoffEvent?.type === "engineer_spec_handoff" ? handoffEvent.retainedCommit ?? null : null;
  const evidenceCommitProvenance = evidenceCommit
    ? retirement?.type === "engineer_worktree_retired" ? "provider_retirement" as const : "live_validation" as const
    : null;
  const evidence = { branch, planSlug, handoff, evidenceCommit, evidenceCommitProvenance };
  if (["awaiting_spec_merge", "settled"].includes(successor.state)) {
    if (!handoff || !branch || !planSlug || !evidenceCommit) {
      return invalidCandidate(successor, known, "the provider successor handoff lacks immutable workspace evidence", evidence);
    }
    const resolved = await resolvePipelineEvidenceCommit(input.commission.repoRoot, branch);
    if (!input.authorized()) return null;
    if (resolved !== evidenceCommit.toLowerCase()) {
      return invalidCandidate(successor, known, "the provider successor branch does not resolve to its durable commit", evidence);
    }
    if (handoff.outcome === "pr_opened") {
      const prError = await validatePullRequest(
        input.commission.repoRoot,
        handoff,
        input.authorized,
      );
      if (!input.authorized()) return null;
      if (prError) return invalidCandidate(successor, known, prError, evidence);
    }
  }
  return {
    ...invalidCandidate(successor, known, "", evidence),
    validation: "valid",
    validationReason: null,
  };
}

/** Revalidate, reserve, and replay one exact successor through the existing event reducer. */
export async function adoptPipelineSuccessor(input: {
  sink: PipelineRecoverySink;
  commission: PipelineCommission;
  guard: PipelineRecoveryGuard;
  candidateEngineerRunId: string;
  candidateRevision: number;
  candidateFingerprint: string;
  lifecycle: PipelineEngineerLifecycle;
  authorized: () => boolean;
}): Promise<PipelineRecoveryResult> {
  if (!input.authorized()) return fail("task_conflict", CONSENT_WITHDRAWN);
  const held = getPipelineCommission(input.commission.id) ?? input.commission;
  if (completedPipelineAdoptionMatches(held, input)) {
    return { ok: true, commission: held, idempotent: true };
  }
  const existingRecovery = held.recovery;
  const existingCandidate = held.successorCandidate;
  const resuming = existingRecovery?.kind === "adoption" &&
    existingRecovery.predecessorAttempt === input.guard.activeAttempt &&
    existingRecovery.predecessorEngineerRunId === input.guard.engineerRunId &&
    existingRecovery.predecessorProviderRevision === input.guard.providerRevision &&
    existingRecovery.candidateFingerprint === input.candidateFingerprint &&
    existingCandidate?.engineerRunId === input.candidateEngineerRunId &&
    existingCandidate.providerRevision === input.candidateRevision &&
    existingCandidate.fingerprint === input.candidateFingerprint;
  const candidate = resuming
    ? existingCandidate
    : await inspectPipelineSuccessor({
        commission: held,
        lifecycle: input.lifecycle,
        authorized: input.authorized,
      });
  if (!input.authorized()) return fail("task_conflict", CONSENT_WITHDRAWN);
  if (!candidate) return fail("lineage_mismatch", "the provider no longer reports a direct successor");
  if (candidate.engineerRunId !== input.candidateEngineerRunId ||
      candidate.providerRevision !== input.candidateRevision ||
      candidate.fingerprint !== input.candidateFingerprint) {
    return fail("candidate_changed", "the provider successor changed; review it again before adoption");
  }
  if (candidate.validation !== "valid") {
    return fail("lineage_mismatch", candidate.validationReason ?? "the provider successor could not be validated");
  }
  if (!input.authorized()) return fail("task_conflict", CONSENT_WITHDRAWN);
  const reserved = reservePipelineCommissionAdoption({ guard: input.guard, candidate });
  if (!reserved.ok) return reserved;
  input.sink.upsertPipelineCommission(reserved.commission);
  let commission = getPipelineCommission(reserved.commission.id) ?? reserved.commission;
  const attempt = commission.attempts.find((entry) => entry.attempt === commission.activeAttempt)!;
  // Replay the complete journal after the durable reservation, then fence it against the
  // exact fingerprint the operator reviewed. The same captured events are applied below,
  // leaving no second provider-read window in which unseen events could enter adoption.
  const replay = await input.lifecycle.replay({
    engineerRunId: candidate.engineerRunId,
    afterRevision: 0,
  });
  if (!input.authorized()) return fail("task_conflict", CONSENT_WITHDRAWN);
  if (!replay.ok) {
    const partial = updatePipelineCommissionRecovery({
      commissionId: commission.id,
      attempt: attempt.attempt,
      state: replay.outcomeUnknown ? "provider_outcome_unknown" : "adoption_partial",
      error: replay.error,
    });
    if (partial) input.sink.upsertPipelineCommission(partial);
    return fail(
      replay.outcomeUnknown ? "provider_outcome_unknown" : "lineage_mismatch",
      `the adopted journal could not be replayed: ${replay.error}`,
      replay.outcomeUnknown,
    );
  }
  const adoptedEvents: EngineerLifecycleEvent[] = [];
  for (const raw of replay.value) {
    const parsed = parseEngineerEvent(raw);
    if (!parsed.ok || !parsed.known) {
      const partial = updatePipelineCommissionRecovery({
        commissionId: commission.id,
        attempt: candidate.attempt,
        state: "adoption_partial",
        error: "the adopted journal contains an unsupported event schema",
      });
      if (partial) input.sink.upsertPipelineCommission(partial);
      return fail("lineage_mismatch", "the adopted journal contains an unsupported event schema");
    }
    adoptedEvents.push(parsed.event);
  }
  const created = adoptedEvents[0];
  const replayFingerprint = created?.type === "engineer_run_created"
    ? fingerprint({
        schemaVersion: 1,
        capability: "engineerLifecycleEventsV1",
        engineerRunId: candidate.engineerRunId,
        correlationId: commission.correlationId,
        attemptKey: candidate.attemptKey,
        attempt: candidate.attempt,
        previousEngineerRunId: candidate.previousEngineerRunId,
        repoRoot: commission.repoRoot,
        idea: created.idea,
        eventRevision: candidate.providerRevision,
        state: candidate.state,
        integrationOwner: candidate.integrationOwner,
      }, adoptedEvents)
    : null;
  if (replayFingerprint !== candidate.fingerprint) {
    const error = "the provider successor changed after review; abandon this adoption and inspect again";
    const partial = updatePipelineCommissionRecovery({
      commissionId: commission.id,
      attempt: candidate.attempt,
      state: "adoption_partial",
      error,
    });
    if (partial) input.sink.upsertPipelineCommission(partial);
    return fail("candidate_changed", error);
  }
  for (const event of adoptedEvents) {
    const applied = applyEngineerEvent(event);
    if (!["stored", "duplicate", "stale"].includes(applied.outcome)) {
      const partial = updatePipelineCommissionRecovery({
        commissionId: commission.id,
        attempt: candidate.attempt,
        state: "adoption_partial",
        error: `event ${event.revision} was refused (${applied.outcome})`,
      });
      if (partial) input.sink.upsertPipelineCommission(partial);
      return fail("lineage_mismatch", `the adopted journal was refused at revision ${event.revision}`);
    }
    if (applied.commission) {
      commission = applied.commission;
      input.sink.upsertPipelineCommission(commission);
    }
  }
  const complete = updatePipelineCommissionRecovery({
    commissionId: commission.id,
    attempt: candidate.attempt,
    state: "complete",
    error: null,
    clearCandidate: true,
  });
  if (!complete) return fail("task_conflict", "the adopted Pipeline attempt changed during replay");
  input.sink.upsertPipelineCommission(complete);
  return { ok: true, commission: complete, idempotent: reserved.idempotent };
}
