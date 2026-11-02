import { randomUUID } from "node:crypto";
import { ScheduleNextIterationSchema, type ResidentPacingReceipt } from "@shared/residents.ts";

export const RESIDENT_PACING_TIMEOUT_MS = 10_000;
export type ResidentPacingResult = ResidentPacingReceipt | {
  callId: string; code: "not_recorded" | "outcome_unknown"; error: string;
};
/** A timeout never means rollback. A caller can safely replay exactly this identity. */
export async function scheduleResidentIteration(
  input: { delaySeconds: number; reason?: string; callId?: string },
  post: (body: unknown, signal: AbortSignal) => Promise<Response>,
  timeoutMs = RESIDENT_PACING_TIMEOUT_MS,
): Promise<ResidentPacingResult> {
  const callId = input.callId ?? randomUUID();
  const parsed = ScheduleNextIterationSchema.safeParse({ ...input, callId });
  if (!parsed.success) return { callId, code: "not_recorded", error: `Nothing was recorded: ${parsed.error.message}` };
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    // Race explicitly as well: an injected transport or misbehaving fetch may ignore abort.
    const { response, body } = await Promise.race([
      post(parsed.data, signal).then(async (response) => ({ response, body: await response.json() as ResidentPacingReceipt & { code?: string; error?: string } })),
      new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
    ]);
    if (response.ok && body.callId === callId && typeof body.pending === "boolean" && typeof body.delaySeconds === "number") return body;
    if (body.code === "not_recorded") return { callId, code: "not_recorded", error: `Nothing was recorded: ${body.error ?? "request refused"}` };
  } catch (error) {
    const cause = error instanceof Error ? error.cause : null;
    if (cause && typeof cause === "object" && "code" in cause && cause.code === "ECONNREFUSED") {
      return { callId, code: "not_recorded", error: "Nothing was recorded: connection refused before sending." };
    }
  }
  return { callId, code: "outcome_unknown", error: `The request may still apply. Replay callId ${callId} to read its receipt without changing the schedule.` };
}
