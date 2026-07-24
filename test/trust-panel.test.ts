import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TrustPanel, TrustGrantSummary } from "../src/web/components/TrustPanel.tsx";
import { trustRows, mergeBlindSpots, grantPatch, candidateRepos } from "../src/web/lib/trust.ts";
import {
  ForemanConfigSchema,
  InspectorConfigSchema,
  ShippingConfigSchema,
} from "../src/shared/protocol.ts";
import type { ForemanState } from "../src/web/useForeman.ts";
import type { InspectorState } from "../src/web/useInspector.ts";
import type { ShippingState } from "../src/web/useShipping.ts";

// What is at stake: Trust is the one surface where "who may act in which repo" is decided,
// and it decides it by writing to three SEPARATE allowlists that three subsystems gate on.
// A row that unions them wrongly hides a grant; a cell that writes the wrong list grants a
// permission nobody clicked for; the merge-without-review blind spot is the one dangerous
// combination, and it used to be discoverable only as prose on the Shipping panel. The pure
// helpers are the load-bearing part, so they are driven directly - the repo renders with
// `renderToStaticMarkup` and has no jsdom, so a cell click is unassertable any other way.

// ---- row union and sorting -------------------------------------------------------------

test("rows are the sorted union of the three allowlists and the staged list", () => {
  const rows = trustRows(["/b", "/a"], ["/a"], ["/c"], ["/d"]);
  assert.deepEqual(
    rows.map((r) => r.repo),
    ["/a", "/b", "/c", "/d"],
  );
  const a = rows.find((r) => r.repo === "/a")!;
  assert.deepEqual(a, { repo: "/a", foreman: true, inspector: true, merge: false });
  const c = rows.find((r) => r.repo === "/c")!;
  assert.deepEqual(c, { repo: "/c", foreman: false, inspector: false, merge: true });
});

test("a staged repo shows as an ungranted row, so 'add grants nothing' survives a reload", () => {
  const rows = trustRows([], [], [], ["/staged"]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { repo: "/staged", foreman: false, inspector: false, merge: false });
});

test("an allowlist row wins over a stale staged entry for the same repo - one row, granted", () => {
  // The repo was staged, then granted, and the staged entry has not been pruned yet. It must
  // appear once, with its grant, not twice and not ungranted: the allowlists win.
  const rows = trustRows(["/repo"], [], [], ["/repo"]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { repo: "/repo", foreman: true, inspector: false, merge: false });
});

// ---- blind-spot detection --------------------------------------------------------------

test("a merge grant without a review grant is a blind spot only while YOLO is armed", () => {
  const rows = trustRows([], [], ["/repo"], []); // merge yes, inspector no
  assert.deepEqual(mergeBlindSpots(rows, false), [], "disarmed: nothing to warn about");
  const armed = mergeBlindSpots(rows, true);
  assert.equal(armed.length, 1);
  assert.equal(armed[0]!.repo, "/repo");
});

test("a repo the Inspector may review is not a blind spot even when armed", () => {
  const rows = trustRows([], ["/repo"], ["/repo"], []); // merge AND inspector
  assert.deepEqual(mergeBlindSpots(rows, true), []);
});

// ---- what one cell click writes --------------------------------------------------------

const LISTS = { foreman: ["/f"], inspector: ["/i"], shipping: ["/s"], staged: ["/staged"] };

test("a cell writes the full new list to EXACTLY the owning subsystem", () => {
  const f = grantPatch("foreman", "/new", false, LISTS);
  assert.equal(f.subsystem, "foreman");
  assert.deepEqual(f.repoAllowlist, ["/f", "/new"]);

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
    update: async () => {},
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
    update: async () => {},
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
    update: async () => {},
    error: null,
  };
}

function render(f: ForemanState, i: InspectorState, s: ShippingState): string {
  return renderToStaticMarkup(
    createElement(TrustPanel, { foreman: f, inspector: i, shipping: s }),
  );
}

test("the matrix renders one grant column per subsystem and the add row's anchor", () => {
  const html = render(
    foreman({ repoAllowlist: ["/repo"] }),
    inspector({ repoAllowlist: ["/repo"] }),
    shipping({ repoAllowlist: ["/repo"] }),
  );
  assert.match(html, /data-anchor="trust\/matrix"/);
  assert.match(html, /data-anchor="trust\/add"/);
  assert.match(html, /Foreman sends live/);
  assert.match(html, /Inspector posts reviews/);
  assert.match(html, /YOLO merges/);
  // The one repo appears once, in the mono path cell.
  assert.match(html, /class="trust-repo-path"[^>]*>\/repo</);
  assert.equal((html.match(/class="trust-repo-path"/g) ?? []).length, 1);
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
  // The trapped merge pill is marked, and its repo is named in the footnote.
  assert.match(html, /trust-grant is-on is-trapped/);
  assert.match(html, /YOLO may merge in \/repo/);
});

test("with YOLO disarmed the same lists fly no footnote", () => {
  const html = render(
    foreman(),
    inspector({ repoAllowlist: [] }),
    shipping({ repoAllowlist: ["/repo"], autoMerge: false }),
  );
  assert.doesNotMatch(html, /trust-trap-note/);
});

test("an unreachable subsystem renders the unknown warning, and names which - not 'off'", () => {
  const html = render(foreman({ config: null }), inspector(), shipping());
  assert.match(html, /trust-unknown/);
  assert.match(html, /unknown, not\s+off/);
  assert.match(html, /Foreman/);
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
