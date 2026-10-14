import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateDir } from "../shared/harness-runtime.mjs";
import { sanitizeLogLine } from "./update-log.ts";

/** Append to the existing daemon log without rotating a file its daemon still has open. */
export function logMain(line: string, path = join(stateDir(), "daemon.log")): void {
  try {
    mkdirSync(dirname(path), {recursive: true});
    appendFileSync(path, `${new Date().toISOString()} [main pid=${process.pid}] ${sanitizeLogLine(line).replace(/[\r\n]/g, " ").slice(0, 2000)}\n`, {mode: 0o600});
  } catch { /* Logging must not prevent startup or dialog answers. */ }
}
