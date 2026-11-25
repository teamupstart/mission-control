const MOD_TOKENS = ["cmd", "ctrl", "alt", "shift"] as const;

/** True for a character whose case shift merely flips (i.e. a letter). */
export function isCased(ch: string): boolean {
  return ch.toLowerCase() !== ch.toUpperCase();
}

/**
 * Split a canonical chord back into modifiers + key. Done by peeling known
 * "<mod>+" prefixes rather than splitting on "+", so a chord whose key *is* "+"
 * (e.g. "cmd++" or a bare "+") parses correctly.
 */
export function parseChord(chord: string): { mods: string[]; key: string } {
  let rest = chord;
  const mods: string[] = [];
  let matched = true;
  while (matched) {
    matched = false;
    for (const m of MOD_TOKENS) {
      const prefix = `${m}+`;
      if (rest.startsWith(prefix) && rest.length > prefix.length) {
        mods.push(m);
        rest = rest.slice(prefix.length);
        matched = true;
        break;
      }
    }
  }
  return { mods, key: rest };
}

const MOD_SYMBOL: Record<string, string> = { cmd: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧" };
const KEY_LABEL: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Escape: "Esc",
  Enter: "↵",
  Tab: "⇥",
  " ": "Space",
  Backspace: "⌫",
  Delete: "⌦",
  ContextMenu: "☰",
};

/** Human-readable form of a chord for keycaps and the editor (e.g. "⌘K", "⇧O", "⇥", "/"). */
export function formatChord(chord: string): string {
  if (!chord) return "";
  const { mods, key } = parseChord(chord);
  const modStr = mods.map((m) => MOD_SYMBOL[m] ?? m).join("");
  // A modified letter reads as the keycap convention it's written in everywhere
  // else ("⌘K", "⇧O"), while a bare letter stays as typed ("k").
  if (mods.length > 0 && key.length === 1 && isCased(key)) return modStr + key.toUpperCase();
  return modStr + (KEY_LABEL[key] ?? key);
}
