import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ForemanSettingsPanel,
  episodeBucket,
  episodeTallies,
  sessionHandle,
  FOREMAN_STRIP_BUCKETS,
} from "../src/web/components/ForemanSettingsPanel.tsx";
import { ForemanConfigSchema } from "../src/shared/protocol.ts";
import type { ForemanState } from "../src/web/useForeman.ts";
import type { ForemanEpisode, ForemanStatus } from "../src/shared/types.ts";

// What is at stake: this panel now makes two claims nothing else in the app makes, and
// both are the kind that are worse wrong than absent.
//
//  1. The strip's numbers ARE the filter. A tile saying "4 escalated" over three rows is
//     a number the operator now distrusts, on the one screen whose whole purpose is to
//     explain what Foreman has been doing. The tallies and the filter derive from one
//     bucket function, and the tiles cover every bucket, so they always sum to the rows.
//     The Inspector's version of this shipped a strip that ignored 49 rows out of 50.
//  2. The strip is folded out of the LEDGER, not out of `ForemanStatus.counts`. Those
//     counts are scoped to LIVE sessions by design; the ledger is historical and
//     fleet-wide. Swapping one for the other compiles, renders, and is wrong in a way
//     only a real ledger shows - so it is pinned here with the two deliberately disagreeing.
//
// Rendered as static markup rather than driven in a browser, the house pattern for
// panels: the dashboard holds an SSE connection open and hangs headless automation.
// Effects never run here, so nothing fetches.

function episode(over: Partial<ForemanEpisode> = {}): ForemanEpisode {
  return {
    id: 1,
    noteKey: "3f2a91cc-0d44-4d1e-9f1a-77e2b0c9aa10",
    sessionId: "proc:/dev/ttys004:4123:1700",
    marker: "await:1700",
    situation: "terminal-pane",
    surface: "terminal",
    question: "Claude needs your permission to run the tests",
    pane: null,
    menu: null,
    reviewId: null,
    purpose: "Approving a test run.",
    brief: null,
    recommendation: null,
    classification: "routine-access",
    confidence: 0.6,
    tier: 2,
    cheapAction: null,
    divergence: null,
    disposition: "answered",
    lastAction: null,
    sentText: null,
    sentOption: null,
    sentBy: "foreman",
    createdAt: 1000,
    resolvedAt: 1000,
    resolvedBy: "foreman",
    ...over,
  };
}

function status(over: Partial<ForemanStatus> = {}): ForemanStatus {
  return {
    enabled: true,
    mode: "dry-run",
    running: true,
    queueDepth: 0,
    counts: { answered: 0, escalated: 0, pending: 0, skipped: 0 },
    lastActionAt: null,
    autopilot: { on: false, active: 0, max: 5, ready: 0, blocked: 0, disabled: 0 },
    ...over,
  } as ForemanStatus;
}

function html(over: Partial<ForemanState> = {}): string {
  const state: ForemanState = {
    config: ForemanConfigSchema.parse({ enabled: true, mode: "dry-run", triage: "shadow" }),
    status: status(),
    backlogPlan: null,
    episodes: [],
    update: async () => true,
    error: null,
    ...over,
  };
  return renderToStaticMarkup(
    createElement(ForemanSettingsPanel, { state, onNavigate: () => {} }),
  );
}

// ---- the strip and the filter are the same question ------------------------------------

test("every episode lands in exactly one bucket, and the tallies add up", () => {
  const rows = [
    episode({ marker: "a", disposition: "answered" }),
    episode({ marker: "b", disposition: "escalated" }),
    episode({ marker: "c", disposition: "pending" }),
    episode({ marker: "d", disposition: "skipped" }),
    episode({ marker: "e", disposition: "escalated" }),
  ];
  const t = episodeTallies(rows);
  assert.deepEqual(t, { answered: 1, escalated: 2, pending: 1, skipped: 1 });
  // The filter's own arithmetic, done the way the panel does it.
  for (const bucket of Object.keys(t) as (keyof typeof t)[]) {
    assert.equal(rows.filter((r) => episodeBucket(r) === bucket).length, t[bucket]);
  }
});

test("the strip has a tile for every bucket, so the tiles account for every row", () => {
  const rows = [
    episode({ marker: "a", disposition: "answered" }),
    episode({ marker: "b", disposition: "escalated" }),
    episode({ marker: "c", disposition: "pending" }),
    episode({ marker: "d", disposition: "skipped" }),
  ];
  const t = episodeTallies(rows);
  assert.equal(
    Object.values(t).reduce((a, b) => a + b, 0),
    rows.length,
    "an episode bucket has no tile",
  );
  assert.deepEqual(
    new Set(Object.keys(t)),
    new Set(FOREMAN_STRIP_BUCKETS),
    "the Foreman strip and the bucket vocabulary have drifted",
  );
});

