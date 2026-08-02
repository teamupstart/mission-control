import type { ReactNode } from "react";

/**
 * Which full-screen page is showing, and the overlays that outlive all of them.
 *
 * One of the page slots renders; the others are elements App merely CONSTRUCTED, so their
 * components never mount and never poll. That is what keeps the settings page's five
 * category-scoped hooks (and the runs page's fetches) quiet while you are on the fleet,
 * exactly as they were while the settings modal was closed.
 *
 * `runs` and `ensembles` are two slots rather than one "execution" slot for that same
 * reason: they were tabs on a shared page and each mounted a controller that fetches, so
 * folding them back together would put the ensembles detail loader behind the runs rail.
 */
export function AppPageShell({
  page,
  library,
  runs,
  ensembles,
  settings,
  fleet,
  overlays,
}: {
  page: "fleet" | "library" | "runs" | "ensembles" | "settings";
  library: ReactNode;
  runs: ReactNode;
  ensembles: ReactNode;
  settings: ReactNode;
  fleet: ReactNode;
  overlays: ReactNode;
}): React.JSX.Element {
  const body = page === "library"
    ? library
    : page === "runs"
      ? runs
      : page === "ensembles"
        ? ensembles
        : page === "settings"
          ? settings
          : fleet;
  return <>{body}{overlays}</>;
}
