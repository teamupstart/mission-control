import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * What is at stake: a board card item is toggleable because it is in ONE registry, and the
 * next one added has to be in it too.
 *
 * `src/web/lib/board-card.ts` holds the ids, the labels and the prose. `SessionTile` gates
 * each optional CARD item on the same ids, `ConsoleDetail` gates each CONVERSATION one, and
 * `BoardCardPanel` draws a checkbox per entry. Any one of those four can be edited without
 * the others and still typecheck, lint, build and pass every rendering test - and the result
 * is an item nobody can turn off, or a checkbox that governs nothing. Neither failure is
 * visible in a diff that adds one line to a 400-line component.
 *
 * So this is a source scan, for the same reason `tooltip-coverage.test.ts` is one: a render
 * test can only check the items a test happens to name, and the failure being prevented
 * here is the item nobody thought about.
 *
 * It also pins the two decisions the registry is NOT allowed to drift on - the attention
 * flags stay compulsory, and the shipped defaults draw exactly the card the previous
 * release drew.
 */

// A fake `localStorage` and a fetch that accepts, installed BEFORE the modules below are
// imported. `uiConfig.ts` seeds its module store synchronously at load from `uiCache`, and
// `updateUiConfig` reverts its optimistic commit when the daemon refuses - so without an
// accepting fetch every toggle in this file would land and then silently undo itself.
const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
});
Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  value: async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
});

const { DISPLAY_GROUP_COPY, DISPLAY_ITEMS, isDisplayItemShown } = await import(
  "../src/web/lib/board-card.ts",
);
const { BoardCardPanel } = await import("../src/web/components/BoardCardPanel.tsx");
const { updateUiConfig } = await import("../src/web/lib/uiConfig.ts");
const { UI_CONFIG_DEFAULTS } = await import("../src/shared/protocol.ts");

