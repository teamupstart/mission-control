/**
 * A repository's identity colour, from its root path alone.
 *
 * One pure function so every surface that colours a repository reads the same answer. The
 * Board's repository groups are the first consumer; a rail glyph or a Library row that wants
 * the same colour later must call this rather than keeping a second table, which is the rule
 * `AGENT_IDENTITY` already follows for a harness's brand colour.
 *
 * DERIVED, never stored. A colour persisted per repository would need a migration the first
 * time the palette changed and would drift between machines that had seen different
 * repositories in a different order. Hashing the root means a repository has the same colour
 * on every machine, across reloads, and on a fleet that has never seen it before - and adding
 * a repository never renumbers the ones already on screen, which a "next free colour"
 * allocator would do on every restart.
 */

/**
 * The palette, spread so that no two entries can be mistaken for each other.
 *
 * THE PRIMARY CONSTRAINT IS MUTUAL DISTINCTNESS, and it was learned the hard way: an earlier
 * seven-entry version paired a gold with a clay and a teal with a steel, and two repositories
 * that landed on one of those pairs drew two frames a person could not tell apart - which is
 * the entire job of this colour. Every entry here is at least 30 degrees of hue from every
 * other, which `test/repo-color.test.ts` asserts numerically so the next entry added has to
 * clear the same bar.
 *
 * Six rather than seven, because six is what that spacing fits. A seventh could only be
 * squeezed into the congested blue-to-purple arc, and buying a marginally lower collision rate
 * with two entries nobody can distinguish is paying in the currency the feature is denominated
 * in.
 *
 * The secondary constraint is not to be MISTAKEN FOR A STATE. `--working` is blue, `--idle`
 * green, `--attention` amber, `--danger` red, `--held` purple and `--neutral` a blue-grey, and
 * those carry the whole board's meaning. Perfect avoidance turned out to be unbuyable - the
 * hue circle minus six reserved hues does not hold six more entries 30 degrees apart - so this
 * palette is merely no-entry-equals-a-state-colour, and the rest of the defence is
 * positional: a repository colour appears ONLY as a frame's border tint and as a 7px dot in a
 * header that names the repository in monospace beside it. It is never a card's spine, never a
 * column's swatch and never a badge fill, which is where every state colour lives. A frame is
 * therefore never in a position to be read as a state, and two repositories are never in a
 * position to be read as one.
 *
 * A COLLISION IS NOT A BUG. Six entries hashed over four repositories collide about half the
 * time, and no palette fixes that - the heading names the repository, so the colour is a
 * scanning aid and the name is the identity. What this array buys is that two frames are
 * either the same colour or obviously different ones, with no near-misses in between.
 *
 * Hex rather than `oklch()` or a `--repo-*` token per entry: the value is handed to the DOM as
 * an inline custom property (the same way `AgentDot` hands over `--agent-accent`), and the
 * stylesheet mixes it with `color-mix(in oklab, …)` at the point of use. That keeps the palette
 * in one array in one file instead of split across a token block and a lookup.
 */
export const REPO_PALETTE = [
  "#e0714a", // coral
  "#b9c33a", // lime
  "#19b3b8", // cyan
  "#7b7ef0", // indigo
  "#cc66e0", // orchid
  "#ee6392", // rose
] as const;

/**
 * FNV-1a over the path's code units, which is all this needs to be.
 *
 * Not a cryptographic hash and not trying to be: the requirement is that the same string
 * always lands on the same entry and that two paths differing late in a long shared prefix -
 * `/Users/you/code/mission-control` and `/Users/you/code/mission-control-web`, which is
 * exactly what a checkout pool produces - do not collide more often than chance. FNV-1a mixes
 * every character into the accumulator, so a differing suffix changes the result; a cheaper
 * "sum the char codes" would map anagrams together and cluster same-length siblings.
 *
 * `>>> 0` after each multiply keeps this in unsigned 32-bit range. Without it the value drifts
 * past `Number.MAX_SAFE_INTEGER` and starts losing low bits, which is where a hash quietly
 * stops depending on the end of a long path - and every path here is long.
 */
function hash32(text: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    value ^= text.charCodeAt(i);
    // The FNV prime, as the shift-and-add form: `value * 0x01000193` overflows the exact
    // integer range before `>>> 0` can truncate it, so the product would already be wrong.
    value = (value + (value << 1) + (value << 4) + (value << 7) + (value << 8) + (value << 24)) >>> 0;
  }
  return value;
}

/** Which palette entry this repository root gets. Exported for the tests that pin stability. */
export function repoColorIndex(repoRoot: string): number {
  return hash32(repoRoot) % REPO_PALETTE.length;
}

/**
 * The colour to hand the DOM for this repository, as a plain CSS colour.
 *
 * Takes the root as it appears on the session (`Session.repoRoot`), unnormalised: that value
 * is already resolved through symlinks by the daemon, so two sessions in one repository agree
 * on the string and therefore agree on the colour. Normalising here - trimming a trailing
 * slash, lowercasing - would be inventing a second notion of repository identity beside the
 * one `orderSessions` groups by, and the two would disagree on the day they diverged.
 */
export function repoColor(repoRoot: string): string {
  return REPO_PALETTE[repoColorIndex(repoRoot)]!;
}
