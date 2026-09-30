import { randomUUID } from "node:crypto";
import type { Session, Task } from "@shared/types.ts";
import { terminalResourceIds } from "@shared/pane.ts";
import type { WorkflowBinding } from "@shared/workflow.ts";
import { SESSION_TRANSFER_STATES, SESSION_TRANSFER_SNAPSHOT_LIMIT, sessionTransferUnresolved,
  type SessionTransferState, type SessionTransferSummary, type SessionTransferPage } from "@shared/session-transfer.ts";
import { openDb } from "../db.ts";
import { canonicalWorktreePath } from "../worktrees/path.ts";
import type { SpawnedHome } from "../terminal/home.ts";

export type TransferBinding = Pick<WorkflowBinding, "id" | "workflowVersionId" | "sessionId" | "noteKey" |
  "sessionCwd" | "sessionRepoRoot" | "repoRoot" | "triggerMode" | "deliveryMode" | "maxRepairRounds">;

export function transferBinding(binding: WorkflowBinding): TransferBinding {
  const { id, workflowVersionId, sessionId, noteKey, sessionCwd, sessionRepoRoot, repoRoot,
    triggerMode, deliveryMode, maxRepairRounds } = binding;
  return { id, workflowVersionId, sessionId, noteKey, sessionCwd, sessionRepoRoot, repoRoot,
    triggerMode, deliveryMode, maxRepairRounds };
}

/** Changes to the task attempt or any checkout invalidate adoption, even if cwd is reused. */
export function transferTaskIdentity(task: Task): string {
  return JSON.stringify({ status: task.status, dispatchedAt: task.dispatchedAt, workflowId: task.workflowId, repoRoot: task.repoRoot,
    worktreePath: task.worktreePath, branch: task.branch, provider: task.provider,
    worktreeLeaseId: task.worktreeLeaseId,
    extraRepos: task.extraRepos.map(({ repoRoot, worktreePath, branch, provider, worktreeLeaseId }) =>
      ({ repoRoot, worktreePath, branch, provider, worktreeLeaseId })) });
}

export interface TransferFacts {
  agent: Session["agent"];
  nativeId: string;
  sourceName: string;
  sourceRuntime: Session["runtime"];
  sourceEpisodeId: string | null;
  cwd: string;
  repoRoot: string | null;
  taskIdentity: string | null;
  taskEpisodeId: string | null;
  bindings: TransferBinding[];
  leaseRoot: string;
  leaseId: string;
  backend: SpawnedHome["homeBackend"] | null;
  home: SpawnedHome | null;
  resumeHookAt?: number;
  sourceStopped: boolean;
  stopStarted: boolean;
  sourceProcess: { pid: number; startMs: number } | null;
  launchAt: number | null;
  launchOutcome: "not_started" | "launched" | "unknown" | "refused";
  canEnd: boolean;
}

export interface SessionTransfer {
  id: string;
  revision: number;
  sourceSessionId: string;
  noteKey: string;
  taskId: string | null;
  state: string;
  reason: string;
  successorSessionId: string | null;
  createdAt: number;
  updatedAt: number;
  facts: TransferFacts;
}

// SQL and TS both define unresolved by terminal outcomes. New/unknown states fail closed.
export const UNRESOLVED_TRANSFER_SQL = "state NOT IN ('adopted', 'aborted', 'failed')";
export const TRANSFER_HOLD_REASON = "Continue in terminal is awaiting verified ownership. Check the transfer in Sitrep before sending or changing this work.";

function read(row: Record<string, unknown> | undefined): SessionTransfer | null {
  if (!row) return null;
  return { id: String(row.id), revision: Number(row.revision), sourceSessionId: String(row.source_session_id),
    noteKey: String(row.note_key), taskId: row.task_id as string | null, state: String(row.state),
    reason: String(row.reason), successorSessionId: row.successor_session_id as string | null,
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), facts: JSON.parse(String(row.facts_json)) as TransferFacts };
}

