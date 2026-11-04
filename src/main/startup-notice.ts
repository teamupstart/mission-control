/**
 * Tell a person why the app they just opened is leaving, without staying open long.
 *
 * The startup gate answers an ordinary launch during an update helper's transaction with a
 * notice instead of an error (`MIGRATION_IN_PROGRESS_NOTICE`). How it is shown matters as much as
 * its words: before the bundle swap the helper is waiting for every process in the bundle to
 * exit, so whatever shows the notice must end on its own. A modal dialog cannot - a macOS message
 * box without a parent window can be neither timed out nor dismissed programmatically - so a
 * person who walked away would hold the update until it rolled back.
 *
 * A notification is preferred: it outlives the process that posted it, so the launch waits only
 * until the OS confirms it. When notifications are unavailable, the post fails, or the OS never
 * confirms it, the notice is shown in a small window that closes itself after `fallbackMs`.
 * Either way the person sees why the app did not open, and the wait stays bounded far inside
 * the helper's two-minute bundle-exit wait.
 */
export interface StartupNoticePort {
  supported(): boolean;
  /** Post `body`; call `onShown` once the OS has displayed it. */
  show(body: string, onShown: () => void): void;
  /** Show `body` in-process; resolve when it is closed. Must close itself by `holdMs`. */
  fallback(body: string, holdMs: number): Promise<void>;
  log(line: string): void;
}

/** Long enough for the OS to accept a notification, short against the helper's bundle wait. */
export const STARTUP_NOTICE_CONFIRM_MS = 2_000;
/** Long enough to read two sentences, still a small fraction of the helper's bundle wait. */
export const STARTUP_NOTICE_FALLBACK_MS = 8_000;

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[c]!);

/**
 * The fallback window's whole page: no script, no remote resource, both appearances.
 * Its copy is the notice and nothing else, so the window and the notification cannot disagree.
 */
export function startupNoticePage(notice: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Mission Control</title>
<style>
:root { color-scheme: light dark; --bg: #f5f5f7; --fg: #1d1d1f; --muted: #6e6e73; }
@media (prefers-color-scheme: dark) { :root { --bg: #1e1e20; --fg: #f5f5f7; --muted: #a1a1a6; } }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--fg);
  font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; -webkit-user-select: none; }
main { box-sizing: border-box; height: 100%; padding: 20px 24px; display: flex; flex-direction: column; justify-content: center; gap: 6px; }
h1 { margin: 0; font-size: 14px; font-weight: 600; }
p { margin: 0; color: var(--muted); }
</style></head><body><main role="status" aria-live="polite">
<h1>Update in progress</h1><p>${escapeHtml(notice)}</p>
</main></body></html>`;
}

function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
  ]).finally(() => clearTimeout(timer));
}

async function notified(notice: string, port: StartupNoticePort, confirmMs: number): Promise<boolean> {
  let supported = false;
  try { supported = port.supported(); } catch { /* Treated as unsupported. */ }
  if (!supported) {
    port.log("startup notice: notifications are unavailable; showing it in a window");
    return false;
  }
  const shown = new Promise<boolean>((resolve) => {
    try {
      port.show(notice, () => resolve(true));
    } catch (error) {
      port.log(`could not show the startup notice: ${String(error)}`);
      resolve(false);
    }
  });
  const confirmed = await within(shown, confirmMs, false);
  if (!confirmed) port.log("startup notice: the notification was not confirmed; showing it in a window");
  return confirmed;
}

export async function announceStartupNotice(
  notice: string,
  port: StartupNoticePort,
  {confirmMs = STARTUP_NOTICE_CONFIRM_MS, fallbackMs = STARTUP_NOTICE_FALLBACK_MS} = {},
): Promise<void> {
  port.log(`startup deferred: ${notice}`);
  if (await notified(notice, port, confirmMs)) return;
  // Bounded here as well as by the port, so a window that never reports closing cannot hold
  // the bundle either.
  let shown: Promise<void>;
  try { shown = port.fallback(notice, fallbackMs).catch((error) => port.log(`could not show the startup notice window: ${String(error)}`)); }
  catch (error) { port.log(`could not show the startup notice window: ${String(error)}`); return; }
  await within(shown, fallbackMs + 500, undefined);
}
