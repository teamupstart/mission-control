import type { WorktreeClaim, WorktreesConfig } from "./protocol.ts";
import type { TerminalBackendId } from "./terminal.ts";

export const WORKTREE_INVENTORY_LIMITS = {
  repositories: 128,
  slotsPerRepository: 128,
  legacyItems: 256,
  textBytes: 2048,
  previewTokens: 128,
  /** One bulk destroy selection. Matches one pool's slot bound; a selection may span pools. */
  bulkSlots: 128,
  /**
   * Queued, running, and undismissed failed background operations listed at once. A full list
   * refuses new submissions; it never evicts a failure report to make room.
   */
  operations: 64,
} as const;

export type WorktreeRiskKey =
  | "dirty"
  | "unlanded"
  | "leased"
  | "domain-owned"
  | "occupied"
  | "unknown-occupancy"
  | "quarantined"
  | "over-capacity"
  | "legacy-unverifiable"
  | "foreign";

/**
 * Who may hold a native slot's lease: the one list the allocator validates against, the slot
 * row's owner is read back through, and Settings names. `warm` is maintenance holding the slot
 * for a moment, such as a seed copying from it, and is never a task.
 */
export const WORKTREE_OWNER_KINDS = ["task", "check", "manual", "warm"] as const;
export type WorktreeOwnerKind = (typeof WORKTREE_OWNER_KINDS)[number];

export function isWorktreeOwnerKind(value: unknown): value is WorktreeOwnerKind {
  return typeof value === "string" && (WORKTREE_OWNER_KINDS as readonly string[]).includes(value);
}

export interface WorktreeOwnerView {
  kind: WorktreeOwnerKind;
  key: string;
  label: string;
}

export interface WorktreeProcessSummary {
  state: "known" | "unknown";
  count: number | null;
  reason: string | null;
}

export type WorktreeDefaultRelation = "merged" | "unmerged" | "unknown";

/**
 * Where a claim variable's value would come from for a step that names it. Never the value.
 */
export type WorktreeClaimVariableSource = "daemon" | "loginShell";

export interface WorktreeClaimVariableView {
  name: string;
  present: boolean;
  /** Null when missing: unset or empty in both, or carrying the daemon's own token. */
  source: WorktreeClaimVariableSource | null;
}

/**
 * A slot's dependency state as Settings shows it.
 *
 * - `never`: no claim has run in this slot.
 * - `current`: the last claim succeeded and its fingerprint matches the default branch's (or
 *   the default could not be read, or the claim lists no fingerprint paths).
 * - `stale`: the last claim succeeded, but at a fingerprint the last fetched default branch no
 *   longer has. The next lease runs the steps again.
 * - `installing`: a claim is running in this slot right now.
 * - `failed`: the last claim failed, timed out or was stopped.
 * - `interrupted`: a claim was cut off by a restart. The next claim starts cold.
 */
export type WorktreeSlotDependencyState =
  | "never"
  | "current"
  | "stale"
  | "installing"
  | "failed"
  | "interrupted";

/** What every dependency state carries. */
interface WorktreeSlotDependenciesBase {
  /** The commit the slot's recorded fingerprint was taken at. */
  fingerprintSha: string | null;
  /** When the last claim settled. */
  claimedAt: number | null;
}

/**
 * A failed claim, field by field. The daemon decodes its own record; the browser never parses
 * prose. Claim variable values are removed from `reason` and `tail` before they are stored.
 */
export interface WorktreeClaimFailureView {
  /** Null, with `stepCount` and `command`, only for a failure an earlier build recorded as text. */
  step: number | null;
  stepCount: number | null;
  command: string | null;
  reason: string;
  /** The step's last output. Empty when it printed nothing. */
  tail: string;
  /** Output bytes dropped from the front of the tail. */
  truncatedBytes: number;
  /**
   * An earlier build stored this failure's output before values were redacted from it, so the
   * daemon does not send it at all. `tail` is then empty.
   */
  tailWithheld: boolean;
}

/**
 * A slot's dependency state. Each state carries exactly its own facts, so a reader switches on
 * `state` and never has to know which other fields happen to be null alongside it.
 */
export type WorktreeSlotDependenciesView =
  | (WorktreeSlotDependenciesBase & { state: "never" })
  | (WorktreeSlotDependenciesBase & {
      state: "current";
      /** The default-branch commit it was judged against; null when none could be. */
      defaultSha: string | null;
    })
  | (WorktreeSlotDependenciesBase & {
      state: "stale";
      /** The fetched default-branch commit whose dependencies differ. */
      defaultSha: string;
    })
  | (WorktreeSlotDependenciesBase & {
      state: "installing";
      /** The running claim's own id, which Stop names so it can only ever stop this claim. */
      claimId: string;
      /** When this claim began, for its elapsed time. */
      startedAt: number;
      /** Null until the first step starts: the fingerprint is still being read. */
      step: { step: number; stepCount: number; command: string; startedAt: number } | null;
    })
  | (WorktreeSlotDependenciesBase & { state: "failed"; failure: WorktreeClaimFailureView })
  | (WorktreeSlotDependenciesBase & { state: "interrupted" });

