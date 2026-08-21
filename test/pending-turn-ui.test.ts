import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PendingTurn } from "../src/shared/types.ts";
import { PendingTurnView } from "../src/web/components/TranscriptPanel.tsx";
import {
  latestEditablePendingTurn,
  PENDING_TURN_HELD_REASON,
  pendingTurnHeld,
  pendingTurnStatus,
  recallPendingTurnIntoDraft,
  shouldRecallPendingTurn,
} from "../src/web/lib/pending-turns.ts";

function turn(over: Partial<PendingTurn> = {}): PendingTurn {
  return {
    id: "pending-1",
    noteKey: "conversation-1",
    seq: 0,
    text: "Please check the queue race.",
    state: "queued",
    revision: 0,
    createdAt: 1,
    updatedAt: 1,
    claimedAt: null,
    lastError: null,
    ...over,
  };
}

test("the pending row renders as a complete human turn with edit guidance", () => {
  const html = renderToStaticMarkup(
    createElement(PendingTurnView, {
      turn: turn(),
      editable: true,
      onEdit: () => {},
    }),
  );
  assert.match(html, /turn-user pending-turn is-queued/);
  assert.match(html, />You</);
  assert.match(html, />queued</);
  assert.match(html, /Please check the queue race\./);
  assert.match(html, />Edit</);
  assert.match(html, /Up Arrow in an empty reply box/);
});

test("a queued row held by an open dialog says so, and offers the jump to it", () => {
  const html = renderToStaticMarkup(
    createElement(PendingTurnView, {
      turn: turn(),
      editable: true,
      held: true,
      onEdit: () => {},
      onGoToReview: () => {},
    }),
  );
  // Amber, not working-blue: the row is not on its way, and the class is what says so.
  assert.match(html, /pending-turn is-queued is-held/);
  assert.match(html, /data-pending-held="true"/);
  assert.match(html, />queued · held</);
  assert.match(html, new RegExp(PENDING_TURN_HELD_REASON));
  assert.match(html, />Go to review</);
  // Recall stays available - the point is that the message is stuck, not that it is stuck
  // beyond the operator's reach.
  assert.match(html, />Edit</);
  // The keystroke hint yields the line to the reason.
  assert.doesNotMatch(html, /Up Arrow in an empty reply box/);
});

test("held is exactly the daemon's own precondition: an open dialog over a queued row", () => {
  // `canDrain` in src/server/pending-turns.ts refuses delivery while `paneDialog` is set,
  // so this predicate is a read of that rule and not a presentation choice.
  assert.equal(pendingTurnHeld(turn(), true), true);
  assert.equal(pendingTurnHeld(turn(), false), false);
  // A claimed row already crossed the boundary the dialog guards; an uncertain one has a
  // louder story. Neither is "held".
  assert.equal(pendingTurnHeld(turn({ state: "sending" }), true), false);
  assert.equal(pendingTurnHeld(turn({ state: "uncertain" }), true), false);
});

test("an unheld queued row is unchanged by the held affordance existing", () => {
  const html = renderToStaticMarkup(
    createElement(PendingTurnView, { turn: turn(), editable: true, onEdit: () => {} }),
  );
  assert.doesNotMatch(html, /is-held/);
  assert.doesNotMatch(html, />Go to review</);
  assert.match(html, /Up Arrow in an empty reply box/);
});

test("sending rows cannot be edited", () => {
  const html = renderToStaticMarkup(
    createElement(PendingTurnView, {
      turn: turn({ state: "sending", revision: 1, claimedAt: 2 }),
      editable: false,
    }),
  );
  assert.match(html, /data-pending-state="sending"/);
  assert.match(html, />sending</);
  assert.doesNotMatch(html, />Edit</);
  assert.doesNotMatch(html, />Retry</);
});

test("uncertain rows explain the failure and expose both human resolutions", () => {
  const html = renderToStaticMarkup(
    createElement(PendingTurnView, {
      turn: turn({ state: "uncertain", revision: 2, lastError: "pickup was not observed" }),
      editable: false,
      onRetry: () => {},
      onMarkSent: () => {},
    }),
  );
  assert.match(html, /delivery uncertain/);
  assert.match(html, /pickup was not observed/);
  assert.match(html, />Retry</);
  assert.match(html, />Mark sent</);
});

