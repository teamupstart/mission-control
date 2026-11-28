import { lstatSync } from "node:fs";
import { AgentEnvironmentConfigSchema } from "@shared/protocol.ts";
import { openDb } from "./db.ts";

/** A recreated directory at the same launch path cannot claim an earlier launch's warning. */
function directoryId(home: string): string | null | undefined {
  try {
    const dir = lstatSync(home, { bigint: true, throwIfNoEntry: false });
    return dir?.isDirectory() ? dir.dev + ":" + dir.ino : null;
  } catch {
    return undefined; // Unreadable. Retain the record until the filesystem can be checked.
  }
}

export function rememberTerminalLaunchWarning(home: string, missing: string[]): void {
  const identity = directoryId(home);
  if (!identity) return;
  const { names } = AgentEnvironmentConfigSchema.parse({ names: missing });
  openDb().prepare(`INSERT OR REPLACE INTO terminal_launch_warnings
    (launch_home, directory_id, missing_names) VALUES (?, ?, ?)`).run(home, identity, JSON.stringify(names));
}

/** Bind once by wrapper ancestry. Later sightings use the same tty, PID and process start time. */
export function restoreTerminalLaunchWarning(sessionId: string, home?: string | null): string[] | null | undefined {
  const db = openDb();
  let row = db.prepare("SELECT launch_home, missing_names FROM terminal_launch_warnings WHERE session_id = ?")
    .get(sessionId);
  if (row && home && row.launch_home !== home) return;
  if (!row && home) {
    const pending = db.prepare("SELECT directory_id FROM terminal_launch_warnings WHERE launch_home = ? AND session_id IS NULL").get(home);
    if (!pending) return;
    const identity = directoryId(home);
    if (identity === undefined) return null; // Retry once the launch directory is readable.
    if (pending.directory_id === identity) {
      row = db.prepare(`UPDATE terminal_launch_warnings SET session_id = ? WHERE launch_home = ? AND session_id IS NULL
        RETURNING missing_names`).get(sessionId, home);
    }
  }
  if (!row) return;
  try {
    return AgentEnvironmentConfigSchema.parse({ names: JSON.parse(String(row.missing_names)) }).names;
  } catch {
    return undefined;
  }
}

/** Keep live processes and launches still waiting for first sight. Their wrappers clean their own homes. */
export function pruneTerminalLaunchWarnings(live: { has(id: string): boolean }): void {
  const db = openDb();
  const rows = db.prepare("SELECT launch_home, directory_id, session_id FROM terminal_launch_warnings").all();
  for (const row of rows) {
    if (typeof row.session_id === "string" && live.has(row.session_id)) continue;
    const home = String(row.launch_home);
    const identity = directoryId(home);
    if (identity !== undefined && identity !== row.directory_id) {
      db.prepare("DELETE FROM terminal_launch_warnings WHERE launch_home = ?").run(home);
    }
  }
}
