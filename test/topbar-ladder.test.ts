/**
 * What is at stake: the topbar is the desktop shell's title bar, and its height is
 * published as `--topbar-h` for every full-height surface beneath it. Its only responsive
 * strategy used to be `flex-wrap`, which sheds one control at a time onto ragged extra
 * rows - the bar grew from 110px to 191px between a maximised window and half a screen,
 * and everything under it shrank by however much the bar had chosen to sprawl.
 *
 * The replacement is a five-rung `@container` ladder, and it has three failure modes that
 * are all completely silent - no console, no compile error, and a diff that reads fine:
 *
 * 1. `.topbar` stops declaring a container. Every `@container topbar` rule below is then
 *    dead, the bar reverts to wrapping, and nothing says so.
 * 2. A rung is authored ABOVE the base rule it overrides. `@container` adds no
 *    specificity, so source order alone decides - `.filter-input { width: 150px }` after
 *    the rung that zeroes it simply wins. This one bit during development: the pulse
 *    collapsed and the filter did not.
 * 3. A rung sheds a label with `display: none`. The bar looks right and every collapsed
 *    control loses its accessible name at the same time, turning a narrow window into a
 *    row of unnamed icons.
 *
 * Driven from source for the reason `topbar-popover-dismiss.test.ts` gives: App sits
 * behind an SSE stream that hangs headless automation, and there is no jsdom here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CSS_PATH = fileURLToPath(new URL("../src/web/styles.css", import.meta.url));
const css = readFileSync(CSS_PATH, "utf8");
const app = readFileSync(fileURLToPath(new URL("../src/web/App.tsx", import.meta.url)), "utf8");

/** Comments discuss `display: none` and container widths in prose, so they go first. */
const bare = css.replace(/\/\*[\s\S]*?\*\//g, " ");

interface Rung {
  /** The rung's `max-width`, in px. */
  width: number;
  /** Index in `bare` where the rung's `@container` opens, and where its `}` closes. */
  at: number;
  end: number;
  /** The rules inside it, as `[selector, body]` pairs. */
  rules: [string, string][];
}

/**
 * The ladder's rungs, each with its own rules - by brace matching, not by slicing to the
 * end of the file. `@container` bodies are rules-inside-rules, so the flat `[^{}]*` pass
 * the other CSS tests use cannot read them, and slicing from the first rung to EOF sweeps
 * in every unrelated rule below the topbar section (which is how the first draft of this
 * file "found" `display: none` on the files toolbar).
 */
function ladder(source: string): Rung[] {
  const out: Rung[] = [];
  const re = /@container topbar \(max-width: (\d+)px\)\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < source.length && depth > 0) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") depth--;
      i++;
    }
    assert.equal(depth, 0, `unbalanced braces in the ${m[1]}px rung`);
    const body = source.slice(start, i - 1);
    const rules = [...body.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
      ([, s = "", b = ""]) => [s.trim().replace(/\s+/g, " "), b] as [string, string],
    );
    out.push({ width: Number(m[1]), at: m.index, end: i, rules });
  }
  return out;
}

const RUNGS = ladder(bare);

/** The properties a declaration block sets, e.g. `width`, `display`. */
function props(body: string): string[] {
  return [...body.matchAll(/(^|;)\s*([a-z-]+)\s*:/g)].map((m) => m[2]!);
}

test("the bar actually declares the container every rung queries", () => {
  // Without this the whole ladder is inert and the bar silently goes back to wrapping.
  const topbar = bare.slice(bare.indexOf(".topbar {"));
  assert.match(
    topbar.slice(0, topbar.indexOf("}")),
    /container(-type)?:[^;]*inline-size/,
    "`.topbar` no longer declares an inline-size container - every @container rung below it is dead",
  );
  assert.match(
    topbar.slice(0, topbar.indexOf("}")),
    /container:\s*topbar\b/,
    "the container's NAME must stay `topbar`; the rungs query it by name",
  );
});

test("the rungs are ordered widest-first, and each one is reachable", () => {
  assert.ok(RUNGS.length >= 2, "the ladder is gone");
  for (let i = 1; i < RUNGS.length; i++) {
    // Not merely a tidiness rule: rungs stack, so one authored out of order either fires
    // before the state it was measured against or is masked by a wider one entirely.
    assert.ok(
      RUNGS[i]!.width < RUNGS[i - 1]!.width,
      `rung ${RUNGS[i]!.width}px comes after ${RUNGS[i - 1]!.width}px - the ladder must descend`,
    );
  }
});

