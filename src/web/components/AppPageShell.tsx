import type { ReactNode } from "react";

/**
 * Which full-screen page is showing, and the overlays that outlive all of them.
 *
 * One of the page slots renders; the others are elements App merely CONSTRUCTED, so their
 * components never mount and never poll. That is what keeps the settings page's five
 * category-scoped hooks (and the workflows page's fetches) quiet while you are on the
 * fleet, exactly as they were while the settings modal was closed.
 */
export function AppPageShell({
  page,
  workflows,
  settings,
  fleet,
  overlays,
}: {
  page: "fleet" | "workflows" | "settings";
  workflows: ReactNode;
  settings: ReactNode;
  fleet: ReactNode;
  overlays: ReactNode;
}): React.JSX.Element {
  const body = page === "workflows" ? workflows : page === "settings" ? settings : fleet;
  return <>{body}{overlays}</>;
}
