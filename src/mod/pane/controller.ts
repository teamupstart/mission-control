import type { HomeDispatchAnswerRequest, HomeDispatchInbox, HomeDispatchInboxItem } from "@shared/home-dispatch.ts";
import { attentionKey, needsYouItems } from "../attention.ts";
import { postAnswer, type DaemonResult } from "../client.ts";
import type { CoreHost, ModPaneTab } from "../host.ts";
import { plain } from "./text.ts";

/**
 * The pane's session state and its one write path (spec 7.22, 7.8): which tab, which item is
 * open, what the person has typed, and the receipt of what they sent. Plain object over the
 * host, so the fake host drives it. Views read it through `view()` and never mutate it.
 *
 * The pane reads only the inbox. Its writes are `POST /dispatch/answers` with `answer`,
 * `approve_plan` and `request_changes`; review decisions are never sent from here.
 */

export interface PaneControllerDeps {
  host: Pick<CoreHost, "fetch"> & { paneState: Pick<CoreHost["paneState"], "set"> };
  sessionId: string;
  cwd: string;
  getInbox: () => HomeDispatchInbox | null;
  /** Polls the inbox now (the core's tick), so a settled item leaves without waiting five seconds. */
  refresh: () => Promise<void>;
  redraw: () => void;
}

export interface PaneNotice {
  tone: "ok" | "error";
  text: string;
}

/** The open item, named by task and by the ask, so a replaced question is noticed. */
export interface PaneSelection {
  taskId: string;
  reviewId: string | null;
  /** The plan revision the person is reading, so a revised plan is not answered with feedback written for the old one. */
  revisionHash: string | null;
}

export interface PaneUiState {
  tab: ModPaneTab;
  selected: PaneSelection | null;
  draft: string;
  changing: boolean;
  notice: PaneNotice | null;
  busy: boolean;
}

/** What an approval was drawn with: the item, the ask and the revision the person read. */
export interface ShownApproval {
  taskId: string;
  reviewId: string;
  revisionHash: string;
}

export interface PaneController {
  readonly host: PaneControllerDeps["host"];
  view: () => Readonly<PaneUiState>;
  inbox: () => HomeDispatchInbox | null;
  /** What needs the person, minus what they have just answered and the daemon has yet to drop. */
  needsYou: () => HomeDispatchInboxItem[];
  /** Reconciles the open item with the latest inbox. Called before each draw. */
  sync: () => void;
  selectTab: (tab: ModPaneTab, options?: { persist?: boolean }) => void;
  select: (taskId: string) => void;
  back: () => void;
  setDraft: (text: string) => void;
  toggleChanges: () => void;
  answer: (item: ShownAsk, answer: { option: string } | { text: string }) => Promise<void>;
  approve: (shown: ShownApproval) => Promise<void>;
  requestChanges: (shown: ShownApproval, text: string) => Promise<void>;
}

export interface ShownAsk {
  taskId: string;
  reviewId: string;
}

const short = (hash: string): string => plain(hash).slice(0, 8);