export interface NativeWorktreeSlotView {
  id: string;
  poolId: string;
  provider: "mission";
  ordinal: number;
  state: string;
  version: number;
  path: string;
  owner: WorktreeOwnerView | null;
  leaseAgeMs: number | null;
  head: string | null;
  defaultRelation: WorktreeDefaultRelation;
  dirty: boolean | null;
  processes: WorktreeProcessSummary;
  diskBytes: number | null;
  quarantineReason: string | null;
  diagnostic: string | null;
  actions: Array<"return" | "destroy" | "warm">;
  /** Null when the pool has no dependency claim configured. */
  dependencies: WorktreeSlotDependenciesView | null;
  /**
   * The log of the most recent Warm that held this slot, kept on the slot row so it stays
   * reachable after a restart. Null when no Warm has held it, or that log is gone.
   */
  warmLog: WorktreeWarmLogView | null;
}

/** A Warm operation's full log, under the daemon's state directory. */
export interface WorktreeWarmLogView {
  /** The operation id, which names the log: `logs/worktree-warm/<id>.log`. */
  id: string;
  /** The log's absolute path on the daemon's disk. */
  path: string;
}

export interface WorktreeRepositoryView {
  id: string;
  name: string;
  root: string;
  commonDirectory: string;
  poolPath: string;
  policy: {
    enabled: boolean;
    maxSlots: number;
    setupArgv: string[] | null;
    claim: WorktreeClaim | null;
  };
  /**
   * Every variable name the pool's claim lists, once, with whether a step would receive it.
   * Empty when there is no claim. Values never leave the daemon.
   */
  claimVariables: WorktreeClaimVariableView[];
  counts: {
    total: number;
    leased: number;
    available: number;
    quarantined: number;
    overCapacity: number;
  };
  diskBytes: number | null;
  lastReconciledAt: number | null;
  reconciliationError: string | null;
  status: "ready" | "attention" | "unavailable";
  slots: NativeWorktreeSlotView[];
}

export type LegacyWorktreeClassification =
  | "ownedExact"
  | "identityUnverifiable"
  | "foreign"
  | "unreadable";

export interface LegacyWorktreeView {
  id: string;
  classification: LegacyWorktreeClassification;
  repoRoot: string;
  path: string;
  owner: { kind: "task" | "check"; id: string; position?: number } | null;
  leaseId: string | null;
  holder: string | null;
  acquiredAt: string | null;
  processes: WorktreeProcessSummary;
  dirty: boolean | null;
  canReturn: boolean;
  diagnostic: string | null;
}

export interface LegacyWorktreeInventory {
  capability: {
    kind: "missing" | "diagnostic-only" | "conditional-json";
    version: string | null;
    diagnostic: string | null;
  };
  totals: Record<LegacyWorktreeClassification, number>;
  items: LegacyWorktreeView[];
}

export interface WorktreeInventory {
  config: WorktreesConfig;
  observedAt: number;
  revision: string;
  repositories: WorktreeRepositoryView[];
  legacy: LegacyWorktreeInventory;
  /** Executed previews still queued or running in the background, and failures not yet dismissed. */
  operations: WorktreeOperationView[];
}

export type WorktreeActionRequest =
  | { action: "return"; slotId: string }
  | { action: "prune"; poolId: string; mode: "safe" | "rightSize" }
  | { action: "reconcile"; poolId: string }
  | {
      action: "destroy";
      target:
        | { kind: "slot"; slotId: string }
        | { kind: "slots"; slotIds: string[] }
        | { kind: "pool"; poolId: string };
    }
  | {
      action: "legacyReturn";
      owner: { kind: "task" | "check"; id: string; position?: number };
    }
  | {
      /**
       * Prepare idle slots ahead of time: one available slot, or every available slot of a pool.
       * Each is held under a `warm` lease, fetched, reset to origin's default branch, seeded or
       * claimed under the pool's claim, and returned as available.
       */
      action: "warm";
      target: { kind: "slot"; slotId: string } | { kind: "pool"; poolId: string };
    };

export interface WorktreeActionRisk {
  key: WorktreeRiskKey;
  label: string;
  acknowledgeable: boolean;
}

export interface WorktreeActionAffected {
  provider: "mission" | "treehouse" | "git";
  id: string;
  path: string;
  owner: WorktreeOwnerView | null;
  version: number | null;
  /** Opaque digest of bounded provider/Git/process facts used only for stale-preview binding. */
  safetyRevision: string;
  diskBytes: number | null;
}

