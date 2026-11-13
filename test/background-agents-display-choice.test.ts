import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SubagentEntry, SubagentSummary } from "../src/shared/types.ts";

/**
 * Phase 3 of background sub-agent visibility: Settings > Display > Board card > Background
 * sub-agents, the one radio that picks Nested sub-cards (the default) or Chip and popover for
 * the board card and the conversation together.
 *
 * The browser spec (`e2e/specs/background-agents-display-choice.spec.ts`) switches it live and
 * opens the popover; these pin what a browser cannot isolate: the persisted key's parse and
 * fallback on both sides of the wire, its backup class, the picker entry, and the exact markup
 * each treatment draws on each surface.
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

const { BACKGROUND_AGENTS_STYLES, UI_CONFIG_DEFAULTS, UiConfigPatchSchema, UiConfigSchema } = await import(
  "../src/shared/protocol.ts"
);
const { APP_CONFIG_ENTRIES } = await import("../src/shared/app-config-entries.ts");
const { settingPayloadForEntry } = await import("../src/server/settings-backups/config-registry.ts");
const { DISPLAY_CHOICES } = await import("../src/web/lib/board-card.ts");
const { SETTINGS_CONTROLS } = await import("../src/web/lib/settings-search.ts");
const { updateUiConfig } = await import("../src/web/lib/uiConfig.ts");
const { previewSession, PREVIEW_RESIDENT } = await import("../src/web/lib/board-card-preview.ts");
const { ResidentVisitorCard } = await import("../src/web/residents/ResidentVisitorCard.tsx");
const { BoardCardPanel } = await import("../src/web/components/BoardCardPanel.tsx");
const { SessionTile } = await import("../src/web/components/layouts/SessionTile.tsx");
const { SubagentChip, subagentChipLabel } = await import("../src/web/components/layouts/SubagentChip.tsx");
const { ConversationActivity, agentsTabDetail } = await import("../src/web/components/ConversationActivity.tsx");
const { TranscriptPanel } = await import("../src/web/components/TranscriptPanel.tsx");
const { resetHistories, seedTail } = await import("../src/web/lib/transcript-history.ts");
const { mkSession } = await import("./helpers/session-fixture.ts");

type Style = (typeof BACKGROUND_AGENTS_STYLES)[number];

function agent(over: Partial<SubagentEntry> & { id: string }): SubagentEntry {
  return {
    type: "Explore",
    description: `Agent ${over.id}`,
    state: "running",
    startedAt: 1_000,
    endedAt: null,
    toolUses: null,
    tokens: null,
    lastTool: null,
    summary: null,
    launchTurnId: null,
    ...over,
  };
}

/** The plan's sample: two running, one finished. */
const SAMPLE: SubagentSummary = {
  agents: [
    agent({ id: "a1", description: "Map every offset-pagination call site", toolUses: 18, tokens: 41_000, lastTool: "Grep" }),
    agent({ id: "a2", type: "general-purpose", description: "Convert billing report queries", toolUses: 6, tokens: 12_000, lastTool: "Edit" }),
    agent({ id: "a3", description: "Find contract tests for /ledger", state: "completed", endedAt: 66_000, toolUses: 9, tokens: 22_000 }),
  ],
  finishedFolded: 0,
};

async function withStyle<T>(style: Style, fn: () => T): Promise<T> {
  await updateUiConfig({ backgroundAgentsStyle: style });
  try {
    return fn();
  } finally {
    await updateUiConfig({ backgroundAgentsStyle: UI_CONFIG_DEFAULTS.backgroundAgentsStyle });
  }
}

function tile(subagents?: SubagentSummary): string {
  return renderToStaticMarkup(
    createElement(SessionTile, {
      session: mkSession({ name: "Ledger", state: "idle", ...(subagents ? { subagents } : {}) }),
      onOpen: () => {},
      draggingRepo: null,
      onDropped: () => {},
      onDropError: () => {},
      onDropConfirm: () => {},
    }),
  );
}

function panel(subagents?: SubagentSummary): string {
  resetHistories();
  seedTail("s1", {
    messages: [{ id: "m0", role: "user", text: "move the ledger", tools: [], ts: 0 }],
    start: 0,
    atStart: true,
    pos: 10,
  });
  return renderToStaticMarkup(
    createElement(TranscriptPanel, {
      session: mkSession({ id: "s1", ...(subagents ? { subagents } : {}) }),
      canSend: true,
    }),
  );
}

