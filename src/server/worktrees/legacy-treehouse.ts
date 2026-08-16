import type { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { openDb } from "../db.ts";
import { onPath, run, type RunResult } from "../util/exec.ts";
import { NativeWorktreeGit, type WorktreeGit } from "./git.ts";
import {
  inspectWorktreeOccupancy,
  type WorktreeOccupancy,
} from "./occupancy.ts";
import { canonicalWorktreePath } from "./path.ts";

const TREEHOUSE = "treehouse";
const REQUIRED_VERSION = [2, 1, 1] as const;
const COMMAND_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 1_048_576;
const MAX_DIAGNOSTIC_CHARS = 512;

/** Holder names used by historical task acquisitions. Never widened from live observations. */
export const LEGACY_TASK_HOLDER = "mission-control";
export const LEGACY_CHECK_HOLDER_PREFIX = "mission-control-check-";

export function legacyCheckHolder(attemptId: string): string {
  return `${LEGACY_CHECK_HOLDER_PREFIX}${attemptId}`;
}

export type LegacyTreehouseCapability =
  | { kind: "missing"; diagnostic: string }
  | { kind: "diagnostic-only"; version: string | null; diagnostic: string }
  | { kind: "conditional-json"; version: string };

export interface LegacyTreehouseProcessHint {
  pid: number | null;
  command: string;
}

export interface LegacyTreehouseTree {
  name: string;
  path: string;
  status: string;
  leaseId: string | null;
  holder: string | null;
  acquiredAt: string | null;
  processes: LegacyTreehouseProcessHint[];
  identity: "exact" | "unverifiable";
}

export type LegacyTreehouseStatus =
  | {
      state: "readable";
      capability: LegacyTreehouseCapability;
      trees: LegacyTreehouseTree[];
      diagnostic: string | null;
    }
  | {
      state: "unreadable";
      capability: LegacyTreehouseCapability;
      diagnostic: string;
    };

export interface LegacyTreehouseReturnRef {
  repoRoot: string;
  path: string;
  leaseId: string;
  expectedHolder: string;
}

export type LegacyTreehouseReturnResult =
  | { outcome: "returned" }
  | { outcome: "conflict" | "blocked" | "outcomeUnknown"; reason: string };

export interface LegacyTreehouseAdapterDeps {
  execute?: typeof run;
  present?: (binary: string) => boolean;
}

function bounded(value: string): string {
  const compact = value.trim().replace(/\s+/g, " ");
  return compact.length <= MAX_DIAGNOSTIC_CHARS
    ? compact
    : `${compact.slice(0, MAX_DIAGNOSTIC_CHARS - 1)}…`;
}

function failedCommand(label: string, result: RunResult): string {
  if (result.overflowed) return `${label} produced more than ${MAX_OUTPUT_BYTES} bytes`;
  if (result.outcomeUnknown) return `${label} did not complete, so its outcome is unknown`;
  const detail = bounded(result.stderr);
  return `${label} exited ${result.code}${detail ? `: ${detail}` : ""}`;
}

function parseVersion(stdout: string): { raw: string; parts: [number, number, number] } | null {
  const match = /(?:^|[^\d.])(v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?)(?![\d.])/.exec(stdout);
  if (!match) return null;
  return { raw: match[1]!, parts: [Number(match[2]), Number(match[3]), Number(match[4])] };
}

function atLeast(parts: readonly number[], minimum: readonly number[]): boolean {
  for (let i = 0; i < minimum.length; i += 1) {
    if ((parts[i] ?? 0) > (minimum[i] ?? 0)) return true;
    if ((parts[i] ?? 0) < (minimum[i] ?? 0)) return false;
  }
  return true;
}

function optionalString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function processHints(value: unknown): LegacyTreehouseProcessHint[] | null {
  if (!Array.isArray(value)) return null;
  return value.slice(0, 64).map((entry) => {
    if (typeof entry === "string") return { pid: null, command: bounded(entry) };
    if (!entry || typeof entry !== "object") return { pid: null, command: bounded(String(entry)) };
    const row = entry as Record<string, unknown>;
    const pid = typeof row.pid === "number" && Number.isInteger(row.pid) ? row.pid : null;
    const command = typeof row.command === "string"
      ? row.command
      : typeof row.cmd === "string"
        ? row.cmd
        : JSON.stringify(entry);
    return { pid, command: bounded(command) };
  });
}

export function parseLegacyTreehouseJson(stdout: string): LegacyTreehouseTree[] | null {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;
  const trees: LegacyTreehouseTree[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return null;
    const row = entry as Record<string, unknown>;
    if (typeof row.name !== "string" || typeof row.path !== "string" || typeof row.status !== "string") {
      return null;
    }
    const leaseId = optionalString(row.lease_id);
    const holder = optionalString(row.lease_holder);
    const acquiredAt = optionalString(row.leased_at);
    const processes = processHints(row.processes);
    if (leaseId === undefined || holder === undefined || acquiredAt === undefined || processes === null) {
      return null;
    }
    const normalizedLeaseId = leaseId?.trim() || null;
    const normalizedHolder = holder?.trim() || null;
    if (row.status !== "available" && (!normalizedLeaseId || !normalizedHolder)) return null;
    trees.push({
      name: row.name,
      path: canonicalWorktreePath(row.path),
      status: row.status,
      leaseId: normalizedLeaseId,
      holder: normalizedHolder,
      acquiredAt,
      processes,
      identity: normalizedLeaseId && normalizedHolder ? "exact" : "unverifiable",
    });
  }
  return trees;
}

function parseDiagnosticText(stdout: string): LegacyTreehouseTree[] {
  const trees: LegacyTreehouseTree[] = [];
  const pattern = /^(\S+)[ \t]+(leased|in-use|available|dirty|you're here)[ \t]+(\S+)(?:[ \t]+\(held by (.+?)\))?[ \t]*$/;
  for (const raw of stdout.split(/\r?\n/)) {
    const match = pattern.exec(raw.trim());
    if (!match) continue;
    trees.push({
      name: match[1]!,
      status: match[2]!,
      path: canonicalWorktreePath(expandHome(match[3]!)),
      leaseId: null,
      holder: match[4]?.trim() || null,
      acquiredAt: null,
      processes: [],
      identity: "unverifiable",
    });
  }
  return trees;
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith(`~${sep}`) ? join(homedir(), path.slice(2)) : path;
}

/** Read-only plus exact conditional-return bridge for historical persisted resources. */
export class LegacyTreehouseAdapter {
  private readonly execute: typeof run;
  private readonly present: (binary: string) => boolean;

  constructor(deps: LegacyTreehouseAdapterDeps = {}) {
    this.execute = deps.execute ?? run;
    this.present = deps.present ?? onPath;
  }

  async capabilities(): Promise<LegacyTreehouseCapability> {
    if (!this.present(TREEHOUSE)) {
      return {
        kind: "missing",
        diagnostic: "Treehouse is not installed; native worktrees remain available, but legacy cleanup requires Treehouse v2.1.1 or newer",
      };
    }
    const result = await this.exec(["--version"]);
    if (result.code !== 0 || result.outcomeUnknown || result.overflowed) {
      return { kind: "diagnostic-only", version: null, diagnostic: failedCommand("treehouse --version", result) };
    }
    const version = parseVersion(result.stdout);
    if (!version) {
      return {
        kind: "diagnostic-only",
        version: null,
        diagnostic: `Treehouse version output is unrecognized: ${bounded(result.stdout) || "empty output"}`,
      };
    }
    if (!atLeast(version.parts, REQUIRED_VERSION)) {
      return {
        kind: "diagnostic-only",
        version: version.raw,
        diagnostic: `Treehouse ${version.raw} is diagnostic-only; conditional cleanup requires v2.1.1 or newer`,
      };
    }
    return { kind: "conditional-json", version: version.raw };
  }

  async status(repoRoot: string): Promise<LegacyTreehouseStatus> {
    const capability = await this.capabilities();
    if (capability.kind === "missing") {
      return { state: "unreadable", capability, diagnostic: capability.diagnostic };
    }
    if (capability.kind === "diagnostic-only") {
      const result = await this.exec(["status"], repoRoot);
      if (result.code !== 0 || result.outcomeUnknown || result.overflowed) {
        return { state: "unreadable", capability, diagnostic: failedCommand("treehouse status", result) };
      }
      const trees = parseDiagnosticText(result.stdout);
      if (result.stdout.trim() && trees.length === 0) {
        return {
          state: "unreadable",
          capability,
          diagnostic: "treehouse status output was not recognized; no legacy ownership inference was made",
        };
      }
      return {
        state: "readable",
        capability,
        trees,
        diagnostic: capability.diagnostic,
      };
    }
    const result = await this.exec(["status", "--json"], repoRoot);
    if (result.code !== 0 || result.outcomeUnknown || result.overflowed) {
      return { state: "unreadable", capability, diagnostic: failedCommand("treehouse status --json", result) };
    }
    const trees = parseLegacyTreehouseJson(result.stdout);
    if (!trees) {
      return {
        state: "unreadable",
        capability,
        diagnostic: "treehouse status --json returned malformed or incomplete lease identity",
      };
    }
    return { state: "readable", capability, trees, diagnostic: null };
  }

  async conditionalReturn(
    ref: LegacyTreehouseReturnRef,
    finalGate?: () => Promise<string | null>,
  ): Promise<LegacyTreehouseReturnResult> {
    const before = await this.status(ref.repoRoot);
    if (before.state === "unreadable") return { outcome: "blocked", reason: before.diagnostic };
    if (before.capability.kind !== "conditional-json") {
      return { outcome: "blocked", reason: before.capability.diagnostic };
    }
    const path = canonicalWorktreePath(ref.path);
    const current = before.trees.find((tree) => tree.path === path);
    if (!current || current.leaseId !== ref.leaseId || current.holder !== ref.expectedHolder) {
      return {
        outcome: "conflict",
        reason: `legacy Treehouse identity changed for ${path}; expected lease ${ref.leaseId} held by ${ref.expectedHolder}`,
      };
    }
    if (finalGate) {
      let refusal: string | null;
      try {
        refusal = await finalGate();
      } catch {
        refusal = "final legacy return safety checks failed";
      }
      if (refusal) return { outcome: "blocked", reason: refusal };
    }
    const returned = await this.exec([
      "return",
      "--force",
      "--if-lease-id",
      ref.leaseId,
      "--if-lease-holder",
      ref.expectedHolder,
      path,
    ], ref.repoRoot);
    if (returned.code !== 0 || returned.outcomeUnknown || returned.overflowed) {
      const reason = failedCommand("conditional treehouse return", returned);
      return returned.outcomeUnknown || returned.overflowed
        ? { outcome: "outcomeUnknown", reason }
        : { outcome: "blocked", reason };
    }
    const after = await this.status(ref.repoRoot);
    if (after.state === "unreadable") {
      return {
        outcome: "outcomeUnknown",
        reason: `conditional return exited successfully, but post-return status is unreadable: ${after.diagnostic}`,
      };
    }
    const remaining = after.trees.find(
      (tree) => tree.path === path && tree.leaseId === ref.leaseId && tree.holder === ref.expectedHolder,
    );
    if (remaining) {
      return {
        outcome: "outcomeUnknown",
        reason: `Treehouse still reports lease ${ref.leaseId} held by ${ref.expectedHolder} after return`,
      };
    }
    return { outcome: "returned" };
  }

  private exec(args: string[], cwd?: string): Promise<RunResult> {
    return this.execute(TREEHOUSE, args, {
      ...(cwd ? { cwd } : {}),
      timeoutMs: COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
  }
}

export type LegacyOwner =
  | {
      kind: "task";
      id: string;
      position: number;
      repoRoot: string;
      path: string;
      leaseId: string | null;
      expectedHolder: string;
    }
  | {
      kind: "check";
      id: string;
      repoRoot: string;
      path: string;
      leaseId: string | null;
      expectedHolder: string;
    };

export interface LegacyOwnerRef {
  kind: LegacyOwner["kind"];
  id: string;
  position?: number;
  path?: string;
  leaseId?: string | null;
}

export type LegacyInventoryClass = "ownedExact" | "identityUnverifiable" | "foreign" | "unreadable";

export interface LegacyInventoryItem {
  classification: LegacyInventoryClass;
  repoRoot: string;
  path: string;
  leaseId: string | null;
  holder: string | null;
  acquiredAt: string | null;
  processHints: LegacyTreehouseProcessHint[];
  owners: Array<{ kind: LegacyOwner["kind"]; id: string; position?: number }>;
  occupancy: WorktreeOccupancy;
  dirty: boolean | null;
  canConditionalReturn: boolean;
  diagnostic: string | null;
}

export type LegacyReturnPreview =
  | { allowed: true; owner: LegacyOwner; item: LegacyInventoryItem }
  | { allowed: false; reason: string; item: LegacyInventoryItem | null };

export type LegacyOwnerIdentity =
  | { state: "exact"; owner: LegacyOwner }
  | { state: "gone" }
  | { state: "blocked"; reason: string };

export interface LegacyTreehouseServiceDeps {
  adapter?: LegacyTreehouseAdapter;
  occupancy?: typeof inspectWorktreeOccupancy;
  git?: Pick<WorktreeGit, "inspect">;
}

/** Durable-owner projection and fail-closed drain protocol used by task/check cleanup. */
export class LegacyTreehouseService {
  private readonly adapter: LegacyTreehouseAdapter;
  private readonly occupancy: typeof inspectWorktreeOccupancy;
  private readonly git: Pick<WorktreeGit, "inspect">;

  constructor(private readonly db: DatabaseSync = openDb(), deps: LegacyTreehouseServiceDeps = {}) {
    this.adapter = deps.adapter ?? new LegacyTreehouseAdapter();
    this.occupancy = deps.occupancy ?? inspectWorktreeOccupancy;
    this.git = deps.git ?? new NativeWorktreeGit();
  }

  /** Browser-safe capability observation; no Treehouse command or path comes from a request. */
  capabilities(): Promise<LegacyTreehouseCapability> {
    return this.adapter.capabilities();
  }

  async inventory(): Promise<LegacyInventoryItem[]> {
    const owners = this.owners();
    const repoRoots = [...new Set(owners.map((owner) => owner.repoRoot))];
    const observed: Array<{ repoRoot: string; status: LegacyTreehouseStatus }> = [];
    for (const repoRoot of repoRoots) observed.push({ repoRoot, status: await this.adapter.status(repoRoot) });
    const paths = new Set(owners.map((owner) => owner.path));
    for (const entry of observed) {
      if (entry.status.state === "readable") for (const tree of entry.status.trees) paths.add(tree.path);
    }
    const occupancy = await this.occupancy([...paths]);
    const dirty = new Map<string, boolean | null>();
    await Promise.all([...paths].map(async (path) => {
      try {
        const inspected = await this.git.inspect(path);
        dirty.set(path, inspected.ok ? inspected.value.dirty : null);
      } catch {
        dirty.set(path, null);
      }
    }));

    const items: LegacyInventoryItem[] = [];
    const seenOwners = new Set<string>();
    for (const entry of observed) {
      const repoOwners = owners.filter((owner) => owner.repoRoot === entry.repoRoot);
      if (entry.status.state === "unreadable") {
        for (const owner of repoOwners) {
          seenOwners.add(ownerKey(owner));
          items.push(this.itemForOwner(owner, null, "unreadable", entry.status.diagnostic, occupancy, dirty));
        }
        continue;
      }
      for (const tree of entry.status.trees) {
        const matches = repoOwners.filter((owner) => owner.path === tree.path);
        const pathOwners = owners.filter((owner) => owner.path === tree.path);
        const observedAtPath = entry.status.trees.filter((candidate) => candidate.path === tree.path).length;
        if (matches.length === 0) {
          items.push({
            classification: "foreign",
            repoRoot: entry.repoRoot,
            path: tree.path,
            leaseId: tree.leaseId,
            holder: tree.holder,
            acquiredAt: tree.acquiredAt,
            processHints: tree.processes,
            owners: [],
            occupancy: occupancy.get(tree.path) ?? { status: "unknown", reason: "occupancy was not inspected" },
            dirty: dirty.get(tree.path) ?? null,
            canConditionalReturn: false,
            diagnostic: "Treehouse reports this resource, but Mission Control has no durable owner for it",
          });
          continue;
        }
        for (const owner of matches) {
          seenOwners.add(ownerKey(owner));
          const exact = observedAtPath === 1 && pathOwners.length === 1 &&
            owner.leaseId !== null && tree.identity === "exact" &&
            owner.leaseId === tree.leaseId && owner.expectedHolder === tree.holder;
          items.push(this.itemForOwner(
            owner,
            tree,
            exact ? "ownedExact" : "identityUnverifiable",
            exact
              ? null
              : observedAtPath > 1
                ? `Treehouse status reports ${observedAtPath} resources at canonical path ${tree.path}`
                : pathOwners.length > 1
                ? `multiple durable Mission Control owners name ${tree.path}`
                : identityDiagnostic(owner, tree),
            occupancy,
            dirty,
            pathOwners,
          ));
        }
      }
    }
    for (const owner of owners) {
      if (seenOwners.has(ownerKey(owner))) continue;
      const repo = observed.find((entry) => entry.repoRoot === owner.repoRoot);
      const readable = repo?.status.state === "readable";
      items.push(this.itemForOwner(
        owner,
        null,
        readable ? "identityUnverifiable" : "unreadable",
        readable
          ? `Treehouse status does not report the persisted ${owner.kind} path ${owner.path}`
          : "Treehouse status could not be read",
        occupancy,
        dirty,
      ));
    }
    return items;
  }

  async previewReturn(ownerRef: LegacyOwnerRef): Promise<LegacyReturnPreview> {
    const owner = this.owner(ownerRef);
    if (!owner) return { allowed: false, reason: "the persisted legacy owner no longer exists or no longer names Treehouse", item: null };
    const item = (await this.inventory()).find((candidate) =>
      candidate.owners.some((entry) => entry.kind === owner.kind && entry.id === owner.id &&
        (owner.kind !== "task" || entry.position === owner.position)),
    ) ?? null;
    if (!item) return { allowed: false, reason: "legacy Treehouse status did not produce an inventory item", item: null };
    if (item.classification !== "ownedExact") return { allowed: false, reason: item.diagnostic ?? "legacy identity is not exact", item };
    if (item.occupancy.status !== "known") return { allowed: false, reason: item.occupancy.reason, item };
    if (item.occupancy.occupants.length > 0) return { allowed: false, reason: `legacy worktree is occupied by ${item.occupancy.occupants.length} process(es)`, item };
    if (item.dirty !== false) return { allowed: false, reason: item.dirty ? "legacy worktree is dirty" : "legacy worktree cleanliness is unknown", item };
    return { allowed: true, owner, item };
  }

  /** Provider-authoritative identity read used before the domain state machine authorizes return. */
  async ownership(ownerRef: LegacyOwnerRef): Promise<LegacyOwnerIdentity> {
    const owner = this.owner(ownerRef);
    if (!owner) return { state: "blocked", reason: "the persisted legacy owner no longer exists or no longer names Treehouse" };
    if (!owner.leaseId) {
      return {
        state: "blocked",
        reason: `persisted ${owner.kind} ${owner.id} has no Treehouse lease ID for ${owner.path}`,
      };
    }
    const status = await this.adapter.status(owner.repoRoot);
    if (status.state === "unreadable") return { state: "blocked", reason: status.diagnostic };
    if (status.capability.kind !== "conditional-json") {
      return { state: "blocked", reason: status.capability.diagnostic };
    }
    const tree = status.trees.find((candidate) => candidate.path === owner.path);
    if (!tree) return { state: "gone" };
    if (tree.identity !== "exact" || tree.leaseId !== owner.leaseId || tree.holder !== owner.expectedHolder) {
      return { state: "blocked", reason: identityDiagnostic(owner, tree) };
    }
    return { state: "exact", owner };
  }

  async executeReturn(ownerRef: LegacyOwnerRef): Promise<LegacyTreehouseReturnResult> {
    const preview = await this.previewReturn(ownerRef);
    if (!preview.allowed) return { outcome: "blocked", reason: preview.reason };
    const current = this.owner(ownerRef);
    if (!current || ownerKey(current) !== ownerKey(preview.owner) || current.path !== preview.owner.path ||
      current.leaseId !== preview.owner.leaseId || current.expectedHolder !== preview.owner.expectedHolder) {
      return { outcome: "conflict", reason: "the durable legacy owner changed after preview" };
    }
    return this.adapter.conditionalReturn({
      repoRoot: current.repoRoot,
      path: current.path,
      leaseId: current.leaseId!,
      expectedHolder: current.expectedHolder,
    }, async () => {
      const unsafe = await this.returnSafetyReason(current.path);
      if (unsafe) return unsafe;
      const finalOwner = this.owner(ownerRef);
      if (!finalOwner || ownerKey(finalOwner) !== ownerKey(current) || finalOwner.path !== current.path ||
        finalOwner.leaseId !== current.leaseId || finalOwner.expectedHolder !== current.expectedHolder) {
        return "the durable legacy owner changed during final safety checks";
      }
      return null;
    });
  }

  /** Final destructive-action gates, sampled again after preview and immediately before CAS return. */
  private async returnSafetyReason(path: string): Promise<string | null> {
    const [occupancy, inspected] = await Promise.all([
      this.occupancy([path]).then(
        (observed) => observed.get(path) ?? { status: "unknown" as const, reason: "occupancy was not inspected" },
        () => ({ status: "unknown" as const, reason: "occupancy inspection failed" }),
      ),
      this.git.inspect(path).catch(() => null),
    ]);
    if (occupancy.status !== "known") return occupancy.reason;
    if (occupancy.occupants.length > 0) {
      return `legacy worktree is occupied by ${occupancy.occupants.length} process(es)`;
    }
    if (!inspected?.ok) return "legacy worktree cleanliness is unknown";
    return inspected.value.dirty ? "legacy worktree is dirty" : null;
  }

  private owners(): LegacyOwner[] {
    const taskRows = this.db.prepare(
      `SELECT id, 0 AS position, repo_root, worktree_path, worktree_lease_id
         FROM tasks WHERE provider = 'treehouse' AND worktree_path IS NOT NULL
       UNION ALL
       SELECT task_id AS id, position, repo_root, worktree_path, worktree_lease_id
         FROM task_repos WHERE provider = 'treehouse' AND worktree_path IS NOT NULL`,
    ).all() as unknown as Array<Record<string, unknown>>;
    const checkRows = this.db.prepare(
      `SELECT attempt_id, repo_root, lease_path, lease_id, holder_token
         FROM workflow_check_leases
        WHERE provider = 'treehouse' AND cleanup_state IN ('held', 'returning')`,
    ).all() as unknown as Array<Record<string, unknown>>;
    return [
      ...taskRows.map((row): LegacyOwner => ({
        kind: "task",
        id: String(row.id),
        position: Number(row.position),
        repoRoot: resolve(String(row.repo_root)),
        path: canonicalWorktreePath(String(row.worktree_path)),
        leaseId: row.worktree_lease_id === null ? null : String(row.worktree_lease_id),
        expectedHolder: LEGACY_TASK_HOLDER,
      })),
      ...checkRows.map((row): LegacyOwner => ({
        kind: "check",
        id: String(row.attempt_id),
        repoRoot: resolve(String(row.repo_root)),
        path: canonicalWorktreePath(String(row.lease_path)),
        leaseId: row.lease_id === null ? null : String(row.lease_id),
        expectedHolder: String(row.holder_token),
      })),
    ];
  }

  private owner(ref: LegacyOwnerRef): LegacyOwner | null {
    const owner = this.owners().find((candidate) => candidate.kind === ref.kind && candidate.id === ref.id &&
      (candidate.kind !== "task" || candidate.position === (ref.position ?? 0))) ?? null;
    if (!owner) return null;
    if (ref.path !== undefined && owner.path !== canonicalWorktreePath(ref.path)) return null;
    if (Object.hasOwn(ref, "leaseId") && owner.leaseId !== ref.leaseId) return null;
    return owner;
  }

  private itemForOwner(
    owner: LegacyOwner,
    tree: LegacyTreehouseTree | null,
    classification: LegacyInventoryClass,
    diagnostic: string | null,
    occupancy: Map<string, WorktreeOccupancy>,
    dirty: Map<string, boolean | null>,
    linkedOwners: LegacyOwner[] = [owner],
  ): LegacyInventoryItem {
    const path = tree?.path ?? owner.path;
    const observed = occupancy.get(path) ?? { status: "unknown" as const, reason: "occupancy was not inspected" };
    const cleanliness = dirty.get(path) ?? null;
    return {
      classification,
      repoRoot: owner.repoRoot,
      path,
      leaseId: tree?.leaseId ?? owner.leaseId,
      holder: tree?.holder ?? owner.expectedHolder,
      acquiredAt: tree?.acquiredAt ?? null,
      processHints: tree?.processes ?? [],
      owners: linkedOwners.map((linked) => ({
        kind: linked.kind,
        id: linked.id,
        ...(linked.kind === "task" ? { position: linked.position } : {}),
      })),
      occupancy: observed,
      dirty: cleanliness,
      canConditionalReturn: classification === "ownedExact" && observed.status === "known" &&
        observed.occupants.length === 0 && cleanliness === false,
      diagnostic,
    };
  }
}

function ownerKey(owner: LegacyOwner): string {
  return owner.kind === "task" ? `task:${owner.id}:${owner.position}` : `check:${owner.id}`;
}

function identityDiagnostic(owner: LegacyOwner, tree: LegacyTreehouseTree): string {
  if (!owner.leaseId) {
    return `persisted ${owner.kind} ${owner.id} has no Treehouse lease ID; inspect '${owner.repoRoot}' with 'treehouse status --json' and resolve it manually`;
  }
  if (tree.identity !== "exact") return "Treehouse status cannot provide stable lease identity";
  if (tree.leaseId !== owner.leaseId) return `Treehouse now reports a different lease ID at ${owner.path}; refusing a same-path or same-holder lease`;
  return `Treehouse holder ${tree.holder ?? "(none)"} does not match expected holder ${owner.expectedHolder}`;
}

let warnedRetiredCadence = false;

/** Warn about the retired external-pool cadence without aliasing it to native maintenance. */
export function warnRetiredTreehouseCadence(env: NodeJS.ProcessEnv = process.env): void {
  const key = ["MISSION_POOL_REAP_MS", "FLEET_POOL_REAP_MS", "HARNESS_POOL_REAP_MS"]
    .find((candidate) => env[candidate] !== undefined);
  if (warnedRetiredCadence || !key) return;
  warnedRetiredCadence = true;
  console.warn(
    `[mission-control] ${key} is retired and ignored; use MISSION_WORKTREE_SWEEP_MS for native worktree maintenance`,
  );
}
