import { useEffect } from "react";
import { chordFromEvent } from "./keybindings.ts";

/** Intercept the chord before dashboard navigation, including Escape-to-close. */
export function useChordCapture(active: boolean, cancel: () => void, record: (chord: string) => void) {
  useEffect(() => {
    if (!active) return;
    function onKey(event: KeyboardEvent) {
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      if (event.key === "Escape") return cancel();
      const chord = chordFromEvent(event);
      if (chord) record(chord);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, cancel, record]);
}
