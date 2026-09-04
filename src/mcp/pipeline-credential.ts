import { readFileSync, statSync } from "node:fs";
import {
  PIPELINE_CALLER_CREDENTIAL_ENV,
  PIPELINE_CALLER_CREDENTIAL_FILE_ENV,
} from "@shared/pipeline.ts";

/**
 * Resolve a Pipeline launch capability without weakening the file boundary.
 *
 * The environment value exists only for daemons too old to issue a credential file. Once a
 * file is named, any invalid, expired, unreadable, or overly permissive file is a refusal.
 * Falling through to the environment in that state would revive a credential the daemon had
 * explicitly replaced.
 */
export function readPipelineCallerCredential(
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): string | null {
  const file = env[PIPELINE_CALLER_CREDENTIAL_FILE_ENV];
  if (!file) return env[PIPELINE_CALLER_CREDENTIAL_ENV] ?? null;

  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0) return null;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (
      typeof parsed.credential === "string"
      && parsed.credential.length >= 32
      && typeof parsed.expiresAt === "number"
      && Number.isSafeInteger(parsed.expiresAt)
      && parsed.expiresAt > now
    ) return parsed.credential;
    return null;
  } catch {
    return null;
  }
}
