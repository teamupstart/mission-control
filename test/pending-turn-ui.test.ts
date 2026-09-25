import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PendingTurn, SteeredTurn, TranscriptMessage } from "../src/shared/types.ts";
import { PendingTurnView, SteeredTurnView } from "../src/web/components/TranscriptPanel.tsx";
import type { SessionState } from "../src/shared/types.ts";
import type { DialogBearing } from "../src/shared/session.ts";
import {
  latestEditablePendingTurn,
  PENDING_TURN_HELD_REASON,
  pendingTurnHold,
  pendingTurnStatus,
  recallPendingTurnIntoDraft,
  sentAgo,
  shouldRecallPendingTurn,
} from "../src/web/lib/pending-turns.ts";
import { steeredTurnReceipt } from "../src/shared/message-delivery.ts";

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

const MENU = {
  prompt: "Which linter?",
  options: [{ number: 1, label: "eslint" }],
  highlighted: 1,
} as DialogBearing["paneDialog"];

function bearing(state: SessionState, paneDialog: DialogBearing["paneDialog"] = null): DialogBearing {
  return { state, paneDialog };
}

test("a queued row held by an open dialog says so, and offers the jump to it", () => {
  const html = renderToStaticMarkup(
    createElement(PendingTurnView, {
      turn: turn(),
      editable: true,
      hold: "review",
      onEdit: () => {},
      onGoToReview: () => {},
    }),
  );
  // Amber, not working-blue: the row is not on its way, and the class is what says so.
  assert.match(html, /pending-turn is-queued is-held/);
  assert.match(html, /data-pending-held="review"/);
  assert.match(html, />queued · held</);
  assert.match(html, new RegExp(PENDING_TURN_HELD_REASON.review));
  assert.match(html, />Go to review</);
  // Recall stays available - the point is that the message is stuck, not that it is stuck
  // beyond the operator's reach.
  assert.match(html, />Edit</);
  // The keystroke hint yields the line to the reason.
  assert.doesNotMatch(html, /Up Arrow in an empty reply box/);
});

test("a row held by shutdown names shutdown, and offers no jump to an unrendered card", () => {
  const html = renderToStaticMarkup(
    createElement(PendingTurnView, {
      turn: turn(),
      editable: true,
      hold: "shutdown",
      onEdit: () => {},
      // Supplied deliberately: the component must refuse the jump on the hold's kind, not
      // on the caller happening to omit the handler.
      onGoToReview: () => {},
    }),
  );
  assert.match(html, /pending-turn is-queued is-held/);
  assert.match(html, /data-pending-held="shutdown"/);
  assert.match(html, />queued · held</);
  assert.match(html, new RegExp(PENDING_TURN_HELD_REASON.shutdown));
  // `activePaneDialog` reports nothing for a dying session, so `ConsoleDetail` renders no
  // dialog card - a jump here would land on an anchor that is not in the document.
  assert.doesNotMatch(html, />Go to review</);
  assert.doesNotMatch(html, /Held until you answer the review above/);
});

test("the hold a row reports is the one the daemon's gate would apply", () => {
  // `canDrain` in src/server/pending-turns.ts refuses on an active dialog AND refuses
  // anything that is not idle, so these are reads of that rule, not presentation choices.
  assert.equal(pendingTurnHold(turn(), bearing("idle", MENU)), "review");
  assert.equal(pendingTurnHold(turn(), bearing("idle")), null);
  assert.equal(pendingTurnHold(turn(), bearing("working")), null);

  // A dying session holds every queued row, dialog or no dialog, and says so as shutdown.
  // Naming the review there would point at a card `activePaneDialog` has already withdrawn.
  for (const state of ["stopping", "exited"] as const) {
    assert.equal(pendingTurnHold(turn(), bearing(state)), "shutdown");
    assert.equal(pendingTurnHold(turn(), bearing(state, MENU)), "shutdown");
  }

  // A claimed row already crossed the boundary these gates guard; an uncertain one has a
  // louder story. Neither is held, under either blocker.
  for (const state of ["sending", "uncertain"] as const) {
    assert.equal(pendingTurnHold(turn({ state }), bearing("idle", MENU)), null);
    assert.equal(pendingTurnHold(turn({ state }), bearing("exited")), null);
  }
});

