/**
 * Helpers for asserting on `renderToStaticMarkup` output.
 *
 * `stripReactIds` exists because `Tooltip` calls `useId`, and React's generated ids are
 * POSITION-dependent: the same component renders `_R_1_` standing alone and `_R_9_` three
 * levels inside a card. Every leaf-parity test in this suite works by rendering a shared
 * component on its own and asserting a layout's output CONTAINS that markup, so without
 * this the ids alone would fail every one of those comparisons - and would go on failing
 * for any future component that generates an id, which is not what those tests are about.
 *
 * Normalising is safe for what they assert: the id is a link between two nodes that this
 * strips from BOTH sides, so a card that re-inlined its own copy of a chip still differs
 * in class, text or structure and still fails.
 */

/** React's SSR ids (`_R_1_`, `_R_2h_`, …), flattened so markup compares by structure. */
export function stripReactIds(html: string): string {
  return html.replace(/_R_[0-9a-z]*_/g, "_R_");
}

/** `haystack.includes(needle)` with React's generated ids normalised out of both. */
export function containsMarkup(haystack: string, needle: string): boolean {
  return stripReactIds(haystack).includes(stripReactIds(needle));
}

/**
 * The text of the hidden description `Tooltip` renders for `aria-describedby`.
 *
 * The visible bubble only exists while a pointer is over the trigger, and these tests
 * have no DOM to hover with - so this hidden copy is the only place a tooltip's wording
 * is assertable, and it is what replaced the `title` attributes these tests used to read.
 */
export function tooltipLabels(html: string): string[] {
  return [...html.matchAll(/<span id="_R_[0-9a-z]*_" class="tt-desc">(.*?)<\/span>/g)].map((m) =>
    // Decoded, so a test can write the apostrophe the operator reads rather than `&#x27;`.
    m[1]!
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&"),
  );
}

/** True when some tooltip in `html` says exactly `label`. */
export function hasTooltip(html: string, label: string): boolean {
  return tooltipLabels(html).includes(label);
}

/**
 * True when some tooltip in `html` starts with `prefix`.
 *
 * For the labels that end in a keyboard chord: which key is bound is the keybinding
 * tests' business, and pinning it here would fail this file for an unrelated rebind.
 */
export function hasTooltipStarting(html: string, prefix: string): boolean {
  return tooltipLabels(html).some((l) => l.startsWith(prefix));
}
