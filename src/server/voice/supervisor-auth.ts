import { createHmac, timingSafeEqual } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const VOICE_SUPERVISOR_PROOF_HEADER = "x-mission-voice-supervisor-proof";
export type SupervisorReportState = "started" | "exited";

export function signSupervisorReport(key: Buffer, instance: string, state: SupervisorReportState): string {
  return createHmac("sha256", key).update(`mission-voice-supervised/v1\n${state}\n${instance}`).digest("hex");
}

/** The instance's namespace binds it to the same supervisor even across a daemon restart. */
export function verifySupervisorReport(directory: string, instance: string, state: SupervisorReportState, proof?: string): boolean {
  const match = /^(shell|dev)_([a-f0-9]{64})$/u.exec(instance);
  if (!match || !proof || !/^[a-f0-9]{64}$/u.test(proof)) return false;
  let fd: number | undefined;
  try {
    fd = openSync(join(directory, "supervisor-keys", match[1] + ".key"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size !== 32) return false;
    const key = readFileSync(fd);
    if (key.length !== 32) return false;
    return timingSafeEqual(Buffer.from(signSupervisorReport(key, instance, state), "hex"), Buffer.from(proof, "hex"));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
