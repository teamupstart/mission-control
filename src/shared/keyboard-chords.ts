const MOD_TOKENS = ["cmd", "ctrl", "alt", "shift"] as const;

/** True for a character whose case shift merely flips (i.e. a letter). */
export function isCased(ch: string): boolean {
  return ch.toLowerCase() !== ch.toUpperCase();
}

/**
 * Canonical chord for a keydown: modifier tokens (cmd/ctrl/alt/shift) joined by
 * "+" ahead of the key. Returns null for a lone modifier press so key capture can
 * keep waiting for a real key.
 *
 * Whether shift is a modifier depends on whether the key is *cased*:
 *
 * - A cased character (a letter) only changes case under shift, so shift is a real
 *   modifier: Shift+O is "shift+o", distinct from a bare "o". That asymmetry is
 *   what makes a shift+letter binding expressible at all - and it cuts both ways:
 *   Shift+S is "shift+s" and so no longer triggers "s" (send), Shift+K no longer
 *   kills, and so on. Deliberate.
 * - An uncased character comes out of the keyboard *different* under shift ("+"
 *   from Shift+= on a US layout, "?" from Shift+/), so shift stays baked into the
 *   character and is never emitted as a token - "+" and "/" bind as themselves.
 * - A named key (Tab, Enter) has no character to bake shift into, so shift is a
 *   modifier there too: "shift+Tab".
 */
export function chordFromEvent(e: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">, physicalModifiers = false): string | null {
  const k = e.key;
  if (k === "Shift" || k === "Control" || k === "Alt" || k === "Meta") return null;
  const mods: string[] = [];
  if (e.metaKey) mods.push("cmd");
  if (e.ctrlKey) mods.push("ctrl");
  if (e.altKey) mods.push("alt");
  let key: string;
  // Option+digit is spelled by its physical digit. macOS turns it into a symbol (`¡`, `™`, … on
  // a US layout, something else on others), which would let the Keyboard panel record a chord
  // the ⌥1…⌥9 resident jumps answer first. Spelled as the digit, it meets their reservation.
  const digit = e.altKey && !e.shiftKey ? /^Digit([0-9])$/.exec(e.code ?? "")?.[1] : undefined;
  if (digit !== undefined) {
    key = digit;
  } else if (k.length === 1 && !isCased(k)) {
    key = k;
    if (physicalModifiers && e.shiftKey) mods.push("shift");
  } else {
    key = k.length === 1 ? k.toLowerCase() : k;
    if (e.shiftKey) mods.push("shift");
  }
  return [...mods, key].join("+");
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

const NAMED_SHORTCUT_KEYS = new Set([
  ...Object.keys(KEY_LABEL),
  "CapsLock", "Clear", "End", "Help", "Home", "Insert", "NumLock", "PageDown",
  "PageUp", "Pause", "PrintScreen", "ScrollLock", "AudioVolumeDown", "AudioVolumeMute", "AudioVolumeUp",
]);

/** Validate a string without a key event, using the recorder's spelling and modifier order. */
export function isCanonicalChord(chord: string): boolean {
  const { mods, key } = parseChord(chord);
  const printable = [...key].length === 1 && !/\p{Cc}/u.test(key);
  if (!printable && !NAMED_SHORTCUT_KEYS.has(key) && !/^F(?:[1-9]|1\d|2[0-4])$/.test(key)) return false;
  return chordFromEvent({
    key, code: "", metaKey: mods.includes("cmd"), ctrlKey: mods.includes("ctrl"),
    altKey: mods.includes("alt"), shiftKey: mods.includes("shift"),
  }) === chord;
}

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
