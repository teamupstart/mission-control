import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ForemanEpisode, Session } from "../src/shared/types.ts";
import {
  ConsoleDetail,
  ForemanRail,
  inviteFailure,
} from "../src/web/components/layouts/ConsoleDetail.tsx";
import { QueueHint, WorkQueue } from "../src/web/components/WorkQueue.tsx";
import { mkSession } from "./helpers/session-fixture.ts";
import { mkSessionView } from "./helpers/session-view.ts";

/**
 * The two things an operator sees about Foreman's participation in a session: the control
 * that grants or reads it, and the sentence that explains its absence.
 *
 * Phase 2 made Foreman refuse to act in a session it was not invited into. What that left
 * on screen was a slot that either read "Foreman intent" or was not there at all, with no
 * way to tell "Foreman has nothing to say yet" apart from "Foreman is not allowed in
 * here" - and no way to change the second. A work queue in the same session accepted
 * items under a panel that never said nobody was coming for them. These pin both.
 *
 * `ForemanRail` is rendered directly rather than through `ConsoleDetail` for the count
 * states: the episodes behind `Foreman · N` arrive from `api.episodes` inside an effect,
 * and `renderToStaticMarkup` runs no effects, so a test driving the whole detail can only
 * ever see the empty-history rail. The case that DOES travel through `ConsoleDetail` is
 * asserted there as well, because which session field feeds the control is half of what
 * this phase changed.
 */

let episodeId = 0;
function mkEpisode(over: Partial<ForemanEpisode> = {}): ForemanEpisode {
  return {
    id: ++episodeId,
    marker: `m${episodeId}`,
    disposition: "answered",
    question: "Needs approval: Bash",
    purpose: "Polling GitHub until the pending CI job finishes.",
    createdAt: 0,
    ...over,
  } as ForemanEpisode;
}

function rail(o: {
  session?: Session;
  episodes?: ForemanEpisode[];
  live?: boolean;
  drawerOpen?: boolean;
  busy?: boolean;
}): string {
  return renderToStaticMarkup(
    createElement(ForemanRail, {
      session: o.session ?? mkSession(),
      episodes: o.episodes ?? [],
      live: o.live ?? true,
      drawerOpen: o.drawerOpen ?? false,
      busy: o.busy ?? false,
      onToggleDrawer: () => undefined,
      onInvite: () => undefined,
    }),
  );
}

const detailHtml = (session: Session): string =>
  renderToStaticMarkup(createElement(ConsoleDetail, { session, view: mkSessionView(session) }));

// ---- state 1: uninvited ----

test("an uninvited session is offered the invite, not a reading it cannot get", () => {
  const html = rail({ session: mkSession({ foremanInvite: null }) });
  assert.match(html, /Invite foreman/);
  assert.match(html, /foreman-rail invite/, "wears the Foreman accent, so it reads as an action");
  assert.doesNotMatch(html, /Foreman intent/, "the slot has ONE meaning at a time");
  assert.doesNotMatch(html, /aria-expanded/, "it opens nothing - it writes an invite");
});

test("the invite affordance is disabled while its write is in flight", () => {
  // The route is not idempotent in cost, and the rail only flips when the resulting
  // session_upsert lands - so without this the gap between the two is clickable.
  const html = rail({ session: mkSession({ foremanInvite: null }), busy: true });
  assert.match(html, /disabled=""/);
});

test("an exited, uninvited session offers nothing at all", () => {
  // Inviting Foreman into a session that has stopped buys an operator nothing: there is
  // no queue to tick, no wrap-up to prompt, and nothing left to type into.
  assert.equal(rail({ session: mkSession({ foremanInvite: null }), live: false }), "");
});

// ---- state 2: invited, no history ----

test("an invited session with no history still shows the rail", () => {
  // The regression this phase fixes on the invited side. The old gate was
  // `episodes.length > 0 || session.goal`, so the seconds between an invite and Foreman's
  // first reading rendered an empty slot - taking the drawer, and with it the only way to
  // withdraw the invite again, out of reach exactly when it is most wanted.
  const html = rail({ session: mkSession({ goal: null }), episodes: [] });
  assert.match(html, /Foreman intent/);
  assert.match(html, /aria-expanded="false"/, "it opens the drawer");
  assert.doesNotMatch(html, /foreman-rail invite/);
});

// ---- state 3: invited, with history ----

test("history is counted on the rail, and open decisions raise the dot", () => {
  const settled = rail({ episodes: [mkEpisode(), mkEpisode()] });
  assert.match(settled, /Foreman · 2/);
  assert.doesNotMatch(settled, /fr-dot/, "nothing is waiting on the operator");

  const waiting = rail({ episodes: [mkEpisode(), mkEpisode({ disposition: "escalated" })] });
  assert.match(waiting, /Foreman · 2/);
  assert.match(waiting, /fr-dot/, "one of them needs a decision");
});

// ---- the wiring, through the detail that owns it ----

test("ConsoleDetail drives the slot from the session's own invite field", () => {
  const invited = detailHtml(mkSession());
  assert.match(invited, /Foreman intent/);
  assert.doesNotMatch(invited, /Invite foreman/);

  // The same detail, the same tab strip, one field different - which is the whole claim.
  // Nothing else about the session changed, so nothing else can be the cause.
  const uninvited = detailHtml(mkSession({ foremanInvite: null }));
  assert.match(uninvited, /Invite foreman/);
  assert.doesNotMatch(uninvited, /Foreman intent/);
  assert.match(uninvited, /detail-tabs/, "still the same strip, not a suppressed one");
});

