import { createPrivateKey, createPublicKey, randomBytes, sign, verify, type KeyObject } from "node:crypto";
import { closeSync, fstatSync, readSync } from "node:fs";
import { confinedVoiceListener } from "./supervised-listener.ts";

export const VOICE_SUPERVISOR_PROOF_HEADER = "x-mission-voice-supervisor-proof";
export type SupervisorReportState = "started" | "exited";
const verifierEnv = { shell: "MISSION_VOICE_SHELL_PUBLIC_KEY", dev: "MISSION_VOICE_DEV_PUBLIC_KEY" } as const;

function payload(instance: string, state: SupervisorReportState) {
  // Earlier start signatures did not attest filesystem confinement. The exit
  // protocol remains valid for those already-running children after upgrade.
  const protocol = state === "started" ? "mission-voice-confined/v1" : "mission-voice-supervised/v2";
  return Buffer.from([protocol, state, instance].join("\n"));
}

/** Consume a dedicated inherited credential descriptor before spawning any listener. */
function readSigningKey(fd: number): KeyObject {
  if (!Number.isSafeInteger(fd) || fd < 3) throw new Error("A dedicated supervisor credential descriptor is required.");
  const bytes = Buffer.alloc(49); // RFC 8410 Ed25519 PKCS#8 seed, plus one byte to detect overflow.
  try {
    const stat = fstatSync(fd);
    // A service manager may open a private file under a different, protected OS identity
    // before dropping privileges, or send the same credential on a private pipe at each boot.
    const uid = process.getuid?.();
    const protectedFile = stat.isFile() && uid !== undefined && uid !== 0 && stat.uid !== uid && (stat.mode & 0o077) === 0;
    if (!protectedFile && !stat.isFIFO() && !stat.isSocket()) throw new Error("Unprotected supervisor credential.");
    let size = 0;
    while (size < bytes.length) {
      const n = readSync(fd, bytes, size, bytes.length - size, protectedFile ? size : null);
      if (!n) break;
      size += n;
    }
    if (size !== 48) throw new Error("Invalid supervisor credential.");
    return createPrivateKey({ key: bytes.subarray(0, size), type: "pkcs8", format: "der" });
  } finally {
    bytes.fill(0);
    closeSync(fd);
  }
}

/** Each boot imports the launcher's provisioned key. Only its public verifier goes to the daemon. */
export function createVoiceSupervisor(name: keyof typeof verifierEnv, credential: number | KeyObject) {
  const privateKey = typeof credential === "number" ? readSigningKey(credential) : credential;
  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") throw new Error("Expected a private Ed25519 supervisor key.");
  const der = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  const prefix = name + "_" + der.toString("hex") + "_";
  const signature = (instance: string, state: SupervisorReportState) =>
    sign(null, payload(instance, state), privateKey).toString("hex");
  return {
    daemonEnv: { [verifierEnv[name]]: der.toString("base64") },
    async launch(stateHome: string, executable: string, args: string[], env: NodeJS.ProcessEnv,
      announce: (instance: string, proof: string) => Promise<void>) {
      const instance = prefix + randomBytes(32).toString("hex");
      const start = confinedVoiceListener(stateHome, instance);
      await announce(instance, signature(instance, "started"));
      return { instance, child: start(executable, args, env) };
    },
    exitProof: (instance: string) => signature(instance, "exited"),
  };
}

/** Check the exact event against the immutable issuer embedded in this instance. */
export function supervisorIssuer(instance: string, state: SupervisorReportState, proof?: string) {
  const match = /^(shell|dev)_([a-f0-9]{88})_[a-f0-9]{64}$/u.exec(instance);
  if (!match || !proof || !/^[a-f0-9]{128}$/u.test(proof)) return null;
  try {
    const der = Buffer.from(match[2]!, "hex");
    const key = createPublicKey({ format: "der", type: "spki", key: der });
    if (key.asymmetricKeyType !== "ed25519" || !verify(null, payload(instance, state), key, Buffer.from(proof, "hex"))) return null;
    return { name: match[1] === "shell" ? "shell" as const : "dev" as const, key: der.toString("base64") };
  } catch {
    return null;
  }
}

export function verifySupervisorReport(instance: string, state: SupervisorReportState, proof: string | undefined, knownLaunch: () => boolean): boolean {
  const issuer = supervisorIssuer(instance, state, proof);
  // The original issuer can retire an existing child across verifier rotation.
  return !!issuer && (issuer.key === process.env[verifierEnv[issuer.name]] || (state === "exited" && knownLaunch()));
}
