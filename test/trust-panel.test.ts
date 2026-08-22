import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TrustPanel, TrustGrantSummary } from "../src/web/components/TrustPanel.tsx";
import {
  trustRows,
  mergeBlindSpots,
  checkExecutionGrants,
  checksArmedReading,
  grantPatch,
  candidateRepos,
  type ChecksArmedReading,
  type TrustLists,
} from "../src/web/lib/trust.ts";
import {
  ForemanConfigSchema,
  InspectorConfigSchema,
  ShippingConfigSchema,
} from "../src/shared/protocol.ts";
import { DEFAULT_WORKFLOW_CONFIG } from "../src/shared/workflow.ts";
import type { ForemanState } from "../src/web/useForeman.ts";
import type { InspectorState } from "../src/web/useInspector.ts";
import type { ShippingState } from "../src/web/useShipping.ts";
import type { WorkflowSettingsState } from "../src/web/useWorkflowSettings.ts";

// What is at stake: Trust is the one surface where "who may act in which repo" is decided,
// and it decides it by writing to four SEPARATE allowlists that four subsystems gate on.
// A row that unions them wrongly hides a grant; a cell that writes the wrong list grants a
// permission nobody clicked for; and two combinations are flagged amber for two different
// reasons - the merge-without-review contradiction, and armed check execution, which is the
// heaviest grant in the matrix. The pure helpers are the load-bearing part, so they are
// driven directly - the repo renders with `renderToStaticMarkup` and has no jsdom, so a
// cell click is unassertable any other way.

/** The empty matrix, so a case names only the lists it is actually about. */
function lists(over: Partial<TrustLists> = {}): TrustLists {
  return { foreman: [], workflows: [], inspector: [], shipping: [], staged: [], ...over };
}

// ---- row union and sorting -------------------------------------------------------------

test("rows are the sorted union of the four allowlists and the staged list", () => {
  const rows = trustRows(lists({
    foreman: ["/b", "/a"],
    inspector: ["/a"],
    shipping: ["/c"],
    staged: ["/d"],
    workflows: ["/e"],
  }));
  assert.deepEqual(
    rows.map((r) => r.repo),
    ["/a", "/b", "/c", "/d", "/e"],
  );
  const a = rows.find((r) => r.repo === "/a")!;
  assert.deepEqual(a, {
    repo: "/a", foreman: true, workflows: false, inspector: true, merge: false,
  });
  const c = rows.find((r) => r.repo === "/c")!;
  assert.deepEqual(c, {
    repo: "/c", foreman: false, workflows: false, inspector: false, merge: true,
  });
  // The new column reaches its own row rather than riding on another list's membership.
  const e = rows.find((r) => r.repo === "/e")!;
  assert.deepEqual(e, {
    repo: "/e", foreman: false, workflows: true, inspector: false, merge: false,
  });
});

test("a staged repo shows as an ungranted row, so 'add grants nothing' survives a reload", () => {
  const rows = trustRows(lists({ staged: ["/staged"] }));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    repo: "/staged", foreman: false, workflows: false, inspector: false, merge: false,
  });
});

test("an allowlist row wins over a stale staged entry for the same repo - one row, granted", () => {
  // The repo was staged, then granted, and the staged entry has not been pruned yet. It must
  // appear once, with its grant, not twice and not ungranted: the allowlists win.
  const rows = trustRows(lists({ foreman: ["/repo"], staged: ["/repo"] }));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    repo: "/repo", foreman: true, workflows: false, inspector: false, merge: false,
  });
});

// ---- blind-spot detection --------------------------------------------------------------

test("a merge grant without a review grant is a blind spot only while YOLO is armed", () => {
  const rows = trustRows(lists({ shipping: ["/repo"] })); // merge yes, inspector no
  assert.deepEqual(mergeBlindSpots(rows, false), [], "disarmed: nothing to warn about");
  const armed = mergeBlindSpots(rows, true);
  assert.equal(armed.length, 1);
  assert.equal(armed[0]!.repo, "/repo");
});

test("a repo the Inspector may review is not a blind spot even when armed", () => {
  const rows = trustRows(lists({ inspector: ["/repo"], shipping: ["/repo"] }));
  assert.deepEqual(mergeBlindSpots(rows, true), []);
});

// ---- armed check execution ---------------------------------------------------------------

