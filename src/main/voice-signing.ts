import { safeStorage } from "electron";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { createVoiceSupervisor } from "../server/voice/supervisor-auth.ts";
import { readVoiceRecord, writeVoiceRecord } from "../server/voice/recovery-files.ts";
import { stateDir } from "../shared/harness-runtime.mjs";
import { logMain } from "./main-log.ts";

/** The packaged shell is also the launch service for the daemon it starts. */
export function shellVoiceSigner() {
  try {
    const fd = process.env.MISSION_VOICE_SHELL_CREDENTIAL_FD;
    if (fd !== undefined) return createVoiceSupervisor("shell", Number(fd));
    // An external launch service owns that verifier and must supply its matching credential.
    if (process.env.MISSION_VOICE_SHELL_PUBLIC_KEY || !safeStorage.isEncryptionAvailable()) return undefined;
    const home = stateDir();
    const file = join(home, "voice", "shell-credential.json");
    let der: Buffer;
    if (lstatSync(file, {throwIfNoEntry: false})) {
      const sealed = Buffer.from(JSON.parse(readVoiceRecord(home, file)), "base64");
      der = Buffer.from(safeStorage.decryptString(sealed), "base64");
    } else {
      der = generateKeyPairSync("ed25519").privateKey.export({format: "der", type: "pkcs8"});
      const sealed = safeStorage.encryptString(der.toString("base64"));
      if (!writeVoiceRecord(home, file, sealed.toString("base64"))) throw new Error("Credential storage unavailable");
    }
    try { return createVoiceSupervisor("shell", createPrivateKey({format: "der", type: "pkcs8", key: der})); }
    finally { der.fill(0); }
  } catch {
    logMain("Voice playback unavailable. Could not open the shell supervisor credential.");
    return undefined;
  }
}
