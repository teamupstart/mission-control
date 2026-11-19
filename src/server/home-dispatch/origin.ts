import type { HomeDispatchSurface } from "@shared/home-dispatch.ts";
import { openDb } from "../db.ts";

/** Where a task came from (spec 2.4, 7.6). The daemon is the only writer. */
export interface TaskOrigin {
  surface: HomeDispatchSurface;
  /** The session's own repository, even when the task targets another one. */
  repo: string | null;
  sessionId: string | null;
}

/** The home pane the session recorded, as the JSON `home_dispatch_sessions.terminal` holds it. */
function recordedTerminal(sessionId: string | null): string | null {
  if (sessionId === null) return null;
  const row = openDb()
    .prepare("SELECT terminal FROM home_dispatch_sessions WHERE session_id = ?")
    .get(sessionId) as { terminal: string | null } | undefined;
  return row?.terminal ?? null;
}

/**
 * Stamp the origin columns on a task that was just created. Only called while the
 * `headless-mode` flag is on (every caller sits behind the route gate), so a flag-off daemon
 * never writes them.
 */
export function stampTaskOrigin(taskId: string, origin: TaskOrigin): void {
  openDb()
    .prepare(
      "UPDATE tasks SET origin_surface = ?, origin_repo = ?, origin_session_id = ?, origin_terminal = ? WHERE id = ?",
    )
    .run(origin.surface, origin.repo, origin.sessionId, recordedTerminal(origin.sessionId), taskId);
}
