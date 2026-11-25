// Spoken names (`voice` preview flag): contract C of
// `docs/plans/voice-addressing-for-agents/phased-plan.md`.
//
// Browser-safe: no `node:` import may reach this module. Who can be addressed (`SpokenName`, the
// roster the daemon publishes), what a name sounds like (`phoneticKey`, `keysSoundAlike`) and why
// a name is risky (`validateSpokenName`) are said once here, so the dispatch form, a resident
// profile, Voice settings and the later router all read one rule. Routing compares
// `phoneticKey` values with `keysSoundAlike`, so validation and routing agree on what "sounds
// like" means.
//
// Validation warns and never blocks: a name with every warning is still saved and still
// addressable. The warnings only encourage a more distinctive name.

import { z } from "zod";
import type { ResidentMarkerColorId } from "./residents.ts";
import type { AgentType, TaskKind } from "./types.ts";
import { VOICE_COMMON_WORDS } from "./voice-common-words.ts";

/** The longest call sign or reference name, in characters, after trimming. */
export const SPOKEN_NAME_MAX = 40;

/**
 * A call sign or reference name as it is stored: trimmed, inner whitespace collapsed to one
 * space, one line, 1 to `SPOKEN_NAME_MAX` characters.
 */
export const SpokenNameSchema = z
  .string()
  .transform((value) => value.trim().replace(/\s+/g, " "))
  .pipe(z.string().min(1, "a spoken name cannot be blank").max(SPOKEN_NAME_MAX, `a spoken name is at most ${SPOKEN_NAME_MAX} characters`));

/**
 * A spoken name that may be blank, which means none, in a revisioned settings blob. Clearing it
 * there has to write it: a resident revision carries forward any key a save omits
 * (`preserveUnknownResidentSettings`), so an omitted reference name would come back.
 */
export const BlankableSpokenNameSchema = z
  .string()
  .transform((value) => value.trim().replace(/\s+/g, " "))
  .pipe(z.string().max(SPOKEN_NAME_MAX, `a spoken name is at most ${SPOKEN_NAME_MAX} characters`));

/**
 * The words voice listens for on their own: cancelling, stopping, answering. A name that is one
 * of them, or sounds like one, can be taken for the command.
 */
export const VOICE_CONTROL_WORDS = ["cancel", "stop", "reply", "answer", "submit", "option", "no"] as const;
export type VoiceControlWord = (typeof VOICE_CONTROL_WORDS)[number];

// ---- the roster ----

/** Whether an addressable agent can take a message now. */
export const SPOKEN_NAME_STATES = ["running", "hibernated", "not-running"] as const;
export type SpokenNameState = (typeof SPOKEN_NAME_STATES)[number];

/** A resident profile, or a session addressed through its task's call sign. */
export const SPOKEN_NAME_KINDS = ["resident", "session"] as const;
export type SpokenNameKind = (typeof SPOKEN_NAME_KINDS)[number];

/**
 * One agent that answers to a spoken name: an entry of `VoiceState.roster`.
 *
 * Kept for agents that are not running too, so "<name> isn't running" can be said: that is why
 * `state` is a field and not a filter.
 */
export interface SpokenName {
  /** `resident:<profileId>` or `task:<taskId>`. Stable for the agent's life. */
  key: string;
  /** What to say: a reference name or profile name for a resident, the call sign for a session. */
  name: string;
  kind: SpokenNameKind;
  /** The resident answers to a configured reference name, even when identical to its profile name. */
  isReferenceName?: true;
  /** The resident's open run's task, or the call sign's task. Null for a resident not running. */
  taskId: string | null;
  /** The live session while one runs the task; a session's last session id otherwise; or null. */
  sessionId: string | null;
  /** One line on what the agent does: a resident's description, a session's task title. */
  role: string;
  /** A resident's board colour; null for a session, which has none. */
  colorId: ResidentMarkerColorId | null;
  /** The harness that runs it, which later chooses the model the router asks. */
  agent: AgentType;
  state: SpokenNameState;
}