function rail(props: { subagents?: SubagentSummary | null; tab?: "activity" | "yours" | "agents"; collapsed?: boolean }): string {
  return renderToStaticMarkup(
    createElement(ConversationActivity, {
      messages: [],
      open: true,
      onToggle: () => {},
      tab: props.tab ?? "activity",
      onTab: () => {},
      selectedTurnId: null,
      onSelectTurn: () => {},
      collapsed: props.collapsed ?? false,
      onCollapsed: () => {},
      subagents: props.subagents ?? null,
    }),
  );
}

/** The `.tile-marks` row of a rendered tile. */
function marks(html: string): string {
  const start = html.indexOf('<span class="tile-marks">');
  assert.ok(start >= 0, "the tile has no flag row");
  return html.slice(start, html.indexOf('<span class="tile-runtime-line">', start));
}

// ---- the persisted key ----

test("the key is Nested sub-cards unless Chip and popover was chosen, and nothing else is stored", () => {
  assert.deepEqual([...BACKGROUND_AGENTS_STYLES], ["nested", "chip"]);
  assert.equal(UI_CONFIG_DEFAULTS.backgroundAgentsStyle, "nested");
  // A fresh install and an upgrade with nothing stored read the default.
  assert.equal(UiConfigSchema.parse({}).backgroundAgentsStyle, "nested");
  for (const style of BACKGROUND_AGENTS_STYLES) {
    assert.equal(UiConfigSchema.parse({ backgroundAgentsStyle: style }).backgroundAgentsStyle, style);
  }
  // A stored value this build does not know - a later build's, or an `off` that was never
  // offered - reads as the default rather than failing the whole `ui` record.
  for (const stray of ["off", "lane", 7, null]) {
    const parsed = UiConfigSchema.parse({ backgroundAgentsStyle: stray, layout: "console" });
    assert.equal(parsed.backgroundAgentsStyle, "nested", `${JSON.stringify(stray)} was adopted`);
    assert.equal(parsed.layout, "console", "a stray treatment cost the rest of the record");
  }
});

test("a write is strict: an unknown treatment is refused, never stored as the default", () => {
  assert.equal(UiConfigPatchSchema.parse({ backgroundAgentsStyle: "chip" }).backgroundAgentsStyle, "chip");
  assert.equal(UiConfigPatchSchema.safeParse({ backgroundAgentsStyle: "off" }).success, false);
  assert.equal(UiConfigPatchSchema.safeParse({ backgroundAgentsStyle: "lane" }).success, false);
  // A patch that names other keys leaves this one alone rather than resetting it.
  assert.equal(UiConfigPatchSchema.parse({ layout: "board" }).backgroundAgentsStyle, undefined);
});

test("the key is an operator setting, so a settings backup carries it", () => {
  // The restore itself is exercised end to end in `background-agents-style-backup.test.ts`.
  const entry = APP_CONFIG_ENTRIES.ui;
  assert.equal(entry.classification.fields.backgroundAgentsStyle, "setting");
  const payload = settingPayloadForEntry(entry, { backgroundAgentsStyle: "chip" }) as Record<string, unknown>;
  assert.equal(payload.backgroundAgentsStyle, "chip");
});

// ---- the picker ----

test("Board card offers Background sub-agents after Task type, with the plan's copy", () => {
  const card = DISPLAY_CHOICES.filter((choice) => choice.group === "card");
  assert.deepEqual(card.map((choice) => choice.key), ["taskKindCard", "backgroundAgentsStyle"]);
  const choice = card[1]!;
  assert.equal(choice.label, "Background sub-agents");
  assert.equal(
    choice.description,
    "How a session shows the sub-agents it launched in the background, on its card and in its conversation.",
  );
  assert.deepEqual(
    choice.options.map((o) => [o.id, o.label, o.description]),
    [
      [
        "nested",
        "Nested sub-cards",
        "Each agent hangs under its card, and a tray above the reply box lists them. Cards grow while agents run.",
      ],
      [
        "chip",
        "Chip and popover",
        "A chip in the card's flags opens the list, and the conversation rail gains an Agents tab. Cards keep their height.",
      ],
    ],
  );
});

