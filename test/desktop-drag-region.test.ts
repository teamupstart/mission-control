/**
 * What is at stake: in the desktop shell the topbar IS the title bar, so it carries
 * `-webkit-app-region: drag`. That region is built by the compositor out of element
 * geometry, and the initial value of the property is `none`, not `no-drag` - only an
 * explicit `no-drag` subtracts from it. A layer painted OVER the bar therefore does not
 * take its own clicks back: the OS keeps the mousedown and the renderer never sees it.
 *
 * The failure is silent and looks like flakiness rather than a rectangle, because the
 * bar's height varies (the foldable usage row, and wrapping on a narrow window). It cost
 * the settings and dispatch modals their ✕ and the alerts popover its top strip - each
 * hovering correctly and refusing to fire, with nothing in the console.
 *
 * So the no-drag list in `styles.css` is not allowed to fall behind the floating layers.
 * Every rule that floats a layer out of flow has to be covered by it or exempted here
 * with a reason, and the exemption has to still be true.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CSS_PATH = fileURLToPath(new URL("../src/web/styles.css", import.meta.url));
const css = readFileSync(CSS_PATH, "utf8");

/** Comments carry `position: fixed` in prose, so they go before anything is parsed. */
const bare = css.replace(/\/\*[\s\S]*?\*\//g, " ");

interface Rule {
  selectors: string[];
  body: string;
}

function rules(source: string): Rule[] {
  const out: Rule[] = [];
  // styles.css has no preprocessor and no nesting, so the flat pass is exact. `@media`
  // blocks arrive as a rule whose "body" is more rules; their inner rules match too,
  // which is what we want, and the wrapper itself declares nothing.
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const selectors = (m[1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/\s+/g, " "))
      .filter(Boolean);
    out.push({ selectors, body: m[2] ?? "" });
  }
  return out;
}

const ALL = rules(bare);

/** The class tokens a selector mentions, so `.alert-pop.mode-pop` matches `.alert-pop`. */
function classesIn(selector: string): string[] {
  return [...selector.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((m) => m[1] as string);
}

const noDragClasses = new Set(
  ALL.filter((r) => /-webkit-app-region:\s*no-drag/.test(r.body))
    .flatMap((r) => r.selectors)
    .flatMap(classesIn),
);

/**
 * Layers that float over the bar but cannot take a click, so they have nothing to lose
 * to the drag region. Each needs the property that makes it inert to still hold - the
 * assertion below re-checks it rather than trusting the comment.
 */
const EXEMPT: Record<string, { because: string; declares: RegExp }> = {
  tooltip: {
    because: "pointer-events: none - it never receives a click to begin with",
    declares: /pointer-events:\s*none/,
  },
};

test("the desktop shell still makes the topbar the draggable title bar", () => {
  // The premise of every other assertion here. If the shell ever gets a native title
  // bar back, this file is the thing that should be deleted, loudly and on purpose.
  const dragRules = ALL.filter((r) => /-webkit-app-region:\s*drag\b/.test(r.body));
  assert.deepEqual(
    dragRules.flatMap((r) => r.selectors),
    [".is-desktop .topbar"],
    "the drag region moved or multiplied; the covered list below is scoped to the topbar",
  );
});

test("every floating layer cancels the topbar's drag region", () => {
  const topbarZ = 10; // `.topbar { z-index: 10 }` - anything above it can paint over the bar.
  const uncovered: string[] = [];

  for (const rule of ALL) {
    const floats =
      /position:\s*fixed/.test(rule.body) ||
      Number(/z-index:\s*(-?\d+)/.exec(rule.body)?.[1] ?? "0") > topbarZ;
    if (!floats) continue;

    for (const selector of rule.selectors) {
      const classes = classesIn(selector);
      if (classes.some((c) => noDragClasses.has(c))) continue;

      const exempt = classes.map((c) => EXEMPT[c]).find(Boolean);
      if (exempt) {
        assert.match(
          rule.body,
          exempt.declares,
          `"${selector}" is exempt because ${exempt.because}, but no longer declares it`,
        );
        continue;
      }
      uncovered.push(selector);
    }
  }

  assert.deepEqual(
    uncovered,
    [],
    "these float over the topbar with no `-webkit-app-region: no-drag`, so the OS eats " +
      "their clicks in the desktop shell. Add them to the `.is-desktop` no-drag rule in " +
      "styles.css, or exempt them here with the reason they cannot be clicked.",
  );
});