/** Render the delimiter once, including for names saved with their own surrounding quotes. */
export function quotedReferenceName(name: string): string {
  let inner = name.trim();
  while (inner.length >= 2 && ((inner.startsWith('"') && inner.endsWith('"')) || (inner.startsWith('“') && inner.endsWith('”')))) {
    inner = inner.slice(1, -1).trim();
  }
  return `"${inner}"`;
}

export type SpokenNameIdentity = Pick<SpokenName, "name" | "isReferenceName">;

export function spokenNameLabel(entry: SpokenNameIdentity): string {
  return entry.isReferenceName ? quotedReferenceName(entry.name) : entry.name;
}

/** The roster key of a resident profile. */
export function residentSpokenNameKey(profileId: string): string {
  return `resident:${profileId}`;
}

/** The roster key of a task with a call sign. */
export function taskSpokenNameKey(taskId: string): string {
  return `task:${taskId}`;
}

/**
 * Whether a task of this kind can carry a call sign. A resident is addressed by its profile's
 * reference name or name, so its task cannot: the roster would leave the call sign out while the
 * agent's card printed it, naming the agent something the operator cannot say. The roster, the
 * card's name, and the create and the edit that would set one, all ask this.
 */
export function taskKindTakesCallSign(kind: TaskKind): boolean {
  return kind !== "resident";
}

/** Why an edit that gives a resident's task a call sign is refused. */
export const RESIDENT_CALL_SIGN_REFUSAL =
  "A resident is addressed by the reference name on its profile, so its task takes no call sign.";

/** A name as it is compared: trimmed, whitespace collapsed, lowercase and in Unicode NFC. */
export function normalizeSpokenName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase().normalize("NFC");
}

// ---- what a name sounds like ----

/**
 * The words of a name as letters only: accents folded, lowercase, a trailing possessive dropped
 * ("Steve's" is Steve), hyphens and other punctuation splitting or vanishing.
 */
