import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AlertPanel } from "../src/web/components/AlertBar.tsx";
import type { AwayConfig } from "../src/shared/protocol.ts";
import type { AwayBufferSummary } from "../src/shared/away-buffer.ts";

/**
 * What is at stake: the panel has to LOOK like what it is, in every state it has.
 *
 * The three controls used to be three bare checkboxes that looked identical but were
 * not alike - two are per-machine browser preferences, one is server state that survives
 * the tab closing. The redesign encodes that difference structurally (a labelled channel
 * section, then away mode as its own card), so these assert the structure rather than the
 * copy: a card that quietly became a fourth row would still pass a text-only test.
 *
 * The muted case gets the most attention because it is the one that can lie. Rendered,
 * it must carry the muted tone AND drop the away tint, so the glance and the sentence
 * agree that nothing is getting through.
 *
 * `createElement` rather than JSX because the runner's glob only matches .test.ts, and
 * `renderToStaticMarkup` rather than jsdom because nothing here needs a DOM - `now` and
 * the permission are props for exactly that reason.
 */

const NOW = 1_000_000_000;

const awayOn: AwayConfig = {
  away: true,
  awaySince: NOW - 64 * 60_000, // 1h 04m, the mockup's own figure
  detectStalls: true,
  stallWorkingMinutes: 10,
  stallUnfinishedMinutes: 20,
  stallGateMinutes: 5,
  stallEscalationMinutes: 5,
};
const awayOff: AwayConfig = { ...awayOn, away: false, awaySince: null };

const buffered: AwayBufferSummary = {
  since: awayOn.awaySince,
  count: 7,
  dropped: 0,
  rollup: "1 stuck · 6 finished",
  lines: ["Session wedged - silent for 40m", "api-refactor finished"],
};

function render(props: Partial<Parameters<typeof AlertPanel>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(AlertPanel, {
      perm: "granted" as NotificationPermission,
      desktopOn: true,
      soundOn: true,
      away: awayOff,
      buffered: null,
      now: NOW,
      preview: false,
      onEnable: () => {},
      onFlipDesktop: () => {},
      onFlipSound: () => {},
      onFlipAway: () => {},
      onTogglePreview: () => {},
      ...props,
    }),
  );
}

test("channels are switches under a section heading, not bare checkboxes", () => {
  const html = render();
  assert.match(html, /How you&#x27;re reached/);
  assert.match(html, /class="alert-channel"/);
  assert.match(html, /role="switch"[^>]*aria-checked="true"[^>]*aria-label="Desktop notifications"/);
  assert.match(html, /aria-label="Sound"/);
  assert.match(html, /class="pal-switch" data-on="true"/, "reuses the app's own pill switch");
  assert.doesNotMatch(html, /type="checkbox"/, "the checkboxes are gone");
});

// The away control must not be drawn as a third channel row - that identical-looking
// third checkbox is the defect this redesign exists to fix.
test("away mode is a card, not a third channel row", () => {
  const html = render();
  assert.match(html, /class="alert-card"/);
  assert.match(html, /class="alert-card-title">Away mode/);
  const channels = html.match(/class="alert-channel"/g) ?? [];
  assert.equal(channels.length, 2, "exactly the two delivery channels are rows");
});

test("reachable: ok tone, card untinted, no away meta", () => {
  const html = render();
  assert.match(html, /data-tone="ok"/);
  assert.match(html, /data-on="false"[^>]*data-tone="ok"/);
  assert.match(html, /You&#x27;re reachable/);
  assert.doesNotMatch(html, /class="alert-meta"/, "nothing to report when you're at the desk");
});

test("away: the card expands with elapsed time, the buffered count and a Digest button", () => {
  const html = render({ away: awayOn, buffered });
  assert.match(html, /data-tone="away"/);
  assert.match(html, /class="alert-card" data-on="true"/);
  assert.match(html, /class="alert-fig">away 1h 04m/, "elapsed time, from awaySince");
  assert.match(html, /7 buffered/, "the count the digest route could never supply");
  assert.match(html, /Digest<\/button>/);
  assert.match(html, /Away 1h 04m\. Blockers interrupt via desktop and sound/);
});

test("away with an empty buffer says so and disables the Digest button", () => {
  const html = render({ away: awayOn, buffered: { ...buffered, count: 0, lines: [], rollup: "" } });
  assert.match(html, /nothing buffered yet/);
  assert.match(html, /Digest<\/button>/);
  assert.match(html, /disabled=""/, "nothing to look at yet");
});

test("away ignores a buffer summary from a different window", () => {
  const html = render({
    away: awayOn,
    buffered: { ...buffered, since: awayOn.awaySince! - 60_000 },
    preview: true,
  });
  assert.match(html, /nothing buffered yet/);
  assert.match(html, /Digest<\/button>/);
  assert.match(html, /disabled=""/, "a stale window has nothing current to preview");
  assert.doesNotMatch(html, /7 buffered/);
  assert.doesNotMatch(html, /1 stuck · 6 finished/);
  assert.doesNotMatch(html, /Session wedged - silent for 40m/);
});

test("the preview lists what is waiting, only when unfolded", () => {
  const folded = render({ away: awayOn, buffered });
  assert.doesNotMatch(folded, /class="alert-preview"/);
  const open = render({ away: awayOn, buffered, preview: true });
  assert.match(open, /class="alert-preview"/);
  assert.match(open, /1 stuck · 6 finished/);
  assert.match(open, /Session wedged - silent for 40m/);
});

test("a capped buffer states what it left out rather than truncating silently", () => {
  const html = render({
    away: awayOn,
    buffered: { ...buffered, dropped: 12 },
    preview: true,
  });
  assert.match(html, /\+12 beyond the buffer&#x27;s cap/);
});

// The invariant, rendered. Away mode is not a delivery path.
test("both channels off while away: muted tone, and no promise anything gets through", () => {
  const html = render({ desktopOn: false, soundOn: false, away: awayOn, buffered });
  assert.match(html, /data-tone="muted"/, "the tint drops the away accent for the warning one");
  assert.match(html, /Nothing can reach you/);
  assert.match(html, /only get the digest when you return/);
  assert.doesNotMatch(html, /Blockers interrupt/, "must not claim blockers get through");
  // Still away, so the card still reports the window it is holding.
  assert.match(html, /7 buffered/);
});

test("both channels off at the desk: muted, and the dashboard is the only signal", () => {
  const html = render({ desktopOn: false, soundOn: false });
  assert.match(html, /data-tone="muted"/);
  assert.match(html, /the dashboard is the only signal/);
});

test("away is disabled until the daemon has answered, rather than guessing not-away", () => {
  const html = render({ away: null });
  assert.match(html, /aria-label="Away mode"[^>]*disabled=""/);
  assert.match(html, /data-disabled="true"/);
});

test("without notification permission the channel is offered but not claimed", () => {
  const html = render({ perm: "denied", desktopOn: false });
  assert.match(html, /Enable desktop alerts/);
  assert.match(html, /aria-label="Desktop notifications"[^>]*disabled=""/);
});