test("the picker is one radio group with Nested sub-cards checked, and the preview draws the chosen treatment", async () => {
  const nested = await withStyle("nested", () => renderToStaticMarkup(createElement(BoardCardPanel)));
  assert.match(nested, /role="radiogroup" aria-label="Board card: Background sub-agents"/);
  assert.equal(nested.match(/name="display-choice-backgroundAgentsStyle"/g)?.length, 2);
  assert.match(nested, /name="display-choice-backgroundAgentsStyle" checked="" value="nested"/);
  assert.ok(nested.includes(">Nested sub-cards</label>") && nested.includes(">Chip and popover</label>"));
  // The preview card has agents, so the default hangs sub-cards beneath it and draws no chip.
  const stage = nested.slice(nested.indexOf('<div class="board-card-preview-stage" inert="'));
  assert.ok(stage.includes('class="subagent-tree"'), "the preview hangs no sub-cards under the default");
  assert.ok(!stage.includes("tf-agents"), "the preview draws a chip under the default");

  const chip = await withStyle("chip", () => renderToStaticMarkup(createElement(BoardCardPanel)));
  assert.match(chip, /name="display-choice-backgroundAgentsStyle" checked="" value="chip"/);
  const chipStage = chip.slice(chip.indexOf('<div class="board-card-preview-stage" inert="'));
  assert.ok(chipStage.includes("tile-flag tf-agents"), "the preview draws no chip under Chip and popover");
  assert.ok(!chipStage.includes('class="subagent-tree"'), "the preview still hangs sub-cards under Chip and popover");
});

test("the preview fixture carries the plan's sample agents", () => {
  const subagents = previewSession(100_000).subagents;
  assert.ok(subagents);
  assert.deepEqual(subagents.agents.map((a) => a.state), ["running", "running", "completed"]);
});

test("searching Settings for sub-agents lands on the Board card entry, which holds the picker", () => {
  const card = SETTINGS_CONTROLS.find((c) => c.id === "board-card");
  assert.ok(card, "no board-card entry");
  assert.equal(card.anchor, "display/board-card");
  for (const term of ["sub-agents", "background agents", "agent chip", "popover", "nested", "agents tab", "tray"]) {
    assert.ok(card.keywords.includes(term), `the Board card entry is not found by "${term}"`);
  }
  // Not on Conversation header: a result labelled for another section reads as a different
  // control, even though both entries jump to the same panel.
  const header = SETTINGS_CONTROLS.find((c) => c.id === "conversation-header")!;
  for (const term of ["sub-agents", "background agents", "agents tab", "tray"]) {
    assert.ok(!header.keywords.includes(term), `Conversation header also answers "${term}"`);
  }
});


// ---- the board card ----

