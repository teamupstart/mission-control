import type { ReactNode } from "react";
import type { MissionRoute } from "../workflows/useWorkflowRoute.ts";

/**
 * Which full-screen page is showing, and the overlays that outlive all of them.
 *
 * One of the page slots renders; the others are elements App merely CONSTRUCTED, so their
 * components never mount and never poll. That is what keeps the settings page's five
 * category-scoped hooks (and the runs page's fetches, and the Ship log's) quiet while you
 * are on the fleet, exactly as they were while the settings modal was closed.
 *
 * `runs`, `ensembles` and `shipped` are three slots rather than one "execution" slot for
 * that same reason: each mounts a controller that fetches, so folding them together would
 * put the ensembles detail loader and a week of ledger rows behind the runs rail.
 *
 * One slot PER `MissionRoute` page, keyed by the page name, rather than a hand-copied
 * union and a ternary ladder. Both of those were a silent failure: a page added to
 * `MissionRoute` and forgotten here type-checked and then rendered the FLEET, which looks
 * like a broken link rather than like the missing wiring it is. As a `Record` over the
 * route's own page names, a new page is a compile error at this call site until it has a
 * body, and the lookup below has no fallback arm left to take.
 */
export function AppPageShell({
  page,
  overlays,
  ...slots
}: {
  page: MissionRoute["page"];
  overlays: ReactNode;
} & Record<MissionRoute["page"], ReactNode>): React.JSX.Element {
  return <>{slots[page]}{overlays}</>;
}
