// What is at stake: a repository's colour is DERIVED, so the derivation is the only thing
// keeping it stable.
//
// Nothing stores a repository's colour. That is deliberate - a stored colour needs a migration
// the first time the palette changes, and drifts between machines that met repositories in a
// different order - but it means the hash IS the contract. If it stops depending on the whole
// path, sibling checkouts collide; if the palette is reordered, every repository on every
// operator's board changes colour at once for no reason they asked for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { REPO_PALETTE, repoColor, repoColorIndex } from "../src/web/lib/repo-color.ts";

test("the same root always gets the same colour", () => {
  const root = "/Users/you/code/mission-control";
  assert.equal(repoColor(root), repoColor(root));
  assert.ok(REPO_PALETTE.includes(repoColor(root) as (typeof REPO_PALETTE)[number]));
});

test("the hash reads the whole path, so sibling checkouts spread across the palette", () => {
  // The case a checkout pool actually produces: every path shares a long prefix and differs
  // only at the end. A "sum the character codes" hash, or one whose accumulator has stopped
  // depending on late characters (which is what dropping the `>>> 0` does), maps the whole
  // family onto one or two entries.
  //
  // Asserted over a FAMILY rather than over a pair. Demanding that two named siblings land on
  // different entries is a one-in-six coin flip dressed up as a contract - it would have
  // "passed" the old palette and started failing the moment the palette shrank, which is
  // exactly what it did. Full coverage by a family of siblings is the property that actually
  // distinguishes a hash reading the suffix from one ignoring it.
  const siblings = Array.from(
    { length: 60 },
    (_, i) => `/Users/you/code/mission-control-${i}`,
  );
  assert.equal(
    new Set(siblings.map(repoColorIndex)).size,
    REPO_PALETTE.length,
    "a family of sibling checkouts does not reach every palette entry - the suffix is not being read",
  );
  // And the same at the far end of a long shared prefix, where a weak hash runs out of
  // influence first.
  const deep = Array.from(
    { length: 60 },
    (_, i) => `/very/long/shared/prefix/that/goes/on/and/on/repo-${i}`,
  );
  assert.equal(new Set(deep.map(repoColorIndex)).size, REPO_PALETTE.length);
});

test("every palette entry is reachable, so the fleet does not crowd into three colours", () => {
  // A hash that only ever returned a few entries would look fine on a two-repository fleet and
  // collide constantly on a ten-repository one, which is exactly when the colour starts to
  // matter. Ordinary-looking paths, not adversarial ones.
  const seen = new Set<number>();
  for (let i = 0; i < 400; i += 1) seen.add(repoColorIndex(`/Users/you/code/service-${i}`));
  assert.equal(seen.size, REPO_PALETTE.length);
});

test("the index is always in range", () => {
  // `%` on a negative accumulator would return a negative index, and `REPO_PALETTE[-2]` is
  // `undefined` - a card with no colour at all rather than a wrong one. The `>>> 0` in the hash
  // is what prevents it, and this is what would notice its removal.
  for (const root of ["", "/", "a", "/Users/you/code/x".repeat(40), "/tmp/ünïcødé-repo"]) {
    const index = repoColorIndex(root);
    assert.ok(Number.isInteger(index), `${root} produced a non-integer index`);
    assert.ok(index >= 0 && index < REPO_PALETTE.length, `${root} produced ${index}`);
    assert.equal(typeof repoColor(root), "string");
  }
});

/** A hex entry's hue in degrees, which is what "these two look alike" reduces to. */
function hue(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const span = max - min;
  const raw =
    max === r ? (g - b) / span : max === g ? 2 + (b - r) / span : 4 + (r - g) / span;
  return (raw * 60 + 360) % 360;
}

/** Shortest way round the circle, so 350 and 10 are 20 apart rather than 340. */
const hueGap = (a: number, b: number): number => {
  const raw = Math.abs(a - b) % 360;
  return Math.min(raw, 360 - raw);
};

test("no two palette entries can be mistaken for each other", () => {
  // THE regression test for this palette, and it exists because the first version failed it:
  // it paired a gold with a clay (20 degrees apart) and a teal with a steel (10 degrees apart),
  // and two repositories landing on either pair drew two frames a person could not tell apart -
  // which is the entire job of this colour. Caught only by looking at a real board, which is
  // exactly the kind of defect a numeric assertion should be catching instead.
  const failures: string[] = [];
  for (const [i, a] of REPO_PALETTE.entries()) {
    for (const b of REPO_PALETTE.slice(i + 1)) {
      const gap = hueGap(hue(a), hue(b));
      if (gap < 30) failures.push(`${a} and ${b} are only ${Math.round(gap)} degrees apart`);
    }
  }
  assert.deepEqual(failures, [], failures.join("\n  "));
});

test("no palette entry is one of the state hues", () => {
  // The one rule this palette exists to obey: `--working` blue, `--idle` green, `--attention`
  // amber, `--danger` red and `--purple` (which `--held` aliases) carry the board's whole
  // meaning, and a repository colour landing on one of them would teach the eye that a group
  // means a state.
  //
  // Read OUT OF THE STYLESHEET rather than pasted here, which is the whole point of the test: a
  // hardcoded list passes forever while the theme moves underneath it, and the failure this
  // guards against is a state hue being retuned onto a palette entry - which nobody would think
  // to check from the CSS side.
  const css = readFileSync(fileURLToPath(new URL("../src/web/styles.css", import.meta.url)), "utf8");
  const hue = (token: string): string => {
    const found = new RegExp(`--${token}:\\s*(#[0-9a-fA-F]{3,8});`).exec(css);
    assert.ok(found, `--${token} is no longer a hex literal in styles.css - update this test`);
    return found[1]!.toLowerCase();
  };
  const stateHues = ["working", "idle", "attention", "danger", "purple"].map(hue);
  for (const entry of REPO_PALETTE) {
    assert.ok(!stateHues.includes(entry.toLowerCase()), `${entry} is a state colour`);
  }
  assert.equal(new Set(REPO_PALETTE).size, REPO_PALETTE.length, "two palette entries are equal");
});