function spokenWords(name: string): string[] {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[‘’`]/g, "'")
    .split(/[\s\-_/.,]+/)
    .map((word) => word.replace(/'s$|s'$|'$/, "").replace(/[^\p{L}\p{M}\p{N}]/gu, ""))
    .filter(Boolean);
}

const VOWELS = "AEIOU";
const isVowel = (letter: string | undefined): boolean => letter !== undefined && VOWELS.includes(letter);

/**
 * One word's key: Metaphone, with Double Metaphone's choices where the two differ (an initial
 * vowel is `A`, B is `P`). Letters that sound alike share a code and silent letters drop out, so
 * Steve and Stevie are both `STF` and Steven is `STFN`. Codes are not collapsed across a vowel,
 * which keeps Bo (`P`) apart from Bobby (`PP`).
 */
function metaphone(input: string): string {
  if (!/^[a-z]+$/.test(input)) return "";
  let word = input.toUpperCase();
  if (/^(AE|GN|KN|PN|WR)/.test(word)) word = word.slice(1);
  if (word.startsWith("X")) word = `S${word.slice(1)}`;
  if (word.startsWith("WH")) word = `W${word.slice(2)}`;
  let key = "";
  for (let i = 0; i < word.length; i++) {
    const letter = word[i]!;
    const prev = word[i - 1];
    const next = word[i + 1];
    const after = word[i + 2];
    // A doubled letter sounds once; C is the exception (ACCENT is K, S).
    if (letter === prev && letter !== "C") continue;
    switch (letter) {
      case "A": case "E": case "I": case "O": case "U":
        if (i === 0) key += "A";
        break;
      case "B":
        if (!(prev === "M" && i === word.length - 1)) key += "P";
        break;
      case "C":
        if (next === "I" && after === "A") key += "X";
        else if (next === "H") key += prev === "S" || after === "R" ? "K" : "X";
        else if (next === "I" || next === "E" || next === "Y") { if (prev !== "S") key += "S"; }
        else key += "K";
        break;
      case "D":
        if (next === "G" && (after === "E" || after === "I" || after === "Y")) { key += "J"; i++; }
        else key += "T";
        break;
      case "G":
        if (next === "H") {
          if (isVowel(after)) key += "K";
          i++;
        } else if (next === "N" && (i + 2 === word.length || word.slice(i + 1) === "NED")) {
          // Silent, as in Sign and Signed.
        } else if ((next === "I" || next === "E" || next === "Y") && prev !== "G") key += "J";
        else key += "K";
        break;
      case "H":
        if (isVowel(next) && !(prev !== undefined && "CSPTG".includes(prev))) key += "H";
        break;
      case "K":
        if (prev !== "C") key += "K";
        break;
      case "P":
        key += next === "H" ? "F" : "P";
        break;
      case "Q":
        key += "K";
        break;
      case "S":
        if (next === "H" || (next === "I" && (after === "O" || after === "A"))) key += "X";
        else key += "S";
        break;
      case "T":
        if (next === "I" && (after === "O" || after === "A")) key += "X";
        else if (next === "H") key += "0";
        else if (!(next === "C" && after === "H")) key += "T";
        break;
      case "V":
        key += "F";
        break;
      case "W":
      case "Y":
        if (isVowel(next)) key += letter;
        break;
      case "X":
        key += "KS";
        break;
      case "Z":
        key += "S";
        break;
      default:
        // F, J, L, M, N, R sound as written.
        key += letter;
    }
  }
  return key;
}

/**
 * What a name sounds like: one Metaphone-style key per word, joined by a space. Case,
 * punctuation, accents and a possessive do not change it, so "steve's" keys as Steve.
 */
export function phoneticKey(name: string): string {
  const keys = spokenWords(name).map(metaphone);
  return keys.every(Boolean) ? keys.join(" ") : "";
}

/** The edit distance between two short strings. */
export function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length]!;
}

/**
 * Whether two keys sound alike: the same key, or keys one edit apart that start with the same
 * sound. A sound added or dropped counts from three codes (Steve `STF` and Steven `STFN`); one
 * sound swapped for another only from four (Martin `MRTN` and Marvin `MRFN`), since on three it
 * pairs names as different as Stop and Steve. Shorter keys must match exactly, and keys that
 * start differently never match, so rhymes such as Max and Rex do not.
 */
export function keysSoundAlike(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a[0] !== b[0] || editDistance(a, b) !== 1) return false;
  const shorter = Math.min(a.length, b.length);
  return a.length === b.length ? shorter >= 4 : shorter >= 3;
}

/**
 * Whether two names sound alike: their whole keys do, or their first words' keys do. The first
 * word matters on its own because an utterance is routed by its first word, so "Release" and
 * "Release Captain" start the same way when spoken.
 */
export function namesSoundAlike(a: string, b: string): boolean {
  const keyA = phoneticKey(a);
  const keyB = phoneticKey(b);
  if (keysSoundAlike(keyA, keyB)) return true;
  const wordsA = spokenWords(a);
  const wordsB = spokenWords(b);
  return (wordsA.length > 1 || wordsB.length > 1)
    && keysSoundAlike(metaphone(wordsA[0] ?? ""), metaphone(wordsB[0] ?? ""));
}

/** Syllables in one word, by vowel groups less a silent final e. Never fewer than one. */
function syllables(word: string): number {
  const groups = word.match(/[aeiouy]+/g)?.length ?? 0;
  const silentE = word.length > 2 && word.endsWith("e") && !/[aeiouy]e$/.test(word) && !/[^aeiouy]le$/.test(word);
  return Math.max(1, groups - (silentE ? 1 : 0));
}

// ---- validation ----

/** The warnings, in the order they are reported: the riskiest first. */
export const SPOKEN_NAME_WARNING_KINDS = ["control-word", "sounds-like", "common-word", "short", "symbols-only"] as const;
export type SpokenNameWarningKind = (typeof SPOKEN_NAME_WARNING_KINDS)[number];

export type SpokenNameWarning =
  | { kind: "control-word"; word: VoiceControlWord }
  | { kind: "sounds-like"; names: readonly string[] }
  | { kind: "common-word" }
  | { kind: "short" }
  | { kind: "symbols-only" };

/** The steps of the distinctiveness meter: four, less one per warning. */
export const SPOKEN_NAME_METER_STEPS = 4;

/**
 * Why a name may be hard to address by voice, against the names already on the roster. Empty
 * when it is distinctive, and for a blank name. The caller leaves the agent's own entry out of
 * `roster`, so a name is never warned against itself. A name with no letters a to z has no
 * phonetic key, so it is checked for an exact roster match. Symbols alone also draw a warning.
 *
 * - `control-word`: the name's first word is, or sounds like (`keysSoundAlike`, as routing will
 *   compare it), one of `VOICE_CONTROL_WORDS`;
 * - `sounds-like`: it sounds like another roster name (`namesSoundAlike`), naming each;
 * - `common-word`: a one-word name on the bundled list of everyday words;
 * - `short`: a one-word name of one syllable and four letters or fewer.
 */
export function validateSpokenName(name: string, roster: readonly Pick<SpokenName, "name" | "isReferenceName">[] = []): SpokenNameWarning[] {
  const normalized = normalizeSpokenName(name);
  if (!normalized) return [];
  const words = spokenWords(name);
  const first = words[0];
  const warnings: SpokenNameWarning[] = [];
  if (!/[\p{L}\p{N}]/u.test(normalized)) warnings.push({ kind: "symbols-only" });
  if (first) {
    const firstKey = metaphone(first);
    const control = VOICE_CONTROL_WORDS.find((word) => word === first || keysSoundAlike(metaphone(word), firstKey));
    if (control) warnings.push({ kind: "control-word", word: control });
  }
  const alike: string[] = [];
  for (const entry of roster) {
    if (normalizeSpokenName(entry.name) !== normalized && !namesSoundAlike(name, entry.name)) continue;
    const label = spokenNameLabel(entry);
    if (!alike.some((seen) => normalizeSpokenName(seen) === normalizeSpokenName(label))) alike.push(label);
  }
  if (alike.length > 0) warnings.push({ kind: "sounds-like", names: alike });
  if (first && words.length === 1 && VOICE_COMMON_WORDS.has(first)) warnings.push({ kind: "common-word" });
  if (first && /^[a-z]{1,4}$/.test(first) && words.length === 1 && syllables(first) === 1) warnings.push({ kind: "short" });
  return warnings;
}

/** How many meter steps a name lights: four, less one per warning. */
export function spokenNameMeter(warnings: readonly SpokenNameWarning[]): number {
  return Math.max(0, SPOKEN_NAME_METER_STEPS - warnings.length);
}

/** Join names as one phrase: "A", "A or B", "A, B or C". */
function either(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

/** A warning in two or three words, for the meter and the roster's Check column. */
export function spokenNameWarningLabel(warning: SpokenNameWarning): string {
  switch (warning.kind) {
    case "control-word":
      return "Voice command";
    case "sounds-like":
      return `Sounds like ${either(warning.names)}`;
    case "common-word":
      return "Everyday word";
    case "symbols-only":
      return "Symbols only";
    case "short":
      return "Very short";
  }
}

/** A warning as one sentence that says why, and that the name can be kept. */
export function spokenNameWarningText(warning: SpokenNameWarning, name: string, referenceName = false): string {
  const said = name.trim().replace(/\s+/g, " ");
  const label = referenceName ? quotedReferenceName(said) : `“${said}”`;
  switch (warning.kind) {
    case "control-word":
      return `“${warning.word}” is a word voice listens for on its own, so ${label} can be taken for it. You can keep it; another name is safer.`;
    case "sounds-like":
      return `It can be heard as ${either(warning.names)}, which another agent answers to. You can keep it; a name that sounds different is safer.`;
    case "common-word":
      return !referenceName && said.toLowerCase() === "will"
        ? "Sentences like “Will you grab the door?” start the same way. You can keep it; a rarer name is safer."
        : `Everyday sentences can start with ${label}. You can keep it; a rarer name is safer.`;
    case "symbols-only":
      return "This name has no letters or numbers to say. You can keep it or choose a spoken word.";
    case "short":
      return "One short syllable is easy to miss or mishear. You can keep it; two syllables or more is safer.";
  }
}