test("a workflow grant only flags check execution while checks are switched on", () => {
  const rows = trustRows(lists({ workflows: ["/repo"] }));
  assert.deepEqual(
    checkExecutionGrants(rows, false),
    [],
    "checks off: no command can run, so amber here would be noise",
  );
  const armed = checkExecutionGrants(rows, true);
  assert.equal(armed.length, 1);
  assert.equal(armed[0]!.repo, "/repo");
});

test("an armed daemon flags only the repos actually holding the workflow grant", () => {
  // The repo is trusted for three other things and NOT for workflows: no command can run
  // there, so it must not be swept into the footnote by being in the matrix at all.
  const rows = trustRows(lists({
    foreman: ["/other"], inspector: ["/other"], shipping: ["/other"], workflows: ["/repo"],
  }));
  assert.deepEqual(checkExecutionGrants(rows, true).map((r) => r.repo), ["/repo"]);
});

// ---- surviving a failed config poll ------------------------------------------------------

// The bug this reading exists for. `useWorkflowSettings` replaces its config with null on any
// failed poll, so reading `config?.checksEnabled ?? false` retires the warning within one 5s
// interval of the daemon going quiet - while three places claimed it could not. An
// unreachable daemon has not disarmed the switch it is storing.
test("a confirmed reading needs the switch AND somewhere to run", () => {
  assert.deepEqual(
    checksArmedReading({ checksEnabled: true, repoAllowlist: ["/repo"] }, false),
    { armed: true, confirmed: true },
  );
  // Checks on with nothing granted can execute nothing - the inert-grant amber this module
  // refuses everywhere else.
  assert.deepEqual(
    checksArmedReading({ checksEnabled: true, repoAllowlist: [] }, false),
    { armed: false, confirmed: true },
  );
  assert.deepEqual(
    checksArmedReading({ checksEnabled: false, repoAllowlist: ["/repo"] }, false),
    { armed: false, confirmed: true },
  );
});

test("a remembered arming survives an unreadable config, marked unconfirmed", () => {
  assert.deepEqual(checksArmedReading(null, true), { armed: true, confirmed: false });
});

test("an unreadable config claims nothing when nothing was ever read", () => {
  // Absence of evidence is not evidence of arming: a page that has never seen a config must
  // not invent an amber, or every cold start behind a slow daemon flies one.
  assert.deepEqual(checksArmedReading(null, false), { armed: false, confirmed: false });
});

test("a confirmed disarm overrides the memory rather than being outvoted by it", () => {
  // The other direction of the same rule. Remembering must not make the warning permanent:
  // once the daemon answers and says checks are off, that is the live fact.
  assert.deepEqual(
    checksArmedReading({ checksEnabled: false, repoAllowlist: ["/repo"] }, true),
    { armed: false, confirmed: true },
  );
});

// ---- what one cell click writes --------------------------------------------------------

const LISTS = lists({
  foreman: ["/f"], workflows: ["/w"], inspector: ["/i"], shipping: ["/s"], staged: ["/staged"],
});

test("a cell writes the full new list to EXACTLY the owning subsystem", () => {
  const f = grantPatch("foreman", "/new", false, LISTS);
  assert.equal(f.subsystem, "foreman");
  assert.deepEqual(f.repoAllowlist, ["/f", "/new"]);

  const w = grantPatch("workflows", "/new", false, LISTS);
  assert.equal(w.subsystem, "workflows");
  assert.deepEqual(w.repoAllowlist, ["/w", "/new"]);

  const i = grantPatch("inspector", "/new", false, LISTS);
  assert.equal(i.subsystem, "inspector");
  assert.deepEqual(i.repoAllowlist, ["/i", "/new"]);

  // The `merge` column is Shipping's allowlist - the one mapping worth pinning.
  const m = grantPatch("merge", "/new", false, LISTS);
  assert.equal(m.subsystem, "shipping");
  assert.deepEqual(m.repoAllowlist, ["/s", "/new"]);
});

test("revoking a grant removes it from the owning list and touches nothing staged", () => {
  const patch = grantPatch("foreman", "/f", true, LISTS);
  assert.deepEqual(patch.repoAllowlist, []);
  assert.equal(patch.trustStaged, null, "a revoke never re-stages");
});