test("every session state resolves to a hold that matches whether delivery is possible", () => {
  // Exhaustive over the union rather than over today's interesting cases: a new state must
  // be classified here deliberately instead of defaulting to "on its way".
  const STATES: readonly SessionState[] = [
    "starting",
    "idle",
    "working",
    "awaiting_input",
    "awaiting_review",
    "stopping",
    "exited",
  ];
  for (const state of STATES) {
    const hold = pendingTurnHold(turn(), bearing(state, MENU));
    // With a menu up, no state may report "on its way": either the dialog holds it, or the
    // session is dying and shutdown holds it. A null here is the exact ambiguity this
    // change exists to remove.
    assert.notEqual(hold, null, `state "${state}" reports a dialog-covered row as unheld`);
    const dying = state === "stopping" || state === "exited";
    assert.equal(hold, dying ? "shutdown" : "review", `state "${state}" named the wrong blocker`);
  }
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
  assert.match(html, />sent · waiting for the agent to pick it up</);
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
    assert.match(source, /pendingTurnHold\(/, `${path} does not compute the held state`);
    assert.match(source, /PENDING_TURN_HELD_STATUS/, `${path} does not relabel a held row`);
    assert.match(source, /revealPaneDialog\(/, `${path} offers no jump to the blocking review`);
  }
});

function steer(over: Partial<SteeredTurn> = {}): SteeredTurn {
  return { id: "pending-1", text: "Skip e2e for now.", acceptedAt: 100_000, ...over };
}

function said(text: string, ts: number, role: "user" | "assistant" = "user"): TranscriptMessage {
  return { id: `${role}-${ts}`, role, text, tools: [], ts };
}

test("a sending row says who it is waiting on, how long, and marks itself in flight", () => {
  const html = renderToStaticMarkup(
    createElement(PendingTurnView, {
      turn: turn({ state: "sending", revision: 1, claimedAt: 10_000 }),
      editable: false,
      agentLabel: "Claude",
      now: 52_000,
    }),
  );
  assert.match(html, />sent · waiting for Claude to pick it up</);
  assert.match(html, />Sent 0:42 ago</);
  assert.match(html, /data-in-flight="pending-1"/);
  assert.match(html, /in-flight-pulse/);
});

test("a held or queued row is not drawn as in flight", () => {
  for (const html of [
    renderToStaticMarkup(createElement(PendingTurnView, { turn: turn(), editable: true, now: 5 })),
    renderToStaticMarkup(createElement(PendingTurnView, {
      turn: turn(), editable: true, hold: "review", now: 5,
    })),
  ]) {
    assert.doesNotMatch(html, /data-in-flight/);
    assert.doesNotMatch(html, /Sent \d/);
  }
});

test("a steered row keeps the message on screen and says the agent has not read it", () => {
  const html = renderToStaticMarkup(
    createElement(SteeredTurnView, { turn: steer(), agentLabel: "claude", now: 172_000 }),
  );
  assert.match(html, /class="turn turn-user pending-turn is-steered"/);
  assert.match(html, /data-in-flight="pending-1"/);
  assert.match(html, />steered · waiting for claude to read it</);
  assert.match(html, />Skip e2e for now\.</);
  assert.match(html, />Sent 1:12 ago</);
  assert.match(html, />Claude reads steering at its next step</);
  // Accepted by the driver: there is nothing left to edit, retry, or expedite.
  assert.doesNotMatch(html, />(Edit|Retry|Steer now|Interrupt and deliver)</);
});

test("the transcript turn that carries a steered message is its receipt", () => {
  assert.equal(steeredTurnReceipt(steer(), []), null);
  assert.equal(steeredTurnReceipt(steer(), [said("Skip e2e for now.", 100_500)]), "user-100500");
  // Whitespace and a harness's own wrapping around the text do not hide it.
  assert.equal(
    steeredTurnReceipt(steer(), [said("<queued>\n  Skip e2e   for now.\n</queued>", 101_000)]),
    "user-101000",
  );
  // A transcript without timestamps cannot be ordered, so its match is taken.
  assert.equal(steeredTurnReceipt(steer(), [said("Skip e2e for now.", 0)]), "user-0");
});

test("a transcript clock up to five seconds behind the steer still counts as its receipt", () => {
  // acceptedAt is 100_000: the window opens at exactly 95_000 and not a millisecond sooner.
  assert.equal(steeredTurnReceipt(steer(), [said("Skip e2e for now.", 95_000)]), "user-95000");
  assert.equal(steeredTurnReceipt(steer(), [said("Skip e2e for now.", 94_999)]), null);
});

test("an earlier identical message, or the agent quoting it, is not the receipt", () => {
  assert.equal(steeredTurnReceipt(steer(), [said("Skip e2e for now.", 60_000)]), null);
  assert.equal(steeredTurnReceipt(steer(), [said("Skip e2e for now.", 101_000, "assistant")]), null);
  assert.equal(steeredTurnReceipt(steer({ text: "   " }), [said("   ", 101_000)]), null);
});

test("sent time reads as minutes and seconds and never goes negative", () => {
  assert.equal(sentAgo(1_000, 1_000), "0:00");
  assert.equal(sentAgo(0, 42_999), "0:42");
  assert.equal(sentAgo(0, 125_000), "2:05");
  assert.equal(sentAgo(5_000, 1_000), "0:00");
});
