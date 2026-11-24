import { generateKeyPairSync } from "node:crypto";
import { createVoiceSupervisor, VOICE_SUPERVISOR_PROOF_HEADER, type SupervisorReportState } from "../../src/server/voice/supervisor-auth.ts";

export function newFixtureSupervisor(name: "shell" | "dev") {
  return createVoiceSupervisor(name, generateKeyPairSync("ed25519").privateKey);
}
const supervisors = { shell: newFixtureSupervisor("shell"), dev: newFixtureSupervisor("dev") };
export const fixtureSupervisorEnv = { ...supervisors.shell.daemonEnv, ...supervisors.dev.daemonEnv };

/** The listener receives its instance. Only this launcher fixture has the signing function. */
export function fixtureVoiceSupervisor(name: keyof typeof supervisors = "shell") {
  const signer = supervisors[name];
  const instance = signer.newInstance();
  const proof = (state: SupervisorReportState, subject = instance) => signer.proof(subject, state);
  return { instance, proof, headers: (state: SupervisorReportState) => ({ [VOICE_SUPERVISOR_PROOF_HEADER]: proof(state) }) };
}