export function getSessionTransfer(id: string): SessionTransfer | null {
  return read(openDb().prepare("SELECT * FROM session_runtime_transfers WHERE id = ?").get(id));
}
/** A transported task already made its binding decision, including an intentionally empty set. */
export function taskWorkflowTransferred(task: Task): boolean {
  if (!task.sessionId) return false;
  const transfer = read(openDb().prepare(`SELECT * FROM session_runtime_transfers WHERE task_id = ?
    AND successor_session_id = ? AND state = 'adopted' ORDER BY created_at DESC LIMIT 1`).get(task.id, task.sessionId));
  if (!transfer?.facts.taskIdentity) return false;
  // Adoption needs the full ownership snapshot, but its binding decision lasts for this
  // task attempt. Status and branch can change afterward without authorizing a new pin.
  // Reuse the persisted dispatch marker instead of adding another attempt ledger.
  const reservedTask = JSON.parse(transfer.facts.taskIdentity) as Pick<Task, "dispatchedAt">;
  return reservedTask.dispatchedAt === task.dispatchedAt;
}
export function adoptedTransferHome(sessionId: string): SpawnedHome | null {
  return read(openDb().prepare(`SELECT * FROM session_runtime_transfers
    WHERE successor_session_id = ? AND state = 'adopted' ORDER BY created_at DESC LIMIT 1`).get(sessionId))?.facts.home ?? null;
}
export function failedSessionTransfers(): SessionTransfer[] {
  return openDb().prepare("SELECT * FROM session_runtime_transfers WHERE state = 'failed'").all().map((row) => read(row)!);
}
export function unresolvedSessionTransfers(): SessionTransfer[] {
  return openDb().prepare(`SELECT * FROM session_runtime_transfers WHERE ${UNRESOLVED_TRANSFER_SQL} ORDER BY created_at, id`)
    .all().map((row) => read(row)!);
}
export function transferForTask(taskId: string): SessionTransfer | null {
  return read(openDb().prepare(`SELECT * FROM session_runtime_transfers WHERE task_id = ? AND ${UNRESOLVED_TRANSFER_SQL}`).get(taskId));
}
export function transferForNote(noteKey: string): SessionTransfer | null {
  return read(openDb().prepare(`SELECT * FROM session_runtime_transfers WHERE note_key = ? AND ${UNRESOLVED_TRANSFER_SQL}`).get(noteKey));
}
export function transferForSource(sessionId: string): SessionTransfer | null {
  return read(openDb().prepare(`SELECT * FROM session_runtime_transfers WHERE source_session_id = ? AND ${UNRESOLVED_TRANSFER_SQL}`).get(sessionId));
}
export function transferRetiredSource(sessionId: string): boolean {
  return Boolean(openDb().prepare(`SELECT id FROM session_runtime_transfers WHERE source_session_id = ?
    AND state NOT IN ('prepared', 'aborted') LIMIT 1`).get(sessionId));
}

export function transferHold(session: Pick<Session, "id" | "agentSessionId"> & Partial<Pick<Session, "terminals">>): string | null {
  if (transferForSource(session.id) || transferForNote(session.agentSessionId ?? session.id)) return TRANSFER_HOLD_REASON;
  if (session.terminals) {
    const resources = terminalResourceIds({ terminals: session.terminals });
    if (unresolvedSessionTransfers().some((transfer) => transfer.facts.home?.terminalResourceId
      && resources.has(transfer.facts.home.terminalResourceId))) return TRANSFER_HOLD_REASON;
  }
  return null;
}
export function transferProtectsBinding(binding: Pick<WorkflowBinding, "id" | "sessionId" | "noteKey">): boolean {
  const transfer = transferForNote(binding.noteKey);
  return Boolean(transfer && transfer.sourceSessionId === binding.sessionId && transfer.facts.bindings.some((b) => b.id === binding.id));
}

/** Caller validates ownership in the same transaction; indexes arbitrate concurrent claims. */
export function reserveSessionTransfer(input: Pick<SessionTransfer, "sourceSessionId" | "noteKey" | "taskId" | "facts">): SessionTransfer {
  const id = randomUUID();
  const now = Date.now();
  openDb().prepare(`INSERT INTO session_runtime_transfers
    (id, revision, source_session_id, note_key, task_id, state, reason, successor_session_id, facts_json, created_at, updated_at)
    VALUES (?, 1, ?, ?, ?, 'prepared', 'Preparing terminal transfer', NULL, ?, ?, ?)`)
    .run(id, input.sourceSessionId, input.noteKey, input.taskId, JSON.stringify(input.facts), now, now);
  return getSessionTransfer(id)!;
}

