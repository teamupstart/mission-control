import { createContext, useContext } from "react";
import {
  PAUSE_CARD_CONTROLS,
  PAUSE_CONSOLE_CONTROLS,
  type PauseCardControl,
  type PauseConsoleControl,
} from "@shared/pause.ts";
import { updateUiConfig, useUiConfig } from "./uiConfig.ts";

/**
 * Which pause controls the board card and the console draw - the operator's choice in
 * Settings > Display > Pause controls, any number of each at once.
 *
 * The one place the two `UiConfig` lists are read and written, so the card, the console and
 * the settings previews cannot disagree. A preview pins its own answer through
 * `PauseControlsPreview` instead of the stored one, which is how each option's preview shows
 * that control alone.
 */

export interface PauseControlCopy {
  label: string;
  description: string;
}

export const PAUSE_CARD_CONTROL_COPY: Record<PauseCardControl, PauseControlCopy> = {
  corner: {
    label: "Corner buttons",
    description: "Pause and priority buttons in the card's top-right corner, shown when you point at the card.",
  },
  chip: {
    label: "Run chip",
    description: "A Running, Paused or Priority chip at the start of the runtime row. Its menu can also pause after the current turn.",
  },
  menu: {
    label: "Card menu",
    description: "A ⋯ menu in the card's head, plus a Resume button on a paused card.",
  },
};

export const PAUSE_CONSOLE_CONTROL_COPY: Record<PauseConsoleControl, PauseControlCopy> = {
  toolbar: {
    label: "Toolbar button",
    description: "A pause button beside session control in the tab row. Its menu can also pause after the current turn or make this the priority session.",
  },
  composer: {
    label: "Message box button",
    description: "A pause button beside Send. While paused, Send becomes Queue and a band above the box says why.",
  },
  badge: {
    label: "State badge and band",
    description: "A pause half on the state badge in the header, and a band under the header while paused.",
  },
};

/** Only the ids this build knows, in registry order. A stored unknown id is inert. */
function known<T extends string>(ids: readonly T[], stored: readonly string[]): ReadonlySet<T> {
  return new Set(ids.filter((id) => stored.includes(id)));
}

interface PreviewPins {
  card?: readonly PauseCardControl[];
  console?: readonly PauseConsoleControl[];
}

/** A settings preview's pinned controls; null everywhere else, which reads the stored choice. */
export const PauseControlsPreview = createContext<PreviewPins | null>(null);

export function usePauseCardControls(): ReadonlySet<PauseCardControl> {
  const pinned = useContext(PauseControlsPreview)?.card;
  const stored = useUiConfig().pauseCardControls;
  return known(PAUSE_CARD_CONTROLS, pinned ?? stored);
}

export function usePauseConsoleControls(): ReadonlySet<PauseConsoleControl> {
  const pinned = useContext(PauseControlsPreview)?.console;
  const stored = useUiConfig().pauseConsoleControls;
  return known(PAUSE_CONSOLE_CONTROLS, pinned ?? stored);
}

/** A list with `id` present or absent, fresh and never duplicated. Pure, for the panel and tests. */
export function withControl(list: readonly string[], id: string, on: boolean): string[] {
  const without = list.filter((entry) => entry !== id);
  return on ? [...without, id] : without;
}

export function setPauseCardControl(current: readonly string[], id: PauseCardControl, on: boolean): void {
  void updateUiConfig({ pauseCardControls: withControl(current, id, on) });
}

export function setPauseConsoleControl(current: readonly string[], id: PauseConsoleControl, on: boolean): void {
  void updateUiConfig({ pauseConsoleControls: withControl(current, id, on) });
}