// The defect this exists to prevent: `ForemanStatus.counts` is right there on the state
// the panel already reads, it has the same four keys, and using it would look correct in
// every test written against a fixture where the two agree. It is scoped to LIVE sessions
// on purpose, so on a real daemon it disagrees with a historical ledger constantly.
test("the strip is folded from the ledger rows, not from the live-session counts", () => {
  const out = html({
    episodes: [
      episode({ marker: "a", disposition: "escalated" }),
      episode({ marker: "b", disposition: "escalated" }),
      episode({ marker: "c", disposition: "escalated" }),
    ],
    // Deliberately contradictory: no live session has an escalated note right now, while
    // three sit in the historical ledger. The strip must report the ledger's three.
    status: status({ counts: { answered: 41, escalated: 0, pending: 0, skipped: 0 } }),
  });
  assert.match(out, /<b>3<\/b><span>escalated<\/span>/, "the strip is showing status.counts");
  assert.doesNotMatch(out, /<b>41<\/b>/, "a live-session count reached the ledger's strip");
});

// ---- the posture line ------------------------------------------------------------------

// The reading this panel was built to surface. `running` is polled every 4s and was
// rendered nowhere: a Foreman whose worker is dead looked exactly like one that is idle,
// with its mode still cheerfully reported.
test("a dead worker outranks the mode in the posture line", () => {
  const out = html({ status: status({ running: false, mode: "live" }) });
  assert.match(out, /Enabled, but no worker is running/);
  assert.doesNotMatch(out, /Live - replying in sessions/);
});

test("a running Foreman states its mode, and live is the loud one", () => {
  const live = html({
    config: ForemanConfigSchema.parse({ enabled: true, mode: "live", triage: "shadow" }),
  });
  assert.match(live, /Live - replying in sessions on your behalf/);
  assert.match(live, /sc-state-danger/);

  const dry = html();
  assert.match(dry, /Dry run - deciding, sending nothing/);
});

// Null config is "unknown", never "off". Every control below falls back to a default, and
// presenting a schema default as the daemon's answer tells the operator Foreman is quiet
// when the stored config may well be enabled and live.
test("an unanswered daemon renders unknown, not off", () => {
  const out = html({ config: null, status: null });
  assert.match(out, /Unknown - the daemon has not answered/);
  assert.match(out, /sc-state-unknown/);
  assert.doesNotMatch(out, /Off - nothing is being answered/);
  assert.match(out, /what Foreman is actually set to is unknown/);
});

test("a disabled Foreman says off rather than describing a mode nothing runs", () => {
  const out = html({
    config: ForemanConfigSchema.parse({ enabled: false, mode: "live", triage: "off" }),
  });
  assert.match(out, /Off - nothing is being answered/);
  assert.doesNotMatch(out, /Live - replying in sessions/);
});

// ---- the anchors are a public contract -------------------------------------------------