// `grantPatch` computes the INTENDED prune; the panel applies it only after the grant write
// is confirmed (a rejected write must not vanish the row - see the panel's `grant`).
test("a first grant prunes the staged entry; a grant on an unstaged repo leaves staging alone", () => {
  const staged = grantPatch("inspector", "/staged", false, LISTS);
  assert.deepEqual(staged.trustStaged, [], "the newly-granted repo leaves the staged list");

  const unstaged = grantPatch("inspector", "/new", false, LISTS);
  assert.equal(unstaged.trustStaged, null, "an unstaged repo does not rewrite the staged list");
});

// ---- the add picker's candidates -------------------------------------------------------

test("the add picker omits repos already in the matrix", () => {
  assert.deepEqual(candidateRepos(["/a", "/b", "/c"], ["/b"]), ["/a", "/c"]);
});

// ---- static render ---------------------------------------------------------------------

function foreman(over: Partial<{ repoAllowlist: string[]; config: null }> = {}): ForemanState {
  return {
    config: over.config === null ? null : ForemanConfigSchema.parse({ repoAllowlist: over.repoAllowlist ?? [] }),
    status: null,
    backlogPlan: null,
    episodes: [],
    update: async () => true,
    error: null,
  };
}
function inspector(
  over: Partial<{ repoAllowlist: string[]; config: null }> = {},
): InspectorState {
  return {
    config:
      over.config === null
        ? null
        : InspectorConfigSchema.parse({ repoAllowlist: over.repoAllowlist ?? [] }),
    inspections: [],
    model: null,
    update: async () => true,
    resolveFindings: async () => true,
    error: null,
  };
}
function shipping(
  over: Partial<{ repoAllowlist: string[]; autoMerge: boolean; config: null }> = {},
): ShippingState {
  return {
    config:
      over.config === null
        ? null
        : ShippingConfigSchema.parse({
            repoAllowlist: over.repoAllowlist ?? [],
            autoMerge: over.autoMerge ?? false,
          }),
    inspections: [],
    update: async () => true,
    error: null,
  };
}

function workflowState(
  over: Partial<{ repoAllowlist: string[]; checksEnabled: boolean; config: null }> = {},
): WorkflowSettingsState {
  return {
    testEvidenceAudit: null,
    config:
      over.config === null
        ? null
        : {
            ...DEFAULT_WORKFLOW_CONFIG,
            repoAllowlist: over.repoAllowlist ?? [],
            checksEnabled: over.checksEnabled ?? false,
          },
    status: null,
    update: async () => true,
    error: null,
  };
}

function render(
  f: ForemanState,
  i: InspectorState,
  s: ShippingState,
  w: WorkflowSettingsState = workflowState(),
  /**
   * The armed reading, defaulted to what `SettingsPage` would derive from `w` with no
   * memory. Overridable so the remembered-across-a-failed-poll case is reachable, which is
   * the whole point of the panel taking it as a prop rather than deriving it.
   */
  checks: ChecksArmedReading = checksArmedReading(w.config, false),
): string {
  return renderToStaticMarkup(
    createElement(TrustPanel, { foreman: f, workflows: w, inspector: i, shipping: s, checks }),
  );
}

test("the matrix renders one grant column per subsystem and the add row's anchor", () => {
  const repo = "/Users/dev/work/harness";
  const html = render(
    foreman({ repoAllowlist: [repo] }),
    inspector({ repoAllowlist: [repo] }),
    shipping({ repoAllowlist: [repo] }),
    workflowState({ repoAllowlist: [repo] }),
  );
  assert.match(html, /data-anchor="trust\/matrix"/);
  assert.match(html, /data-anchor="trust\/add"/);
  assert.match(html, /Foreman sends live/);
  assert.match(html, /Workflows act/);
  assert.match(html, /GitHub Inspector posts reviews/);
  assert.match(html, /YOLO merges/);
  // The one repo appears once by directory name, with its absolute path in the tooltip.
  assert.match(html, /class="trust-repo-path"[^>]*>harness<\/span>/);
  assert.match(html, /class="tt-desc">\/Users\/dev\/work\/harness<\/span>/);
  assert.equal((html.match(/class="trust-repo-path"/g) ?? []).length, 1);
});

