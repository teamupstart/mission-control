import { test } from "node:test";
import type { SessionFilesController } from "../src/web/lib/sessionFiles.ts";
import type { SessionViewProps } from "../src/web/components/layouts/types.ts";
import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionCard } from "../src/web/components/SessionCard.tsx";
import { ConsoleDetail } from "../src/web/components/layouts/ConsoleDetail.tsx";
import { SessionTile } from "../src/web/components/layouts/SessionTile.tsx";
import { RailRow } from "../src/web/components/layouts/RailRow.tsx";
import {
  AgentDot,
  CostChip,
  RuntimeTileFlag,
  SessionWhere,
  runtimeRailMark,
  InspectorChip,
  InspectorRailMark,
  InspectorTileFlag,
  PrChip,
  PrTileFlag,
  RuntimeMetaRow,
  ScheduleOriginChip,
  ScheduleOriginRailMark,
  ScheduleOriginTileFlag,
  SessionTitle,
  StateBadge,
  EnsembleChip,
  EnsembleRailMark,
  EnsembleTileFlag,
  ensembleMemberStateLabel,
  ensembleMemberTone,
} from "../src/web/components/session-bits.tsx";
import { Tooltip } from "../src/web/components/Tooltip.tsx";
import { EffortPicker } from "../src/web/components/EffortPicker.tsx";
import { ModePicker } from "../src/web/components/ModePicker.tsx";
import {
  meta,
  mkEnsembleLink,
  mkEnsembleSummary,
  mkSession,
  mkTaskSummary,
} from "./helpers/session-fixture.ts";
import { containsMarkup } from "./helpers/markup.ts";
import type { Session, SessionCost } from "../src/shared/types.ts";

/**
 * The card, the console detail and the board tile must draw their shared leaf pieces from
 * ONE implementation - `session-bits.tsx` - rather than from private copies.
 *
 * This is a bug class, not a tidiness preference. SessionCard is rendered only by the Cards
 * layout while ConsoleDetail serves both Console and Board, so a card carrying its own copy
 * of the PR chip / state badge / title means fixing the shared one fixes two layouts and
 * silently leaves the third wrong - with nothing failing to say so.
 *
 * So rather than assert what the markup happens to look like today (which would just be a
 * second copy to drift), each test renders the shared component standalone and asserts the
 * layout's own output CONTAINS that exact markup. Re-inline a copy and the fragments stop
 * matching the moment the two differ.
 *
 * `createElement` rather than JSX because the runner's glob only matches .test.ts.
 */

/** An adopted-PR summary, defaulting to the ordinary "reviewed, found things" shape. */
function insp(over: Partial<NonNullable<Session["inspector"]>> = {}): Session["inspector"] {
  return {
    prKey: "o/r#7",
    url: "https://example.test/pr/7",
    mode: "live",
    open: 1,
    postedOpen: 1,
    round: 1,
    lastReviewedAt: 1_700_000_000_000,
    failed: false,
    ...over,
  };
}

function card(over: Partial<Session> = {}): string {
  return renderToStaticMarkup(
    createElement(SessionCard, {
      session: mkSession(over),
      onOpenReviews: () => {},
    }),
  );
}

/** The board's overview tile, with the drag-and-drop wiring it never exercises here. */
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

/** Render one shared leaf on its own, so a layout's output can be checked against it. */
function bit<P extends object>(
  component: (props: P) => React.JSX.Element | null,
  props: P,
): string {
  return renderToStaticMarkup(createElement(component, props));
}

test("the card's agent dot is the shared AgentDot", () => {
  for (const agent of ["claude", "codex"] as const) {
    assert.ok(
      containsMarkup(card({ agent }), bit(AgentDot, { agent })),
      `card should render the shared AgentDot for ${agent}`,
    );
  }
});

test("the card's PR chip is the shared PrChip", () => {
  const cases: Partial<Session>[] = [
    { prUrl: "https://example.test/pr/7", prNumber: 7, prState: "open" },
    { prUrl: "https://example.test/pr/7", prNumber: 7, prState: "merged" },
    // The failing-checks alert is part of the chip, and never occurs in a healthy fleet -
    // exactly the variant a hand-copied card would be least likely to keep in step.
    {
      prUrl: "https://example.test/pr/7",
      prNumber: 7,
      prState: "open",
      prChecks: "failing",
    },
    // A PR with no number falls back to the "PR" label rather than "#undefined".
    { prUrl: "https://example.test/pr/7", prNumber: null, prState: "open" },
  ];
  for (const over of cases) {
    const session = mkSession(over);
    assert.ok(
      containsMarkup(card(over), bit(PrChip, { session })),
      `card should render the shared PrChip for ${JSON.stringify(over)}`,
    );
  }
});

