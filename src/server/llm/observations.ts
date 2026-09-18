/** An optional process-local observer; worker processes never import the daemon's database. */
let failureObserver: ((error: unknown) => void) | undefined;
export function setLlmFailureObserver(observer: (error: unknown) => void): void { failureObserver = observer; }
export function observeLlmFailure(error: unknown): void {
  try { failureObserver?.(error); } catch { /* Preserve the provider's error and fatal behavior. */ }
}
