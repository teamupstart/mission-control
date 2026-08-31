/** Keep a recently edited composer clear of Foreman for one full minute. */
export const COMPOSER_INPUT_GUARD_MS = 60_000;

/**
 * A focused browser renews this lease on a heartbeat. The lease makes a lost blur finite
 * when a tab crashes or disappears without running React cleanup.
 */
export const COMPOSER_FOCUS_LEASE_MS = 30_000;

interface ClientActivity {
  focusedUntil: number;
  lastInputAt: number | null;
}

/**
 * Daemon-owned, transient browser presence for session composers.
 *
 * Each dashboard tab has its own client id so one tab blurring cannot clear another tab's
 * focus. Nothing is persisted: a daemon restart forgets browser presence, while live tabs
 * immediately restore focused state through their heartbeat.
 */
export class ComposerActivityTracker {
  private sessions = new Map<string, Map<string, ClientActivity>>();

  record(
    sessionId: string,
    clientId: string,
    activity: { focused: boolean; typed: boolean },
    now = Date.now(),
  ): void {
    this.prune(now);
    const clients = this.sessions.get(sessionId) ?? new Map<string, ClientActivity>();
    const current = clients.get(clientId) ?? { focusedUntil: 0, lastInputAt: null };
    const next: ClientActivity = {
      focusedUntil: activity.focused ? now + COMPOSER_FOCUS_LEASE_MS : 0,
      lastInputAt: activity.typed ? now : current.lastInputAt,
    };
    clients.set(clientId, next);
    this.sessions.set(sessionId, clients);
    this.prune(now);
  }

  blocksForeman(sessionId: string, now = Date.now()): boolean {
    this.prune(now);
    const clients = this.sessions.get(sessionId);
    if (!clients) return false;
    for (const activity of clients.values()) {
      if (activity.focusedUntil > now) return true;
      if (activity.lastInputAt !== null && now - activity.lastInputAt < COMPOSER_INPUT_GUARD_MS) {
        return true;
      }
    }
    return false;
  }

  private prune(now: number): void {
    for (const [sessionId, clients] of this.sessions) {
      for (const [clientId, activity] of clients) {
        const focusExpired = activity.focusedUntil <= now;
        const inputExpired =
          activity.lastInputAt === null || now - activity.lastInputAt >= COMPOSER_INPUT_GUARD_MS;
        if (focusExpired && inputExpired) clients.delete(clientId);
      }
      if (clients.size === 0) this.sessions.delete(sessionId);
    }
  }
}
