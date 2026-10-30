import type { ResidentPacingReceipt, ResidentPacingRequest, ResidentRun } from "@shared/residents.ts";
import { openDb, sessionSpendSince } from "../db.ts";
import { getResidentRun, inResidentTransaction } from "./store.ts";

export const RESIDENT_DAY_MS = 86_400_000;
export const RESIDENT_RETENTION_MS = 7 * RESIDENT_DAY_MS;
export interface ResidentIteration {
  run_id: string; seq: number; trigger: "launch" | "loop" | "run_now";
  delivery: "claimed" | "sent" | "released" | "unconfirmed";
  transcript_offset: number | null; claimed_at: number; sent_at: number | null;
}
export class ResidentLoopRefusal extends Error {}
export function liveRun(id: string): ResidentRun {
  const run = getResidentRun(id)?.run;
  if (!run || run.endedAt !== null || run.launchState !== "launched") {
    throw new ResidentLoopRefusal("This resident has ended or has not launched.");
  }
  return run;
}
export function residentClaims(): ResidentIteration[] {
  return openDb().prepare("SELECT * FROM resident_iterations WHERE delivery = 'claimed'").all() as unknown as ResidentIteration[];
}
export function claimedIteration(id: string): ResidentIteration | undefined {
  return openDb().prepare("SELECT * FROM resident_iterations WHERE run_id = ? AND delivery = 'claimed'").get(id) as unknown as ResidentIteration | undefined;
}
const CLEAR_REQUEST = "wake_request_delay_s = NULL, wake_request_reason = NULL, wake_request_generation = NULL";
export function pauseResident(id: string, reason: string): void {
  openDb().prepare(`UPDATE resident_runs SET loop_state = 'paused', pause_reason = ?, next_wake_at = NULL,
    ${CLEAR_REQUEST} WHERE id = ? AND ended_at IS NULL AND launch_state = 'launched'`).run(reason, id);
}
export function resumeResident(id: string, working: boolean, generation: number | null, at: number): void {
  const run = liveRun(id);
  openDb().prepare(`UPDATE resident_runs SET loop_state = ?, pause_reason = NULL, wake_reason = NULL, next_wake_at = ?,
    consumed_generation = ? WHERE id = ?`).run(working ? "working" : "waiting",
    working ? null : at + run.settings.loop.delaySeconds * 1000,
    working ? run.consumedGeneration : generation ?? run.consumedGeneration, id);
}
export function beginResidentCompaction(id: string): void {
  liveRun(id);
  openDb().prepare("UPDATE resident_runs SET loop_state = 'compacting' WHERE id = ?").run(id);
}
export function completeResidentCompaction(id: string, generation: number | null): void {
  const run = liveRun(id);
  // Consume the maintenance generation without scheduling or counting an iteration.
  openDb().prepare("UPDATE resident_runs SET loop_state = 'waiting', consumed_generation = ? WHERE id = ?")
    .run(generation ?? run.consumedGeneration, id);
}
export function humanResidentTurn(id: string): void {
  openDb().prepare(`UPDATE resident_runs SET next_wake_at = NULL, wake_reason = NULL, ${CLEAR_REQUEST},
    loop_state = CASE WHEN loop_state = 'paused' THEN 'paused' ELSE 'working' END
    WHERE id = ? AND ended_at IS NULL`).run(id);
}
export function completeResidentGeneration(id: string, generation: number, at: number): boolean {
  return inResidentTransaction(() => {
    const run = liveRun(id);
    if (run.loopState === "paused" || run.loopState === "compacting" || claimedIteration(id) ||
        generation <= (run.consumedGeneration ?? -1)) return false;
    const request = openDb().prepare(`SELECT wake_request_delay_s AS delay, wake_request_reason AS reason,
      wake_request_generation AS generation FROM resident_runs WHERE id = ?`).get(id) as {
      delay: number | null; reason: string | null; generation: number | null;
    };
    const applies = request.generation !== null && request.generation > (run.consumedGeneration ?? -1) && request.generation <= generation;
    openDb().prepare(`UPDATE resident_runs SET loop_state = 'waiting', consumed_generation = ?,
      next_wake_at = ?, wake_reason = ?, ${CLEAR_REQUEST} WHERE id = ?`).run(
      generation, at + (applies ? request.delay! : run.settings.loop.delaySeconds) * 1000,
      applies ? request.reason : null, id);
    return true;
  });
}
export function paceResident(id: string, request: ResidentPacingRequest, generation: number, at: number): ResidentPacingReceipt {
  return inResidentTransaction(() => {
    const run = liveRun(id);
    const prior = openDb().prepare("SELECT receipt FROM resident_pacing_calls WHERE run_id = ? AND call_id = ?")
      .get(id, request.callId) as { receipt: string } | undefined;
    if (prior) return JSON.parse(prior.receipt) as ResidentPacingReceipt;
    if (run.loopState === "paused") throw new ResidentLoopRefusal(run.pauseReason ?? "This resident is paused.");
    const settings = run.settings.loop;
    const delay = Math.min(settings.maxDelaySeconds, Math.max(settings.minDelaySeconds, request.delaySeconds));
    const pending = run.loopState !== "waiting" || !!claimedIteration(id) || generation > (run.consumedGeneration ?? -1);
    const receipt: ResidentPacingReceipt = { callId: request.callId, delaySeconds: delay, pending, nextWakeAt: pending ? null : at + delay * 1000 };
    if (pending) {
      openDb().prepare(`UPDATE resident_runs SET wake_request_delay_s = ?, wake_request_reason = ?,
        wake_request_generation = ? WHERE id = ?`).run(delay, request.reason, Math.max(generation, (run.consumedGeneration ?? -1) + 1), id);
    } else {
      openDb().prepare("UPDATE resident_runs SET next_wake_at = ?, wake_reason = ? WHERE id = ?").run(receipt.nextWakeAt, request.reason, id);
    }
    openDb().prepare("INSERT INTO resident_pacing_calls VALUES (?, ?, ?, ?)").run(id, request.callId, JSON.stringify(receipt), at);
    return receipt;
  });
}
export function claimResidentWake(id: string, trigger: "loop" | "run_now", offset: number | null, at: number): ResidentIteration | null {
  return inResidentTransaction(() => {
    const run = liveRun(id);
    if (run.loopState === "paused" || claimedIteration(id)) return null;
    const seq = run.lastSeq + 1;
    openDb().prepare("UPDATE resident_runs SET last_seq = ?, loop_state = 'working', next_wake_at = NULL WHERE id = ?").run(seq, id);
    openDb().prepare(`INSERT INTO resident_iterations (run_id, seq, trigger, delivery, transcript_offset, claimed_at)
      VALUES (?, ?, ?, 'claimed', ?, ?)`).run(id, seq, trigger, offset, at);
    return claimedIteration(id)!;
  });
}
export function settleResidentClaim(row: ResidentIteration, delivery: "sent" | "released" | "unconfirmed", at: number): void {
  inResidentTransaction(() => {
    const changed = openDb().prepare(`UPDATE resident_iterations SET delivery = ?, sent_at = ?
      WHERE run_id = ? AND seq = ? AND delivery = 'claimed'`).run(delivery, delivery === "sent" ? at : null, row.run_id, row.seq);
    if (!changed.changes) return;
    if (delivery !== "released") openDb().prepare("UPDATE resident_runs SET iteration = iteration + 1 WHERE id = ?").run(row.run_id);
    if (delivery === "unconfirmed") pauseResident(row.run_id, "wake delivery unconfirmed");
    if (delivery === "released") openDb().prepare(`UPDATE resident_runs SET loop_state = 'waiting', next_wake_at = ?
      WHERE id = ? AND ended_at IS NULL AND loop_state = 'working'`).run(at + 1000, row.run_id);
  });
}
export function pruneResidentLoop(at: number): void {
  openDb().prepare(`DELETE FROM resident_iterations WHERE
    (delivery IN ('sent', 'released') AND claimed_at < ?) OR
    (delivery = 'unconfirmed' AND run_id IN (SELECT id FROM resident_runs WHERE ended_at IS NOT NULL))`).run(at - RESIDENT_RETENTION_MS);
}
export function residentGuardrail(run: ResidentRun, at: number): string | null {
  const settings = run.settings.loop;
  const rows = openDb().prepare(`SELECT claimed_at FROM resident_iterations WHERE run_id = ?
    AND delivery IN ('claimed', 'sent', 'unconfirmed') AND claimed_at > ? ORDER BY claimed_at`)
    .all(run.id, at - RESIDENT_DAY_MS) as Array<{ claimed_at: number }>;
  if (settings.iterationCap !== null && rows.length >= settings.iterationCap) {
    const available = rows[rows.length - settings.iterationCap]!.claimed_at + RESIDENT_DAY_MS;
    return `Iteration guardrail reached. Resume after ${new Date(available).toISOString()}.`;
  }
  if (settings.spendCapUsd !== null) {
    const sessions = openDb().prepare("SELECT id, agent_session_id FROM sdk_sessions WHERE task_id = ?").all(run.taskId) as Array<{ id: string; agent_session_id: string | null }>;
    const spend = sessionSpendSince([...new Set(sessions.flatMap((s) => [s.id, ...(s.agent_session_id ? [s.agent_session_id] : [])]))], at - RESIDENT_DAY_MS);
    if (spend.costUsd === null) return "Spend cannot be measured. Resume when the unpriced usage leaves the 24-hour window.";
    if (spend.costUsd >= settings.spendCapUsd) {
      let remaining = spend.costUsd;
      for (const entry of spend.entries) {
        remaining -= entry.costUsd!;
        if (remaining < settings.spendCapUsd) return `Spend guardrail reached. Resume after ${new Date(entry.at + RESIDENT_DAY_MS).toISOString()}.`;
      }
    }
  }
  return null;
}
