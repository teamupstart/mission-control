import { fileURLToPath, URL } from "node:url";
import { envVar } from "../shared/harness-runtime.mjs";

/**
 * Packaged claim-before-exec guard for managed terminal resumes.
 *
 * In its own module, beside `config.ts` and re-exported by it, so the discovery sweep can
 * recognize a running guard (`terminal/launch-process.ts`) without importing `config.ts`,
 * whose module scope freezes the state directory. Same directory as `config.ts`, so the
 * relative path resolves exactly as it did there, from source and from a bundle alike.
 */
export function resumeGuardPath(): string {
  return envVar("RESUME_GUARD") ?? fileURLToPath(new URL("../../dist/satellites/resume-guard.mjs", import.meta.url));
}