// ---- a refused write, and the sentence that has to admit it ----
//
// `api`'s writes go through `request()`, which never rejects: a 500, a vanished session or
// a dropped connection all settle as `{ ok: false, error }`. So "the promise resolved" is
// not "it worked", and the withdrawal case is where that distinction has teeth - Foreman
// is still in the session, and still typing.

test("a refused write leads with what is still true, not with the failure", () => {
  const withdrawn = inviteFailure("withdraw", "HTTP 500");
  // The operator's actual exposure: something may still be acting in their session.
  assert.match(withdrawn, /still be triaging/);
  assert.match(withdrawn, /not withdrawn/);
  assert.match(withdrawn, /HTTP 500/, "the daemon's own words survive");

  const invited = inviteFailure("invite", undefined);
  assert.match(invited, /still not in this session/);
  // No reason to give, so no dangling punctuation where one would have gone.
  assert.doesNotMatch(invited, /:/);
  assert.doesNotMatch(invited, /\.\./);
});

test("a multi-line refusal is flattened and clamped into one line", () => {
  // A zod rejection arrives as a JSON dump. This line has one row to live in, and the
  // sentence after the reason is the part that must survive.
  const noisy = inviteFailure("withdraw", `{\n  "issues": [\n${"x".repeat(200)}\n  ]\n}`);
  assert.doesNotMatch(noisy, /\n/);
  assert.match(noisy, /…/, "clamped rather than allowed to run over the sentence");
  assert.match(noisy, /still be triaging/, "the consequence survives the clamp");
});

// ---- the other half: the panel that would otherwise say nothing ----

const queueHtml = (session: Session, enabled = true): string =>
  renderToStaticMarkup(
    createElement(WorkQueue, {
      session,
      foremanMode: "live",
      foremanEnabled: enabled,
      allowlisted: true,
      onToggleCollapsed: () => {},
    }),
  );

test("an uninvited session's work queue says so over an EMPTY queue", () => {
  // The panel an operator actually meets. `renderToStaticMarkup` runs no effects, so the
  // fetched queue is empty here - which is the exact branch that used to return an add box
  // and nothing else, and the one the other reasons deliberately stay silent in.
  const html = queueHtml(mkSession({ foremanInvite: null }));
  assert.match(html, /Nothing queued/);
  assert.match(html, /Foreman is not in this session/);
  assert.match(html, /invite it from the rail above/);
});

test("an invited session's empty queue still explains nothing - there is nothing to explain", () => {
  const html = queueHtml(mkSession());
  assert.doesNotMatch(html, /wq-hint/, "no items, so no claim about what happens to them");
});

test("an empty queue with Foreman off says nothing either", () => {
  // `foreman-off` outranks the invite, and its sentence is about items keeping their
  // order while they wait. With no items that is a sentence about nothing, so the panel
  // stays quiet rather than reaching past the winning reason for one it can render.
  const html = queueHtml(mkSession({ foremanInvite: null }), false);
  assert.doesNotMatch(html, /wq-hint/);
});

/**
 * The uninvited line is the only one that renders when nothing is waiting, which makes it
 * the only one that has to look at what the panel is actually DRAWING above it.
 *
 * A queue whose items have all finished is not empty on screen - the list renders every
 * item, terminal ones included - but `open.length` is 0. Read as "nothing here at all",
 * that prints "Nothing queued" directly beneath six completed rows: a false claim, made by
 * the one reason whose entire job is to stop an operator reading silence as a bug.
 *
 * `QueueHint` is asserted directly because the panel gets its items from a fetch and
 * `renderToStaticMarkup` runs no effects - the all-finished queue is unreachable through
 * `WorkQueue`, which is how it survived review.
 */
const hintHtml = (o: { waiting: number; drawn: number }): string =>
  renderToStaticMarkup(
    createElement(QueueHint, {
      enabled: true,
      mode: "live",
      allowlisted: true,
      session: mkSession({ foremanInvite: null }),
      ...o,
    }),
  );

test("the uninvited line says what is true of the list it stands under", () => {
  assert.match(hintHtml({ waiting: 2, drawn: 2 }), /nothing here will be drafted or sent/);
  assert.match(hintHtml({ waiting: 2, drawn: 2 }), /work through these/);

  // Items on screen, none of them waiting. It must not claim the queue is empty.
  const finished = hintHtml({ waiting: 0, drawn: 6 });
  assert.match(finished, /Nothing is waiting/);
  assert.doesNotMatch(finished, /Nothing queued/, "six completed rows are drawn right above it");
  assert.match(finished, /Foreman is not in this session/, "still explains the absence");

  // Genuinely nothing - the panel explaining itself rather than its contents.
  const empty = hintHtml({ waiting: 0, drawn: 0 });
  assert.match(empty, /Nothing queued/);
  assert.doesNotMatch(empty, /Nothing is waiting/);
});

test("a finished queue in an INVITED session still says nothing", () => {
  // The `waiting === 0` retirement is unchanged for every other reason: they are claims
  // about items that will be acted on, and there are none.
  const html = renderToStaticMarkup(
    createElement(QueueHint, {
      enabled: true,
      mode: "dry-run",
      allowlisted: true,
      session: mkSession(),
      waiting: 0,
      drawn: 6,
    }),
  );
  assert.equal(html, "");
});
