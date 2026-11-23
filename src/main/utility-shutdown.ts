/**
 * Keep Electron alive until its owned utility exits; request an orderly drain first.
 * Leave time for forced termination inside the shell's 30-second quit deadline.
 */
export function stopUtilityProcess(child: {
  postMessage(message: unknown): void;
  once(event: 'exit', listener: () => void): unknown;
  kill(): unknown;
}, timeoutMs = 25_000): Promise<void> {
  return new Promise((resolve) => {
    // kill() requests termination; only the exit event proves the process is gone.
    const timer = setTimeout(() => { child.kill(); }, timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    try { child.postMessage({type: 'mission:shutdown'}); }
    catch { clearTimeout(timer); child.kill(); }
  });
}
