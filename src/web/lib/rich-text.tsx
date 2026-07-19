import { createContext, useCallback, useContext, useEffect, useState } from "react";

/**
 * Whether messages render as formatted markdown - headings, lists, tables, and
 * syntax-highlighted code fences - or as the raw text the agent actually emitted.
 *
 * On by default: agents write markdown, so formatting it is showing the message as
 * intended, and unformatted fences are the thing this setting exists to fix. The
 * off switch is for reading the literal bytes - checking exactly what an agent said
 * before you paste it somewhere that isn't a markdown renderer.
 *
 * Persisted per-machine in localStorage next to the layout and keybindings: it's a
 * preference about this screen, not a fact about the fleet, so it never goes near
 * the daemon.
 */
const KEY = "mission-control.rich-text";
const DEFAULT = true;

function load(): boolean {
  try {
    const raw = localStorage.getItem(KEY);
    // An unset key means "never chosen", which is the default - not "off". Only the
    // exact string we write counts as a decision; anything else falls back.
    return raw === null ? DEFAULT : raw === "1";
  } catch {
    return DEFAULT;
  }
}

type RichText = [boolean, (on: boolean) => void];

/**
 * A context rather than a prop threaded from App, unlike `layout`. App renders the
 * layout, so it owns that state and passes it one level. Nothing between App and a
 * chat turn cares whether text is formatted - it would be a boolean handed through
 * three components that never read it - and two independent `useState`s over one
 * localStorage key would leave the modal and the transcript disagreeing.
 */
const RichTextContext = createContext<RichText | null>(null);

export function RichTextProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [on, setOn] = useState<boolean>(load);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, on ? "1" : "0");
    } catch {
      /* storage unavailable - keep in-memory only */
    }
  }, [on]);
  const set = useCallback((next: boolean) => setOn(next), []);
  return <RichTextContext.Provider value={[on, set]}>{children}</RichTextContext.Provider>;
}

/**
 * The live setting. Falls back to the default outside a provider rather than
 * throwing, so a component rendered in isolation - a test, a future embed - still
 * renders readable text instead of crashing.
 */
export function useRichText(): RichText {
  return useContext(RichTextContext) ?? [DEFAULT, () => {}];
}
