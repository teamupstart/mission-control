/**
 * Open a link outside the dashboard: in the desktop app through its bridge, which hands it to
 * the system browser, and in a browser in a new tab with no opener and no referrer. The bridge
 * checks nothing about the URL, so a caller that opens a link it did not write checks it first.
 */
export async function openExternal(href: string): Promise<void> {
  if (window.missionDesktop) {
    await window.missionDesktop.openExternal(href);
    return;
  }
  window.open(href, "_blank", "noopener,noreferrer");
}

/**
 * Open a link outside the dashboard and say whether it opened. The desktop bridge's rejection is
 * a failure. In a browser, `window.open` with `noopener` always returns null, so it cannot tell a
 * blocked tab from an opened one: this opens without it, then cuts the new tab's opener at once,
 * before the cross-origin page it loads can run, and reads a null return as a blocked tab. The
 * one difference from `openExternal` is the referrer: the new page may be told the dashboard's
 * origin, which the sign-in link's own redirect URI names already.
 */
export async function openExternalChecked(href: string): Promise<boolean> {
  try {
    if (window.missionDesktop) {
      await window.missionDesktop.openExternal(href);
      return true;
    }
    const tab = window.open(href, "_blank");
    if (!tab) return false;
    tab.opener = null;
    return true;
  } catch {
    return false;
  }
}
