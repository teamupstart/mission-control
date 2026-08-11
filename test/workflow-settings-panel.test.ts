/**
 * What is at stake: the one switch in this app that can type into somebody's live agent
 * session used to live in a floating drawer on another page - no rail row, no scope badge,
 * no deep link, and invisible to settings search. Moving it into a category is only worth
 * anything if the controls came WITH it, so this pins that the panel actually draws Live
 * delivery, its allowlist, the retention fields and the health counters, each on the anchor
 * the search index points at.
 *
 * Two further claims are pinned here because a static render cannot reach them and getting
 * either wrong is silent. The pre-poll panel must say the daemon has not answered rather
 * than present "off, no repos" as fact - the Inspector panel's rule, and the same failure:
 * an operator reads a safe posture that may not be in force. And the retention gate has to
 * ask before SHORTENING a limit, because the next sweep acts on it and compaction is not
 * reversible.
 *
 * The panel was then redrawn with the settings console's leaves, which is what the last
 * group of cases is about. Two things had to survive that rewrite and one had to be true
 * for the first time. The four anchors are a public contract - `settings-search.ts` points
 * at them and a deep link that lands nowhere is a search result that lies - so they are
 * asserted before and after the daemon answers. The strip is a NAVIGATING one: its tiles
 * count fleet-wide scalars and open the real run list, they sum to nothing, and if one ever
 * grows an `aria-pressed` it has drifted back into being a filter over rows this panel does
 * not have. And the retention limits are now shown against `completedRunCount` - the
 * population `maxCompletedRuns` actually ranks - never against `retainedRunCount`, which
 * counts every run row of any status and would be a gauge moving for reasons the limit
 * beside it cannot cause.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  WorkflowSettingsPanel,
  checkRepoOptions,
  readRetention,
  retentionShortens,
  workflowStripLinks,
} from "../src/web/components/WorkflowSettingsPanel.tsx";
import {
  applyWorkflowPoll,
  pollIsLatest,
  pollRacedByWrite,
  type WorkflowSettingsState,
} from "../src/web/useWorkflowSettings.ts";
import type { WorkflowConfig } from "../src/shared/workflow.ts";
import { DEFAULT_WORKFLOW_CONFIG, type WorkflowStatus } from "../src/shared/workflow.ts";
import { withOverlayHost } from "./helpers/overlay-host.ts";

// Every scalar a different number, so a tile wired to the wrong field cannot accidentally
// show the right one. `inspectorGates` is the deliberate zero: a tile at zero still has to
// render, because a missing tile reads as a missing subsystem.
const STATUS: WorkflowStatus = {
  activeRuns: 2,
  queuedPersonaCalls: 1,
  runningPersonaCalls: 7,
  waitingDeliveries: 3,
  uncertainDeliveries: 4,
  inspectorGates: 0,
  lastRecoveryAt: null,
  lastRetentionAt: null,
  lastRetentionError: null,
  retainedRunCount: 42,
  completedRunCount: 17,
  deliveredDeliveries: 9,
  lastRetentionCompacted: 0,
  lastRetentionDeleted: 0,
};

function state(over: Partial<WorkflowSettingsState> = {}): WorkflowSettingsState {
  return {
    config: null,
    status: null,
    update: async () => true,
    error: null,
    ...over,
  };
}

function render(over: Partial<WorkflowSettingsState> = {}): string {
  return renderToStaticMarkup(
    withOverlayHost(
      createElement(WorkflowSettingsPanel, { state: state(over), onNavigate: () => {} }),
    ),
  );
}

// `liveEnabled` is stated rather than inherited. This fixture's job is "the daemon has
// answered", and it is used by the cases that need an OFF switch to compare against; since the
// shipped default became `true` those two meanings stopped coinciding, and a fixture that
// silently followed the default would have flipped the assertions under them.
const ANSWERED = {
  config: {
    ...DEFAULT_WORKFLOW_CONFIG,
    liveEnabled: false,
    repoAllowlist: ["/src/mission-control"],
  },
  status: STATUS,
};

test("every control the search index points at is on the panel", () => {
  const html = render(ANSWERED);
  for (const anchor of [
    "workflows/live-delivery",
    "workflows/allowlist",
    "workflows/retention",
    "workflows/health",
  ]) {
    assert.ok(html.includes(`data-anchor="${anchor}"`), `panel is missing ${anchor}`);
  }
});

test("the settings panel offers active published Workflows as the dispatch default", () => {
  const html = renderToStaticMarkup(
    withOverlayHost(createElement(WorkflowSettingsPanel, {
      state: state(ANSWERED),
      onNavigate: () => {},
      foremanEnabled: true,
      workflows: [{
        id: "workflow-review",
        name: "Release review",
        description: "",
        draftRevision: 2,
        currentVersionId: "version-2",
        publishedVersion: 2,
        archivedAt: null,
        updatedAt: 1,
        errorCount: 0,
        warningCount: 0,
        nodeCount: 3,
        personaCount: 1,
        builtin: false,
      }],
    })),
  );
  assert.match(html, /Dispatch default/);
  assert.match(html, /Default after-work Workflow for dispatched tasks/);
  assert.match(html, /Release review · v2/);
});

// The anchors have to survive the pre-poll render too: `settings-sidebar-render.test.ts`
// walks a statically rendered page, and a control that only appears once a fetch lands is
// one a deep link from search cannot scroll to on arrival.
test("the anchors are drawn before the daemon has answered", () => {
  const html = render();
  for (const anchor of [
    "workflows/live-delivery",
    "workflows/allowlist",
    "workflows/retention",
    "workflows/health",
  ]) {
    assert.ok(html.includes(`data-anchor="${anchor}"`), `pre-poll panel is missing ${anchor}`);
  }
});

// The switch is now the console's `ConsoleSwitch` in the card's action slot, which is still
// a real `<input type="checkbox">` - the styling is `appearance: none` over one, not a div
// with an onClick. It has to stay that: this is the control that arms a paste into somebody
// else's terminal, and it must be reachable from the keyboard.
test("the Live delivery switch is a real checkbox, off and disabled before the first read", () => {
  const html = render();
  const card = /<section class="sc-card" data-anchor="workflows\/live-delivery">(.*?)<\/section>/s
    .exec(html);
  assert.ok(card, "Live delivery should be a console card on its anchor");
  const box = /<input type="checkbox"[^>]*>/.exec(card[1]!);
  assert.ok(box, "the switch must be a checkbox, not a div with a click handler");
  assert.doesNotMatch(box[0], /checked/, "pre-poll must not draw Live as enabled");
  assert.match(box[0], /disabled/, "pre-poll must not accept a click it cannot honour");
  // The accessible name is the `.sr-only` span - the card title says "Live delivery" and
  // that alone would not tell a screen reader what the switch does.
  assert.match(card[1]!, /Enable Live workflow delivery/);
  // The danger tone, on the one switch whose consequence is a keystroke in a live composer.
  assert.match(card[1]!, /sc-switch sc-switch-danger/);
});

// The posture line is the half a checkbox cannot draw: "off" and "the daemon has not
// answered" are the same unchecked box, and only one of them means nothing is being typed
// into a session.
test("the posture line separates off from unanswered from live", () => {
  assert.match(render(), /sc-state-unknown[^>]*>.*?Unknown - the daemon has not answered/s);
  assert.match(render(ANSWERED), /sc-state-off[^>]*>.*?Off - nothing is delivered/s);
  assert.match(
    render({ config: { ...ANSWERED.config, liveEnabled: true }, status: STATUS }),
    /sc-state-danger[^>]*>.*?Live - repairs are typed into agent sessions/s,
  );
});

test("with no answer from the daemon the panel says so rather than showing defaults as fact", () => {
  const html = render();
  assert.match(html, /wf-settings-unknown/);
  assert.match(html, /is unknown/);
  assert.doesNotMatch(
    html,
    /Workflows may act in no repositories yet/,
    "an unanswered panel must not assert an empty allowlist",
  );
  assert.match(
    html,
    /Unknown - the daemon hasn.{0,8}t said/,
    "the grant count reads unknown, which is not the same as zero",
  );
  assert.match(
    html,
    /Workflow health is unavailable/,
    "an unanswered panel must not draw health counters it does not have",
  );
});

test("an answered panel counts the allowlist and carries the health counters", () => {
  const html = render(ANSWERED);
  assert.doesNotMatch(html, /wf-settings-unknown/);
  // The one granted repo is a COUNT here, not a row: the paths themselves live in Trust,
  // which is the surface that can also say what else that repo is trusted with.
  assert.match(html, /Workflows may act in 1 repository\b/);
  // The counters come from the status payload, not from a placeholder. The two that mean
  // "somebody must look" were promoted out of this list into the strip; what is left is the
  // throughput and sweep bookkeeping, and it still has to carry real numbers.
  assert.match(html, /Retained runs<\/span><span class="sc-health-value">42</);
  assert.match(html, /Queued Persona calls<\/span><span class="sc-health-value">1</);
  assert.match(html, /Running Persona calls<\/span><span class="sc-health-value">7</);
});

// The defect class the Inspector caught on this panel, pinned rather than the one sentence.
//
// When the repo list moved to Trust, three of the four sentences describing "which
// repositories" were reworded to name Trust and one was left pointing at the page itself
// ("the repositories granted below"). It rendered perfectly and was wrong: an operator who
// followed it downward found a count and a link, not the list the sentence promised.
//
// So the invariant is spatial, not lexical - no sentence on this panel may locate the
// repository grant ON this panel - which also catches the next sentence someone adds. The
// legitimate "below"s here (the controls, the retention stages, the check-command table)
// are all about things that really are below, and none of them mentions a repository.
//
// Driven over EVERY state the panel renders, which is the whole difficulty: the offending
// sentence lives behind `liveEnabled`, so a scan of the default fixture passes while the bug
// is on screen. A guard that cannot see the copy it guards is worse than none - it reports
// safety it never checked. The two conditional warnings are each other's blind spot, so both
// switches are turned on here.
const COPY_STATES: [string, Partial<WorkflowSettingsState>][] = [
  ["unanswered", {}],
  ["answered, live off", ANSWERED],
  ["live on", { config: { ...ANSWERED.config, liveEnabled: true }, status: STATUS }],
  ["checks on", { config: { ...ANSWERED.config, checksEnabled: true }, status: STATUS }],
  [
    "live and checks on",
    {
      config: { ...ANSWERED.config, liveEnabled: true, checksEnabled: true },
      status: STATUS,
    },
  ],
];

test("no sentence on the panel claims the granted repositories are on this page", () => {
  for (const [label, state] of COPY_STATES) {
    // Segmented on ELEMENT boundaries as well as sentence ends. Collapsing the markup to one
    // string first glues a tooltip label (which has no full stop) onto the paragraph after
    // it, and the pair reads as one sentence containing both "below" and "repository" when
    // neither element says both - a false positive that would make this guard useless the
    // day it fired.
    const offenders = render(state)
      .replace(/<[^>]+>/g, "\n")
      .replace(/&#x27;/g, "'")
      .split("\n")
      .flatMap((block) => block.split(/(?<=\.)\s+/))
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter((s) => /repositor/i.test(s) && /\b(above|below)\b/i.test(s));
    assert.deepEqual(
      offenders,
      [],
      `${label}: a sentence about repositories points at this page, but the grant is in Trust`,
    );
  }
});

// The guard above is only worth having if the states it scans really do carry the sentences.
// Pinned separately so a fixture that quietly stops rendering the conditional warnings fails
// here - loudly - instead of turning the scan into a no-op that always passes.
test("the copy scan actually reaches both conditional warnings", () => {
  const live = render({ config: { ...ANSWERED.config, liveEnabled: true }, status: STATUS });
  assert.match(live, /Live bindings write into a real terminal pane/);
  const checks = render({ config: { ...ANSWERED.config, checksEnabled: true }, status: STATUS });
  assert.match(checks, /A check runs a command in the repository under review/);
});

test("an empty allowlist reads as a real nowhere, not as an unanswered daemon", () => {
  const html = render({ config: DEFAULT_WORKFLOW_CONFIG, status: STATUS });
  assert.match(html, /Workflows may act in no repositories yet/);
  assert.doesNotMatch(html, /Unknown - the daemon hasn.{0,8}t said/);
});

// The consent sentence is part of the feature, not decoration: it is what an operator reads
// before allowing a paste into a session they may be watching.
test("Live enabled flies the sentence saying what it does", () => {
  const off = render(ANSWERED);
  assert.doesNotMatch(off, /wf-settings-live-warn/, "an off switch must not fly the warning");
  const on = render({
    config: { ...ANSWERED.config, liveEnabled: true },
    status: STATUS,
  });
  assert.match(on, /wf-settings-live-warn/);
  // The apostrophe arrives HTML-escaped, so the phrase is matched around it.
  assert.match(on, /A repair packet is typed into the agent.{0,8}s own composer/);

  // And on a FRESH install, because the default is now on. An operator who never opens this
  // panel is authorised to have packets typed into any repository they later allowlist, so the
  // sentence explaining that has to be on screen without anybody switching anything.
  assert.match(
    render({ config: DEFAULT_WORKFLOW_CONFIG, status: STATUS }),
    /wf-settings-live-warn/,
  );
});

// The retention boxes are typed text, so the read has to refuse a half-entered number
// rather than PUT a NaN. The ranges restated in the panel are the daemon's own.
test("retention refuses values outside the ranges the daemon enforces", () => {
  const ok = readRetention({
    rawEvidenceDays: "30",
    completedRunDays: "180",
    maxCompletedRuns: "1000",
  });
  assert.deepEqual(ok, {
    ok: true,
    value: { rawEvidenceDays: 30, completedRunDays: 180, maxCompletedRuns: 1_000 },
  });
  for (const bad of [
    { rawEvidenceDays: "0", completedRunDays: "180", maxCompletedRuns: "1000" },
    { rawEvidenceDays: "366", completedRunDays: "180", maxCompletedRuns: "1000" },
    { rawEvidenceDays: "30", completedRunDays: "29", maxCompletedRuns: "1000" },
    { rawEvidenceDays: "30", completedRunDays: "180", maxCompletedRuns: "99" },
    { rawEvidenceDays: "30.5", completedRunDays: "180", maxCompletedRuns: "1000" },
    { rawEvidenceDays: "", completedRunDays: "180", maxCompletedRuns: "1000" },
    { rawEvidenceDays: "thirty", completedRunDays: "180", maxCompletedRuns: "1000" },
  ]) {
    const read = readRetention(bad);
    assert.equal(read.ok, false, `${JSON.stringify(bad)} should be refused`);
    // A sentence naming the field and its range, not a bare "invalid".
    if (!read.ok) assert.match(read.error, /between \d+ and [\d,]+/);
  }
});

// Only a SHORTENING needs the confirm: the next sweep can then compact or delete history
// today's limits would have kept, and neither is reversible. Lengthening one, or leaving
// them alone, must save without a dialog - a confirm on every Apply is one nobody reads.
test("only a shortened limit asks first", () => {
  const current = DEFAULT_WORKFLOW_CONFIG.retention;
  assert.equal(retentionShortens(current, current), false);
  assert.equal(
    retentionShortens({ ...current, rawEvidenceDays: current.rawEvidenceDays + 1 }, current),
    false,
  );
  for (const key of ["rawEvidenceDays", "completedRunDays", "maxCompletedRuns"] as const) {
    assert.equal(
      retentionShortens({ ...current, [key]: current[key] - 1 }, current),
      true,
      `a shorter ${key} should ask`,
    );
  }
});

// ---- the navigating health strip ----
//
// Every tile carries the scalar it claims. A tile wired to the wrong field is the worst
// class of defect this panel can have: it renders a plausible number, nothing on the page
// contradicts it, and the number it is wrong about is "how many repairs may or may not have
// been typed into somebody's session".
test("each health tile carries the scalar it claims", () => {
  const byId = new Map(workflowStripLinks(STATUS).map((tile) => [tile.id, tile]));
  assert.equal(byId.get("needs-you")?.count, STATUS.uncertainDeliveries);
  assert.equal(byId.get("waiting")?.count, STATUS.waitingDeliveries);
  assert.equal(byId.get("gates")?.count, STATUS.inspectorGates);
  assert.equal(byId.get("active")?.count, STATUS.activeRuns);
  assert.equal(byId.get("delivered")?.count, STATUS.deliveredDeliveries);
  assert.equal(byId.size, 5, "a tile added or dropped silently changes what the strip means");
});

// A zero is a reading, not an absence. "No retained delivery is confirmed as sent" is
// exactly what an operator who has just enabled Live delivery is looking for, and a strip
// that hides its zeroes answers that question by leaving the subsystem out of the picture.
test("a tile with a zero count still renders", () => {
  assert.equal(STATUS.inspectorGates, 0, "the fixture must keep a zero for this to test");
  const tiles = workflowStripLinks(STATUS);
  assert.ok(tiles.some((tile) => tile.id === "gates" && tile.count === 0));
  assert.match(render(ANSWERED), /<b>0<\/b><span>Inspector gates<\/span>/);
});

// The one assertion that stops the strip drifting back into being a filter. `ConsoleStrip`'s
// tiles ARE the filter over the ledger beside them and sum to its rows; these count
// fleet-wide scalars over three different populations, sum to nothing, and there is no
// ledger on this panel to subset - so an `aria-pressed` here would be a promise the panel
// cannot keep. Links, with real deep-link hashes, and no pressed state.
test("the health tiles are links out, not filter buttons", () => {
  const html = render(ANSWERED);
  assert.match(html, /class="sc-strip sc-strip-links"/);
  assert.doesNotMatch(html, /aria-pressed/, "a navigating tile must not claim a pressed state");
  const strip = /<div class="sc-strip sc-strip-links">(.*?)<\/div><section/s.exec(html);
  assert.ok(strip, "the strip should sit above the health card");
  assert.equal(
    (strip[1]!.match(/<a class="sc-stat sc-stat-link/g) ?? []).length,
    5,
    "every tile is an anchor",
  );
  assert.doesNotMatch(strip[1]!, /<button/, "no tile is a button");
});

// The `href` is the load-bearing half and the click handler is the enhancement. A panel
// mounted without `onOpenRuns` still has to render tiles that go somewhere - the first cut
// called `preventDefault` unconditionally and then a missing handler, which is a link that
// looks live, highlights on hover, and does nothing at all when clicked.
test("a tile is a real link even with nothing listening for the click", () => {
  const html = render(ANSWERED);
  assert.match(
    html,
    /<a class="sc-stat sc-stat-link sc-stat-danger" href="#\/runs\?status=waiting_for_session"/,
    "the destination must be on the element, not only in a handler",
  );
});

// Where each tile goes. The hashes are the same grammar the runs page's own filter chips
// produce, so a tile is a real deep link and not a button wearing an underline.
test("the tiles deep-link into the real run list, pre-filtered", () => {
  const byId = new Map(workflowStripLinks(STATUS).map((tile) => [tile.id, tile]));
  assert.equal(byId.get("needs-you")?.href, "#/runs?status=waiting_for_session");
  assert.equal(byId.get("gates")?.href, "#/runs?status=waiting_for_inspector");
  assert.equal(byId.get("delivered")?.href, "#/runs?status=completed");
  // Waiting deliveries have no single run status that means them, so the tile opens the
  // whole list rather than inventing a filter that would show the wrong rows.
  assert.equal(byId.get("waiting")?.href, "#/runs");
});

// A tile must not count a population its own link cannot reach. `activeRuns` is every run
// that has not finished - running, waiting AND blocked - so the first cut's "Running" label
// pointing at `status=running` meant a fleet with blocked work counted it on this tile and
// then landed on a list that excluded it. Three populations in one tile, and the reason this
// asserts the ABSENCE of the narrower filter rather than just the presence of the new one.
test("the Active tile does not link to a filter narrower than what it counts", () => {
  const byId = new Map(workflowStripLinks(STATUS).map((tile) => [tile.id, tile]));
  const active = byId.get("active");
  assert.ok(active, "the tile counting activeRuns should be the Active tile");
  assert.equal(active.label, "Active", "the label has to name what activeRuns counts");
  assert.equal(active.href, "#/runs");
  assert.doesNotMatch(
    active.href,
    /status=/,
    "no single run status means 'active', so any status filter here excludes rows it counted",
  );
});

// A null status draws no strip at all rather than five zeroes: zeroes would be a reading,
// and the daemon has not given one. The card under it still says so, and still carries the
// anchor a deep link from search needs.
test("no strip and no counters before the daemon answers", () => {
  const html = render();
  assert.doesNotMatch(html, /sc-strip-links/);
  assert.match(html, /Workflow health is unavailable - the daemon has not answered/);
  assert.match(html, /data-anchor="workflows\/health"/);
});

// The privacy sentence is a contract, not copy: it is what an operator reads before letting
// a panel poll their fleet's workflow counters, and every word of it is a claim about what
// does NOT cross this boundary.
test("the health card keeps the privacy sentence verbatim", () => {
  assert.match(
    render(ANSWERED).replace(/&#x27;/g, "'"),
    /Counters only, refreshed while this panel is open\. No prompt, diff, transcript, Persona guidance, model output or delivery payload passes through here\./,
  );
});

// ---- the retention readout ----
//
// The panel set three limits and showed no measurement of the thing being limited. The
// measurement has to be the population the limit RANKS: `retainedRunCount` is `COUNT(*)`
// over every run row of any status, so rendering it as "42 of 1000" would be a gauge that
// climbs on active work the limit beside it can never remove.
test("retention shows the limit against the runs that limit ranks", () => {
  const html = render(ANSWERED);
  const max = DEFAULT_WORKFLOW_CONFIG.retention.maxCompletedRuns;
  assert.match(html, new RegExp(`>${STATUS.completedRunCount} of ${max}<`));
  assert.notEqual(STATUS.completedRunCount, STATUS.retainedRunCount);
  assert.doesNotMatch(
    html,
    new RegExp(`>${STATUS.retainedRunCount} of ${max}<`),
    "the retention gauge must not be read off the count of every run row",
  );
});

// A daemon that has never swept has not taken a reading, and "0 compacted, 0 deleted" is a
// reading - the same class of lie as drawing a default config as the daemon's answer.
test("the last sweep reports nothing until a sweep has run", () => {
  assert.match(render(ANSWERED), /Last sweep removed<\/span><span[^>]*>not yet run</);
  assert.match(
    render({
      config: ANSWERED.config,
      status: { ...STATUS, lastRetentionAt: 1, lastRetentionCompacted: 5, lastRetentionDeleted: 2 },
    }),
    /Last sweep removed<\/span><span[^>]*>5 compacted, 2 deleted</,
  );
  // And with no status at all it is unknown, not zero and not "not yet run".
  assert.match(render({ config: ANSWERED.config }), /Last sweep removed<\/span><span[^>]*>unknown</);
});

// The inverse of what this test used to pin. Workflows IS a column of the Trust matrix now,
// so the editor moved there and the card summarises it - one repo list with one editor, on
// the surface that can show what else the same repo is trusted with. Two editors over one
// stored list is the state this rules out: they would disagree the moment either polled.
test("the allowlist card summarises the grant and points at Trust, editing nothing", () => {
  const html = render(ANSWERED);
  const card = /<section class="sc-card" data-anchor="workflows\/allowlist">(.*?)<\/section>/s
    .exec(html);
  assert.ok(card, "the allowlist should be a console card on its anchor");
  assert.match(card[1]!, /trust-summary/, "the card carries the shared grant summary");
  assert.match(card[1]!, /Manage in Trust/);
  assert.doesNotMatch(card[1]!, /id="workflow-allowlist-path"/, "no add box survives here");
  assert.doesNotMatch(card[1]!, /Add repository/);
});

// No run list. The whole reason this panel takes the leaves and the strip but not the
// two-column split: `WorkflowRuns.tsx` already owns paging, SSE reconciliation and per-run
// actions, and a second copy here would disagree with it the first time either changed.
test("the panel grows no ledger of its own", () => {
  const html = render(ANSWERED);
  assert.doesNotMatch(html, /sc-split/, "a panel with no ledger keeps one column");
  assert.doesNotMatch(html, /sc-ledger|sc-table|sc-row/, "no run table belongs here");
  assert.match(html, /sc-solo/);
});

test("a write refused by the daemon is reported, not swallowed", () => {
  const html = render({ ...ANSWERED, error: "Workflow manager unavailable" });
  assert.match(html, /class="settings-error" role="alert">Workflow manager unavailable/);
});

// A failed read is UNKNOWN, and unknown replaces the last good reading rather than
// deferring to it. This is the defect the Inspector caught on round 1 of #258: the poll
// applied each read only `if (next)`, so once the daemon stopped answering the panel went
// on presenting the queue depths, the last sweep and the Live-delivery switch as its
// current answer - indefinitely, and with every "the daemon has not said" affordance
// (the unknown banner, the disabled controls, the unavailable-health line) keyed on a null
// that could no longer arrive.
//
// Driven through the pure rule rather than the hook: the hook's decision lives in an
// effect, and this runner has no DOM to run one in.
const CONFIG: WorkflowConfig = { ...DEFAULT_WORKFLOW_CONFIG, liveEnabled: true };
const SAVED: WorkflowConfig = { ...DEFAULT_WORKFLOW_CONFIG, liveEnabled: false };

test("a poll that could not read is unknown, not the last thing that was true", () => {
  // Both reads failed while a good reading was on screen: both go unknown.
  assert.deepEqual(
    applyWorkflowPoll({ config: null, status: null }, false, CONFIG),
    { config: null, status: null },
  );
  // One read failed and the other did not - they are independent, so a healthy status does
  // not vouch for a config nobody could read, or the other way round.
  assert.deepEqual(
    applyWorkflowPoll({ config: CONFIG, status: null }, false, CONFIG),
    { config: CONFIG, status: null },
  );
  assert.deepEqual(
    applyWorkflowPoll({ config: null, status: STATUS }, false, CONFIG),
    { config: null, status: STATUS },
  );
  // And an ordinary successful poll still lands both.
  assert.deepEqual(
    applyWorkflowPoll({ config: CONFIG, status: STATUS }, false, null),
    { config: CONFIG, status: STATUS },
  );
});

// The one exception, and the reason the rule takes the race as an argument: a PUT that
// landed after this poll's GET left holds the newer truth. Without this, a poll that raced
// a save would repaint the pre-write config - and a poll whose read FAILED would null out a
// config the operator had just successfully saved, which is the same lie in the other
// direction.
test("a config read that lost a race with a write is dropped, failed or not", () => {
  assert.equal(applyWorkflowPoll({ config: CONFIG, status: STATUS }, true, SAVED).config, SAVED);
  assert.equal(applyWorkflowPoll({ config: null, status: STATUS }, true, SAVED).config, SAVED);
  // Status is never raced - nothing in this panel writes it - so it lands either way.
  assert.equal(applyWorkflowPoll({ config: null, status: STATUS }, true, SAVED).status, STATUS);
});

// The race the Inspector caught on round 2 of #258, and the reason the write clock counts
// in-flight writes rather than bumping one generation number.
//
// The window that matters opens at the CLICK, not when the daemon answers. A poll issued
// just after a save started reads the pre-write config, finds a generation counter exactly
// where it left it, and applies that read over the operator's optimistic value - so Live
// delivery snapped back to off for the length of the write and flipped on again when the
// PUT landed. Measured at ~7 seconds in a browser against a deliberately slowed write:
// `11000000000000000000000000000001111111111111111111` sampled every 250ms.
const IDLE = { completed: 3, inFlight: 0 };

test("a poll is raced by a write that merely OVERLAPS it, not only one that finished", () => {
  // Nothing happening on either side: the poll's reads are trusted.
  assert.equal(pollRacedByWrite(IDLE, IDLE), false);

  // A write was already in flight when the reads went out - the defect's exact shape, and
  // the one a generation counter cannot see, because nothing has completed yet.
  assert.equal(
    pollRacedByWrite({ completed: 3, inFlight: 1 }, { completed: 3, inFlight: 1 }),
    true,
  );
  // A write started while the reads were out and is still going.
  assert.equal(pollRacedByWrite(IDLE, { completed: 3, inFlight: 1 }), true);
  // A write began AND finished entirely inside the poll's window: `inFlight` is zero at
  // both readings, so only `completed` shows it.
  assert.equal(pollRacedByWrite(IDLE, { completed: 4, inFlight: 0 }), true);
  // The in-flight write from the first case, now landed.
  assert.equal(
    pollRacedByWrite({ completed: 3, inFlight: 1 }, { completed: 4, inFlight: 0 }),
    true,
  );
});

// A poll that starts after everything has settled is trusted again - the guard must not
// latch. If it did, the panel would quietly stop updating after the first save, which is
// the same "showing something that is no longer true" failure in a slower form.
test("the race guard clears once writes have settled", () => {
  assert.equal(pollRacedByWrite({ completed: 4, inFlight: 0 }, { completed: 4, inFlight: 0 }), false);
});

// The reorder the Inspector caught on round 3 of #258. The interval starts a tick whether
// or not the previous one's requests are still out, so two polls can be in flight and need
// not land in the order they left - and an older one landing last repaints what IT read.
//
// Not merely a display problem, which is why it was the major of the three: every save on
// this panel spreads the config it is holding, so an operator acting inside that window
// writes the obsolete blob back. Measured against a held response: the switch came on,
// went off for nearly three seconds, then came on again
// (`000000000001111100000001111111111111111111111111111111111111` at 400ms).
test("a poll that has been overtaken is dropped, however late it lands", () => {
  // Polls landing in order: each is the newest when it arrives.
  assert.equal(pollIsLatest(1, 0), true);
  assert.equal(pollIsLatest(2, 1), true);
  // Poll 3 landed first and was applied; polls 1 and 2 arriving afterwards are stale.
  assert.equal(pollIsLatest(2, 3), false);
  assert.equal(pollIsLatest(1, 3), false);
  // A poll cannot apply twice - the same id is no longer newer than itself.
  assert.equal(pollIsLatest(3, 3), false);
});

// ---- Check commands ----
//
// What is at stake: the argv split. There is no shell anywhere in this path, so the rule
// that turns a typed line into an argv is ours alone - and an operator can only trust it if
// the panel shows the result back. `npm test -- --grep "a b"` is five arguments or six
// depending on a rule nobody can read off the box they typed into.
//
// The consent copy is the other half. This switch authorizes running code the reviewed
// BRANCH supplies, with the daemon's filesystem authority, and the panel must say so in
// those terms rather than calling it a sandbox it is not.

test("the check switch and command table render, with their anchors", () => {
  const html = render(ANSWERED);
  for (const anchor of ["workflows/checks", "workflows/check-commands"]) {
    assert.ok(html.includes(`data-anchor="${anchor}"`), `panel is missing ${anchor}`);
  }
  // Pre-poll too, on the panel's existing rule: the controls are present behind the
  // "unknown" banner, so a search result can still jump to them.
  const empty = render();
  for (const anchor of ["workflows/checks", "workflows/check-commands"]) {
    assert.ok(empty.includes(`data-anchor="${anchor}"`), `pre-poll panel is missing ${anchor}`);
  }
});

test("the checks warning names branch-authored code and refuses to claim a sandbox", () => {
  const html = render({
    config: { ...DEFAULT_WORKFLOW_CONFIG, checksEnabled: true, repoAllowlist: ["/repo"] },
    status: STATUS,
  });
  assert.match(html, /branch being reviewed/);
  assert.match(html, /filesystem authority/);
  assert.match(html, /not a sandbox/i);
  // Off, the warning is absent: an operator who has not granted this must not be shown a
  // paragraph about what it does as though they had.
  assert.doesNotMatch(render(ANSWERED), /not a sandbox/i);
});

test("a configured command is listed by root, slot and the argv that will run", () => {
  const html = render({
    config: {
      ...DEFAULT_WORKFLOW_CONFIG,
      checksEnabled: true,
      repoAllowlist: ["/src/mission-control"],
      checkCommands: [
        { repoRoot: "/src/mission-control", slot: "test", command: ["npm", "test", "--filter=a b"] },
      ],
    },
    status: STATUS,
  });
  assert.match(html, /class="wf-settings-check-root"><span[^>]*>mission-control<\/span>/);
  assert.match(html, /class="tt-desc">\/src\/mission-control<\/span>/);
  assert.ok(html.includes("test"));
  // Printed back the way the parser reads it, so what is listed re-parses to what runs.
  assert.ok(
    html.includes("npm test &quot;--filter=a b&quot;"),
    "a listed argv must be printed so it re-parses to the same arguments",
  );
});

test("with no commands the panel says every Check will skip, rather than showing nothing", () => {
  const html = render(ANSWERED);
  assert.match(html, /No commands yet - every Check node will skip and pass\./);
});

// The repository box is the shared `RepoCombobox`, and these three claims are the ones that
// are silent when they break. It has to BE the shared picker - a bare box here was the one
// surface in the app that asked "which repository?" without offering an answer. It must stay
// EMPTY on arrival, because "Add command" sits beside it and a path nobody typed is a
// configuration entry nobody chose. And the sr-only label has to keep reaching the input,
// which now needs an explicit `id`: the widget wraps the input in a div, so a `htmlFor` label
// outside it cannot find its control by containment.
test("the check row's repository box is the shared picker, empty, and still labelled", () => {
  const html = render(ANSWERED);
  assert.match(html, /<label class="sr-only" for="workflow-check-path">/);
  assert.match(html, /<div class="combobox">/, "the repo box is the shared RepoCombobox");
  // Asserted against the input tag itself rather than a slice of the row: the id is unique,
  // and the row's own markup now nests a div, so a lazy `</div>` scan stops inside it.
  const input = /<input [^>]*id="workflow-check-path"[^>]*>/.exec(html);
  assert.ok(input, "the sr-only label needs an input carrying the id it names");
  assert.match(input[0], /role="combobox"/, "that input is the picker's, not a bare box");
  // The placeholder keeps saying a subdirectory is allowed - the picker offers repository
  // roots, and the override that makes a monorepo work is a path below one of them.
  assert.match(input[0], /placeholder="\/path\/to\/repository \(or a subdirectory\)"/);
  assert.match(input[0], /value=""/, "nothing is pre-filled");
  // Pre-poll it is disabled, exactly as the box it replaced was: this panel's rule is that
  // a control is dead until the daemon has said what is stored. The widget takes that as a
  // prop, so a dropped `disabled` reads as an editable field over an unknown config.
  const pre = /<input [^>]*id="workflow-check-path"[^>]*>/.exec(render());
  assert.ok(pre, "the picker is drawn before the daemon answers, for the anchors' sake");
  assert.match(pre[0], /disabled/, "an unanswered daemon leaves the picker inert");
});

// Scope, pinned: the check row's picker is a DIFFERENT flow from the grant that moved to
// Trust. A check command is a per-repository mapping, not a permission - it decides what a
// slot runs, never where a workflow may act - so it stays on this panel with its own box.
test("the check row keeps its picker on this panel, separate from the grant", () => {
  const html = render(ANSWERED);
  const card = /<div class="wf-settings-checks-table"[^>]*>(.*?)<p class="settings-hint wf-settings-check-preview">/s
    .exec(html);
  assert.ok(card, "the check commands table should render");
  assert.match(card[1]!, /id="workflow-check-path"/);
  assert.match(card[1]!, /combobox/, "the check path is picked, not typed from memory");
});

// The one thing about this picker that no render can see, and the thing it is useless
// without. The dropdown is sized from its input, and repo paths differ at the END - so
// sharing a line with the slot select, the command box and a button left the box near its
// 180px floor and ellipsized all 202 options at the same character. Measured in a real
// browser at 1460px: 202 of 202 truncated on a shared line, 1 of 202 on its own. Nothing
// else here would fail if a CSS tidy-up folded it back onto one line.
test("the check row's repository box is given a line of its own", () => {
  const css = readFileSync(fileURLToPath(new URL("../src/web/styles.css", import.meta.url)), "utf8");
  const rule = /\.wf-settings-check-add > \.combobox \{([^}]*)\}/.exec(css);
  assert.ok(rule, "the check row must size the combobox wrapper, not the input inside it");
  assert.match(rule[1]!, /flex:\s*1 1 100%/, "a shared line re-truncates every repo path");
  // And the row's generic 440px cap must not reach the input inside that wrapper, or the
  // box is half-width inside a full-width wrapper and the menu hangs off the wrong rect.
  assert.match(css, /\.wf-settings-check-add > \.combobox > \.field-input \{[^}]*max-width:\s*none/);
});

test("the picker offers allowlisted repositories first, then the workspace scan", () => {
  // `/outside` is allowlisted from outside the workspace roots, so the scan never names it.
  // Dropping it would leave the one repository a check can actually run in unofferable.
  assert.deepEqual(
    checkRepoOptions(["/ws/a", "/ws/b"], ["/outside", "/ws/b"]),
    ["/outside", "/ws/b", "/ws/a"],
  );
  // Listed once. A repository in both lists appears in its allowlisted position, and a
  // duplicate would be two rows in the dropdown that select the same path.
  assert.deepEqual(checkRepoOptions(["/ws/a"], ["/ws/a"]), ["/ws/a"]);
  // Either side alone still answers, which is what the daemon being unreachable looks like.
  assert.deepEqual(checkRepoOptions([], ["/ws/a"]), ["/ws/a"]);
  assert.deepEqual(checkRepoOptions(["/ws/a"], []), ["/ws/a"]);
});

test("the argv preview shows the split, and refuses an unfinished line", () => {
  // Static render, so the preview is at its empty-state. What is pinned here is that the
  // preview EXISTS and prompts for a command; the split itself is exercised directly
  // against `parseCheckCommand` in workflow-check-node.test.ts.
  const html = render(ANSWERED);
  assert.match(html, /Type a command to see exactly how it will be split\./);
  assert.ok(html.includes('class="settings-hint wf-settings-check-preview"'));
});
