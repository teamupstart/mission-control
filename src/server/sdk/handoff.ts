import type { Session } from "@shared/types.ts";
import type { SessionTransferSummary } from "@shared/session-transfer.ts";
import { sdkFor } from "../harness/index.ts";
import type { PreparedResume } from "../harness/resume.ts";
import type { spawnManagedResume } from "../dispatcher.ts";
import type { SpawnedHome } from "../terminal/home.ts";
import type { Registry } from "../registry.ts";
import type { SdkSupervisor } from "./supervisor.ts";
import { SessionTransferCoordinator } from "../session-transfers/coordinator.ts";
import { transferForNote, transferSummary } from "../session-transfers/store.ts";

/** I/O seams; preparation and the launcher remain owned by the managed-resume contract. */
export interface HandoffDeps {
  prepare?: (session: Session) => Promise<PreparedResume>;
  spawn: typeof spawnManagedResume;
  waitForSessionAtCwd: (cwd: string, timeoutMs: number) => Promise<Session | null>;
  settleTask: (taskId: string) => void;
  transfers?: SessionTransferCoordinator;
  backend?: SpawnedHome["homeBackend"];
}

export type HandoffResult =
  | { ok: true; homeName: string; sessionId: string | null; launchOutcome: "launched" | "unknown"; resumeLeaseId: string; transfer: SessionTransferSummary }
  | { ok: false; error: string; transfer?: SessionTransferSummary };

/** Continue one logical conversation. The durable coordinator owns every adoption path. */
export async function handOffToTerminal(
  registry: Registry, supervisor: SdkSupervisor, session: Session, deps: HandoffDeps,
): Promise<HandoffResult> {
  if (session.runtime !== "sdk") return { ok: false, error: "this session already runs in a terminal" };
  const prior = transferForNote(session.agentSessionId ?? session.id);
  if (prior) return { ok: false, error: "This conversation is already being handed over. Check its transfer in Sitrep", transfer: transferSummary(prior) };
  if (!supervisor.handleFor(session.id)) return { ok: false, error: "this session has no live embedded driver to hand over" };
  if (!sdkFor(session.agent)) return { ok: false, error: `${session.agent} has no embedded driver` };
  if (!session.agentSessionId) return { ok: false, error: "this session has not reported its identity yet - try again in a moment" };
  if (!supervisor.beginHandoff(session.id)) return { ok: false, error: "this session is already being handed over or accepting a message" };
  try {
    const transfers = deps.transfers ?? new SessionTransferCoordinator(registry, { settleTask: deps.settleTask });
    return await transfers.run(session, supervisor, deps);
  } finally { supervisor.endHandoff(session.id); }
}