export function updateSessionTransfer(current: SessionTransfer, patch: Partial<Pick<SessionTransfer, "state" | "reason" | "facts" | "successorSessionId">>): SessionTransfer {
  const next = { ...current, ...patch };
  const changed = openDb().prepare(`UPDATE session_runtime_transfers SET revision = revision + 1, state = ?, reason = ?,
    successor_session_id = ?, facts_json = ?, updated_at = ? WHERE id = ? AND revision = ?`)
    .run(next.state, next.reason.slice(0, 500), next.successorSessionId, JSON.stringify(next.facts), Date.now(), current.id, current.revision);
  if (Number(changed.changes) !== 1) throw new Error("Terminal transfer changed; check again");
  return getSessionTransfer(current.id)!;
}

export function transferSummary(transfer: SessionTransfer): SessionTransferSummary {
  const known = (SESSION_TRANSFER_STATES as readonly string[]).includes(transfer.state);
  return { id: transfer.id, revision: transfer.revision, sourceSessionId: transfer.sourceSessionId,
    sourceName: transfer.facts.sourceName, taskId: transfer.taskId, successorSessionId: transfer.successorSessionId,
    state: known ? transfer.state as SessionTransferState : "recovery_required",
    reason: known ? transfer.reason : "This transfer needs a newer Mission Control version to recover safely",
    createdAt: transfer.createdAt, updatedAt: transfer.updatedAt,
    canEnd: known && sessionTransferUnresolved(transfer.state) && transfer.facts.canEnd };
}

export function sessionTransferPage(offset = 0, limit = SESSION_TRANSFER_SNAPSHOT_LIMIT): SessionTransferPage {
  const db = openDb();
  const count = Number(db.prepare(`SELECT COUNT(*) AS count FROM session_runtime_transfers WHERE ${UNRESOLVED_TRANSFER_SQL}`).get()!.count);
  const rows = db.prepare(`SELECT * FROM session_runtime_transfers WHERE ${UNRESOLVED_TRANSFER_SQL} ORDER BY created_at, id LIMIT ? OFFSET ?`).all(limit, offset);
  return { transfers: rows.map((row) => transferSummary(read(row)!)), overflow: Math.max(0, count - offset - rows.length) };
}

export function transferScopeMatches(facts: TransferFacts, session: Pick<Session, "agent" | "agentSessionId" | "cwd" | "repoRoot">): boolean {
  return session.agent === facts.agent && session.agentSessionId === facts.nativeId
    && session.cwd !== null && canonicalWorktreePath(session.cwd) === facts.cwd
    && (session.repoRoot === null ? null : canonicalWorktreePath(session.repoRoot)) === facts.repoRoot;
}

/** Authorize observation of historical deliveries without rewriting their attribution. */
export function runtimeTransferConnects(sourceId: string, targetId: string | null, noteKey: string): boolean {
  if (!targetId) return false;
  const seen = new Set<string>();
  let current = sourceId;
  while (!seen.has(current)) {
    if (current === targetId) return true;
    seen.add(current);
    const row = openDb().prepare(`SELECT successor_session_id FROM session_runtime_transfers
      WHERE source_session_id = ? AND note_key = ? AND state = 'adopted' ORDER BY created_at DESC LIMIT 1`).get(current, noteKey);
    if (!row?.successor_session_id) return false;
    current = String(row.successor_session_id);
  }
  return false;
}

/** Follow only committed ownership, for detached request answers still attributed to source. */
export function runtimeTransferSuccessor(sourceId: string): string {
  let current = sourceId;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const row = openDb().prepare(`SELECT successor_session_id FROM session_runtime_transfers
      WHERE source_session_id = ? AND state = 'adopted' ORDER BY created_at DESC LIMIT 1`).get(current);
    if (!row?.successor_session_id) break;
    current = String(row.successor_session_id);
  }
  return current;
}