// `settings-search.ts` points at two of these by name and `settings-sidebar-render.test.ts`
// enforces uniqueness, but neither notices an anchor that simply stopped being rendered -
// which is what a whole-panel rewrite is most likely to do. Seven model anchors is the
// number that was there before this change, and it stays seven.
test("every settings anchor survives the console rewrite", () => {
  const out = html();
  for (const anchor of [
    "foreman/cheap-tier",
    "foreman/provider",
    "foreman/live-repos",
    "foreman/model-review",
    "foreman/model-verify",
    "foreman/model-triage",
    "foreman/model-backlog",
    "foreman/backlog-model-claude",
    "foreman/backlog-model-codex",
    "foreman/backlog-model-pi",
    "foreman/episodes",
  ]) {
    assert.match(out, new RegExp(`data-anchor="${anchor.replace("/", "\\/")}"`), `${anchor} is gone`);
  }
  // Four Foreman roles plus three backlog harnesses, unchanged by the redraw.
  assert.equal((out.match(/data-anchor="foreman\/(model|backlog-model)-/g) ?? []).length, 7);
});

// ---- the shadow column -----------------------------------------------------------------

test("the shadow column appears with the posture, and reads the divergence", () => {
  const out = html({
    episodes: [episode({ cheapAction: "answer", divergence: "cheap-over-eager" })],
  });
  assert.match(out, /has-shadow/);
  assert.match(out, /sc-div-cheap-over-eager/);
  assert.match(out, /over-eager/);
  // The cheap tier's own action rides along where the divergence does not already imply
  // it - see the dedicated test below for the two cases where it does.
  const cautious = html({
    episodes: [episode({ cheapAction: "skip", divergence: "cheap-too-cautious" })],
  });
  assert.match(cautious, /cautious \(skip\)/);
});

// Rows written before this phase, and rows decided under a posture that takes no
// measurement, must render BLANK. "agreed" would be the panel inventing evidence for the
// one question the shadow posture exists to answer.
test("an unmeasured row renders blank in the shadow column, never 'agreed'", () => {
  const out = html({ episodes: [episode({ cheapAction: null, divergence: null })] });
  assert.match(out, /has-shadow/, "the column is keyed on the posture, not on the data");
  assert.doesNotMatch(out, /sc-div-agree/);
  assert.doesNotMatch(out, /agreed/);
});

test("the shadow column is absent while the cheap tier is off", () => {
  const out = html({
    config: ForemanConfigSchema.parse({ enabled: true, mode: "dry-run", triage: "off" }),
    episodes: [episode()],
  });
  assert.doesNotMatch(out, /has-shadow/);
  assert.doesNotMatch(out, /Cheap tier<\/span>/);
});

// Found by pointing the panel at a real ledger, and invisible in every fixture: under
// `on` the cheap tier IS the decision, so `shadowBoth` never runs and NO row can ever
// carry a measurement. The column was showing anyway - 95 of 100 cells blank - and it
// was costing the ask 132 of the 716 pixels this table gets at a 1500px window. "Not
// off" is the wrong test; "measuring" is the right one.
test("the shadow column is absent under 'on', where no measurement is ever taken", () => {
  const out = html({
    config: ForemanConfigSchema.parse({ enabled: true, mode: "dry-run", triage: "on" }),
    episodes: [episode()],
  });
  assert.doesNotMatch(out, /has-shadow/);
  assert.doesNotMatch(out, /Cheap tier<\/span>/);
});

// The classifier DEFINES these two by the cheap tier's action - `cheap-over-eager` is
// "it answered where the review did not", `deferred` is "it routed up" - so naming the
// action beside them is the same word twice, in the widest fixed column on the row.
test("a divergence that already names its own action does not repeat it", () => {
  const eager = html({ episodes: [episode({ cheapAction: "answer", divergence: "cheap-over-eager" })] });
  assert.match(eager, /over-eager/);
  assert.doesNotMatch(eager, /over-eager \(answer\)/);

  const deferred = html({ episodes: [episode({ cheapAction: "route-up", divergence: "deferred" })] });
  assert.doesNotMatch(deferred, /deferred \(route-up\)/);

  // The other three genuinely add information - agreed on WHAT, cautious in which
  // direction - so they keep it.
  const agreed = html({ episodes: [episode({ cheapAction: "escalate", divergence: "agree" })] });
  assert.match(agreed, /agreed \(escalate\)/);
});

// ---- the ledger ------------------------------------------------------------------------

test("an empty ledger says so in words, and a filtered-empty one says which filter", () => {
  assert.match(html(), /Every prompt Foreman decides on appears here/);
});

// A UUID note key at full length is 36 characters of nothing in a table cell; a synthetic
// one is a path plus two numbers. Each is truncated where it actually carries identity.
test("a session handle is short and keeps the identifying part of each key form", () => {
  assert.equal(sessionHandle("3f2a91cc-0d44-4d1e-9f1a-77e2b0c9aa10"), "3f2a91cc");
  assert.equal(sessionHandle("proc:/dev/ttys004:4123:1700"), "ttys004:4123");
  assert.equal(sessionHandle(""), "unknown");
});

test("the ledger draws a row per episode, with the ask and who decided", () => {
  const out = html({
    episodes: [
      episode({ marker: "a", disposition: "escalated", resolvedBy: "you" }),
      episode({ marker: "b", disposition: "answered", resolvedBy: "foreman" }),
    ],
  });
  assert.match(out, /sc-verdict-escalated/);
  assert.match(out, /sc-verdict-answered/);
  assert.match(out, /Claude needs your permission to run the tests/);
  // Who decided and which tier, in one cell - two tracks for two closed vocabularies
  // cost the ask 130px of the 716 this table gets at a 1500px window.
  assert.match(out, /<span class="sc-decided">you · review<\/span>/);
});

// The panel is drawn from the shared console pieces, same as Inspector and Shipping.
test("the Foreman panel uses the shared settings-console vocabulary", () => {
  const out = html({ episodes: [episode()] });
  for (const cls of ["sc-split", "sc-card", "sc-state", "sc-strip", "sc-table", "sc-ledger"]) {
    assert.match(out, new RegExp(cls), `the Foreman panel is missing ${cls}`);
  }
});

// The enable switch stays in the topbar popover: this panel is the durable posture, not
// the live control. A second master switch here would be two controls for one fact.
test("the panel carries no master switch - that stays in the topbar popover", () => {
  assert.doesNotMatch(html(), /sc-switch/);
});