// The Inspector chip is drawn by FOUR surfaces, and the two that share `session-bits`
// must share this one too. The board tile and the rail render it in their own
// vocabularies (a `.tile-flag`, a bare glyph), but they still take the DECISION of what
// it says from `inspectorChipView` - so what "clean" or "3 findings" means can't drift
// between layouts even where the markup does.
test("the card's inspector chip is the shared InspectorChip", () => {
  const cases: Partial<Session>[] = [
    // Findings outstanding - the state the chip exists for.
    { inspector: insp({ open: 3, round: 2 }) },
    // Reviewed and clean, which must not look like "not reviewed".
    { inspector: insp({ open: 0, round: 1 }) },
    // Adopted but not yet looked at.
    { inspector: insp({ open: 0, round: 0 }) },
    // Dry run: the review happened, the comment did not - a distinction the chip carries.
    { inspector: insp({ open: 2, round: 1, mode: "dry-run" }) },
    // Failed, which never occurs in a healthy fleet and so is only ever exercised here.
    { inspector: insp({ open: 1, round: 1, failed: true }) },
  ];
  for (const over of cases) {
    const session = mkSession(over);
    assert.ok(
      containsMarkup(card(over), bit(InspectorChip, { session })),
      `card should render the shared InspectorChip for ${JSON.stringify(over.inspector)}`,
    );
  }
});

// A PR the Inspector never adopted renders NOTHING, and that silence is the feature: the
// Inspector only adopts what it can prove Mission Control opened, so a card with a PR
// chip and no inspector chip is telling you that PR came from somewhere else.
test("a PR that was never adopted gets no inspector chip at all", () => {
  const over: Partial<Session> = {
    prUrl: "https://example.test/pr/7",
    prNumber: 7,
    prState: "open",
    inspector: null,
  };
  assert.equal(bit(InspectorChip, { session: mkSession(over) }), "");
  assert.ok(!card(over).includes("insp-chip"));
});

// The rail draws the Inspector in its own terse vocabulary, but the glyph-and-count
// span itself has to come from `InspectorRailMark` rather than a private copy, or a
// fix to the shared tooltip silently misses the rail.
test("the rail's inspector mark is the shared InspectorRailMark", () => {
  const cases: Partial<Session>[] = [
    { inspector: insp({ open: 3, round: 2 }) },
    { inspector: insp({ open: 2, round: 1, mode: "dry-run" }) },
    { inspector: insp({ open: 1, round: 1, failed: true }) },
  ];
  for (const over of cases) {
    const session = mkSession(over);
    const rail = renderToStaticMarkup(
      createElement(RailRow, { session, selected: false, onSelect: () => {} }),
    );
    assert.ok(
      containsMarkup(rail, bit(InspectorRailMark, { session })),
      `rail should render the shared InspectorRailMark for ${JSON.stringify(over.inspector)}`,
    );
  }
});

