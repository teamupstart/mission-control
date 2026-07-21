import type { NameRules } from "./types.ts";

/**
 * The naming rules a backend with no grammar of its own declares, and the shared half every
 * other backend's rules are built from.
 *
 * "No grammar" is not "no rules". A name reaches a terminal title bar, a multiplexer status
 * line and a card in the dashboard, and a control character does not mean anything in any of
 * them - a newline in particular submits, splits or truncates depending on which reads it
 * first. So the neutral rules still bar control characters, still collapse whitespace and
 * still cap the length. What they do NOT do is invent a target grammar for a backend that
 * has none.
 *
 * Exported rather than defaulted inside the interface, so a backend declaring these is
 * making a claim a reader can see and a third adapter can disagree with, instead of
 * inheriting an assumption by omission.
 */

/**
 * Every character no display name can carry.
 *
 * `\p{Cc}` is the Unicode control category - C0, DEL and C1 - written as a property escape
 * rather than as the numeric range this rule used to be spelled with in two files, because
 * a range typed out by hand is a range that can be typed out slightly differently the second
 * time. A factory rather than one shared literal: a `/g` regex carries `lastIndex` between
 * calls, so a single instance shared by `.test` and `.replace` answers differently on
 * alternate calls for the same input.
 */
const control = (): RegExp => /\p{Cc}/gu;

/**
 * The longest name we will cut to. Not a backend limit - tmux and wezterm both accept far
 * more - but the point past which a name stops being readable on a card, in a tab strip and
 * in a status line at once, which is where every one of these ends up.
 */
const MAX_NAME_CHARS = 60;

/** What a name that sanitized away to nothing becomes. Never empty: an unnamed home cannot be addressed. */
const FALLBACK_NAME = "task";

/**
 * Strip what no display name can hold, collapse it, and cap it.
 *
 * The shared half of every backend's `sanitize`: control characters become SPACES rather
 * than vanishing, so `a\tb` reads as two words instead of `ab`; runs of whitespace collapse;
 * the result is trimmed, cut and never empty. A backend's own grammar is applied inside this
 * (see tmux's `sanitize`, which hands its already-de-punctuated text through here), never
 * instead of it.
 */
export function plainName(text: string): string {
  const out = text
    .replace(control(), " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_CHARS)
    .trim();
  return out || FALLBACK_NAME;
}

/**
 * Refuse what no display name can hold - the shared half of every backend's `validate`,
 * the way `plainName` is the shared half of every backend's `sanitize`.
 *
 * Control characters are REFUSED here rather than stripped, and that asymmetry with
 * `sanitize` is deliberate: a human typed this one, and quietly renaming their session to
 * something they did not type is worse than telling them why it was rejected. `sanitize` is
 * the other direction, where there is nobody to tell.
 */
export function plainValidate(name: string): string | null {
  return control().test(name) ? "name can't contain control characters" : null;
}

/** Name rules for a backend whose names are display text and nothing more. */
export const PLAIN_NAMES: NameRules = {
  validate: plainValidate,
  sanitize: plainName,
};
