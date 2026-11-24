import type { HomeDispatchInboxItem } from "@shared/home-dispatch.ts";
import type { ViewBuilder } from "./builder.ts";
import type { PaneProps } from "./types.ts";

export const PANE_TAB_BUTTONS = [
  { tab: "needs-you", label: "n Needs you", hotkey: "n" },
  { tab: "tasks", label: "t Tasks", hotkey: "t" },
] as const;

/** Rows a tab may draw before it says how many more there are: the inline form has little room. */
export function rowBudget(props: PaneProps): number {
  return props.placement === "dock" ? 40 : 6;
}

export function askLabel(item: HomeDispatchInboxItem): string {
  switch (item.pending?.kind) {
    case "question":
      return "asks a question";
    case "plan":
      return "plan to approve";
    case "plan-decisions":
      return "plan decisions";
    case "diff":
      return "review";
    case "plan-review":
      return "plan review";
    case "resident-request":
      return "resident request";
    default:
      return item.state === "blocked" ? "blocked" : "waiting";
  }
}

export function addChrome(b: ViewBuilder, props: PaneProps): void {
  const ctl = props.ctl;
  // Reconcile the open item with the latest inbox first, so the notice below is this frame's.
  ctl?.sync();
  for (const tab of PANE_TAB_BUTTONS) {
    b.button({
      label: tab.label,
      hotkey: tab.hotkey,
      group: "tab",
      press: () => ctl?.selectTab(tab.tab),
    });
  }
  const notice = ctl?.view().notice;
  if (notice) b.text(notice.tone === "ok" ? `✓ ${notice.text}` : `! ${notice.text}`, { tone: notice.tone });
}
