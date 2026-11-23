import type { HomeDispatchInboxItem } from "@shared/home-dispatch.ts";
import { viewBuilder, type ViewBuilder } from "./builder.ts";
import { addChrome, askLabel, rowBudget } from "./chrome.ts";
import type { PaneController } from "./controller.ts";
import { clip, formatAge, plain, wrap } from "./text.ts";
import type { PaneProps, TabRenderer } from "./types.ts";

const DASHBOARD_POINTER = "Decide this in the Mission Control dashboard; it is not sent from here.";

const glyph = (item: HomeDispatchInboxItem): string => (item.state === "blocked" ? "!" : "?");

export const renderNeedsYouTab: TabRenderer = (_host, props) => {
  const b = viewBuilder("needs-you", props.placement);
  addChrome(b, props);
  const ctl = props.ctl;
  if (!ctl) {
    b.text("Mission Control is connecting.", { dim: true });
    return b.build();
  }
  const items = ctl.needsYou();
  const selected = ctl.view().selected;
  const open = selected ? items.find((i) => i.taskId === selected.taskId) : undefined;
  if (open) drawItem(b, props, ctl, open);
  else drawList(b, props, ctl, items);
  return b.build();
};

function drawList(b: ViewBuilder, props: PaneProps, ctl: PaneController, items: HomeDispatchInboxItem[]): void {
  b.text(`Needs you · ${items.length}`, { bold: true });
  if (items.length === 0) {
    b.text(ctl.inbox() ? "Nothing needs you right now." : "Waiting for Mission Control.", { dim: true });
    return;
  }
  const now = props.now ?? Date.now();
  const budget = rowBudget(props);
  items.slice(0, budget).forEach((item, index) => {
    const n = index + 1;
    const age = formatAge(now - item.changedAt);
    b.button({
      label: `${n <= 9 ? n : "·"} ${glyph(item)} ${clip(plain(item.title), props.bodyColumns - 28)}  ${askLabel(item)} · ${age}`,
      ...(n <= 9 ? { hotkey: String(n) } : {}),
      group: "row",
      press: () => ctl.select(item.taskId),
    });
    const what = item.pending?.question ?? item.pending?.summary ?? item.run?.blockedReason ?? "";
    const preview = wrap(what, props.bodyColumns - 4).slice(0, props.placement === "dock" ? 2 : 1);
    for (const line of preview) b.text(`    ${line}`, { dim: true });
  });
  if (items.length > budget) b.text(`+${items.length - budget} more in the dashboard`, { dim: true });
}

function drawItem(b: ViewBuilder, props: PaneProps, ctl: PaneController, item: HomeDispatchInboxItem): void {
  const cols = props.bodyColumns;
  const pending = item.pending;
  const ask = pending ? { taskId: item.taskId, reviewId: pending.reviewId } : null;
  b.button({ label: "b Back", hotkey: "b", group: "nav", press: () => ctl.back() });
  b.text(clip(plain(item.title), cols), { bold: true });
  b.text(`${askLabel(item)} · ${formatAge((props.now ?? Date.now()) - item.changedAt)}`, { dim: true });

  if (!pending || pending.dashboardOnly) {
    // A blocked run, or a review the pane does not decide: shown, never sent from here.
    for (const line of wrap(pending?.summary ?? pending?.question ?? item.run?.blockedReason ?? "This task is blocked.", cols)) b.text(line);
    b.text(DASHBOARD_POINTER, { dim: true });
    if (pending?.link) b.text(`Open: ${plain(pending.link)}`, { dim: true });
    return;
  }

  if (pending.kind === "question" && ask) {
    for (const line of wrap(pending.question ?? "", cols)) b.text(line);
    const options = pending.options ?? [];
    options.slice(0, 9).forEach((option, index) => {
      b.button({
        label: `${index + 1} ${clip(plain(option), cols - 4)}`,
        hotkey: String(index + 1),
        group: "action",
        press: () => ctl.answer(ask, { option }),
      });
    });
    if (pending.allowsText) {
      // The text field comes after every option button, so the options take focus first.
      b.input({
        key: "answer-text",
        placeholder: options.length > 0 ? "Or write an answer" : "Write an answer",
        value: ctl.view().draft,
        submitLabel: "send",
        onInput: (value) => ctl.setDraft(value),
        onSubmit: (value) => ctl.answer(ask, { text: value }),
      });
    } else if (options.length === 0) {
      b.text(DASHBOARD_POINTER, { dim: true });
    }
    return;
  }

  if (pending.kind === "plan" && ask && pending.revisionHash) {
    for (const line of wrap(pending.summary ?? "", cols)) b.text(line);
    const revision = pending.revisionHash.slice(0, 8);
    b.text(`Revision ${revision}`, { dim: true });
    const shown = { ...ask, revisionHash: pending.revisionHash };
    // No hotkey on approval: it is reached by focus and confirmed with Enter, never by one stray key.
    b.button({ label: `Approve rev ${revision}`, group: "action", press: () => ctl.approve(shown) });
    b.button({ label: "c Request changes", hotkey: "c", group: "action", press: () => ctl.toggleChanges() });
    if (ctl.view().changing) {
      b.input({
        key: "changes-text",
        placeholder: "What should change?",
        value: ctl.view().draft,
        submitLabel: "send",
        onInput: (value) => ctl.setDraft(value),
        onSubmit: (value) => ctl.requestChanges(shown, value),
      });
    }
    return;
  }

  for (const line of wrap(pending.summary ?? pending.question ?? "", cols)) b.text(line);
  b.text(DASHBOARD_POINTER, { dim: true });
  if (pending.link) b.text(`Open: ${plain(pending.link)}`, { dim: true });
}
