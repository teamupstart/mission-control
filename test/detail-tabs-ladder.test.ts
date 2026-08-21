/**
 * What is at stake: the console detail's tab strip now carries the conversation's toolbar as
 * well as its tabs, and the launcher strip that used to sit above the transcript is gone.
 * Two silent failure classes come with that, and neither shows up as a compile error, a
 * console warning, or a diff that reads wrong.
 *
 * The first is a LOST CONTROL. `SessionLaunchers` has one deliberate mount in the shared
 * Console and Board detail. Its registration and visible controls must stay together.
 *
 * The second is the LADDER, and the failure modes are the ones `topbar-ladder.test.ts`
 * enumerates, because it is the same mechanism (`measuredLadder.ts`):
 *
 * 1. The CSS and `DETAIL_TAB_RUNGS` disagree on how many rungs there are. The fit then either
 *    stops a rung early with room still to give back, or steps onto a rung that does not
 *    exist and reports the row unfittable.
 * 2. `.detail-tabs` stops wrapping - or a tab starts shrinking. The fit READS wrapping, so
 *    `nowrap` means it never observes a second row; and a SHRINKABLE tab wraps its own label
 *    instead of overflowing, which grows the row's tallest child in step with the row and
 *    hides the overflow from the same comparison.
 * 3. A rung sheds a label with `display: none`, which takes the control's accessible name
 *    with it and turns a narrow pane into a strip of unnamed glyphs.
 * 4. A rung sheds a TAB's word. The tabs are what this row is.
 *
 * Driven from source for the reason `topbar-ladder.test.ts` gives: there is no jsdom here.
 * What a browser has to answer instead - that the row actually stays on one line, that the
 * shed labels are still reachable - is
 * `e2e/specs/console-tabs-toolbar.spec.ts`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DETAIL_TAB_RUNGS } from "../src/web/detailTabsLadder.ts";
import { ConsoleDetail } from "../src/web/components/layouts/ConsoleDetail.tsx";
import { SessionLaunchers } from "../src/web/components/LaunchMenu.tsx";
import { mkSession } from "./helpers/session-fixture.ts";
import { mkSessionView } from "./helpers/session-view.ts";

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), "utf8");

const css = read("src/web/styles.css");
const detail = read("src/web/components/layouts/ConsoleDetail.tsx");

/** Comments discuss `display: none` and rung numbers in prose, so they go first. */
const bare = css.replace(/\/\*[\s\S]*?\*\//g, " ");

/** Every `[selector, body]` pair in the sheet. */
const RULES: [string, string][] = [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
  ([, s = "", b = ""]) => [s.trim().replace(/\s+/g, " "), b],
);

/** The token a rung's selector carries, e.g. 2 for `.detail-tabs[data-rung~="2"] .launch-word`. */
function rungOf(selector: string): number | null {
  const found = [...selector.matchAll(/\.detail-tabs\[data-rung~="(\d+)"\]/g)].map((m) =>
    Number(m[1]),
  );
  if (found.length === 0) return null;
  // A selector list is only ever one rung's; a rule spanning two would apply at the wider of
  // them and silently shed early.
  assert.equal(
    new Set(found).size,
    1,
    `"${selector}" mixes rungs ${[...new Set(found)].join(" and ")} in one rule`,
  );
  return found[0]!;
}

const LADDER = new Map<number, [string, string][]>();
for (const [selector, body] of RULES) {
  const rung = rungOf(selector);
  if (rung === null) continue;
  if (!LADDER.has(rung)) LADDER.set(rung, []);
  LADDER.get(rung)!.push([selector, body]);
}

// ---- the arrangement: one strip per host, never zero and never two ----

test("the console detail hosts the strip in its tab row and the panel draws none", () => {
  const html = renderToStaticMarkup(
    createElement(ConsoleDetail, { session: mkSession(), view: mkSessionView(mkSession()) }),
  );
  // The strip is inside the tab row. Sliced rather than matched loosely, because "the markup
  // contains a launcher somewhere" is exactly what a broken move would also satisfy.
  const tabs = html.slice(html.indexOf('class="detail-tabs"'));
  const row = tabs.slice(0, tabs.indexOf('class="detail-body"'));
  assert.match(row, /conv-launch in-toolbar/, "the launcher strip is not in the tab row");
  assert.match(row, /Terminal view/, "the rendering toggle is not in the tab row");
  assert.match(row, /foreman-rail/, "Foreman left the tab row");

  // And the conversation pane draws no second one. `.detail-conv` is where the band used to
  // be; a strip there as well would be two mounts fighting over App's one launcher handle.
  const conv = html.slice(html.indexOf('class="detail-conv"'));
  assert.doesNotMatch(
    conv,
    /conv-launch/,
    "the conversation pane still draws its own strip, so this session has two",
  );
  // The path it dropped is not re-added here either: the `PATH`/`BRANCH` row above already
  // prints it, and a copy in the tab row is the duplication this change exists to remove.
  assert.doesNotMatch(row, /conv-launch-where|conv-launch-path/, "a worktree path is in the tab row");
});

test("exactly one strip per session registers the t / a chords", () => {
  // App keeps ONE launcher handle per session id and clears its parked `pendingLauncherAction`
  // only when a strip registers for that id. Two registrations race - the second overwrites
  // the first, and the first's unmount then deletes a live one. Zero is worse: the chord is
  // dead and the parked action fires later against an unrelated mount.
  //
  // So the console detail's own mount takes `registerLaunchers`, and the panel it hosts does
  // not get it at all.
  const mount = detail.slice(detail.indexOf("<SessionLaunchers"));
  assert.match(
    mount.slice(0, mount.indexOf("/>")),
    /registerLaunchers=\{view\.registerLaunchers\}/,
    "the tab row's strip does not register, so `t` / `a` are dead in the console",
  );
  const transcript = detail.slice(detail.indexOf("<TranscriptPanel"));
  const props = transcript.slice(0, transcript.indexOf("/>")).replace(/\/\/[^\n]*/g, " ");
  assert.doesNotMatch(props, /hostToolbar/, "the retired host split returned");
  assert.doesNotMatch(
    props,
    /registerLaunchers/,
    "the console detail hands `registerLaunchers` to a panel that draws no strip - the console " +
      "would register nothing, or register twice if the panel's strip ever came back",
  );
});

test("the launcher strip carries controls without duplicating the worktree", () => {
  const toolbar = renderToStaticMarkup(createElement(SessionLaunchers, { session: mkSession() }));
  assert.doesNotMatch(toolbar, /conv-launch-lbl|conv-launch-path/);
  assert.match(toolbar, /aria-haspopup="menu"/, "the terminal launcher is gone");
  assert.match(toolbar, /launch-agent/, "the agent launcher is gone");
});

// ---- the ladder ----

test("every rung the fit can reach exists in the stylesheet, and no rung beyond it does", () => {
  const defined = [...LADDER.keys()].sort((a, b) => a - b);
  assert.deepEqual(
    defined,
    Array.from({ length: DETAIL_TAB_RUNGS }, (_, i) => i + 1),
    `styles.css defines rungs [${defined.join(", ")}] but detailTabsLadder.ts steps through ` +
      `1..${DETAIL_TAB_RUNGS}. They have to agree - the fit cannot see what it did not apply.`,
  );
});

test("the row wraps and its tabs do not shrink, because the fit reads both", () => {
  // Failure mode 2, in its two halves. `flex-wrap: wrap` is the signal: with `nowrap` the fit
  // observes one row at every width, never steps down, and the strip overflows the pane
  // instead. And a tab left shrinkable never lets the row overflow in the first place - it
  // wraps its own label, growing the row's tallest child in lockstep with the row, so the
  // comparison the fit makes stays false while the strip degrades into stacked words.
  const tabs = bare.slice(bare.indexOf(".detail-tabs {"));
  const row = tabs.slice(0, tabs.indexOf("}"));
  assert.match(row, /display:\s*flex/, "`.detail-tabs` is no longer a flex row");
  assert.match(
    row,
    /flex-wrap:\s*wrap/,
    "`.detail-tabs` no longer wraps. The measured ladder has nothing to measure: it steps " +
      "down only while the row is taller than its tallest child, so `nowrap` freezes it at " +
      "rung 0 and the row overflows the pane.",
  );

  const tab = bare.slice(bare.indexOf(".detail-tab {"));
  const block = tab.slice(0, tab.indexOf("}"));
  assert.match(block, /flex:\s*none/, "`.detail-tab` shrinks again, so the row cannot overflow");
  assert.match(block, /white-space:\s*nowrap/, "`.detail-tab` wraps its own label again");
});

test("this row is not a query container, and no rung pretends otherwise", () => {
  // The conversation pane's only `container-type` is on `.transcript`, which this row sits
  // ABOVE rather than inside - so a `@container` rule aimed at the tab strip matches nothing
  // and reads exactly like live code.
  assert.doesNotMatch(
    bare,
    /@container\s+detail-tabs\b/,
    "an `@container detail-tabs` rule exists, but nothing declares that container - it is dead",
  );
  const tabs = bare.slice(bare.indexOf(".detail-tabs {"));
  assert.doesNotMatch(
    tabs.slice(0, tabs.indexOf("}")),
    /container(-type|-name)?:/,
    "`.detail-tabs` declares a container - either the ladder moved to container queries, " +
      "which cannot work here, or this is containment nothing asked for",
  );
});

test("every rung rule leads with its rung prefix", () => {
  // Without the prefix a rung rule applies at EVERY width and is back to deciding by source
  // order against the base rule it overrides. Same construction, and same reasoning, as the
  // topbar's - see `topbar-ladder.test.ts` for why there is no source-order assertion beside
  // this one.
  for (const [rung, rules] of LADDER) {
    for (const [selector] of rules) {
      for (const part of selector.split(",")) {
        assert.match(
          part.trim(),
          new RegExp(`^\\.detail-tabs\\[data-rung~="${rung}"\\]`),
          `"${part.trim()}" is in rung ${rung} but does not lead with the rung prefix, so it ` +
            `applies at every width`,
        );
      }
    }
  }
});

test("a shed label goes visually hidden, never display:none", () => {
  // Failure mode 3, and the line is between hiding a WHOLE control and hiding the NAME off
  // one that stays on screen. `display: none` on `.launch-word` or `.fr-word` leaves a live,
  // clickable glyph with nothing naming it - invisible in a screenshot, and the exact reason
  // the ladder is written the way it is. A keycap or a caret is not a name and may go.
  const LABELS = /\.launch-word|\.fr-word/;
  for (const [rung, rules] of LADDER) {
    for (const [selector, body] of rules) {
      if (!LABELS.test(selector)) continue;
      assert.doesNotMatch(
        body,
        /display:\s*none/,
        `rung ${rung} hides "${selector}" with display:none. A label must be hidden VISUALLY ` +
          `(position: absolute + clip-path) so the control it names keeps its accessible ` +
          `name and its tooltip.`,
      );
      assert.match(
        body,
        /position:\s*absolute[\s\S]*clip-path:\s*inset\(50%\)|clip-path:\s*inset\(50%\)[\s\S]*position:\s*absolute/,
        `rung ${rung}'s "${selector}" does not use the visually-hidden pattern. Without ` +
          `\`position: absolute\` it still costs width and a flex gap; without the clip it ` +
          `is still drawn.`,
      );
    }
  }
  // And the known sheds are present, so this cannot pass by the ladder having quietly stopped
  // collapsing anything.
  const shed = [...LADDER.values()].flat().filter(([s]) => LABELS.test(s));
  assert.ok(shed.length >= 3, `only ${shed.length} label rules left in the ladder`);
});

test("no rung ever sheds a tab, its word, or its pip", () => {
  // Failure mode 4. The tabs are what this row IS - a strip of five unlabelled glyphs is not
  // a narrow version of it, it is a different control. The keycap beside a tab's word may go
  // (rung 4, the last thing the row has to give); the tab, its label and its count may not.
  for (const [rung, rules] of LADDER) {
    for (const [selector, body] of rules) {
      if (!/display:\s*none|clip-path/.test(body)) continue;
      for (const part of selector.split(",").map((s) => s.trim())) {
        assert.doesNotMatch(
          part,
          /\.detail-tab$/,
          `rung ${rung} hides a whole tab ("${part}")`,
        );
        assert.doesNotMatch(
          part,
          /\.detail-pip$/,
          `rung ${rung} hides a tab's count pip ("${part}"), which is the only thing saying ` +
            `the work queue has anything in it`,
        );
      }
    }
  }
  // The one thing a tab does give up, so the rung is not silently doing nothing. It is rung
  // 1 deliberately - see `detailTabsLadder.ts` for the measurement that put it there - and
  // that position is asserted, because moving it later is what would trade three buttons'
  // names for five chord hints at the width this pane is most often read at.
  const keycaps = (LADDER.get(1) ?? []).filter(
    ([selector, body]) =>
      /\.detail-tab \.kb-hint/.test(selector) && /display:\s*none/.test(body),
  );
  assert.equal(keycaps.length, 1, "rung 1 no longer sheds the tabs' keycaps");
});

test("every control the ladder strips to a glyph still says what it is", () => {
  // The visually-hidden label covers it only if the label is really the control's name. Each
  // of these is inside a `Tooltip`, which always renders its sentence into a hidden
  // `aria-describedby` node - so a collapsed control keeps both a name and an explanation.
  const html = renderToStaticMarkup(
    createElement(SessionLaunchers, { session: mkSession() }),
  );
  assert.match(html, /launch-word/, "the launcher buttons lost the span the ladder collapses");
  assert.match(html, /aria-describedby/, "a collapsed launcher would have no sentence left");

  // Foreman's word likewise, plus the mark it is drawn as once the word is gone. Without the
  // mark the button collapses to an empty box.
  const railed = renderToStaticMarkup(
    createElement(ConsoleDetail, { session: mkSession(), view: mkSessionView(mkSession()) }),
  );
  assert.match(railed, /fr-word/, "the Foreman rail lost the span rung 3 collapses");
  assert.match(railed, /fr-mark/, "the Foreman rail has no mark left to draw once its word goes");
});

test("the fit runs after every render, not only on mount", () => {
  // This row's requirement is a function of its CONTENT, and its content is the session: the
  // Foreman slot swaps between three shapes over SSE, the queue tab grows a pip, and the next
  // session in the rail brings a different agent's name to the launcher. A mount-only fit is
  // correct exactly until the first server event.
  const at = detail.indexOf("fitDetailTabs(tabsRef.current)");
  assert.notEqual(at, -1, "ConsoleDetail no longer fits its tab row on render");
  assert.notEqual(
    detail.lastIndexOf("useLayoutEffect", at),
    -1,
    "the per-render fit is not in a useLayoutEffect, so it lands after paint",
  );
  assert.match(
    detail.slice(at, detail.indexOf("\n\n", at)),
    /\}\);/,
    "the per-render fit grew a dependency array - it must run after EVERY render",
  );
  assert.match(
    detail,
    /observeDetailTabs\(tabsRef\.current\)/,
    "nothing watches the row for a resize, which is the only signal a render cannot give",
  );
});
