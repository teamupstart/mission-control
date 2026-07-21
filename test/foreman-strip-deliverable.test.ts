import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session, SessionNoteSummary } from "../src/shared/types.ts";
import { ForemanStrip } from "../src/web/components/ForemanStrip.tsx";
import { ForemanNote } from "../src/web/components/ForemanNote.tsx";
import { deliveryTarget, undeliverable } from "../src/web/lib/foreman.ts";

// What is at stake: a button that lies about what it did.
//
// `deliveryTarget` has always known that a draft written for a since-resolved review is
// stale, and `approve()` has always honoured that - by silently calling `dismiss()`. But no
// surface ASKED, so the strip kept drawing "Approve & send" over it, and the human who
// clicked read the note vanishing as "sent". Nothing was sent. The reported session had one
// of these in its notes table: an escalation whose review had been answered 90 minutes
// earlier, still pinned, still offering to send.
//
// The second shape is worse because Foreman raised it deliberately. An escalation with
// `lastAction: "escalated (no reply channel)"` exists BECAUSE nothing could deliver it - and
// the strip offered to deliver it anyway, into whatever pane the session happened to have.
//
// Rendered rather than checked as a pure rule, for the reason `foreman-note.test.ts` gives:
// the predicate was never wrong, nothing asked it. A test below the component could not have
// caught this.

const PANE = { session: "m", window: "w", windowIndex: 1, paneId: "%13" };

/** These components read id/cwd/repoRoot/tmux/wezterm off the session; the cast keeps that honest. */
function mkSession(over: Partial<Session> = {}): Session {
  return { id: "s1", cwd: "/repo", repoRoot: "/repo", tmux: PANE, wezterm: null, ...over } as Session;
}

function mkNote(over: Partial<SessionNoteSummary> = {}): SessionNoteSummary {
  return {
    disposition: "escalated",
    purpose: "Whether to move the collapse heuristic onto ControlSpec.",
    brief: null,
    recommendation: "Chose option 1, move it onto ControlSpec.",
    lastAction: "escalated for your decision",
    handledMarker: "review:rev-1",
    updatedAt: 0,
    ...over,
  } as SessionNoteSummary;
}

function strip(o: {
  session?: Session;
  note?: SessionNoteSummary;
  pendingReviewIds?: ReadonlySet<string>;
}): string {
  return renderToStaticMarkup(
    createElement(ForemanStrip, {
      session: o.session ?? mkSession(),
      note: o.note ?? mkNote(),
      mode: "live",
      enabled: true,
      inputReviewId: null,
      pendingReviewIds: o.pendingReviewIds,
    }),
  );
}

// ---- the predicate ----

test("a draft for a still-pending review is deliverable", () => {
  const t = deliveryTarget({
    handledMarker: "review:rev-1",
    inputReviewId: null,
    pendingReviewIds: new Set(["rev-1"]),
    canSend: true,
  });
  assert.deepEqual(t, { kind: "review", reviewId: "rev-1" });
  assert.equal(undeliverable(t), null);
});

test("a draft for a resolved review is stale, and says so in the human's terms", () => {
  const t = deliveryTarget({
    handledMarker: "review:rev-1",
    inputReviewId: null,
    pendingReviewIds: new Set(),
    canSend: true,
  });
  assert.equal(t.kind, "stale");
  assert.match(undeliverable(t) ?? "", /already been resolved/);
});

test("a terminal draft with no pane has no channel, and names the reason", () => {
  const t = deliveryTarget({
    handledMarker: "dialog:abc123",
    inputReviewId: null,
    pendingReviewIds: new Set(),
    canSend: false,
  });
  assert.equal(t.kind, "no-channel");
  assert.match(undeliverable(t) ?? "", /no terminal pane/);
});

test("omitting canSend keeps the old behaviour exactly", () => {
  // Defaulted to true on purpose: withholding a send the human asked for is not the safe
  // side, so the refusal is made only on positive evidence that there is no pane.
  const t = deliveryTarget({ handledMarker: "await:1", inputReviewId: null, pendingReviewIds: new Set() });
  assert.deepEqual(t, { kind: "send" });
});

// ---- the strip ----

test("the strip offers Approve for a note it can actually deliver", () => {
  const html = strip({ pendingReviewIds: new Set(["rev-1"]) });
  assert.match(html, /Approve &amp; send/);
});

test("the strip does NOT offer Approve for a since-resolved review", () => {
  const html = strip({ pendingReviewIds: new Set() });
  assert.doesNotMatch(html, /Approve &amp; send/, "clicking it would silently dismiss, reading as sent");
  assert.match(html, /Dismiss/, "the human still needs a way to clear it");
});

test("the strip explains a stale note instead of leaving a dead control", () => {
  // The collapsed row is one line by construction, so the sentence lives in the body - but it
  // must be THERE, or the missing button reads as the dashboard being broken.
  const html = renderToStaticMarkup(
    createElement(ForemanStrip, {
      session: mkSession(),
      note: mkNote(),
      mode: "live",
      enabled: true,
      inputReviewId: null,
      pendingReviewIds: new Set<string>(),
    }),
  );
  assert.match(html, /fs-summary/, "still pinned - it is still a thing you owe a click");
  assert.doesNotMatch(html, /Approve &amp; send/);
});

test("an escalation raised with no reply channel does not offer to send itself", () => {
  // The reported shape. Foreman said "no reply channel" and the strip offered to type the
  // recommendation into the session anyway - which, on a session that had gone back to work,
  // meant a paragraph of prose arriving in a running agent's composer.
  const html = strip({
    session: mkSession({ tmux: null, wezterm: null }),
    note: mkNote({ handledMarker: "state:working:1784594261899", lastAction: "escalated (no reply channel)" }),
  });
  assert.doesNotMatch(html, /Approve &amp; send/);
});

test("a terminal escalation on a session that still HAS a pane keeps its Approve", () => {
  // The guard is deliverability, not a blanket refusal of terminal notes: a real ask on a
  // real pane is exactly what the button is for.
  const html = strip({ note: mkNote({ handledMarker: "dialog:abc123" }) });
  assert.match(html, /Approve &amp; send/);
});

test("the strip unmounts for a note that owes nothing, from the shared predicate", () => {
  for (const disposition of ["answered", "skipped"] as const) {
    assert.equal(strip({ note: mkNote({ disposition }) }), "", `${disposition} pins nothing`);
  }
});

// ---- the same note, in the grid card ----

test("the grid card explains an undeliverable note too", () => {
  // Four components draw a session and only one of them is SessionCard; the note is shared by
  // two of them. A card that stays silent about why Foreman never sent this leaves the grid
  // showing a suggested answer with no account of it.
  const html = renderToStaticMarkup(
    createElement(ForemanNote, {
      session: mkSession({ tmux: null, wezterm: null }),
      note: mkNote({ handledMarker: "state:working:1", lastAction: "escalated (no reply channel)" }),
      mode: "live",
      enabled: true,
      inputReviewId: null,
    }),
  );
  assert.match(html, /no terminal pane/);
  assert.doesNotMatch(html, /Approve &amp; send/);
});