// The column's tooltip is the ONLY place the second capability is visible from the matrix:
// one stored list gates both Live delivery and check execution, and a cell reading "allowed"
// cannot show that on its own. If this ever narrows to just delivery, the matrix silently
// starts understating the strongest grant it holds.
//
// Driven with a row present, because the tooltip hangs off the CELL rather than the header -
// an empty matrix carries no column prose at all.
test("the Workflows column names both capabilities its one grant covers", () => {
  const html = render(foreman(), inspector(), shipping(), workflowState({
    repoAllowlist: ["/repo"],
  }));
  assert.match(html, /Live repairs typed into its sessions/);
  assert.match(html, /workflow Commands run against branch code/);
  assert.match(html, /armed separately in Workflows settings/);
});

test("the add row says it grants nothing, so adding cannot read as consent", () => {
  const html = render(foreman(), inspector(), shipping());
  assert.match(html, /Adding a repo grants nothing yet/);
  assert.match(html, /Adding is configuration; enabling is consent/);
});

test("a merge-without-review, armed, flies the dagger footnote with both fixes", () => {
  const html = render(
    foreman(),
    inspector({ repoAllowlist: [] }), // NOT reviewing /repo
    shipping({ repoAllowlist: ["/repo"], autoMerge: true }), // but will merge it
  );
  assert.match(html, /trust-trap-note/);
  assert.match(html, /no pull request will ever qualify/);
  assert.match(html, /Grant the review/);
  assert.match(html, /revoke the merge/);
  // The trapped merge pill is marked, and its repo is named compactly in the footnote.
  assert.match(html, /trust-grant is-on is-trapped/);
  assert.match(html, /YOLO may merge in <span[^>]*>repo<\/span>/);
});

test("warning lists show full paths when compact repository names collide", () => {
  const repos = ["/workspaces/one/api", "/workspaces/two/api"];
  const html = render(
    foreman(),
    inspector({ repoAllowlist: [] }),
    shipping({ repoAllowlist: repos, autoMerge: true }),
    workflowState({ repoAllowlist: repos, checksEnabled: true }),
  );

  assert.match(
    html,
    /trust-trap-note[\s\S]*class="trust-warning-repo"[^>]*>\/workspaces\/one\/api<\/span>[\s\S]*class="trust-warning-repo"[^>]*>\/workspaces\/two\/api<\/span>/,
  );
  assert.match(
    html,
    /trust-arm-note[\s\S]*class="trust-warning-repo"[^>]*>\/workspaces\/one\/api<\/span>[\s\S]*class="trust-warning-repo"[^>]*>\/workspaces\/two\/api<\/span>/,
  );
  assert.doesNotMatch(html, /in <span[^>]*>api<\/span>[\s\S]*, <span[^>]*>api<\/span>/);
});

test("with YOLO disarmed the same lists fly no footnote", () => {
  const html = render(
    foreman(),
    inspector({ repoAllowlist: [] }),
    shipping({ repoAllowlist: ["/repo"], autoMerge: false }),
  );
  assert.doesNotMatch(html, /trust-trap-note/);
});

test("a workflow grant with checks armed flies the double dagger and names the repo", () => {
  const html = render(
    foreman(),
    inspector(),
    shipping(),
    workflowState({ repoAllowlist: ["/repo"], checksEnabled: true }),
  );
  assert.match(html, /trust-arm-note/);
  assert.match(html, /branch-authored code/);
  assert.match(html, /It is not a sandbox/);
  assert.match(html, /Turn Commands off/);
  // The pill carries the marker, and stays a GRANTED pill - amber, not revoked.
  assert.match(html, /trust-grant is-on is-armed/);
  assert.match(html, /in <span[^>]*>repo<\/span>/);
  assert.match(html, /class="tt-desc">\/repo<\/span>/);
});

test("the same grant with checks off is silent - an inert grant must not train amber-blindness", () => {
  const html = render(
    foreman(),
    inspector(),
    shipping(),
    workflowState({ repoAllowlist: ["/repo"], checksEnabled: false }),
  );
  assert.doesNotMatch(html, /trust-arm-note/);
  assert.doesNotMatch(html, /is-armed/);
  assert.match(html, /trust-grant is-on/, "the grant is still shown as granted");
});