test("the rail row keeps a keyboard-focus description outside its nested marks", () => {
  const rail = renderToStaticMarkup(
    createElement(RailRow, {
      session: mkSession({ name: "focus-target" }),
      selected: false,
      onSelect: () => {},
    }),
  );
  const describedBy = rail.match(/<button[^>]*class="rail-row[^"]*"[^>]*aria-describedby="([^"]+)"/)?.[1];
  assert.ok(describedBy);
  assert.match(
    rail,
    new RegExp(`<span id="${describedBy}" class="tt-desc">focus-target - [^<]+</span>`),
  );
});

// The board tile draws the Inspector as a `.tile-flag`, but that link has to come from
// `InspectorTileFlag` rather than a private copy - including the queued and clean states
// the rail suppresses, since the tile shows every state the card does.
test("the board tile's inspector flag is the shared InspectorTileFlag", () => {
  const cases: Partial<Session>[] = [
    { inspector: insp({ open: 3, round: 2 }) },
    { inspector: insp({ open: 0, round: 1 }) },
    { inspector: insp({ open: 0, round: 0 }) },
    { inspector: insp({ open: 2, round: 1, mode: "dry-run" }) },
    { inspector: insp({ open: 1, round: 1, failed: true }) },
  ];
  for (const over of cases) {
    const session = mkSession(over);
    const tile = renderToStaticMarkup(
      createElement(SessionTile, {
        session,
        onOpen: () => {},
        draggingRepo: null,
        onDropped: () => {},
        onDropError: () => {},
        onDropConfirm: () => {},
      }),
    );
    assert.ok(
      containsMarkup(tile, bit(InspectorTileFlag, { session })),
      `tile should render the shared InspectorTileFlag for ${JSON.stringify(over.inspector)}`,
    );
  }
});

// All four surfaces must show the IDENTICAL tooltip copy for the same state, delivered by
// the actual `Tooltip` component - not merely an `aria-label` that happens to match. A
// component wrapped in `Tooltip` and one carrying a bare `aria-label`/`title` render
// IDENTICAL static markup (`Tooltip` adds no DOM node or attribute until it is hovered), so
// asserting on rendered HTML strings cannot tell them apart - the whole point of this test
// would silently stop holding the moment someone reverted a surface to a native `title`
// while leaving its `aria-label` in place. Calling each component as a plain function
// (rather than rendering it) returns its un-rendered element tree, whose root can be
// checked to actually be a `<Tooltip>` carrying the expected `label` prop.
test("all four inspector surfaces are wrapped in the shared Tooltip with identical copy", () => {
  const cases: Partial<Session>[] = [
    { inspector: insp({ open: 3, round: 2 }) },
    { inspector: insp({ open: 0, round: 1 }) },
    { inspector: insp({ open: 0, round: 0 }) },
    { inspector: insp({ open: 2, round: 1, mode: "dry-run" }) },
    { inspector: insp({ open: 1, round: 1, failed: true }) },
  ];
  for (const over of cases) {
    const session = mkSession(over);
    const chipEl = InspectorChip({ session });
    assert.equal(chipEl?.type, Tooltip, "card chip should be wrapped in the shared Tooltip");
    const title = (chipEl?.props as { label: string }).label;
    assert.ok(title, `card chip should have a tooltip label for ${JSON.stringify(over.inspector)}`);

    const tileEl = InspectorTileFlag({ session });
    assert.equal(tileEl?.type, Tooltip, "tile flag should be wrapped in the shared Tooltip");
    assert.equal(
      (tileEl?.props as { label: string }).label,
      title,
      `tile flag tooltip should match the card's for "${title}"`,
    );

    // The rail suppresses the clean/queued states entirely, so only assert there when
    // it actually renders something.
    const railEl = InspectorRailMark({ session });
    if (railEl) {
      assert.equal(railEl.type, Tooltip, "rail mark should be wrapped in the shared Tooltip");
      assert.equal(
        (railEl.props as { label: string }).label,
        title,
        `rail mark tooltip should match the card's for "${title}"`,
      );
    }
  }
});

// The tile's PR flag sits right beside the Inspector flag with the same `.tile-flag`
// styling, so the two must behave identically on hover - both wrapped in the shared
// `Tooltip`, never one instant and the other a slow native `title`.
test("the board tile's PR flag is the shared PrTileFlag, wrapped in the shared Tooltip", () => {
  const cases: Partial<Session>[] = [
    { prUrl: "https://example.test/pr/7", prNumber: 7, prState: "open" },
    { prUrl: "https://example.test/pr/7", prNumber: 7, prState: "merged" },
    { prUrl: "https://example.test/pr/7", prNumber: 7, prState: "open", prChecks: "failing" },
  ];
  for (const over of cases) {
    const session = mkSession(over);
    const flagEl = PrTileFlag({ session });
    assert.equal(flagEl?.type, Tooltip, `tile PR flag should be wrapped in the shared Tooltip for ${JSON.stringify(over)}`);

    const tile = renderToStaticMarkup(
      createElement(SessionTile, {
        session,
        onOpen: () => {},
        draggingRepo: null,
        onDropped: () => {},
        onDropError: () => {},
        onDropConfirm: () => {},
      }),
    );
    assert.ok(
      containsMarkup(tile, bit(PrTileFlag, { session })),
      `tile should render the shared PrTileFlag for ${JSON.stringify(over)}`,
    );
  }

  // A PR number with no URL yet stays the plain, unlinked flag it always was - nothing to
  // hover for, so no Tooltip.
  const noUrl = mkSession({ prUrl: null, prNumber: 9, prState: "open" });
  const noUrlEl = PrTileFlag({ session: noUrl });
  assert.notEqual(noUrlEl?.type, Tooltip, "a PR with no URL yet should not be wrapped in a Tooltip");
});

test("the card's state badge is the shared StateBadge", () => {
  // Both variants: the plain span, and the button that opens the reviews modal. The button
  // needs a pending review, which a healthy fleet never has - so it is only ever exercised
  // here, not by looking at a running dashboard.
  for (const pendingReviews of [0, 2]) {
    const session = mkSession({ pendingReviews });
    assert.ok(
      containsMarkup(
        card({ pendingReviews }),
        bit(StateBadge, { session, onOpenReviews: () => {} }),
      ),
      `card should render the shared StateBadge with ${pendingReviews} pending reviews`,
    );
  }
});


test("the card's title and rename affordance are the shared SessionTitle", () => {
  // Renameable (a live session with a pane) and not (an exited one) render differently, and
  // the pencil affordance only exists in the first.
  const cases: { over: Partial<Session>; canRename: boolean }[] = [
    { over: {}, canRename: true },
    { over: { state: "exited", terminals: [] }, canRename: false },
  ];
  for (const { over, canRename } of cases) {
    const session = mkSession(over);
    assert.ok(
      containsMarkup(card(over), bit(SessionTitle, { session, canRename, renaming: false })),
      `card should render the shared SessionTitle (canRename=${canRename})`,
    );
  }
});

test("the card's context meter is the shared RuntimeMetaRow", () => {
  const m = meta({ contextPct: 73 });
  const session = mkSession({ meta: m });
  assert.ok(
    containsMarkup(card({ meta: m }), bit(RuntimeMetaRow, { meta: m, session })),
    "card should render the shared RuntimeMetaRow",
  );
});

test("the card's cost badge is the shared CostChip", () => {
  // Every economic basis plus the null gate. A hand-copied card is most likely to lose
  // the approximation marker or to render an unknown model as a confident dollar value.
  const cases: (SessionCost | null)[] = [
    null,
    { costUsd: 1.24, basis: "reported", pricingModels: [], pricingVersions: [], input: 2, output: 561, cacheRead: 91_000, cacheWrite: 27_298, updatedAt: 1 },
    // Past COST_ATTENTION_USD, where the chip changes tone rather than growing a
    // second copy of itself in the tile's alert marks.
    { costUsd: 12.5, basis: "reported", pricingModels: [], pricingVersions: [], input: 2, output: 9, cacheRead: 1, cacheWrite: 1, updatedAt: 1 },
    { costUsd: 2.75, basis: "api-equivalent", pricingModels: ["gpt-5.6-sol"], pricingVersions: ["openai-standard-2026-07-22"], input: 100, output: 20, cacheRead: 30, cacheWrite: 10, updatedAt: 1 },
    { costUsd: null, basis: "unpriced", pricingModels: ["gpt-future"], pricingVersions: [], input: 100, output: 20, cacheRead: 30, cacheWrite: 10, updatedAt: 1 },
  ];
  for (const cost of cases) {
    const fragment = bit(CostChip, { cost });
    if (!fragment) {
      assert.ok(!card({ cost }).includes("cost-chip"), "a session with no usage draws no chip");
      continue;
    }
    assert.ok(containsMarkup(card({ cost }), fragment), `card should render the shared CostChip (${cost?.costUsd})`);
  }
  const api = bit(CostChip, { cost: cases[3]! });
  assert.ok(api.includes("≈$2.75"));
  const unknown = bit(CostChip, { cost: cases[4]! });
  assert.ok(unknown.includes("tok"));
});

test("the board tile's agent dot and context meter are the shared ones", () => {
  const m = meta({ contextPct: 73 });
  const session = mkSession({ meta: m });
  const html = tile(session);
  assert.ok(
    containsMarkup(html, bit(AgentDot, { agent: session.agent })),
    "tile should render the shared AgentDot",
  );
  assert.ok(
    containsMarkup(html, bit(RuntimeMetaRow, { meta: m, session, showEffort: false })),
    "tile should render the shared meter without nesting its effort control",
  );
  assert.ok(containsMarkup(html, bit(EffortPicker, { session })), "tile should render the shared effort control beside it");
});

test("the board tile's cost badge is the shared CostChip", () => {
  const cost: SessionCost = {
    costUsd: 3.5, basis: "reported", pricingModels: [], pricingVersions: [], input: 2, output: 561, cacheRead: 91_000, cacheWrite: 27_298, updatedAt: 1,
  };
  assert.ok(containsMarkup(tile(mkSession({ cost })), bit(CostChip, { cost })), "tile should render the shared CostChip");
});

test("the board tile's permission mode is the shared ModePicker", () => {
  // The card grew the picker first, so the board could show a mode it refused to change -
  // or, worse, grow a second chip that drifts from the card's on what a mode is called.
  // Both states are pinned: the pickable one, and the degradation a paneless session takes
  // (no writable pane to drive the native control, so the same read-only chip everywhere).
  const cases: Partial<Session>[] = [
    { permissionMode: "acceptEdits" },
    { permissionMode: "plan", terminals: [] },
  ];
  for (const over of cases) {
    const session = mkSession(over);
    const fragment = bit(ModePicker, { session });
    assert.ok(fragment, `ModePicker should draw something for ${over.permissionMode}`);
    assert.ok(
      containsMarkup(tile(session), fragment),
      `tile should render the shared ModePicker (${over.permissionMode})`,
    );
    assert.ok(
      containsMarkup(card(over), fragment),
      `card should render the shared ModePicker (${over.permissionMode})`,
    );
  }
});

test("card and console detail agree on every shared leaf", () => {
  // The end the whole refactor is for: the two layouts a human compares side by side must
  // be drawing the same pieces, so a fix to one is a fix to both.
  const over: Partial<Session> = {
    prUrl: "https://example.test/pr/7",
    prNumber: 7,
    prState: "open",
    prChecks: "failing",
    pendingReviews: 2,
    meta: meta({ contextPct: 73 }),
    cost: {
      costUsd: 1.24, basis: "reported", pricingModels: [], pricingVersions: [], input: 2, output: 561, cacheRead: 91_000, cacheWrite: 27_298, updatedAt: 1,
    },
    inspector: insp({ open: 3, round: 2 }),
  };
  const session = mkSession(over);
  const detail = renderToStaticMarkup(
    createElement(ConsoleDetail, {
      session,
      view: {
        sessions: [session],
        tasks: [],
        backlog: [],
        onEditTask: () => {},
        backlogPlan: null,
        selectedId: session.id,
        consoleZone: "rail",
        onConsoleZoneChange: () => {},
        onSelect: () => {},
        onDeselect: () => {},
        expandedId: null,
        onToggleExpand: () => {},
        onOpenReviews: () => {},
        onOpenDiff: () => {},
        onOpenFiles: () => {},
        onOpenFile: () => false,
        fileTabRequest: null,
        conversationTabRequest: null,
        workflowsTabRequest: null,
        diffTabRequest: null,
        files: {} as SessionFilesController,
        onReset: () => {},
        onComplete: () => {},
        onKill: () => {},
        onKilled: () => {},
        resetNonces: {},
        registerEl: () => {},
        registerActions: () => {},
        registerLaunchers: () => {},
        registerFind: () => {},
        registerDetailScroll: () => {},
        registerReaderTab: () => {},
        renamingId: null,
        onRenameStart: () => {},
        onRenameClose: () => {},
        foremanMode: "dry-run",
        foremanEnabled: false,
        foremanAllowlist: [],
        inputReviewBySession: new Map<string, string>(),
        pendingReviewIds: new Set<string>(),
        reviews: [],
      },
    }),
  );
  const html = card(over);
  for (const [name, fragment] of [
    ["AgentDot", bit(AgentDot, { agent: session.agent })],
    ["PrChip", bit(PrChip, { session })],
    ["StateBadge", bit(StateBadge, { session, onOpenReviews: () => {} })],
    ["InspectorChip", bit(InspectorChip, { session })],
    ["RuntimeMetaRow", bit(RuntimeMetaRow, { meta: session.meta!, session })],
    ["CostChip", bit(CostChip, { cost: session.cost })],
  ] as const) {
    assert.ok(containsMarkup(html, fragment), `card should contain the shared ${name}`);
    assert.ok(containsMarkup(detail, fragment), `console detail should contain the shared ${name}`);
  }
});

// Dry run means the review happened and NOTHING was published. That is the distinction
// the whole feature's safety story rests on, so it cannot be legible on the card and
// invisible on the other two surfaces - a bare `⌕ 3` must not read the same whether
// those three findings are public review comments or were only recorded here.
//
// The mark vocabularies differ by design (a pill, a `.tile-flag`, a glyph), so this
// asserts each surface carries the shared `insp-dry` hook rather than identical markup.
test("all three inspector surfaces show dry run, and none of them shows it when live", () => {
  const dry = insp({ open: 3, round: 2, mode: "dry-run" });
  const live = insp({ open: 3, round: 2, mode: "live" });

  const tile = (i: Session["inspector"]): string =>
    renderToStaticMarkup(
      createElement(SessionTile, {
        session: mkSession({ inspector: i }),
        onOpen: () => {},
        draggingRepo: null,
        onDropped: () => {},
        onDropError: () => {},
        onDropConfirm: () => {},
      }),
    );
  const rail = (i: Session["inspector"]): string =>
    renderToStaticMarkup(
      createElement(RailRow, {
        session: mkSession({ inspector: i }),
        selected: false,
        onSelect: () => {},
      }),
    );

  for (const [name, render] of [
    ["card", (i: Session["inspector"]) => card({ inspector: i })],
    ["tile", tile],
    ["rail", rail],
  ] as const) {
    assert.match(render(dry), /insp-dry/, `${name} should mark a dry-run review`);
    assert.doesNotMatch(render(live), /insp-dry/, `${name} must not mark a live review`);
  }
});

// The chip's only unconditional child is an aria-hidden glyph, and in the queued state
// the mark is empty - so without a name it announces as nothing at all, and otherwise as
// a bare "3". The tooltip's aria-describedby is a description, and only while open.
test("the inspector chip and its tile twin have an accessible name", () => {
  const session = mkSession({ inspector: insp({ open: 0, round: 0 }) });
  assert.match(bit(InspectorChip, { session }), /aria-label="Inspector: adopted for review/);
  const tile = renderToStaticMarkup(
    createElement(SessionTile, {
      session,
      onOpen: () => {},
      draggingRepo: null,
      onDropped: () => {},
      onDropError: () => {},
      onDropConfirm: () => {},
    }),
  );
  assert.match(tile, /aria-label="Inspector: adopted for review/);
});

// Schedule provenance is the fourth session-level signal to span all four renderers, and
// it follows the Inspector's rule: one shared DECISION (`scheduleOriginTooltip`) so the
// card chip, console-detail chip, board tile flag and rail glyph cannot drift on what a
// scheduled task says or how it is explained on hover.
const SCHEDULED_TASK = {
  id: "task-1",
  title: "Run dependency audit",
  kind: "ship" as const,
  status: "running" as const,
  outcome: null,
  outcomeUrl: null,
  scheduleId: "sched-1",
  scheduleOccurrenceId: "occ-1",
  scheduledFor: 1_753_600_000_000,
  ensemble: null,
};
const SCHEDULE_NAMES = new Map([["sched-1", "Dependency audit"]]);

function scheduledView(session: Session): SessionViewProps {
  return {
    sessions: [session],
    tasks: [],
    backlog: [],
    onEditTask: () => {},
    backlogPlan: null,
    selectedId: session.id,
    consoleZone: "rail",
    onConsoleZoneChange: () => {},
    onSelect: () => {},
    onDeselect: () => {},
    expandedId: null,
    onToggleExpand: () => {},
    onOpenReviews: () => {},
    onOpenDiff: () => {},
    onOpenFiles: () => {},
    onOpenFile: () => false,
    fileTabRequest: null,
    conversationTabRequest: null,
    workflowsTabRequest: null,
    diffTabRequest: null,
    files: {} as SessionFilesController,
    onReset: () => {},
    onComplete: () => {},
    onKill: () => {},
    onKilled: () => {},
    resetNonces: {},
    registerEl: () => {},
    registerActions: () => {},
    registerLaunchers: () => {},
    registerFind: () => {},
    registerDetailScroll: () => {},
    registerReaderTab: () => {},
    renamingId: null,
    onRenameStart: () => {},
    onRenameClose: () => {},
    foremanMode: "dry-run",
    foremanEnabled: false,
    foremanAllowlist: [],
    inputReviewBySession: new Map<string, string>(),
    pendingReviewIds: new Set<string>(),
    reviews: [],
    onOpenSchedule: () => {},
    scheduleNameById: SCHEDULE_NAMES,
  };
}

test("a scheduled task's origin mark is the shared leaf in all four session renderers", () => {
  const session = mkSession({ task: SCHEDULED_TASK });
  const props = { task: SCHEDULED_TASK, scheduleNames: SCHEDULE_NAMES };

  const cardHtml = renderToStaticMarkup(
    createElement(SessionCard, {
      session,
      onOpenReviews: () => {},
      onOpenSchedule: () => {},
      scheduleNameById: SCHEDULE_NAMES,
    }),
  );
  assert.ok(
    containsMarkup(cardHtml, bit(ScheduleOriginChip, props)),
    "the card should render the shared ScheduleOriginChip",
  );

  const detailHtml = renderToStaticMarkup(
    createElement(ConsoleDetail, { session, view: scheduledView(session) }),
  );
  assert.ok(
    containsMarkup(detailHtml, bit(ScheduleOriginChip, props)),
    "console detail should render the shared ScheduleOriginChip",
  );

  const tileHtml = renderToStaticMarkup(
    createElement(SessionTile, {
      session,
      onOpen: () => {},
      draggingRepo: null,
      onDropped: () => {},
      onDropError: () => {},
      onDropConfirm: () => {},
      onOpenSchedule: () => {},
      scheduleNameById: SCHEDULE_NAMES,
    }),
  );
  assert.ok(
    containsMarkup(tileHtml, bit(ScheduleOriginTileFlag, props)),
    "the board tile should render the shared ScheduleOriginTileFlag",
  );

  const railHtml = renderToStaticMarkup(
    createElement(RailRow, {
      session,
      selected: false,
      onSelect: () => {},
      onOpenSchedule: () => {},
      scheduleNameById: SCHEDULE_NAMES,
    }),
  );
  assert.ok(
    containsMarkup(railHtml, bit(ScheduleOriginRailMark, props)),
    "the rail should render the shared ScheduleOriginRailMark",
  );
});

test("all four scheduled-origin surfaces share one Tooltip copy, live name and all", () => {
  const props = { task: SCHEDULED_TASK, scheduleNames: SCHEDULE_NAMES };
  const chip = ScheduleOriginChip(props);
  const tile = ScheduleOriginTileFlag(props);
  const rail = ScheduleOriginRailMark(props);
  assert.equal(chip?.type, Tooltip, "the chip is wrapped in the shared Tooltip");
  assert.equal(tile?.type, Tooltip, "the tile flag is wrapped in the shared Tooltip");
  assert.equal(rail?.type, Tooltip, "the rail mark is wrapped in the shared Tooltip");
  const label = (chip?.props as { label: string }).label;
  assert.match(label, /Scheduled by Dependency audit/);
  assert.equal((tile?.props as { label: string }).label, label);
  assert.equal((rail?.props as { label: string }).label, label);
  // The rail glyph is a mouse-only span, NOT a focusable/role="button" control: the rail row
  // is itself a native button, so an interactive descendant would be an invalid nested
  // control (Inspector round on #241). It matches WorkflowRailMark / InspectorRailMark; the
  // keyboard path to the deep link is the card chip, console-detail chip, and tile flag.
  const railMark = (rail?.props as { children: ReactElement }).children;
  const railProps = railMark.props as { role?: string; tabIndex?: number };
  assert.equal(railProps.role, undefined);
  assert.equal(railProps.tabIndex, undefined);
});

test("a task with no schedule provenance draws no origin mark on any surface", () => {
  const ordinaryTask = { ...SCHEDULED_TASK, scheduleId: null, scheduleOccurrenceId: null, scheduledFor: null };
  const props = { task: ordinaryTask, scheduleNames: SCHEDULE_NAMES };
  assert.equal(bit(ScheduleOriginChip, props), "");
  assert.equal(bit(ScheduleOriginTileFlag, props), "");
  assert.equal(bit(ScheduleOriginRailMark, props), "");
  // And an external-source task never masquerades as scheduled: only scheduleId gates it.
  assert.equal(bit(ScheduleOriginChip, { task: { ...ordinaryTask }, scheduleNames: SCHEDULE_NAMES }), "");
});

test("an archived schedule keeps auditable provenance and isolates chip gestures", () => {
  // The name map holds only live catalog schedules, so a task from an archived one gets a
  // generic label - but the mark still renders and still deep-links, because history
  // carries the schedule even after it leaves the catalog.
  const chip = ScheduleOriginChip({ task: SCHEDULED_TASK, scheduleNames: new Map() });
  assert.equal(chip?.type, Tooltip);
  const label = (chip?.props as { label: string }).label;
  assert.match(label, /Filed by a recurring mission/);
  assert.match(label, /schedule sched-1/);
  assert.match(label, /occurrence occ-1/);

  const button = (
    chip?.props as {
      children: ReactElement<{
        onMouseDown: (event: { stopPropagation: () => void }) => void;
        onDragStart: (event: { stopPropagation: () => void }) => void;
      }>;
    }
  ).children;
  let stopped = 0;
  button.props.onMouseDown({
    stopPropagation: () => {
      stopped += 1;
    },
  });
  button.props.onDragStart({
    stopPropagation: () => {
      stopped += 1;
    },
  });
  assert.equal(stopped, 2);
});

// ---- the ensemble member, across the four session drawings ----
//
// The fifth session-level signal to span all four renderers, and the one whose states are
// hardest to see on a live dashboard: a member blocked on an unanswered question, a casualty, a
// winner. Same rule as the Inspector and schedule families - one shared DECISION
// (`ensembleMemberStateLabel` + the tooltip) so what "needs an answer" means and how it is
// explained cannot drift between the card, the console detail, the board tile and the rail.

test("an ensemble member's mark is the shared leaf in all four session renderers", () => {
  const link = mkEnsembleLink({ ordinal: 2, maxMembers: 5, status: "active" });
  const session = mkSession({ task: mkTaskSummary({ ensemble: link }) });
  const summary = mkEnsembleSummary({ maxMembers: 5, launchedMembers: 3, membersReady: 1 });

  const cardHtml = renderToStaticMarkup(
    createElement(SessionCard, {
      session,
      onOpenReviews: () => {},
      ensembleSummary: summary,
    }),
  );
  assert.ok(
    containsMarkup(cardHtml, bit(EnsembleChip, { link, summary })),
    "the card should render the shared EnsembleChip",
  );

  const detailHtml = renderToStaticMarkup(
    createElement(ConsoleDetail, {
      session,
      view: {
        ...scheduledView(session),
        ensembleSummaryByRun: new Map([[summary.id, summary]]),
      },
    }),
  );
  assert.ok(
    containsMarkup(detailHtml, bit(EnsembleChip, { link, summary })),
    "console detail should render the shared EnsembleChip, summary and all",
  );

  const tileHtml = renderToStaticMarkup(
    createElement(SessionTile, {
      session,
      onOpen: () => {},
      draggingRepo: null,
      onDropped: () => {},
      onDropError: () => {},
      onDropConfirm: () => {},
      ensembleSummary: summary,
    }),
  );
  assert.ok(
    containsMarkup(tileHtml, bit(EnsembleTileFlag, { link, summary })),
    "the board tile should render the shared EnsembleTileFlag",
  );

  const railHtml = renderToStaticMarkup(
    createElement(RailRow, {
      session,
      selected: false,
      onSelect: () => {},
      ensembleSummary: summary,
    }),
  );
  assert.ok(
    containsMarkup(railHtml, bit(EnsembleRailMark, { link, summary })),
    "the rail should render the shared EnsembleRailMark",
  );
});

test("a blocked member says so in every vocabulary, from one decision", () => {
  // The disagreement this whole signal exists to close: the card was red with a waiting question
  // while its ensemble chip said "working". `needsInput` now wins over the status ladder AND over
  // the server's `resultLabel`, and it carries its own tone rather than borrowing `waiting`'s -
  // "submitted, the run is chewing on it" and "waiting on YOU" must not be the same colour.
  const blocked = mkEnsembleLink({ status: "submitted", resultLabel: "rank 1", needsInput: true });
  assert.equal(ensembleMemberStateLabel(blocked), "needs an answer");
  assert.equal(ensembleMemberTone(blocked), "blocked");

  const calm = mkEnsembleLink({ status: "submitted", resultLabel: "rank 1" });
  assert.equal(ensembleMemberStateLabel(calm), "rank 1");
  assert.equal(ensembleMemberTone(calm), "waiting");

  for (const [name, fragment] of [
    ["chip", bit(EnsembleChip, { link: blocked })],
    ["tile flag", bit(EnsembleTileFlag, { link: blocked })],
    ["rail mark", bit(EnsembleRailMark, { link: blocked })],
  ] as const) {
    assert.match(fragment, /ensemble-blocked/, `${name} should carry the blocked tone`);
    assert.match(fragment, /waiting on your answer/, `${name} should explain it on hover`);
  }
  // The rail has one line of room, so it spends it on the words that mean "act on this" rather
  // than on the result label a calm member shows there.
  assert.match(bit(EnsembleRailMark, { link: blocked }), /needs you/);
  assert.match(bit(EnsembleRailMark, { link: calm }), /rank 1/);
});

test("all four ensemble surfaces share one Tooltip copy, run progress and all", () => {
  const link = mkEnsembleLink({ ordinal: 3, maxMembers: 5, status: "reviewing" });
  const summary = mkEnsembleSummary({
    status: "evaluating",
    maxMembers: 5,
    launchedMembers: 5,
    membersReady: 3,
  });
  const chip = EnsembleChip({ link, summary });
  const tile = EnsembleTileFlag({ link, summary });
  const rail = EnsembleRailMark({ link, summary });
  assert.equal(chip?.type, Tooltip, "the chip is wrapped in the shared Tooltip");
  assert.equal(tile?.type, Tooltip, "the tile flag is wrapped in the shared Tooltip");
  assert.equal(rail?.type, Tooltip, "the rail mark is wrapped in the shared Tooltip");
  const label = (chip?.props as { label: string }).label;
  // The denominator is the roster the operator chose, not the wave-by-wave launch count.
  assert.match(label, /candidate 3 of 5/);
  // And the run clause is the ONE stage vocabulary, not a word invented per surface.
  assert.match(label, /run: reviewing, 3 of 5 in/);
  assert.equal((tile?.props as { label: string }).label, label);
  assert.equal((rail?.props as { label: string }).label, label);

  // The rail glyph stays a mouse-only span: the rail row is itself a native button, so an
  // interactive descendant would be an invalid nested control.
  const railMark = (rail?.props as { children: ReactElement }).children;
  const railProps = railMark.props as { role?: string; tabIndex?: number };
  assert.equal(railProps.role, undefined);
  assert.equal(railProps.tabIndex, undefined);
});

test("without a run summary the marks say only what the member link can prove", () => {
  // A member's link arrives with its task; the run's SSE summary is a separate collection that
  // can land a tick later. The progress suffix is the only thing that waits for it - inventing a
  // count from the link would be a second progress vocabulary disagreeing with the dots.
  const link = mkEnsembleLink({ ordinal: 2, maxMembers: 4 });
  const chip = bit(EnsembleChip, { link });
  assert.doesNotMatch(chip, /ensemble-chip-progress/);
  assert.match(chip, /candidate 2 of 4/);
  assert.doesNotMatch(chip, /run: /);
  // The tile flag's `2/4` is the member's ORDINAL over the roster, which the link always has.
  assert.match(bit(EnsembleTileFlag, { link }), /E<\/span> 2\/4 ·/);
});

test("a session in no ensemble draws no mark on any surface", () => {
  const props = { link: null };
  assert.equal(bit(EnsembleChip, props), "");
  assert.equal(bit(EnsembleTileFlag, props), "");
  assert.equal(bit(EnsembleRailMark, props), "");
  assert.doesNotMatch(card({}), /ensemble-chip/);
  assert.doesNotMatch(tile(mkSession({})), /tf-ensemble/);
});

// ---- the session runtime, across the three mark vocabularies ----

test("all three surfaces say an embedded session has no pane, from one decision", () => {
  // The three-vocabularies rule (CLAUDE.md): a new session-level signal has to reach the
  // rail's glyphs, the tile's flags and the card's chips, or two layouts out of three
  // silently omit it. This one matters more than most - it is the reason Focus and Rename
  // are missing from the same card - so the words come from one place and each surface only
  // chooses how terse it is.
  const session = mkSession({ runtime: "sdk", nameSource: "sdk", terminals: [] });

  assert.ok(containsMarkup(card({ runtime: "sdk", nameSource: "sdk", terminals: [] }), bit(SessionWhere, { session })));
  assert.ok(containsMarkup(tile(session), bit(RuntimeTileFlag, { session })));
  const rail = renderToStaticMarkup(
    createElement(RailRow, { session, selected: false, onSelect: () => {} }),
  );
  assert.match(rail, new RegExp(runtimeRailMark(session)!));
});

test("a pane-backed session renders none of it, which is every session by default", () => {
  // The whole feature is invisible until an operator turns the runtime on, so the terminal
  // card must be byte-identical to what it was: no chip, no flag, no glyph.
  const session = mkSession({});
  assert.equal(RuntimeTileFlag({ session }), null);
  assert.equal(runtimeRailMark(session), null);
  assert.doesNotMatch(tile(session), /runtime-flag/);
  assert.doesNotMatch(card({}), /runtime-chip/);
});

test("the card and the console detail agree about where a session is", () => {
  // Both draw it under the title, and both go through `SessionWhere` - the pane string and
  // the runtime chip are answers to the same question, so a card carrying both would say it
  // twice and a detail carrying neither would leave the operator hunting for a pane.
  const session = mkSession({ runtime: "sdk", nameSource: "sdk", terminals: [] });
  const detail = renderToStaticMarkup(
    createElement(ConsoleDetail, { session, view: scheduledView(session) }),
  );
  assert.ok(containsMarkup(detail, bit(SessionWhere, { session })));
});
