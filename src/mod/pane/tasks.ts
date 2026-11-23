import { workflowStages, type WorkflowStageState } from "@shared/home-dispatch-inbox.ts";
import type { HomeDispatchInboxItem } from "@shared/home-dispatch.ts";
import { viewBuilder } from "./builder.ts";
import { addChrome, rowBudget } from "./chrome.ts";
import { clip, formatAge, plain, wrap } from "./text.ts";
import type { TabRenderer } from "./types.ts";

const STATE_GLYPH = { running: "●", ready: "✓", queued: "○" } as const;
const STAGE_GLYPH: Record<WorkflowStageState, string> = { done: "✓", running: "●", blocked: "!", pending: "○" };
const GROUPS = ["running", "ready", "queued"] as const;

function stageLine(item: HomeDispatchInboxItem): string {
  const stages = workflowStages(item);
  return (Object.keys(stages) as (keyof typeof stages)[]).map((id) => `${id} ${STAGE_GLYPH[stages[id]]}`).join(" · ");
}

function resultOf(item: HomeDispatchInboxItem): string {
  if (item.pr) return `PR #${item.pr.number} ${plain(item.pr.url)}${item.pr.checks ? ` · checks ${item.pr.checks}` : ""}`;
  if (item.pending?.summary) return plain(item.pending.summary);
  return "Finished with no pull request.";
}

export const renderTasksTab: TabRenderer = (_host, props) => {
  const b = viewBuilder("tasks", props.placement);
  addChrome(b, props);
  const inbox = props.ctl?.inbox() ?? null;
  const cols = props.bodyColumns;
  const now = props.now ?? Date.now();
  const shown = inbox ? inbox.items.filter((i) => (GROUPS as readonly string[]).includes(i.state)) : [];
  b.text(`Tasks · ${shown.length}`, { bold: true });
  if (!inbox) {
    b.text("Waiting for Mission Control.", { dim: true });
    return b.build();
  }
  if (shown.length === 0) {
    b.text("No running, ready or queued tasks.", { dim: true });
    return b.build();
  }
  const ordered = GROUPS.flatMap((state) => shown.filter((i) => i.state === state).sort((a, c) => c.changedAt - a.changedAt));
  const budget = rowBudget(props);
  for (const item of ordered.slice(0, budget)) {
    const state = item.state as keyof typeof STATE_GLYPH;
    const age = state === "running" && item.elapsedMs !== undefined ? formatAge(item.elapsedMs) : formatAge(now - item.changedAt);
    const detail = state === "queued" && item.queuePosition !== undefined ? `queued #${item.queuePosition}` : state;
    b.text(`${STATE_GLYPH[state]} ${clip(plain(item.title), cols - detail.length - age.length - 8)}  ${detail} · ${age}`, { bold: true });
    b.text(`  ${stageLine(item)}`, { dim: true });
    if (item.shaping) b.text(`  Shaping (${plain(item.shaping.state)}): ${clip(plain(item.shaping.summary), cols - 20)}`, { dim: true });
    if (state === "ready") for (const line of wrap(resultOf(item), cols - 2)) b.text(`  ${line}`);
  }
  if (ordered.length > budget) b.text(`+${ordered.length - budget} more in the dashboard`, { dim: true });
  return b.build();
};
