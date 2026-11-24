import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { signSupervisorReport, VOICE_SUPERVISOR_PROOF_HEADER, type SupervisorReportState } from "../../src/server/voice/supervisor-auth.ts";

/** Stand in for the launcher. Only its separate report request carries a signature. */
export function fixtureVoiceSupervisor(directory: string, name: "dev" | "shell" = "shell") {
  const keys = join(directory, "supervisor-keys");
  mkdirSync(keys, { recursive: true, mode: 0o700 });
  const path = join(keys, name + ".key");
  try {
    writeFileSync(path, randomBytes(32), { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const key = readFileSync(path);
  const instance = name + "_" + randomBytes(32).toString("hex");
  const proof = (state: SupervisorReportState, subject = instance) => signSupervisorReport(key, subject, state);
  return { instance, proof, headers: (state: SupervisorReportState) => ({ [VOICE_SUPERVISOR_PROOF_HEADER]: proof(state) }) };
}
