import { useCallback } from "react";
import { updateUiConfig, useUiConfig } from "./uiConfig.ts";

/**
 * Whether messages render as formatted markdown - headings, lists, tables, and
 * syntax-highlighted code fences - or as the raw text the agent actually emitted.
 *
 * On by default: agents write markdown, so formatting it is showing the message as
 * intended, and unformatted fences are the thing this setting exists to fix. The
 * off switch is for reading the literal bytes - checking exactly what an agent said
 * before you paste it somewhere that isn't a markdown renderer.
 *
 * Stored in the daemon (`app_config.ui.richText`), per machine, alongside the layout and
 * the keybindings. It was `localStorage`, which is per-origin and did not survive the
 * product rename; see `lib/uiConfig.ts`.
 *
 * THE PROVIDER IS GONE, and nothing replaced it. It existed so the modal's toggle and the
 * transcript could not end up with two `useState`s over one key - a module-level store
 * makes that unrepresentable, so there is one value by construction and no tree to wrap.
 * Components rendered in isolation (a test, a future embed) still read fine: with no
 * daemon and no storage the store holds the shipped defaults.
 */
export function useRichText(): [boolean, (on: boolean) => void] {
  const on = useUiConfig().richText;
  const set = useCallback((next: boolean) => {
    void updateUiConfig({ richText: next });
  }, []);
  return [on, set];
}
