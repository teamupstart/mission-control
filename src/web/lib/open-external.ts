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
