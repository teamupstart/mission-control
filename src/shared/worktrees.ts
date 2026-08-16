import type { WorktreesConfig } from "./protocol.ts";
import type { TerminalBackendId } from "./terminal.ts";

export const WORKTREE_INVENTORY_LIMITS = {
  repositories: 128,
  slotsPerRepository: 128,
  legacyItems: 256,
  textBytes: 2048,
  previewTokens: 128,
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

export interface WorktreeOwnerView {
  kind: "task" | "check" | "manual";
  key: string;
  label: string;
}

export interface WorktreeProcessSummary {
  state: "known" | "unknown";
  count: number | null;
  reason: string | null;
}

export type WorktreeDefaultRelation = "merged" | "unmerged" | "unknown";

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
  actions: Array<"return" | "destroy">;
}

export interface WorktreeRepositoryView {
  id: string;
  name: string;
  root: string;
  commonDirectory: string;
  poolPath: string;
  policy: { enabled: boolean; maxSlots: number; setupArgv: string[] | null };
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
}

export type WorktreeActionRequest =
  | { action: "return"; slotId: string }
  | { action: "prune"; poolId: string; mode: "safe" | "rightSize" }
  | { action: "reconcile"; poolId: string }
  | {
      action: "destroy";
      target: { kind: "slot"; slotId: string } | { kind: "pool"; poolId: string };
    }
  | {
      action: "legacyReturn";
      owner: { kind: "task" | "check"; id: string; position?: number };
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

export interface OpenWorktreeRequest {
  backend: TerminalBackendId;
}