// Both footnotes at once, on one repo. They are different columns and different claims, so
// each has to keep its own marker: one pill collecting both daggers would say the merge is
// what runs the code.
test("a repo that is both trapped and armed flies both footnotes, each on its own cell", () => {
  const html = render(
    foreman(),
    inspector({ repoAllowlist: [] }),
    shipping({ repoAllowlist: ["/repo"], autoMerge: true }),
    workflowState({ repoAllowlist: ["/repo"], checksEnabled: true }),
  );
  assert.match(html, /trust-trap-note/);
  assert.match(html, /trust-arm-note/);
  assert.match(html, /trust-grant is-on is-trapped/);
  assert.match(html, /trust-grant is-on is-armed/);
  assert.doesNotMatch(html, /is-trapped is-armed/, "one pill never claims both");
});

// The render half of the poll-failure bug. With the config unreadable there are no
// Workflows-granted rows at all, so the confirmed footnote cannot fire whatever the arming
// says - falling through to nothing here is exactly the self-retiring warning the reading
// exists to prevent.
test("a remembered arming still warns when the config has gone unreadable", () => {
  const html = render(
    foreman(),
    inspector(),
    shipping(),
    workflowState({ config: null }),
    { armed: true, confirmed: false },
  );
  assert.match(html, /trust-arm-unconfirmed/);
  assert.match(html, /were <strong>on<\/strong> at the last reading/);
  assert.match(html, /nothing here has been disarmed/);
  // It names no repository, because it genuinely does not know which. Claiming one from a
  // list we cannot read would be worse than the silence this replaces.
  assert.doesNotMatch(html, /trust-repo-path/);
});

test("an unreadable config with nothing remembered stays silent", () => {
  const html = render(foreman(), inspector(), shipping(), workflowState({ config: null }));
  assert.doesNotMatch(html, /trust-arm-unconfirmed/);
  assert.doesNotMatch(html, /trust-arm-note/);
  // The unknown banner still names Workflows, so the gap is not invisible - it is just not
  // being reported as an arming nobody has evidence of.
  assert.match(html, /trust-unknown/);
});

// Confirmed and unconfirmed are different sentences and must never both fly: one names
// repositories, the other says it cannot, and together they would contradict each other.
test("the confirmed footnote and the unconfirmed one are mutually exclusive", () => {
  const html = render(
    foreman(),
    inspector(),
    shipping(),
    workflowState({ repoAllowlist: ["/repo"], checksEnabled: true }),
  );
  assert.match(html, /trust-arm-note/);
  assert.doesNotMatch(html, /trust-arm-unconfirmed/);
  assert.match(html, /in <span[^>]*>repo<\/span>/);
});

test("an unreachable subsystem renders the unknown warning, and names which - not 'off'", () => {
  const html = render(foreman({ config: null }), inspector(), shipping());
  assert.match(html, /trust-unknown/);
  assert.match(html, /unknown, not\s+off/);
  assert.match(html, /Foreman/);
});

test("an unreachable Workflows daemon is named too, rather than drawn as an empty column", () => {
  const html = render(foreman(), inspector(), shipping(), workflowState({ config: null }));
  assert.match(html, /trust-unknown/);
  assert.match(html, /Workflows/);
});

// ---- the grant summary the three panels borrow -----------------------------------------

test("TrustGrantSummary reads unknown before the daemon answers, and agrees with its count", () => {
  const unknown = renderToStaticMarkup(
    createElement(TrustGrantSummary, {
      configured: false,
      count: 0,
      subject: "Foreman may send live in",
      onNavigate: () => {},
    }),
  );
  assert.match(unknown, /Unknown - the daemon hasn.{0,8}t said/);
  assert.doesNotMatch(unknown, /0 repositories/);

  // A configured-but-empty count reads as a real "nowhere", not "0 repositories".
  const none = renderToStaticMarkup(
    createElement(TrustGrantSummary, {
      configured: true,
      count: 0,
      subject: "Foreman may send live in",
      onNavigate: () => {},
    }),
  );
  assert.match(none, /Foreman may send live in no repositories yet/);

  // One reads in the singular - the whole reason the count is the object, not the subject.
  const one = renderToStaticMarkup(
    createElement(TrustGrantSummary, {
      configured: true,
      count: 1,
      subject: "Foreman may send live in",
      onNavigate: () => {},
    }),
  );
  assert.match(one, /Foreman may send live in 1 repository\b/);
  assert.match(one, /Manage in Trust/);
});