test("no rung is overridden by the base rule it is trying to beat", () => {
  // `@container` contributes NO specificity, so between an identical selector inside a rung
  // and one outside it, SOURCE ORDER alone decides. This is checked per PROPERTY rather
  // than per selector: `.foreman-chip`'s base rule sits far down in the Foreman section and
  // is no problem at all, because it never declares `display`. It is the pair that collides
  // - `.filter-input { width }` in both places - that silently does nothing.
  const outside = [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => !RUNGS.some((r) => m.index! > r.at && m.index! < r.end))
    .map((m) => ({ at: m.index!, sel: m[1]!.trim().replace(/\s+/g, " "), body: m[2]! }));

  for (const rung of RUNGS) {
    for (const [sel, body] of rung.rules) {
      for (const prop of props(body)) {
        const loser = outside.find(
          (r) => r.sel === sel && props(r.body).includes(prop) && r.at > rung.at,
        );
        assert.equal(
          loser,
          undefined,
          `\`${sel} { ${prop} }\` is declared again at index ${loser?.at} - AFTER the ` +
            `${rung.width}px rung that sets it. @container adds no specificity, so the later ` +
            `rule wins and the rung silently does nothing. Move the ladder below it.`,
        );
      }
    }
  }
});

test("a shed label goes visually hidden, never display:none", () => {
  // The line is between hiding a WHOLE control (or region) and hiding the NAME off one that
  // stays on screen. `display: none` on the brand wordmark, the keycap, Foreman's mode chip
  // or the entire pulse takes the pixels and the accessible node together, and leaves
  // nothing behind that a reader could meet unlabelled. `display: none` on a `.tb-label`
  // leaves a live, clickable glyph with no name at all - which is the whole failure mode
  // the ladder is written to avoid, and the one that is invisible in a screenshot.
  const LABELS = /\.tb-label|\.pulse-link-label/;
  for (const rung of RUNGS) {
    for (const [sel, body] of rung.rules) {
      if (!LABELS.test(sel)) continue;
      assert.doesNotMatch(
        body,
        /display:\s*none/,
        `the ${rung.width}px rung hides "${sel}" with display:none. A label must be hidden ` +
          `VISUALLY (position: absolute + clip-path) so the control it names keeps its ` +
          `accessible name and its tooltip.`,
      );
      assert.match(
        body,
        /position:\s*absolute[\s\S]*clip-path:\s*inset\(50%\)|clip-path:\s*inset\(50%\)[\s\S]*position:\s*absolute/,
        `the ${rung.width}px rung's "${sel}" does not use the visually-hidden pattern. ` +
          `Without \`position: absolute\` it still costs width and a flex gap; without the ` +
          `clip it is still drawn.`,
      );
    }
  }
  // And at least the three known label sheds are present, so the test cannot pass by the
  // ladder having quietly stopped collapsing anything.
  const shed = RUNGS.flatMap((r) => r.rules).filter(([s]) => LABELS.test(s));
  assert.ok(shed.length >= 3, `only ${shed.length} label rules left in the ladder`);
});

test("a disconnected pulse keeps its stale figures and review control visible", () => {
  assert.match(
    bare,
    /\.pulse\.is-down \.pulse-seg:not\(\.pulse-link\)\s*\{[^}]*opacity:\s*0\.5/,
    "the disconnected pulse no longer dims its stale figures",
  );
  for (const rung of RUNGS) {
    for (const [sel, body] of rung.rules) {
      const hidesSegment = sel
        .split(",")
        .some((part) =>
          /\.pulse\.is-down \.pulse-seg:not\(\.pulse-link\)\s*$/.test(part.trim()),
        );
      if (!hidesSegment) continue;
      assert.doesNotMatch(
        body,
        /display:\s*none/,
        `the ${rung.width}px rung removes the disconnected pulse's figures and review control`,
      );
    }
  }
});

