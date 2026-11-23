/**
 * What an operation that needs a paused agent to answer - a stop, a kill, an interrupt, a reset
 * - is handed so it can thaw the agent first. A stopped SDK child never answers its driver's
 * interrupt, a SIGTERM to a stopped process waits for a SIGCONT, and a reset types into the
 * pane. `PauseManager` implements it; each operation takes it as an explicit dependency.
 */
export interface PauseRelease {
  /**
   * Thaw and lift this session's pause now, synchronously. Answers null when the session runs
   * freely afterwards (including when it was never paused), or why it could not be thawed - in
   * which case the caller must not go on as if the agent could answer.
   */
  releaseNow(sessionId: string): string | null;
}