export function createPaneController(deps: PaneControllerDeps): PaneController {
  const ui: PaneUiState = { tab: "needs-you", selected: null, draft: "", changing: false, notice: null, busy: false };
  /** Asks answered and sent; hidden until the daemon stops listing them. */
  const answered = new Set<string>();
  /** One ask at one revision: a revised plan under an answered review is a new ask and shows again. */
  const askKey = (reviewId: string, revisionHash: string | undefined | null): string => [reviewId, revisionHash ?? ""].join("@");
  let known = new Set<string>();
  let backedOut = false;

  const needsYou = (): HomeDispatchInboxItem[] => {
    const inbox = deps.getInbox();
    if (!inbox) return [];
    return needsYouItems(inbox).filter((item) => !(item.pending && answered.has(askKey(item.pending.reviewId, item.pending.revisionHash))));
  };

  const clearEntry = (): void => {
    ui.draft = "";
    ui.changing = false;
  };

  const notify = (tone: PaneNotice["tone"], text: string): void => {
    ui.notice = { tone, text };
    deps.redraw();
  };

  const selectionOf = (item: HomeDispatchInboxItem): PaneSelection => ({
    taskId: item.taskId,
    reviewId: item.pending?.reviewId ?? null,
    revisionHash: item.pending?.revisionHash ?? null,
  });

  const find = (taskId: string): HomeDispatchInboxItem | undefined => needsYou().find((i) => i.taskId === taskId);

  const settled = async (item: ShownAsk, revisionHash: string | null, title: string, sent: string): Promise<void> => {
    answered.add(askKey(item.reviewId, revisionHash));
    ui.selected = null;
    backedOut = true;
    known = new Set(needsYou().map(attentionKey));
    clearEntry();
    ui.notice = { tone: "ok", text: `Sent to "${title}": ${plain(sent)}` };
    deps.redraw();
    await deps.refresh().catch(() => {});
    deps.redraw();
  };

  const titleOf = (taskId: string): string => {
    const item = deps.getInbox()?.items.find((i) => i.taskId === taskId);
    return plain(item?.title ?? taskId);
  };

  const refusal = async (result: Exclude<DaemonResult<unknown>, { kind: "ok" }>): Promise<void> => {
    switch (result.kind) {
      case "error": {
        const reason = result.message ? plain(result.message) : `Mission Control refused it (status ${result.status}).`;
        notify("error", `${reason} Nothing was sent.`);
        // A plan or question that moved on is read again, so the new one is what shows.
        if (result.status === 409 || result.status === 404) await deps.refresh().catch(() => {});
        return;
      }
      case "down":
        return notify("error", "Mission Control is not running, so nothing was sent.");
      case "unauthorized":
        return notify("error", "Mission Control refused this session's token. Run `mctl doctor`. Nothing was sent.");
      case "off":
        return notify("error", "Mission Control's headless mode is off, so nothing was sent.");
    }
  };

  /** The revision is the one the person acted on, taken before the call, so a poll mid-flight cannot change what is hidden. */
  const send = async (item: ShownAsk, request: HomeDispatchAnswerRequest, revisionHash: string | null): Promise<void> => {
    if (ui.busy) return;
    ui.busy = true;
    try {
      const result = await postAnswer(deps.host, request);
      if (result.kind === "ok") await settled(item, revisionHash, titleOf(item.taskId), result.value.sent);
      else await refusal(result);
    } finally {
      ui.busy = false;
      deps.redraw();
    }
  };

  /** True (and the person told, nothing sent) when the plan on offer is not the one that was shown. */
  const refuseIfStale = (shown: ShownApproval, then: string): boolean => {
    const live = find(shown.taskId)?.pending;
    if (live && live.reviewId === shown.reviewId && live.revisionHash === shown.revisionHash) return false;
    const now = live?.revisionHash ? ` Revision ${short(live.revisionHash)} is now shown.` : "";
    // The new revision is the one on offer now; feedback written for the old one is dropped.
    const liveItem = find(shown.taskId);
    if (liveItem && ui.selected?.taskId === shown.taskId) ui.selected = selectionOf(liveItem);
    clearEntry();
    ui.notice = { tone: "error", text: `The plan changed since you read it.${now} Review it, then ${then}. Nothing was sent.` };
    deps.redraw();
    return true;
  };

  const caller = { sessionId: deps.sessionId, cwd: deps.cwd } as const;

  return {
    host: deps.host,
    view: () => ui,
    inbox: deps.getInbox,
    needsYou,
    sync: () => {
      const items = needsYou();
      // A new ask the person has not seen reopens the list they may have backed out of.
      const keys = new Set(items.map(attentionKey));
      for (const key of keys) if (!known.has(key)) backedOut = false;
      known = keys;
      if (ui.selected) {
        const current = find(ui.selected.taskId);
        if (!current) {
          ui.selected = null;
          clearEntry();
        } else if (
          (current.pending?.reviewId ?? null) !== ui.selected.reviewId ||
          (current.pending?.revisionHash ?? null) !== ui.selected.revisionHash
        ) {
          // The ask, or the plan revision under it, changed under the person: what they typed was
          // for another one, and the field is closed so they read the new one first.
          ui.selected = selectionOf(current);
          clearEntry();
          ui.notice = { tone: "error", text: "This ask changed while it was open. Read it again before answering." };
        }
        return;
      }
      // One thing waiting and the person has not backed out: show it, so answering is one step.
      const only = items[0];
      if (items.length === 1 && only && !backedOut) ui.selected = selectionOf(only);
    },
    selectTab: (tab, options) => {
      if (ui.tab === tab) return;
      ui.tab = tab;
      if (options?.persist !== false) void deps.host.paneState.set("paneTab", tab).catch(() => {});
      deps.redraw();
    },
    select: (taskId) => {
      const item = find(taskId);
      if (!item) return;
      ui.selected = selectionOf(item);
      clearEntry();
      deps.redraw();
    },
    back: () => {
      ui.selected = null;
      backedOut = true;
      known = new Set(needsYou().map(attentionKey));
      clearEntry();
      deps.redraw();
    },
    setDraft: (text) => {
      ui.draft = text;
    },
    toggleChanges: () => {
      ui.changing = !ui.changing;
      deps.redraw();
    },
    answer: async (item, what) => {
      if ("text" in what && what.text.trim() === "") return notify("error", "Write an answer first.");
      const revisionHash = find(item.taskId)?.pending?.revisionHash ?? null;
      await send(item, { action: "answer", ...caller, ...item, ...("option" in what ? { option: what.option } : { text: what.text }) }, revisionHash);
    },
    approve: async (shown) => {
      if (refuseIfStale(shown, "approve")) return;
      await send(shown, { action: "approve_plan", ...caller, taskId: shown.taskId, reviewId: shown.reviewId, revisionHash: shown.revisionHash }, shown.revisionHash);
    },
    requestChanges: async (shown, text) => {
      // Feedback is for the revision the person read: a plan revised since is refused, not sent.
      if (refuseIfStale(shown, "send changes")) return;
      if (text.trim() === "") return notify("error", "Say what should change first.");
      await send(shown, { action: "request_changes", ...caller, taskId: shown.taskId, reviewId: shown.reviewId, text }, shown.revisionHash);
    },
  };
}