test("filter compaction keeps the review control visible", () => {
  const rung = RUNGS.find(({ width }) => width === 1270);
  assert.ok(rung, "the filter rung is gone");
  const rules = rung.rules.flatMap(([selectors, body]) =>
    selectors.split(",").map((selector) => ({ selector: selector.trim(), body })),
  );
  const readoutSelectors = rules.filter(({ selector }) =>
    /\.pulse-seg:not\(\.pulse-btn\)$/.test(selector),
  );
  assert.equal(readoutSelectors.length, 2, "filter compaction must cover focus and a held term");
  for (const { body } of readoutSelectors) assert.match(body, /display:\s*none/);

  const hiddenPulse = rules.find(
    ({ selector, body }) => /\.pulse$/.test(selector) && /display:\s*none/.test(body),
  );
  assert.equal(hiddenPulse, undefined, "filter compaction hides the entire pulse");

  const buttonSelectors = rules.filter(({ selector }) => /\.pulse-btn$/.test(selector));
  assert.equal(buttonSelectors.length, 2, "the review control must survive both filter states");
  for (const { body } of buttonSelectors) {
    assert.match(body, /padding:\s*0 9px/);
    assert.match(body, /border-left:\s*none/);
    assert.match(body, /border-radius:\s*999px/);
    assert.doesNotMatch(body, /display:\s*none/);
  }

  const emptyPulseSelectors = rules.filter(({ selector }) =>
    /\.pulse:not\(:has\(\.pulse-btn\)\)$/.test(selector),
  );
  assert.equal(
    emptyPulseSelectors.length,
    2,
    "an empty pulse wrapper must be removed for focus and a held term",
  );
  for (const { body } of emptyPulseSelectors) assert.match(body, /display:\s*none/);
});

test("Dispatch never degrades, and the labels that do are marked", () => {
  const bar = app.slice(app.indexOf('<div className="topbar-actions">'));
  const cluster = bar.slice(0, bar.indexOf("<UsageBar"));
  const dispatch = cluster.slice(cluster.indexOf('className="dispatch-btn"'));
  assert.doesNotMatch(
    dispatch.slice(0, dispatch.indexOf("</button>")),
    /tb-label/,
    "Dispatch took a `.tb-label` - the primary action must keep its word at every width",
  );
  // The three that do shed, so a rung has something to act on.
  for (const btn of ["workflow-nav-btn", "missions-btn"]) {
    const at = cluster.indexOf(btn);
    assert.notEqual(at, -1, `${btn} is gone from the action cluster`);
    assert.match(
      cluster.slice(at, cluster.indexOf("</button>", at)),
      /tb-label/,
      `${btn} lost its \`.tb-label\`, so the ladder can no longer collapse it`,
    );
  }
});

test("a control that keeps only a glyph still says what it is", () => {
  // Every button the ladder strips to an icon has to carry its own name - the visually
  // hidden label covers the ones that have one, an `aria-label` covers the rest.
  const bar = app.slice(app.indexOf('<div className="topbar-actions">'));
  const cluster = bar.slice(0, bar.indexOf("<UsageBar"));
  for (const btn of ["workflow-nav-btn", "missions-btn"]) {
    const at = cluster.indexOf(btn);
    assert.match(
      cluster.slice(at, cluster.indexOf("</button>", at)),
      /aria-label=/,
      `${btn} is drawn as a bare glyph on narrow windows and has no aria-label`,
    );
  }
  const foreman = readFileSync(
    fileURLToPath(new URL("../src/web/components/ForemanBar.tsx", import.meta.url)),
    "utf8",
  );
  // Located by the className EXPRESSION rather than by the literal `foreman-btn$`. That
  // string does match today - the class sits in a template literal, so an interpolation's
  // `$` really does follow it - but it matches by coincidence of the neighbouring syntax,
  // and rewriting the same className any other way would leave this slicing from -1.
  const at = foreman.search(/className=\{[^}]*foreman-btn/);
  assert.notEqual(at, -1, "the Foreman button's className expression is gone");
  const btn = foreman.slice(at, foreman.indexOf("</button>", at));
  assert.notEqual(btn.length, 0, "no button markup followed the className - check the slice");
  assert.match(
    btn,
    /aria-label=/,
    "Foreman's word is a `.tb-label` the ladder takes away; the button needs its own name",
  );
});

test("the pulse opts out of the desktop drag region", () => {
  // Its segments are divs, and on the narrow rungs they are a dot and a figure with the
  // word taken away - so the tooltip is the only thing left saying what "3" counts. A drag
  // region swallows the mouse, so a hover inside one never reaches the renderer at all.
  const rules = [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const optedOut = rules.some(
    ([, selectors = "", body = ""]) =>
      /-webkit-app-region:\s*no-drag/.test(body) &&
      selectors.split(",").some((s) => /\.is-desktop \.topbar \.pulse\s*$/.test(s.trim())),
  );
  assert.ok(optedOut, "`.is-desktop .topbar .pulse` is not in the no-drag list");
});
