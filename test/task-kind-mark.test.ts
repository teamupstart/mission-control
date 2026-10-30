import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AnyDisplayChoice, DisplayChoice } from "../src/web/lib/board-card.ts";

/**
 * A task's kind, marked on both surfaces in the style the operator chose.
 *
 * The kind used to print only when it was not `ship`, and only in the console's PATH and
 * BRANCH band, so the most common kind was printed nowhere and no Board card said what kind
 * of task it was. Every kind is now marked - `ship` included - by `TaskKindMark`, in one of
 * four styles per surface or `off` (Settings > Display; mockups in
 * `docs/plans/task-kind-visibility/mockups.html`).
 *
 * `createElement` rather than JSX because the runner's glob only matches .test.ts.
 */

// A fake `localStorage` and a fetch that accepts, installed BEFORE the modules below are
// imported, for the reason `board-card-items.test.ts` gives: `updateUiConfig` reverts its
// optimistic commit when the daemon refuses, so without an accepting fetch every style set
// here would land and then silently undo itself.
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

const { ConsoleDetail } = await import("../src/web/components/layouts/ConsoleDetail.tsx");
const { SessionTile } = await import("../src/web/components/layouts/SessionTile.tsx");
const { BoardCardPanel } = await import("../src/web/components/BoardCardPanel.tsx");
const { TaskKindIcon } = await import("../src/web/components/TaskKindMark.tsx");
const { ConversationHeaderPreview } = await import("../src/web/components/ConversationHeaderPreview.tsx");
const { DISPLAY_CHOICES, setDisplayChoice } = await import("../src/web/lib/board-card.ts");
const { updateUiConfig } = await import("../src/web/lib/uiConfig.ts");
const { TASK_KIND_CARD_STYLES, TASK_KIND_HEADER_STYLES, UI_CONFIG_DEFAULTS } = await import(
  "../src/shared/protocol.ts"
);
const { TASK_KIND_INFO } = await import("../src/shared/task.ts");
const { TASK_KINDS } = await import("../src/shared/types.ts");
const { mkSession, mkTaskSummary } = await import("./helpers/session-fixture.ts");
const { mkSessionView } = await import("./helpers/session-view.ts");

type Session = ReturnType<typeof mkSession>;
type HeaderStyle = (typeof TASK_KIND_HEADER_STYLES)[number];
type CardStyle = (typeof TASK_KIND_CARD_STYLES)[number];

/** A dispatched ship task, named after its task the way a dispatch names it. */
function shipSession(over: Partial<Session> = {}): Session {
  const task = mkTaskSummary({ kind: "ship" });
  return mkSession({ name: task.title, task, ...over });
}

async function withStyles<T>(
  styles: { header?: HeaderStyle; card?: CardStyle },
  fn: () => T,
): Promise<T> {
  await updateUiConfig({
    taskKindHeader: styles.header ?? UI_CONFIG_DEFAULTS.taskKindHeader,
    taskKindCard: styles.card ?? UI_CONFIG_DEFAULTS.taskKindCard,
  });
  try {
    return fn();
  } finally {
    await updateUiConfig({
      taskKindHeader: UI_CONFIG_DEFAULTS.taskKindHeader,
      taskKindCard: UI_CONFIG_DEFAULTS.taskKindCard,
    });
  }
}

function detail(session: Session): string {
  return renderToStaticMarkup(createElement(ConsoleDetail, { session, view: mkSessionView(session) }));
}

function tile(session: Session): string {
  return renderToStaticMarkup(
    createElement(SessionTile, {
      session,
      onOpen: () => {},
      draggingRepo: null,
      onDropped: () => {},
      onDropError: () => {},
      onDropConfirm: () => {},
    }),
  );
}

/** The markup between an element's opening tag (found by `marker`) and the next `until`. */
function region(html: string, marker: string, until: string): string {
  const start = html.indexOf(marker);
  assert.ok(start >= 0, `no ${marker} in the render`);
  return html.slice(start, html.indexOf(until, start + marker.length));
}

test("the shipped styles are the ones chosen from the mockups", () => {
  assert.equal(UI_CONFIG_DEFAULTS.taskKindHeader, "badge");
  assert.equal(UI_CONFIG_DEFAULTS.taskKindCard, "tab");
});

test("a ship task is marked in the console header by default, as a badge on the name's line", async () => {
  const html = await withStyles({}, () => detail(shipSession()));
  const line = region(html, 'class="detail-title-line"', "</h2>");
  assert.match(line, /class="tk-mark tk-badge"[^>]*>.*?<\/svg><span class="tk-label">ship<\/span>/);
  assert.ok(line.indexOf("tk-badge") < line.indexOf("<h2"), "the badge does not lead the name");
});

