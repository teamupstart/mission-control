import { useCallback, useReducer } from "react";
import { UI_CONFIG_DEFAULTS } from "@shared/protocol.ts";
import type { ConversationView } from "@shared/protocol.ts";
import { updateUiConfig, useUiConfig } from "./uiConfig.ts";

/**
 * Which rendering a Conversation is drawn in - the shipped chat log, or the Native PTY
 * terminal stream (`docs/plans/conversation-native-pty/plan.md`).
 *
 * Two switches, deliberately of different KINDS, and this module owns both so their
 * precedence is one function rather than a rule spread across call sites.
 */

/** One rendering, as the settings picker offers it. Prose lives here rather than in
 *  `@shared/protocol.ts` for the reason `LAYOUTS` does: the daemon shows none of it. */
export interface ConversationViewOption {
  id: ConversationView;
  label: string;
  description: string;
}

/** Alphabetical by label, like the layout picker - the order is the picker's, not a ranking. */
export const CONVERSATION_VIEW_OPTIONS: readonly ConversationViewOption[] = [
  {
    id: "chat",
    label: "Chat",
    description: "Turns as messages: a byline per speaker, prose in bubbles, tool calls as chips.",
  },
  {
    id: "terminal",
    label: "Terminal",
    description:
      "Turns as a terminal stream: your messages as prompt lines, the agent's as stdout, tool runs folded into one record, with a status line carrying the session's state.",
  },
];

/**
 * The dashboard's default rendering, stored in the daemon (`app_config.ui.conversationView`)
 * alongside the layout and the keybindings. Shaped exactly like `useRichText`, and for the
 * same reasons: a module-level store means the settings control and the transcript cannot
 * end up with two `useState`s over one key, so there is one value by construction and no
 * provider to wrap. Components rendered in isolation read the shipped defaults.
 */
export function useConversationView(): [ConversationView, (next: ConversationView) => void] {
  const view = useUiConfig().conversationView;
  const set = useCallback((next: ConversationView) => {
    void updateUiConfig({ conversationView: next });
  }, []);
  return [view, set];
}

/**
 * The per-session override: one session read as a terminal while the rest stay on the
 * dashboard's default.
 *
 * A module-level map, keyed by session id, on the `lib/drafts.ts` model - and transient on
 * purpose. There is no precedent in this app for a PERSISTED per-session UI preference,
 * and inventing one here would mean a second settings store beside `app_config.ui`: a
 * per-session table, a route, a migration, and an eviction story for preferences belonging
 * to sessions that no longer exist. The thing being remembered is "read this one
 * differently for a minute", which is worth none of that.
 *
 * The map rather than component state for the same reason the drafts are: the panel
 * unmounts whenever its card collapses or another card expands, and a choice that died
 * with the mount would have to be made again every time you came back to the session.
 *
 * Its scope is honestly the TAB. A reload starts over from the daemon's default, which is
 * the deal `drafts.ts` and `transcript-history.ts` already make.
 */
const overrides = new Map<string, ConversationView>();

/** This session's override, or null when it has none and the global default decides. */
export function readSessionView(sessionId: string): ConversationView | null {
  return overrides.get(sessionId) ?? null;
}

/** Read this session differently from here on - until the tab closes. */
export function writeSessionView(sessionId: string, view: ConversationView): void {
  overrides.set(sessionId, view);
}

/**
 * Forget one session's override because that session is gone for good.
 *
 * Driven by `session_remove` for the reason `dropSessionDrafts` documents at length: it is
 * the one positive "this id is gone" signal, and inferring departure from absence would
 * wipe live sessions every time the fleet list rebuilds after a daemon restart. Without
 * some collection this map is a slow leak in a tab left open for days, and worse, an
 * override could outlive its session and be re-applied to a reused id.
 */
export function dropSessionView(sessionId: string): void {
  overrides.delete(sessionId);
}

/** Test seam: forget every override. Never called by the app. */
export function resetSessionViews(): void {
  overrides.clear();
}

/**
 * THE PRECEDENCE, stated once: a session's own override when it has one, the dashboard's
 * default otherwise. Pure, so the rule can be tested without a DOM.
 */
export function resolveConversationView(
  override: ConversationView | null,
  global: ConversationView = UI_CONFIG_DEFAULTS.conversationView,
): ConversationView {
  return override ?? global;
}

/**
 * Whether this session is being read differently from the rest of the fleet - which is a
 * COMPARISON, not the mere existence of an override.
 *
 * Flipping a session to the terminal and back leaves an explicit `chat` override behind,
 * because a choice made twice is still a choice: this session stays pinned to chat, and if
 * the dashboard default later moves to terminal it will not follow. But at the moment the
 * two agree, the session reads exactly like every other one, and a mark claiming otherwise
 * is a mark that has stopped tracking what it says.
 *
 * Which also means the mark comes BACK on its own if the default moves away later, with no
 * event to wire up: it is derived from the two values every render.
 */
export function differsFromDefault(
  override: ConversationView | null,
  global: ConversationView,
): boolean {
  return override !== null && override !== global;
}

/** What one conversation pane needs to draw itself and to offer the switch. */
export interface SessionConversationView {
  /** The rendering to draw: the override if this session has one, else the default. */
  view: ConversationView;
  /**
   * Whether this session is being read differently from the rest of the fleet right now.
   *
   * A comparison against the current default, not "has an override" - see
   * `differsFromDefault`. What it drives is a mark on the control, and a mark that stays
   * lit while the session reads exactly like every other one is telling the operator
   * something untrue.
   */
  overridden: boolean;
  /** Read this session in that rendering, for this tab. */
  setView: (next: ConversationView) => void;
}

/**
 * The resolved rendering for one session, and the control's setter.
 *
 * The map is read during render rather than copied into state, so switching the panel to
 * another session picks up THAT session's override instead of the one the mount started
 * with. Nothing else subscribes to the map, so a local forced re-render is the whole
 * notification story - the same bargain `useSessionDraft` makes, one level up.
 */
export function useSessionConversationView(sessionId: string): SessionConversationView {
  const [globalView] = useConversationView();
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const override = readSessionView(sessionId);
  const setView = useCallback(
    (next: ConversationView) => {
      writeSessionView(sessionId, next);
      redraw();
    },
    [sessionId],
  );
  return {
    view: resolveConversationView(override, globalView),
    overridden: differsFromDefault(override, globalView),
    setView,
  };
}
