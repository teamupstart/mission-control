import type { ModHost } from "../host.ts";
import { renderNeedsYouTab } from "./needs-you.ts";
import { renderResidentsTab } from "./residents.ts";
import { renderTasksTab } from "./tasks.ts";
import type { PaneProps, PaneView, TabRenderer } from "./types.ts";
import { renderWorkflowsTab } from "./workflows.ts";

export type { PaneButton, PaneProps, PaneView, TabRenderer } from "./types.ts";

/** One renderer per tab (7.22). P12 replaces each file and leaves this table alone. */
export const PANE_TABS: Readonly<Record<PaneProps["tab"], TabRenderer>> = {
  "needs-you": renderNeedsYouTab,
  tasks: renderTasksTab,
  workflows: renderWorkflowsTab,
  residents: renderResidentsTab,
};

/** The pane's view for the tab in `props`. */
export function renderPane(host: ModHost, props: PaneProps): PaneView {
  return PANE_TABS[props.tab](host, props);
}
