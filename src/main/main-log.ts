import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateDir } from "../shared/harness-runtime.mjs";
import { sanitizeLogLine } from "./update-log.ts";

/** Append to the existing daemon log without rotating a file its daemon still has open. */
export function logMain(line: string, path = join(stateDir(), "daemon.log")): void {
  const record = `${new Date().toISOString()} [main pid=${process.pid}] ${sanitizeLogLine(line).replace(/[\r\n]/g, " ").slice(0, 2000)}\n`;
  try {
    mkdirSync(dirname(path), {recursive: true});
    appendFileSync(path, record, {mode: 0o600});
  } catch {
    // Preserve the sanitized diagnostic without exposing the filesystem error's path.
    try { console.error(`Could not append to daemon.log: ${record.trimEnd()}`); }
    catch { /* Even an unavailable stderr must not prevent startup or dialog answers. */ }
  }
}