export interface WorktreeActionPreview {
  token: string;
  request: WorktreeActionRequest;
  inventoryRevision: string;
  expiresAt: number;
  affected: WorktreeActionAffected[];
  risks: WorktreeActionRisk[];
  requiredAcknowledgements: WorktreeRiskKey[];
  allowed: boolean;
  blockers: string[];
  consequences: string[];
}

export interface WorktreeActionExecuteRequest {
  token: string;
  acknowledgements: WorktreeRiskKey[];
}

export interface WorktreeActionExecuteResult {
  ok: true;
  action: WorktreeActionRequest["action"];
  message: string;
}

/**
 * An accepted Execute. The token and acknowledgements were checked before the daemon
 * answered; the safety recheck and the mutation run afterwards, in order, in the background.
 */
export interface WorktreeActionSubmitResult {
  ok: true;
  operation: WorktreeOperationView;
}

/**
 * What a Warm did to one of its targets.
 *
 * - `pending`: not reached yet.
 * - `running`: held under the Warm's lease right now.
 * - `warmed`: its dependencies now match origin's default branch (the steps ran or were skipped).
 * - `claimFailed`: it was warmed, but the claim failed; the slot is back with a failed state.
 * - `skipped`: never touched, because it was not idle when its turn came (leased, quarantined,
 *   gone, or the pool changed).
 * - `cancelled`: Cancel landed before or while it ran. One it was running on is back in the pool.
 * - `failed`: something other than the claim went wrong; `detail` says what.
 */
export type WorktreeWarmTargetOutcome =
  | "pending"
  | "running"
  | "warmed"
  | "claimFailed"
  | "skipped"
  | "cancelled"
  | "failed";

export interface WorktreeWarmTargetView {
  slotId: string;
  ordinal: number;
  path: string;
  outcome: WorktreeWarmTargetOutcome;
  detail: string | null;
}

/** A Warm operation's own facts, beside the shared operation fields. */
export interface WorktreeWarmOperationView {
  targets: WorktreeWarmTargetView[];
  /** The last output of the running Warm, claim variable values removed. */
  tail: string;
  /** Output bytes dropped from the front of `tail`. */
  truncatedBytes: number;
  /** Null until the Warm first holds a slot: a Warm that skipped everything writes no log. */
  log: WorktreeWarmLogView | null;
  /** Cancel was asked for; the running step is being stopped. */
  cancelRequested: boolean;
}

export interface WorktreeOperationView {
  id: string;
  request: WorktreeActionRequest;
  /**
   * `finished` is a Warm that ran to its end, kept so its results and log stay readable until
   * it is dismissed. Every other operation that succeeds leaves the list.
   */
  state: "queued" | "running" | "failed" | "finished";
  /** The exact paths the accepted preview showed. Pending ones are withheld from new actions. */
  targets: Array<{ provider: WorktreeActionAffected["provider"]; id: string; path: string }>;
  error: string | null;
  /** The failure was a stale preview: state moved after it was shown, so preview again. */
  changed: boolean;
  /** The exact slots this operation removes, fixed when it was accepted. Empty for non-removals. */
  removals: Array<{ id: string; path: string }>;
  /**
   * Slots whose removal was confirmed before this operation stopped. Empty unless a failure
   * came partway through a set: those slots are gone, and the rest were left in place.
   */
  completed: Array<{ id: string; path: string }>;
  queuedAt: number;
  finishedAt: number | null;
  /** Null for every action but `warm`. */
  warm: WorktreeWarmOperationView | null;
}

/** An operation still holding its targets: queued or running, not a report waiting to be read. */
export function worktreeOperationPending(operation: Pick<WorktreeOperationView, "state">): boolean {
  return operation.state === "queued" || operation.state === "running";
}

/**
 * What "Preview again" should ask for after a failure. A destroy retries only the fixed set
 * it was accepted with, minus the slots it already removed - the operator is told which ones
 * went. A pool destroy is therefore retried as that slot set, never as the pool, so a slot
 * that joined the pool after the failure cannot ride along. Nothing left to do returns null.
 */
export function worktreeRetryRequest(operation: WorktreeOperationView): WorktreeActionRequest | null {
  const request = operation.request;
  if (request.action !== "destroy") return request;
  const removed = new Set(operation.completed.map((target) => target.id));
  if (request.target.kind === "slot") return removed.has(request.target.slotId) ? null : request;
  const original = request.target.kind === "slots"
    ? request.target.slotIds
    : operation.removals.map((target) => target.id);
  const remaining = original.filter((id) => !removed.has(id));
  if (remaining.length === 0) return null;
  return { action: "destroy", target: { kind: "slots", slotIds: remaining } };
}

export interface OpenWorktreeRequest {
  backend: TerminalBackendId;
}