test("Chip and popover puts one chip in the tile's flags; Nested sub-cards puts none", async () => {
  const chipped = marks(await withStyle("chip", () => tile(SAMPLE)));
  assert.equal(chipped.match(/class="tile-flag tf-agents/g)?.length, 1);
  assert.match(chipped, /<button[^>]*class="tile-flag tf-agents is-running"[^>]*aria-haspopup="dialog"[^>]*aria-expanded="false"/);
  assert.ok(chipped.includes('<span class="tf-agents-label">3 agents</span>'));
  // One pip per agent, in each agent's state.
  assert.equal(chipped.match(/class="tf-agents-pip is-running"/g)?.length, 2);
  assert.equal(chipped.match(/class="tf-agents-pip is-completed"/g)?.length, 1);
  // Closed until clicked: the popover is a portal, never part of the tile's markup.
  assert.ok(!chipped.includes("subagent-popover"));

  const nested = marks(await withStyle("nested", () => tile(SAMPLE)));
  assert.ok(!nested.includes("tf-agents"), "Nested sub-cards drew a chip");
});

test("a card without background agents draws no chip under either treatment", async () => {
  for (const style of BACKGROUND_AGENTS_STYLES) {
    const html = await withStyle(style, () => tile());
    assert.ok(!html.includes("tf-agents"), `${style} drew a chip for a session without agents`);
    assert.equal(html, await withStyle("nested", () => tile()), `${style} changed an agent-free card`);
  }
});

test("the chip says a floor when the list may be cut short, and a folded-only session says finished", () => {
  assert.equal(subagentChipLabel({ subagents: SAMPLE }), "3 agents");
  assert.equal(subagentChipLabel({ subagents: { agents: [agent({ id: "x" })], finishedFolded: 0 } }), "1 agent");
  const full = Array.from({ length: 12 }, (_, i) => agent({ id: `r${i}` }));
  assert.equal(subagentChipLabel({ subagents: { agents: full, finishedFolded: 0 } }), "12+ agents");
  assert.equal(subagentChipLabel({ subagents: { agents: [], finishedFolded: 2 } }), "2 finished");
  // A folded-only session has no pips to draw, and no running tone.
  const folded = renderToStaticMarkup(createElement(SubagentChip, { session: { name: "x", subagents: { agents: [], finishedFolded: 2 } } }));
  assert.ok(!folded.includes("tf-agents-pip") && !folded.includes("is-running"));
});

test("a resident visitor tile carries the chip under Chip and popover, so its agents are never unseen", async () => {
  const visitor = (subagents?: SubagentSummary): string =>
    renderToStaticMarkup(createElement(ResidentVisitorCard, {
      session: mkSession({ name: "Ledger Keeper", ...(subagents ? { subagents } : {}) }),
      mark: PREVIEW_RESIDENT,
      variant: "tile",
      selected: false,
      onOpen: () => {},
    }));
  const chipped = await withStyle("chip", () => visitor(SAMPLE));
  assert.equal(chipped.match(/class="tile-flag tf-agents/g)?.length, 1, "the visitor tile drew no chip");
  assert.ok(chipped.includes('<span class="tf-agents-label">3 agents</span>'));
  // Under Nested sub-cards the board hangs the tree beneath the tile instead, as for any card.
  assert.ok(!(await withStyle("nested", () => visitor(SAMPLE))).includes("tf-agents"));
  // Without agents the flag row is empty, which `.tile-marks:empty` hides.
  assert.match(await withStyle("chip", () => visitor()), /<span class="tile-marks"><\/span>/);
});

// ---- the conversation ----

test("the rail offers Agents only when handed agents, and names the count on the tab", () => {
  const two = rail({});
  assert.equal(two.match(/role="tab"/g)?.length, 2);
  assert.ok(!two.includes(">Agents<"));
  assert.match(two, /data-tabs="2"/);

  const three = rail({ subagents: SAMPLE });
  assert.equal(three.match(/role="tab"/g)?.length, 3);
  // Three tabs take the head's count's room; the Agents tab carries its own.
  assert.ok(!three.includes('class="activity-count"'), "the three-tab head still prints a count");
  assert.match(three, /data-tabs="3"/);
  assert.match(three, />Agents<span class="activity-tab-count">3<\/span><\/button>/);
});

test("the Agents tab lists status, type, description, elapsed, last tool and tokens, and nothing it was not told", () => {
  const html = rail({ subagents: SAMPLE, tab: "agents" });
  assert.match(html, /data-tab="agents"/);
  assert.match(html, /role="tab"[^>]*aria-selected="true"[^>]*>Agents</);
  assert.equal(html.match(/class="agents-row is-running"/g)?.length, 2);
  assert.equal(html.match(/class="agents-row is-completed"/g)?.length, 1);
  assert.ok(html.includes('<span class="agents-type">general-purpose</span>'));
  assert.ok(html.includes('<span class="agents-desc">Convert billing report queries</span>'));
  assert.ok(html.includes('<span class="agents-end">done · </span>'));
  // The tab already prints the count, so the head does not repeat it.
  assert.ok(!html.includes('class="activity-count"'));
  // The collapsed strip names the tab that is up.
  assert.match(html, /<span class="activity-strip-label">Agents<\/span>/);

  assert.equal(agentsTabDetail(SAMPLE.agents[0]!, 135_000), "2m 14s · Grep · 41k tokens");
  // A terminal-hook agent: type, state and elapsed only - no placeholder numbers.
  assert.equal(agentsTabDetail(agent({ id: "h", startedAt: 0, endedAt: 48_000, state: "completed" }), 99_000), "48s");
});

test("an Agents tab whose agents have all folded says how many finished, not Agents 0", () => {
  const folded: SubagentSummary = { agents: [], finishedFolded: 2 };
  const html = rail({ subagents: folded, tab: "agents" });
  assert.match(
    html,
    />Agents<span class="activity-tab-count"><span aria-hidden="true">✓<\/span>2<span class="sr-only"> finished<\/span><\/span><\/button>/,
  );
  assert.ok(!html.includes('<span class="activity-tab-count">0</span>'), "the tab still reads Agents 0");
  // The panel lists the same count, and the folded strip counts it too.
  assert.ok(html.includes('<li class="agents-row agents-folded">2 finished</li>'));
  assert.match(html, /<span class="activity-strip-count">2<\/span>/);
  // The card's chip reads the same state the same way.
  assert.equal(subagentChipLabel({ subagents: folded }), "2 finished");
});

test("the Agents tab marks a failed agent and a stopped agent by label and state", () => {
  const ended: SubagentSummary = {
    agents: [
      agent({ id: "f1", description: "Rewrite the ledger cursor", state: "failed", startedAt: 0, endedAt: 30_000, lastTool: "Bash" }),
      agent({ id: "s1", description: "Sweep the billing fixtures", state: "stopped", startedAt: 0, endedAt: 12_000 }),
    ],
    finishedFolded: 0,
  };
  const html = rail({ subagents: ended, tab: "agents" });
  const rowOf = (description: string): string => {
    const at = html.indexOf(`<span class="agents-desc">${description}</span>`);
    assert.ok(at >= 0, `no row for ${description}`);
    const start = html.lastIndexOf("<li ", at);
    return html.slice(start, html.indexOf("</li>", at));
  };
  const failed = rowOf("Rewrite the ledger cursor");
  assert.match(failed, /^<li class="agents-row is-failed">/);
  assert.ok(failed.includes('<span class="agents-end">failed · </span>30s · Bash'), failed);
  const stopped = rowOf("Sweep the billing fixtures");
  assert.match(stopped, /^<li class="agents-row is-stopped">/);
  assert.ok(stopped.includes('<span class="agents-end">stopped · </span>12s'), stopped);
  // Neither is drawn as running or as done.
  assert.ok(!html.includes("agents-row is-running") && !html.includes(">done · <"));
});

test("a held Agents tab with no agents to list reads Activity", () => {
  const html = rail({ tab: "agents" });
  assert.match(html, /data-tab="activity"/);
  assert.match(html, /<span class="activity-strip-label">Activity<\/span>/);
  assert.ok(!html.includes("agents-list"));
});

test("the conversation holds its rail tab through useRailTab, keyed on whether Agents is offered", async () => {
  // The hook's reset is exercised statefully in `rail-tab-reset-electron.test.ts`; this pins
  // that the conversation is the owner using it, so the reset cannot be bypassed by a local
  // \`useState\` creeping back in.
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/web/components/TranscriptPanel.tsx", import.meta.url), "utf8");
  assert.match(source, /const \[railTab, setRailTab\] = useRailTab\(railAgents !== null\);/);
  assert.doesNotMatch(source, /useState<ActivityTab>/);
});

test("Nested sub-cards docks the tray and leaves the rail two tabs; Chip and popover does the reverse", async () => {
  const nested = await withStyle("nested", () => panel(SAMPLE));
  assert.ok(nested.includes('class="bg-tray"'), "Nested sub-cards drew no tray");
  assert.match(nested, /data-tabs="2"/);

  const chip = await withStyle("chip", () => panel(SAMPLE));
  assert.ok(!chip.includes('class="bg-tray"'), "Chip and popover still drew the tray");
  assert.match(chip, /data-tabs="3"/);
  assert.match(chip, />Agents<span class="activity-tab-count">3<\/span>/);
});

test("a conversation without background agents is the same under either treatment", async () => {
  const nested = await withStyle("nested", () => panel());
  const chip = await withStyle("chip", () => panel());
  assert.ok(!chip.includes("bg-tray") && !chip.includes("Agents<"));
  // `useId` is the only thing that may differ between two renders of the same panel.
  const strip = (html: string): string => html.replace(/_R_[0-9a-z]+_/gi, "");
  assert.equal(strip(chip), strip(nested));
});
