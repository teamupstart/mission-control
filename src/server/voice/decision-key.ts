import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { stateDir } from "../../shared/harness-runtime.mjs";
import {
  VOICE_KEY_ENV,
  VOICE_KEY_PROVIDERS,
  type VoiceKeyAvailability,
  type VoiceKeyProvider,
} from "@shared/voice-decide.ts";

// The decision-model keys saved in Voice settings (contract E), one per provider.
//
// One private file, `<state home>/voice/decision-key.json`, mode 0600 in a 0700 directory. Not
// in SQLite, so neither a database backup nor a settings backup (which snapshots `app_config`)
// ever holds a key, and not in any route's answer: the routes report where a key comes from and
// never the key. Nothing here logs one. A key in the daemon's environment is read where it is
// used and never written here.

type SavedKeys = Partial<Record<VoiceKeyProvider, string>>;
const SavedKeysSchema = z.partialRecord(z.enum(VOICE_KEY_PROVIDERS), z.string().min(1));

/** Where the saved keys live. Resolved per call, so a test's state home is honoured. */
export function decisionKeyPath(): string {
  return join(stateDir(), "voice", "decision-key.json");
}

/** Mutations can start a new store only when there is no existing file. */
function readKeys(path: string): SavedKeys {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  try {
    return SavedKeysSchema.parse(JSON.parse(text));
  } catch {
    // Parser diagnostics can include the contents of the credential file.
    throw new Error("Invalid saved decision-model key file");
  }
}

/** Routing and source reports can fall through when saved keys are unavailable. */
export function savedDecisionKeys(path = decisionKeyPath()): SavedKeys {
  try {
    return readKeys(path);
  } catch {
    console.warn("[voice] the saved decision-model keys could not be read");
    return {};
  }
}

function writeKeys(keys: SavedKeys, path: string): void {
  if (Object.keys(keys).length === 0) {
    rmSync(path, { force: true });
    return;
  }
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!lstatSync(dir).isDirectory()) throw new Error("Invalid voice key directory");
  chmodSync(dir, 0o700);
  // Written whole to a private temporary file and renamed over the old one, so a reader never
  // sees half a file and the key is never readable by anyone else, even for a moment.
  const temp = join(dir, `.decision-key.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(keys)}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** Save one provider's key. The other provider's saved key stays as it was. */
export function saveDecisionKey(provider: VoiceKeyProvider, key: string, path = decisionKeyPath()): void {
  writeKeys({ ...readKeys(path), [provider]: key }, path);
}

/** Remove one provider's saved key. The other provider's stays; with none left the file goes. */
export function removeDecisionKey(provider: VoiceKeyProvider, path = decisionKeyPath()): void {
  const keys = readKeys(path);
  if (!(provider in keys)) return;
  delete keys[provider];
  writeKeys(keys, path);
}

/** A provider's key from the daemon's environment, or null. */
export function environmentDecisionKey(provider: VoiceKeyProvider, env: NodeJS.ProcessEnv): string | null {
  const value = env[VOICE_KEY_ENV[provider]]?.trim();
  return value ? value : null;
}

/** Which keys exist, saved and in the environment, without the keys. */
export function decisionKeyAvailability(saved: SavedKeys, env: NodeJS.ProcessEnv): VoiceKeyAvailability {
  return {
    saved: { openai: Boolean(saved.openai), jev: Boolean(saved.jev) },
    environment: {
      openai: environmentDecisionKey("openai", env) !== null,
      jev: environmentDecisionKey("jev", env) !== null,
    },
  };
}

/** A provider's key: its saved key, which overrides the environment on this machine, or its variable. */
export function decisionKeyFor(provider: VoiceKeyProvider, saved: SavedKeys, env: NodeJS.ProcessEnv): string | null {
  return saved[provider] ?? environmentDecisionKey(provider, env);
}
