import { useCallback } from "react";
import { updateUiConfig, useUiConfig } from "./uiConfig.ts";

/**
 * Whether pressing the dispatch shortcut runs the guided pass - a keyboard walk over the
 * repo, kind, harness and after-work decisions - before handing over the dispatch form
 * with those answers already in place, or opens that form directly the way it always has.
 *
 * The pass is a different way to FILL the dispatch draft, never a second opinion about
 * what a dispatch means: the form it hands over to is the same form, and every rule that
 * form enforces still runs. So this preference changes how a dispatch is composed and
 * nothing about what one does.
 *
 * Stored in the daemon (`app_config.ui.guidedDispatch`), per machine, alongside the layout
 * and the keybindings - see `lib/uiConfig.ts` for why that store rather than
 * `localStorage`. THE ONLY read/write path for it: the modal header, the pass's own escape
 * hatch and Settings are three surfaces over one value, and a component holding its own
 * `useState` over the same key would let two of them disagree mid-dispatch.
 *
 * Its own module rather than a line in `rich-text.ts` because that module is one setting's
 * documentation, not a drawer of hooks; this one earns the same treatment.
 */
export function useGuidedDispatch(): [boolean, (on: boolean) => void] {
  const on = useUiConfig().guidedDispatch;
  const set = useCallback((next: boolean) => {
    void updateUiConfig({ guidedDispatch: next });
  }, []);
  return [on, set];
}
