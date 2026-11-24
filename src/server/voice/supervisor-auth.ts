import { createPrivateKey, createPublicKey, randomBytes, sign, verify, type KeyObject } from "node:crypto";
import { closeSync, fstatSync, readSync } from "node:fs";

export const VOICE_SUPERVISOR_PROOF_HEADER = "x-mission-voice-supervisor-proof";
export type SupervisorReportState = "started" | "exited";
const verifierEnv = { shell: "MISSION_VOICE_SHELL_PUBLIC_KEY", dev: "MISSION_VOICE_DEV_PUBLIC_KEY" } as const;

function payload(instance: string, state: SupervisorReportState) {
  return Buffer.from(["mission-voice-supervised/v2", state, instance].join("\n"));
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