test("each header style puts the mark in its own place, and only there", async () => {
  const where: Record<Exclude<HeaderStyle, "off">, [string, string]> = {
    badge: ['class="detail-title-line"', "</h2>"],
    eyebrow: ['class="detail-title"', 'class="detail-title-line"'],
    tile: ['class="detail-head tk-edge"', 'class="detail-title"'],
    tabs: ['class="detail-tabs"', "<button"],
  };
  for (const style of TASK_KIND_HEADER_STYLES) {
    const html = await withStyles({ header: style }, () => detail(shipSession()));
    const marks = html.match(/class="tk-mark /g) ?? [];
    if (style === "off") {
      assert.equal(marks.length, 0, "off still marks the kind");
      continue;
    }
    assert.equal(marks.length, 1, `${style} marks the kind ${marks.length} times`);
    const [from, to] = where[style];
    assert.ok(region(html, from, to).includes(`tk-mark tk-${style}`), `${style} is not where it belongs`);
  }
});

test("the Display preview puts each header style where the console header puts it", async () => {
  // The preview draws the console header in its own classes rather than mounting
  // `ConsoleDetail`, so this is what stops the two from drifting apart: every style is looked
  // for in the same region of both renders. The tab strip's region ends at its first tab's
  // label, because the console's tabs are buttons and the preview's are not.
  const where: Record<Exclude<HeaderStyle, "off">, [string, string]> = {
    badge: ['class="detail-title-line"', "</h2>"],
    eyebrow: ['class="detail-title"', 'class="detail-title-line"'],
    tile: ['class="detail-head tk-edge"', 'class="detail-title"'],
    tabs: ['class="detail-tabs"', "Conversation"],
  };
  const session = shipSession();
  for (const style of TASK_KIND_HEADER_STYLES) {
    const console = await withStyles({ header: style }, () => detail(session));
    const preview = renderToStaticMarkup(
      createElement(ConversationHeaderPreview, {
        session,
        kindStyle: style,
        showPath: true,
        showBranch: true,
      }),
    );
    const marks = preview.match(/class="tk-mark /g) ?? [];
    if (style === "off") {
      assert.equal(marks.length, 0, "off still marks the kind in the preview");
      continue;
    }
    assert.equal(marks.length, 1, `${style} marks the kind ${marks.length} times in the preview`);
    const [from, to] = where[style];
    for (const [surface, html] of [["console", console], ["preview", preview]] as const) {
      assert.ok(region(html, from, to).includes(`tk-mark tk-${style}`), `${style} is misplaced in the ${surface}`);
    }
  }
  const tile = renderToStaticMarkup(
    createElement(ConversationHeaderPreview, { session, kindStyle: "tile", showPath: true, showBranch: true }),
  );
  assert.ok(
    region(tile, 'class="tk-mark tk-tile"', 'class="detail-title"').includes('class="agent-dot"'),
    "the preview's tile dropped which harness this is",
  );
});

test("the tile style keeps the agent dot, riding the tile's corner", async () => {
  const html = await withStyles({ header: "tile" }, () => detail(shipSession()));
  const mark = region(html, 'class="tk-mark tk-tile"', 'class="detail-title"');
  assert.ok(mark.includes('class="agent-dot"'), "the tile dropped which harness this is");
  assert.ok(mark.includes('role="img"') && mark.includes('aria-label="ship task"'));
});

test("every kind draws its own icon, so no two kinds share a glyph", () => {
  // The rendered SVG, not the source record: a refactor that pointed every kind at one glyph
  // would still compile against `Record<TaskKind, ...>`, and would leave the colour and word
  // tests green while every mark looked the same.
  const glyphs = TASK_KINDS.map((kind) =>
    renderToStaticMarkup(createElement(TaskKindIcon, { kind })).replace(/^<svg[^>]*>|<\/svg>$/g, ""),
  );
  for (const [i, glyph] of glyphs.entries()) {
    assert.match(glyph, /<(path|circle|rect)\b/, `${TASK_KINDS[i]} draws no glyph at all`);
  }
  assert.equal(new Set(glyphs).size, TASK_KINDS.length, "two kinds draw the same icon");
});

test("every kind is marked in its own colour, with its own word", async () => {
  for (const kind of TASK_KINDS) {
    const task = mkTaskSummary({ kind });
    const html = await withStyles({}, () => detail(mkSession({ name: task.title, task })));
    const badge = region(html, 'class="tk-mark tk-badge"', "</span>");
    assert.ok(badge.includes(`--kind:${TASK_KIND_INFO[kind].accent}`), `${kind} is not in its colour`);
    assert.match(html, new RegExp(`</svg><span class="tk-label">${TASK_KIND_INFO[kind].label}</span>`));
  }
});

test("a session with no task draws no kind on either surface", async () => {
  const session = mkSession({ task: null });
  assert.ok(!(await withStyles({}, () => detail(session))).includes("tk-mark"));
  assert.ok(!(await withStyles({}, () => tile(session))).includes("tk-mark"));
});

test("every kind's card carries its own word, icon and colour on its top-edge tab", async () => {
  // All six kinds, not just the two the browser spec dispatches: a card that dropped or
  // mislabelled bugfix, plan, pipeline or chat would otherwise pass. The icon is compared
  // with the kind's own rendered icon, so a tab drawing another kind's glyph fails too.
  for (const kind of TASK_KINDS) {
    const task = mkTaskSummary({ kind });
    const html = await withStyles({}, () => tile(mkSession({ name: task.title, task })));
    const tab = region(html, 'class="tk-mark tk-tab"', "</span>");
    const info = TASK_KIND_INFO[kind];
    assert.ok(tab.includes(`--kind:${info.accent}`), `the ${kind} tab is not in its colour`);
    const icon = renderToStaticMarkup(createElement(TaskKindIcon, { kind, size: 10 }));
    assert.ok(tab.includes(icon), `the ${kind} tab does not draw the ${kind} icon`);
    assert.match(tab, new RegExp(`</svg>${info.label}$`), `the ${kind} tab does not say ${info.label}`);
    assert.equal((html.match(/class="tk-mark /g) ?? []).length, 1, `the ${kind} card is marked more than once`);
  }
});

test("a ship card is marked by default with a tab on its top edge", async () => {
  const html = await withStyles({}, () => tile(shipSession()));
  assert.match(html, /class="tile [^"]*has-kind-tab/);
  assert.match(html, /class="tk-mark tk-tab"[^>]*>.*?<\/svg>ship<\/span>/);
  assert.ok(html.indexOf("tk-tab") < html.indexOf('class="tile-head"'), "the tab is not first");
});

test("each card style puts the mark in its own place, and only there", async () => {
  for (const style of TASK_KIND_CARD_STYLES) {
    const html = await withStyles({ card: style }, () => tile(shipSession()));
    const marks = html.match(/class="tk-mark /g) ?? [];
    if (style === "off") {
      assert.equal(marks.length, 0, "off still marks the kind");
      assert.ok(!html.includes("has-kind-tab"));
      continue;
    }
    assert.equal(marks.length, 1, `${style} marks the kind ${marks.length} times`);
    const head = region(html, 'class="tile-head"', 'class="tile-name"');
    const inHead = head.includes(`tk-mark tk-${style}`);
    assert.equal(inHead, style === "chip" || style === "medallion", `${style} is in the wrong row`);
  }
});

test("the medallion keeps the agent dot and names the kind it only draws", async () => {
  const html = await withStyles({ card: "medallion" }, () => tile(shipSession()));
  const mark = region(html, 'class="tk-mark tk-medallion"', 'class="tile-name"');
  assert.ok(mark.includes('class="agent-dot"'));
  assert.ok(mark.includes('aria-label="ship task"'));
});

test("a display choice accepts only its own surface's styles, at compile time", () => {
  // Checked by `npm run typecheck`, which covers this file: each line below must FAIL to
  // compile, and `@ts-expect-error` turns a line that starts compiling into an error. That is
  // what stops a future edit pairing the card's key with a header style, which the picker would
  // then submit as a preference the daemon refuses. Never called, so nothing is written.
  const misuse = (): void => {
    // @ts-expect-error - "badge" is a conversation-header style, not a board-card one
    setDisplayChoice("taskKindCard", "badge");
    // @ts-expect-error - "tab" is a board-card style, not a conversation-header one
    setDisplayChoice("taskKindHeader", "tab");
  };
  // @ts-expect-error - a card choice cannot offer a header style
  const crossed: DisplayChoice<"taskKindCard"> = { key: "taskKindCard", group: "card", label: "", description: "", options: [{ id: "eyebrow", label: "", description: "" }] };
  // @ts-expect-error - nor can a registry entry pair the two
  const entry: AnyDisplayChoice = { key: "taskKindHeader", group: "conversation", label: "", description: "", options: [{ id: "medallion", label: "", description: "" }] };
  // The correct pairings compile, and the registry holds exactly them.
  const fine = (): void => {
    setDisplayChoice("taskKindCard", "band");
    setDisplayChoice("taskKindHeader", "eyebrow");
  };
  void [misuse, crossed, entry, fine];
  assert.deepEqual(
    DISPLAY_CHOICES.map((choice) => choice.key).sort(),
    ["taskKindCard", "taskKindHeader"],
  );
});

test("the Display panel offers every style for both surfaces, and the card preview follows the card's", async () => {
  for (const choice of DISPLAY_CHOICES) {
    const styles = choice.key === "taskKindHeader" ? TASK_KIND_HEADER_STYLES : TASK_KIND_CARD_STYLES;
    assert.deepEqual(choice.options.map((o) => o.id), [...styles]);
  }
  const panel = await withStyles({}, () => renderToStaticMarkup(createElement(BoardCardPanel)));
  for (const choice of DISPLAY_CHOICES) {
    for (const option of choice.options) {
      assert.ok(panel.includes(`>${option.label}</label>`), `the panel does not offer ${option.label}`);
    }
  }
  assert.match(panel, /name="display-choice-taskKindCard" checked="" value="tab"/);
  assert.match(panel, /name="display-choice-taskKindHeader" checked="" value="badge"/);
  assert.ok(panel.includes("tk-mark tk-tab"), "the preview card is not marked with the default tab");

  const banded = await withStyles({ card: "band" }, () =>
    renderToStaticMarkup(createElement(BoardCardPanel)),
  );
  assert.ok(banded.includes("tk-mark tk-band") && !banded.includes("tk-mark tk-tab"));
});