function src(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../src/${relative}`, import.meta.url)), "utf8");
}

/** Comments blanked, so prose naming an id is never mistaken for a gate on it. */
function code(relative: string): string {
  return src(relative)
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

const CARD_ITEMS = DISPLAY_ITEMS.filter((item) => item.group === "card");
const CONVERSATION_ITEMS = DISPLAY_ITEMS.filter((item) => item.group === "conversation");

/** React's text escaping, so prose with an apostrophe can be looked for in the markup. */
function escaped(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
}

/** The panel, with a chosen hidden list in force. Restores the shipped default after. */
async function panelWith(hidden: readonly string[]): Promise<string> {
  await updateUiConfig({ hiddenDisplayItems: [...hidden] });
  try {
    return renderToStaticMarkup(createElement(BoardCardPanel));
  } finally {
    await updateUiConfig({
      hiddenDisplayItems: [...UI_CONFIG_DEFAULTS.hiddenDisplayItems],
    });
  }
}

test("every optional item the tile draws is gated on a registry id", () => {
  // The direction that catches a new item shipping un-toggleable: a gate the tile does not
  // have is an item the panel cannot govern.
  const tile = code("web/components/layouts/SessionTile.tsx");
  for (const item of CARD_ITEMS) {
    assert.ok(
      tile.includes(`shown("${item.id}")`),
      `SessionTile draws no gate for the registry item "${item.id}"`,
    );
  }
});

test("the tile invents no gate the registry does not know", () => {
  // The other direction, which catches the typo: `shown("lastseen")` compiles only because
  // the id type would reject it - but a future refactor to a looser signature would not,
  // and an unknown id is permanently visible with no checkbox anywhere.
  const tile = code("web/components/layouts/SessionTile.tsx");
  const known = new Set(CARD_ITEMS.map((item) => item.id as string));
  for (const [, id] of tile.matchAll(/shown\("([^"]+)"\)/g)) {
    assert.ok(known.has(id!), `SessionTile gates on "${id}", which is in no registry entry`);
  }
});

test("the tile holds no second copy of the registry", () => {
  // The registry is the one list. A private array of ids in the tile - or a `hidden.includes`
  // reading the stored config directly - is the second source of truth this whole feature
  // exists to remove, and it would drift on the first item added.
  const tile = code("web/components/layouts/SessionTile.tsx");
  assert.ok(
    tile.includes("useDisplayItems()"),
    "SessionTile no longer reads the shared registry hook",
  );
  assert.ok(
    !tile.includes("hiddenDisplayItems"),
    "SessionTile reads the stored config directly instead of going through the registry",
  );
});

test("every registry item is reachable from the panel", async () => {
  const html = await panelWith([]);
  for (const item of CARD_ITEMS) {
    assert.ok(html.includes(escaped(item.label)), `the panel prints no label for "${item.id}"`);
    assert.ok(
      html.includes(escaped(item.description.slice(0, 40))),
      `the panel prints no description for "${item.id}"`,
    );
  }
});

test("the panel's preview populates every item, so no checkbox looks broken", async () => {
  // The constraint on the fixture, stated as the consequence rather than as field coverage:
  // an item the preview session cannot draw looks identical checked and unchecked, which
  // reads as a dead control rather than as an empty session.
  const shownAll = await panelWith([]);
  for (const item of CARD_ITEMS) {
    const hiddenOne = await panelWith([item.id]);
    assert.notEqual(
      hiddenOne,
      shownAll,
      `unchecking "${item.id}" changes nothing in the preview - the fixture does not populate it`,
    );
  }
});

test("hiding an item leaves no trace of it in the preview", async () => {
  // Not merely "different": the fact itself is gone, rather than dimmed or emptied.
  const goalText = "Make the parser accept trailing commas";
  assert.ok((await panelWith([])).includes(escaped(goalText)));
  assert.ok(!(await panelWith(["goal"])).includes(escaped(goalText)));

  const worktreeLeaf = "parser-fix";
  assert.ok((await panelWith([])).includes(worktreeLeaf));
  assert.ok(!(await panelWith(["worktree"])).includes(worktreeLeaf));
});

test("the shipped default hides the worktree and nothing else", () => {
  // D2, at its narrowest. Every other id names something a card already drew, so its
  // absence from this list is what makes an upgrade move nothing on screen; `worktree` is
  // the one item that is new to the card, so it ships off and the operator opts in.
  assert.deepEqual([...UI_CONFIG_DEFAULTS.hiddenDisplayItems], ["worktree"]);
  for (const item of CARD_ITEMS) {
    assert.equal(
      isDisplayItemShown(UI_CONFIG_DEFAULTS.hiddenDisplayItems, item.id),
      item.id !== "worktree",
      `"${item.id}" does not ship in the state the previous release drew`,
    );
  }
});

test("the attention flags are not customizable", () => {
  // D3, pinned from the registry's side. `.tile-marks` means "things that want your
  // attention", and no setting may make a session that needs you look like one that does
  // not. Each of those flags already draws nothing when it has nothing to say.
  const forbidden = ["note", "review", "queue", "pr", "inspector", "schedule", "ensemble",
    "marks", "flags", "held", "agent", "name", "state", "tone"];
  const ids = new Set(DISPLAY_ITEMS.map((item) => item.id as string));
  for (const id of forbidden) {
    assert.ok(!ids.has(id), `"${id}" is pinned always-on and must not be in the registry`);
  }
  // And from the tile's side: no gate may wrap the marks row or the identity above it.
  const tile = code("web/components/layouts/SessionTile.tsx");
  assert.match(tile, /<span className="tile-marks">/);
  assert.ok(
    !/shown\([^)]*\)\s*&&\s*\(?\s*<span className="tile-marks"/.test(tile),
    "the attention-flag row has been made optional",
  );
});

test("registry ids are unique, and both groups carry entries", () => {
  const ids = DISPLAY_ITEMS.map((item) => item.id as string);
  assert.equal(new Set(ids).size, ids.length, "two registry entries share an id");
  // One array, two groups. The console detail's band joined as ENTRIES rather than as a
  // second config key, which is why it needed no schema field and no migration - and the
  // panel sections by whatever groups it finds, so a third surface adds a third value here
  // and is sectioned without the panel being touched.
  assert.deepEqual([...new Set(DISPLAY_ITEMS.map((item) => item.group))], [
    "card",
    "conversation",
  ]);
  assert.ok(CONVERSATION_ITEMS.length > 0, "the conversation group lost its entries");
});

test("no two items announce the same name", () => {
  // A checkbox inside a `<label>` takes its explicit `aria-label` as its whole accessible
  // name, so two items sharing a label are two controls a screen reader cannot tell apart -
  // and that `getByRole("checkbox", { name })` cannot address either. The card's "Branch"
  // and the console band's branch are exactly that collision, which is why the latter is
  // "Git branch".
  const labels = DISPLAY_ITEMS.map((item) => item.label);
  assert.equal(new Set(labels).size, labels.length, "two registry entries share a label");
});

test("the conversation band's two cells are the conversation group, and are their own switches", () => {
  // Named exactly, because the pair is the whole feature: `detailPath` and `detailBranch`
  // are DISTINCT from the card's `worktree` and `branch`. Coupling either pair would make
  // one checkbox mean two surfaces, with no way to express "the path on the card and not
  // over the conversation" - or "neither".
  assert.deepEqual(CONVERSATION_ITEMS.map((item) => item.id), ["detailPath", "detailBranch"]);
  const ids = new Set(DISPLAY_ITEMS.map((item) => item.id as string));
  assert.ok(ids.has("branch") && ids.has("worktree"), "the card's own pair has been renamed");
});

test("each conversation cell is gated on its own registry id in ConsoleDetail", () => {
  // The same direction the tile scan above runs in: a cell whose id nothing gates is an
  // item the panel cannot govern, and that is invisible in a diff of a 900-line component.
  const detail = code("web/components/layouts/ConsoleDetail.tsx");
  for (const item of CONVERSATION_ITEMS) {
    assert.ok(
      detail.includes(`shown("${item.id}")`),
      `ConsoleDetail draws no gate for the registry item "${item.id}"`,
    );
  }
  const known = new Set(CONVERSATION_ITEMS.map((item) => item.id as string));
  for (const [, id] of detail.matchAll(/shown\("([^"]+)"\)/g)) {
    assert.ok(known.has(id!), `ConsoleDetail gates on "${id}", which is in no conversation entry`);
  }
});

test("ConsoleDetail holds no second copy of the registry", () => {
  const detail = code("web/components/layouts/ConsoleDetail.tsx");
  assert.ok(
    detail.includes("useDisplayItems()"),
    "ConsoleDetail no longer reads the shared registry hook",
  );
  assert.ok(
    !detail.includes("hiddenDisplayItems"),
    "ConsoleDetail reads the stored config directly instead of going through the registry",
  );
});

test("both conversation cells ship visible", () => {
  // D2 for this phase's half. The band is byte-identical to the previous release on a
  // profile that has never opened this panel, which is what keeps the three e2e specs that
  // read `.detail-sub` unmodified.
  for (const item of CONVERSATION_ITEMS) {
    assert.ok(
      isDisplayItemShown(UI_CONFIG_DEFAULTS.hiddenDisplayItems, item.id),
      `"${item.id}" does not ship visible`,
    );
  }
});

test("every conversation item is reachable from the panel, under its own heading", async () => {
  const html = await panelWith([]);
  for (const item of CONVERSATION_ITEMS) {
    assert.ok(html.includes(escaped(item.label)), `the panel prints no label for "${item.id}"`);
    assert.ok(
      html.includes(escaped(item.description.slice(0, 40))),
      `the panel prints no description for "${item.id}"`,
    );
  }
  // Two groups means two sections, and a section that does not name itself is a list of
  // checkboxes an operator cannot tell apart from the one above it.
  assert.ok(html.includes("Board card"), "the card section lost its heading");
  assert.ok(html.includes("Conversation header"), "the conversation section lost its heading");
});

test("the conversation section says the height is conditional rather than promising it", async () => {
  // The review's second requirement, pinned where an editor would see it. The band also
  // hosts a task's chip and its pull requests, so hiding both cells collapses it only when
  // nothing else is in it - and a preference that promises height unconditionally is a bug
  // report waiting to be filed.
  const html = await panelWith([]);
  const blurb = DISPLAY_GROUP_COPY.conversation.blurb;
  assert.ok(html.includes(escaped(blurb)), "the conversation section prints no blurb");
  assert.match(blurb, /not always|only collapses|when nothing else/i);
});

test("the preview mounts the real tile rather than a picture of one", () => {
  const panel = code("web/components/BoardCardPanel.tsx");
  assert.ok(panel.includes("<SessionTile"), "the preview no longer mounts SessionTile");
  // And it is unreachable, because the session behind it does not exist. `inert` is what
  // stops its stretched open button, its pickers and its workflow disclosure from being
  // clicked or tabbed into.
  assert.match(panel, /className="board-card-preview-stage" inert/);
});
