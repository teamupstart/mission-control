import { createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";

export const VOICE_SUPERVISOR_PROOF_HEADER = "x-mission-voice-supervisor-proof";
export type SupervisorReportState = "started" | "exited";
const verifierEnv = { shell: "MISSION_VOICE_SHELL_PUBLIC_KEY", dev: "MISSION_VOICE_DEV_PUBLIC_KEY" } as const;

function payload(instance: string, state: SupervisorReportState) {
  return Buffer.from(["mission-voice-supervised/v2", state, instance].join("\n"));
}

/** The launcher keeps this signer in its own process. Only the public verifier goes to the daemon. */
export function createVoiceSupervisor(name: keyof typeof verifierEnv) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const der = publicKey.export({ type: "spki", format: "der" });
  const prefix = name + "_" + der.toString("hex") + "_";
  return {
    daemonEnv: { [verifierEnv[name]]: der.toString("base64") },
    newInstance: () => prefix + randomBytes(32).toString("hex"),
    proof: (instance: string, state: SupervisorReportState) => sign(null, payload(instance, state), privateKey).toString("hex"),
  };
}

export function verifySupervisorReport(instance: string, state: SupervisorReportState, proof: string | undefined, knownLaunch: () => boolean): boolean {
  const match = /^(shell|dev)_([a-f0-9]{88})_[a-f0-9]{64}$/u.exec(instance);
  if (!match || !proof || !/^[a-f0-9]{128}$/u.test(proof)) return false;
  const encoded = process.env[match[1] === "shell" ? verifierEnv.shell : verifierEnv.dev];
  try {
    const der = Buffer.from(match[2]!, "hex");
    const key = createPublicKey({ format: "der", type: "spki", key: der });
    if (key.asymmetricKeyType !== "ed25519" || !verify(null, payload(instance, state), key, Buffer.from(proof, "hex"))) return false;
    // The issuer is part of the persisted instance. It can retire its own recorded child
    // after a daemon restart even when new starts now require a different launcher's key.
    return der.toString("base64") === encoded || (state === "exited" && knownLaunch());
  } catch {
    return false;
  }
}