test("Arrow Up recall requires an empty, unmodified, attachment-free composer", () => {
  const base = {
    key: "ArrowUp",
    value: "",
    selectionStart: 0,
    selectionEnd: 0,
    composing: false,
    modified: false,
    busy: false,
    hasAttachments: false,
  };
  assert.equal(shouldRecallPendingTurn(base), true);
  for (const override of [
    { key: "ArrowDown" },
    { value: "draft" },
    { composing: true },
    { modified: true },
    { busy: true },
    { hasAttachments: true },
  ]) {
    assert.equal(shouldRecallPendingTurn({ ...base, ...override }), false);
  }
});

test("recall targets the newest queued row, skipping sending and uncertain rows", () => {
  const turns = [
    turn({ id: "a", seq: 0 }),
    turn({ id: "b", seq: 1, state: "sending" }),
    turn({ id: "c", seq: 2 }),
    turn({ id: "d", seq: 3, state: "uncertain" }),
  ];
  assert.equal(latestEditablePendingTurn(turns)?.id, "c");
  assert.equal(latestEditablePendingTurn(turns.filter((item) => item.state !== "queued")), null);
  assert.equal(pendingTurnStatus(turns[3]!), "delivery uncertain");
});

test("the shared recall abstraction restores acknowledged server text", async () => {
  const selected = turn({ text: "local copy" });
  let restored: string | null = null;
  const result = await recallPendingTurnIntoDraft({
    client: {
      recallPendingTurn: async (sessionId, turnId, revision) => {
        assert.deepEqual([sessionId, turnId, revision], ["s1", selected.id, selected.revision]);
        return { ok: true, status: 200, text: "acknowledged copy" };
      },
    },
    sessionId: "s1",
    turn: selected,
    restore: (text) => {
      restored = text;
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.acknowledgementLost, undefined);
  assert.equal(restored, "acknowledged copy");
});

test("recall response loss restores the exact locally known multiline text", async () => {
  const selected = turn({ text: "race.\nDo not steer" });
  let restored: string | null = null;
  const result = await recallPendingTurnIntoDraft({
    client: {
      recallPendingTurn: async () => ({ ok: false, error: "connection closed" }),
    },
    sessionId: "s1",
    turn: selected,
    restore: (text) => {
      restored = text;
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.acknowledgementLost, true);
  assert.equal(restored, "race.\nDo not steer");
});

test("an explicit recall CAS conflict leaves the draft untouched", async () => {
  const selected = turn();
  let restored = false;
  const result = await recallPendingTurnIntoDraft({
    client: {
      recallPendingTurn: async () => ({
        ok: false,
        status: 409,
        error: "that queued message is no longer editable",
      }),
    },
    sessionId: "s1",
    turn: selected,
    restore: () => {
      restored = true;
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 409);
  assert.equal(restored, false);
});

test("a successful recall with a lost response body falls back to local text", async () => {
  const selected = turn({ text: "known before recall" });
  let restored: string | null = null;
  const result = await recallPendingTurnIntoDraft({
    client: {
      recallPendingTurn: async () => ({ ok: true, status: 200 }),
    },
    sessionId: "s1",
    turn: selected,
    restore: (text) => {
      restored = text;
    },
  });

  assert.equal(result.acknowledgementLost, true);
  assert.equal(restored, "known before recall");
});

test("both uncontrolled composer surfaces wire Arrow Up to the shared recall guard", () => {
  for (const path of [
    "src/web/components/TranscriptPanel.tsx",
    "src/web/components/ActionBar.tsx",
  ]) {
    const source = readFileSync(path, "utf8");
    assert.match(source, /shouldRecallPendingTurn\(/, `${path} has no recall guard`);
    assert.match(
      source,
      /recallPendingTurnIntoDraft\(/,
      `${path} does not use the acknowledged recall abstraction`,
    );
    assert.match(source, /writeDraft\(/, `${path} does not restore the recalled draft`);
    assert.match(source, /setSelectionRange\(/, `${path} does not put the caret at the end`);
  }
});

test("both surfaces mark a held queued row, so neither can quietly keep the old blue", () => {
  // The queue is drawn twice - the transcript's `PendingTurnView` and the ActionBar's
  // mini-list - and a held row that reads "queued" in one of them is the exact confusion
  // this indicator exists to remove.
  for (const path of [
    "src/web/components/TranscriptPanel.tsx",
    "src/web/components/ActionBar.tsx",
  ]) {
    const source = readFileSync(path, "utf8");
    assert.match(source, /pendingTurnHeld\(/, `${path} does not compute the held state`);
    assert.match(source, /PENDING_TURN_HELD_STATUS/, `${path} does not relabel a held row`);
    assert.match(source, /revealPaneDialog\(/, `${path} offers no jump to the blocking review`);
  }
});
