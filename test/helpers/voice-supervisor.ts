import { createPublicKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { VOICE_SUPERVISOR_PROOF_HEADER, type SupervisorReportState } from "../../src/server/voice/supervisor-auth.ts";

export function newFixtureSupervisor(name: "shell" | "dev") {
  // HTTP fixtures stand in for both the protected launcher and the listener, without OS audio or a child.
  const { privateKey } = generateKeyPairSync("ed25519");
  const issuer = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  return {
    daemonEnv: { [name === "shell" ? "MISSION_VOICE_SHELL_PUBLIC_KEY" : "MISSION_VOICE_DEV_PUBLIC_KEY"]: issuer.toString("base64") },
    newInstance: () => [name, issuer.toString("hex"), randomBytes(32).toString("hex")].join("_"),
    proof: (instance: string, state: SupervisorReportState, legacyStart = false) => {
      const protocol = state === "started" && !legacyStart ? "mission-voice-confined/v1" : "mission-voice-supervised/v2";
      return sign(null, Buffer.from([protocol, state, instance].join("\n")), privateKey).toString("hex");
    },
  };
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
