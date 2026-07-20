import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionCard } from "../src/web/components/SessionCard.tsx";
import { ConsoleDetail } from "../src/web/components/layouts/ConsoleDetail.tsx";
import { SessionTile } from "../src/web/components/layouts/SessionTile.tsx";
import {
  AgentDot,
  CostChip,
  PrChip,
  RuntimeMetaRow,
  SessionTitle,
  StateBadge,
} from "../src/web/components/session-bits.tsx";
import { meta, mkSession } from "./helpers/session-fixture.ts";
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

function card(over: Partial<Session> = {}): string {
  return renderToStaticMarkup(
    createElement(SessionCard, { session: mkSession(over), onOpenReviews: () => {} }),
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
      card({ agent }).includes(bit(AgentDot, { agent })),
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
      card(over).includes(bit(PrChip, { session })),
      `card should render the shared PrChip for ${JSON.stringify(over)}`,
    );
  }
});

test("the card's state badge is the shared StateBadge", () => {
  // Both variants: the plain span, and the button that opens the reviews modal. The button
  // needs a pending review, which a healthy fleet never has - so it is only ever exercised
  // here, not by looking at a running dashboard.
  for (const pendingReviews of [0, 2]) {
    const session = mkSession({ pendingReviews });
    assert.ok(
      card({ pendingReviews }).includes(bit(StateBadge, { session, onOpenReviews: () => {} })),
      `card should render the shared StateBadge with ${pendingReviews} pending reviews`,
    );
  }
});

test("the card's title and rename affordance are the shared SessionTitle", () => {
  // Renameable (a live session with a pane) and not (an exited one) render differently, and
  // the pencil affordance only exists in the first.
  const cases: { over: Partial<Session>; canRename: boolean }[] = [
    { over: {}, canRename: true },
    { over: { state: "exited", tmux: null, wezterm: null }, canRename: false },
  ];
  for (const { over, canRename } of cases) {
    const session = mkSession(over);
    assert.ok(
      card(over).includes(
        bit(SessionTitle, { session, canRename, renaming: false }),
      ),
      `card should render the shared SessionTitle (canRename=${canRename})`,
    );
  }
});

test("the card's context meter is the shared RuntimeMetaRow", () => {
  const m = meta({ contextPct: 73 });
  assert.ok(
    card({ meta: m }).includes(bit(RuntimeMetaRow, { meta: m })),
    "card should render the shared RuntimeMetaRow",
  );
});

test("the card's cost badge is the shared CostChip", () => {
  // Both sides of the chip's own gate. An unpriced session (no telemetry, or none yet)
  // renders nothing at all, and that empty case is the one a hand-copied card would get
  // wrong - it is what every card looks like before anyone switches telemetry on.
  const cases: (SessionCost | null)[] = [
    null,
    { costUsd: 1.24, input: 2, output: 561, cacheRead: 91_000, cacheWrite: 27_298, updatedAt: 1 },
    // Past COST_ATTENTION_USD, where the chip changes tone rather than growing a
    // second copy of itself in the tile's alert marks.
    { costUsd: 12.5, input: 2, output: 9, cacheRead: 1, cacheWrite: 1, updatedAt: 1 },
  ];
  for (const cost of cases) {
    const fragment = bit(CostChip, { cost });
    if (!fragment) {
      assert.ok(!card({ cost }).includes("cost-chip"), "an unpriced session draws no chip");
      continue;
    }
    assert.ok(card({ cost }).includes(fragment), `card should render the shared CostChip (${cost?.costUsd})`);
  }
});

test("the board tile's agent dot and context meter are the shared ones", () => {
  const m = meta({ contextPct: 73 });
  const session = mkSession({ meta: m });
  const tile = renderToStaticMarkup(
    createElement(SessionTile, {
      session,
      gateNeedsYou: false,
      onOpen: () => {},
      draggingRepo: null,
      onDropped: () => {},
      onDropError: () => {},
    }),
  );
  assert.ok(
    tile.includes(bit(AgentDot, { agent: session.agent })),
    "tile should render the shared AgentDot",
  );
  assert.ok(tile.includes(bit(RuntimeMetaRow, { meta: m })), "tile should render the shared meter");
});

test("the board tile's cost badge is the shared CostChip", () => {
  const cost: SessionCost = {
    costUsd: 3.5, input: 2, output: 561, cacheRead: 91_000, cacheWrite: 27_298, updatedAt: 1,
  };
  const session = mkSession({ cost });
  const tile = renderToStaticMarkup(
    createElement(SessionTile, {
      session,
      gateNeedsYou: false,
      onOpen: () => {},
      draggingRepo: null,
      onDropped: () => {},
      onDropError: () => {},
    }),
  );
  assert.ok(tile.includes(bit(CostChip, { cost })), "tile should render the shared CostChip");
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
      costUsd: 1.24, input: 2, output: 561, cacheRead: 91_000, cacheWrite: 27_298, updatedAt: 1,
    },
  };
  const session = mkSession(over);
  const detail = renderToStaticMarkup(
    createElement(ConsoleDetail, {
      session,
      view: {
        sessions: [session],
        tasks: [],
        onEditTask: () => {},
        backlogPlan: null,
        gateAlerts: new Set<string>(),
        selectedId: session.id,
        onSelect: () => {},
        onDeselect: () => {},
        expandedId: null,
        onToggleExpand: () => {},
        onOpenReviews: () => {},
        onOpenDiff: () => {},
        onReset: () => {},
        resetNonces: {},
        registerEl: () => {},
        registerActions: () => {},
        renamingId: null,
        onRenameStart: () => {},
        onRenameClose: () => {},
        foremanMode: "dry-run",
        foremanEnabled: false,
        foremanAllowlist: [],
        inputReviewBySession: new Map<string, string>(),
        pendingReviewIds: new Set<string>(),
      },
    }),
  );
  const html = card(over);
  for (const [name, fragment] of [
    ["AgentDot", bit(AgentDot, { agent: session.agent })],
    ["PrChip", bit(PrChip, { session })],
    ["StateBadge", bit(StateBadge, { session, onOpenReviews: () => {} })],
    ["RuntimeMetaRow", bit(RuntimeMetaRow, { meta: session.meta! })],
    ["CostChip", bit(CostChip, { cost: session.cost })],
  ] as const) {
    assert.ok(html.includes(fragment), `card should contain the shared ${name}`);
    assert.ok(detail.includes(fragment), `console detail should contain the shared ${name}`);
  }
});
