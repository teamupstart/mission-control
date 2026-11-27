import { needsYouItems } from "../attention.ts";
import { renderNeedsYouTab } from "./needs-you.ts";
import { renderResidentsTab } from "./residents.ts";
import { renderTasksTab } from "./tasks.ts";
import type { PaneProps, PaneRenderHost, PaneView, TabRenderer } from "./types.ts";
import { renderWorkflowsTab } from "./workflows.ts";

export type { PaneButton, PaneInput, PaneLine, PaneNode, PaneProps, PaneRenderHost, PaneView, TabRenderer } from "./types.ts";
export { createPaneController, type PaneController } from "./controller.ts";

/** One renderer per tab (7.22). The Workflows and Residents tabs are later iterations and stay stubs. */
export const PANE_TABS: Readonly<Record<PaneProps["tab"], TabRenderer>> = {
  "needs-you": renderNeedsYouTab,
  tasks: renderTasksTab,
  workflows: renderWorkflowsTab,
  residents: renderResidentsTab,
};

export function renderPane(host: PaneRenderHost, props: PaneProps): PaneView {
  if (props.placement === "widget" && props.ctl) return widgetView(props);
  return PANE_TABS[props.tab](host, props);
}

function widgetView(props: PaneProps): PaneView {
  const inbox = props.ctl?.inbox();
  const waiting = inbox ? needsYouItems(inbox).length : 0;
  const running = inbox?.counts.running ?? 0;
  const text = inbox ? `${waiting} need you · ${running} running` : "Mission Control";
  return { tab: props.tab, placement: props.placement, lines: [text], buttons: [], inputs: [], nodes: [{ kind: "text", line: { text } }] };
}
