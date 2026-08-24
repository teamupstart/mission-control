/**
 * What the repo picker offers for what you type.
 *
 * The rule is one sentence - the repos whose NAME matches, or, when none does, the repos whose
 * PATH does - and it is the sentence that makes the guided pass's Repo step worth having: every
 * checkout in a workspace shares a long leading prefix, so the substring-over-the-whole-path
 * match this replaced returned nearly all of them for any common letter and the first keystroke
 * narrowed nothing.
 *
 * A unit test because the rule is a pure function, extracted for exactly that reason (the same
 * split `filterSessionFiles` keeps in `FilePicker`). What it cannot see is that the widget draws
 * what this returns, or that ↵ takes the highlighted row - `e2e/specs/guided-dispatch.spec.ts`
 * drives that, and `e2e/specs/multi-repo-dispatch.spec.ts` is the standing proof that the OTHER
 * caller of this shared control still resolves a full path pasted into it.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { filterRepos, repoOptionLabels } from "../src/web/components/RepoCombobox.tsx";

/** A workspace as an operator's actually looks: one prefix, many leaves. */
const REPOS = [
  "/Users/dev/workspace/ai-harness",
  "/Users/dev/workspace/mission-control",
  "/Users/dev/workspace/second-repo",
  "/Users/dev/workspace/service2",
  "/Users/dev/clients/acme/api",
  "/Users/dev/clients/acme/web",
];

test("an empty query offers every repo, in the workspace's own order", () => {
  // Order is not incidental: the arrows walk this list, so a filter that re-sorted on each
  // keystroke would move the row under the highlight while it was being aimed at.
  assert.deepEqual(filterRepos(REPOS, ""), REPOS);
  assert.deepEqual(filterRepos(REPOS, "   "), REPOS);
});

test("a common letter narrows to the names that hold it, not to every path that does", () => {
  // `e` is in `/Users/dev/workspace/` - it is in the prefix of all six - so the old
  // path-substring match returned the whole list here and typing bought nothing.
  assert.deepEqual(filterRepos(REPOS, "e"), [
    "/Users/dev/workspace/ai-harness",
    "/Users/dev/workspace/second-repo",
    "/Users/dev/workspace/service2",
    "/Users/dev/clients/acme/web",
  ]);
  // And a fragment of a name reaches its repo alone.
  assert.deepEqual(filterRepos(REPOS, "harn"), ["/Users/dev/workspace/ai-harness"]);
});

test("a digit filters, because repository names contain digits", () => {
  // The reason the Repo step spends no digit on selecting by position: a `2` that picked the
  // second row would make this repo the one repo nobody can type their way to.
  assert.deepEqual(filterRepos(REPOS, "service2"), ["/Users/dev/workspace/service2"]);
  assert.deepEqual(filterRepos(REPOS, "2"), ["/Users/dev/workspace/service2"]);
});

test("a typed absolute path still resolves, through the fallback rather than a second mode", () => {
  // No basename contains a `/`, so a path matches nothing by name and falls through to the
  // path match by itself. This is the multi-repo attach field's whole usage, and it is why
  // that spec needed no edit when this rule changed.
  assert.deepEqual(filterRepos(REPOS, "/Users/dev/workspace/second-repo"), [
    "/Users/dev/workspace/second-repo",
  ]);
  assert.deepEqual(filterRepos(REPOS, "clients/acme"), [
    "/Users/dev/clients/acme/api",
    "/Users/dev/clients/acme/web",
  ]);
});

test("a directory an operator files by is still findable, when no name matches it", () => {
  // The fallback earns its keep here. `acme` names no repo, so a name-only match would have
  // made a whole client folder unreachable by the word its owner calls it.
  assert.deepEqual(filterRepos(REPOS, "acme"), [
    "/Users/dev/clients/acme/api",
    "/Users/dev/clients/acme/web",
  ]);
  // But a name match wins outright where there is one: `api` is a repo, and the folder above
  // it does not dilute the answer.
  assert.deepEqual(filterRepos(REPOS, "api"), ["/Users/dev/clients/acme/api"]);
});

test("matching ignores case and surrounding space, as typing into a path field does", () => {
  assert.deepEqual(filterRepos(REPOS, "  AI-Harness "), ["/Users/dev/workspace/ai-harness"]);
});

test("a query nothing holds offers nothing, rather than falling back to everything", () => {
  // The fallback is for a query the NAMES miss and the paths hold. A query neither holds is a
  // typo, and answering it with all 202 repos would read as the filter having given up.
  assert.deepEqual(filterRepos(REPOS, "zzz"), []);
});

test("the returned list is a copy, so a caller cannot sort the workspace out from under itself", () => {
  const out = filterRepos(REPOS, "");
  out.reverse();
  assert.equal(REPOS[0], "/Users/dev/workspace/ai-harness");
});

/**
 * What each offered row READS as, which is the other half of the same complaint: a filter
 * that narrows correctly still leaves an unreadable menu if every surviving row draws the
 * whole path, because the list is only as wide as its input and the ellipsis therefore lands
 * before the directory name.
 *
 * The rule these pin is that NOTHING a row draws is a path - not the name, and not the hint
 * a colliding row carries. A first pass printed the parent DIRECTORY there and passed its own
 * tests against `~/clients/acme`; under a temp root the same code rendered
 * `/private/var/folders/1c/djbypfjn…/workspace/alpha`, which is the wall of shared prefix
 * this whole function exists to remove, put back one line lower. So these assert exact
 * strings, and the last one asserts the property directly.
 */
test("a row is the checkout's name, with no hint when the name is already unique", () => {
  assert.deepEqual(repoOptionLabels(["/Users/dev/workspace/ai-harness"]), [
    { repo: "/Users/dev/workspace/ai-harness", name: "ai-harness", hint: null },
  ]);
  // The whole workspace, offered at once - the state the screenshot in the bug report shows -
  // and not one row falls back to a path.
  assert.deepEqual(
    repoOptionLabels(REPOS.slice(0, 4)).map((o) => o.name),
    ["ai-harness", "mission-control", "second-repo", "service2"],
  );
  assert.ok(repoOptionLabels(REPOS.slice(0, 4)).every((o) => o.hint === null));
});

test("two checkouts sharing a name are told apart by ONE folder name, not by a path", () => {
  const labels = repoOptionLabels(["/Users/dev/clients/acme/api", "/Users/dev/work/beta/api"]);
  assert.deepEqual(labels, [
    { repo: "/Users/dev/clients/acme/api", name: "api", hint: "acme" },
    { repo: "/Users/dev/work/beta/api", name: "api", hint: "beta" },
  ]);
});

test("the group walks up past an ancestor that does not separate it", () => {
  // Both sit in `shared`, so the immediate parent names the two rows identically and settles
  // nothing. The group climbs together and stops at the first level where the names differ,
  // and BOTH rows are labelled from that one level - a hint chosen per row could compare a
  // grandparent against a parent and read as though they were the same kind of fact.
  assert.deepEqual(repoOptionLabels(["/home/x/shared/api", "/home/y/shared/api"]), [
    { repo: "/home/x/shared/api", name: "api", hint: "x" },
    { repo: "/home/y/shared/api", name: "api", hint: "y" },
  ]);
});

test("the hint answers the offered list, not every repo the daemon knows", () => {
  // `acme/api` and `acme/web` are both in REPOS and neither collides, so a query that offers
  // only one of them must not start explaining itself. Computing collisions over the whole
  // known set instead would put a second line back on rows that do not need one.
  const offered = filterRepos([...REPOS, "/Users/dev/work/beta/api"], "web");
  assert.deepEqual(offered, ["/Users/dev/clients/acme/web"]);
  assert.deepEqual(repoOptionLabels(offered), [
    { repo: "/Users/dev/clients/acme/web", name: "web", hint: null },
  ]);
});

test("a checkout with no folder above it carries no hint, rather than a stand-in", () => {
  // `/api` sits at the filesystem root, so there is no folder name to label it by. It gets
  // nothing. An earlier pass printed `/` here and this test asserted it, which made the
  // no-paths invariant say "no paths, except this one" - and one character of path is still
  // path. The pair stays distinguishable anyway: one `api` carries a folder and one does not.
  assert.deepEqual(repoOptionLabels(["/api", "/srv/api"]), [
    { repo: "/api", name: "api", hint: null },
    { repo: "/srv/api", name: "api", hint: "srv" },
  ]);
});

test("a group nothing can separate still never renders a path", () => {
  // Neither row has an ancestor at any level, so the walk finds no distinguishing level and
  // both come back bare. Weaker than the cases above and deliberately so: the alternative is
  // inventing a label, and the full path is already one hover away on the row's tooltip.
  assert.deepEqual(repoOptionLabels(["/api", "/api/"]), [
    { repo: "/api", name: "api", hint: null },
    { repo: "/api/", name: "api", hint: null },
  ]);
});

test("no label is ever a path, including under a deep temp root", () => {
  // The exact shape the review caught, asserted as the PROPERTY rather than as two more
  // expected strings - a rule stated once here cannot be satisfied by a fixture that happens
  // to be shallow. A separator anywhere in a name or a hint is the defect.
  const deep = [
    "/private/var/folders/1c/djbypfjn4px99pjhhdj8xhyc0000gn/T/mc-e2e-F1RHuK/workspace/alpha/shared-lib",
    "/private/var/folders/1c/djbypfjn4px99pjhhdj8xhyc0000gn/T/mc-e2e-F1RHuK/workspace/beta/shared-lib",
    "/private/var/folders/1c/djbypfjn4px99pjhhdj8xhyc0000gn/T/mc-e2e-F1RHuK/workspace/demo-repo",
  ];
  const labels = repoOptionLabels(deep);
  assert.deepEqual(
    labels.map((o) => [o.name, o.hint]),
    [
      ["shared-lib", "alpha"],
      ["shared-lib", "beta"],
      ["demo-repo", null],
    ],
  );
  assertNoPaths(labels);
});

/**
 * The invariant, with NO exceptions carved out of it.
 *
 * An earlier version of this helper allowed `hint === "/"` through, on the reasoning that the
 * filesystem root is a name. It is not - it is a separator, it is the only thing a row may
 * never draw, and an exception written into the checker is exactly how the property stops
 * being checkable. A row with no folder to name carries no hint at all instead.
 */
function assertNoPaths(labels: { name: string; hint: string | null }[]): void {
  for (const { name, hint } of labels) {
    assert.ok(!name.includes("/"), `a row name must not hold a separator, got "${name}"`);
    assert.ok(
      hint === null || !hint.includes("/"),
      `a row hint must be a folder name or nothing, got "${hint}"`,
    );
  }
}

test("no offered list anywhere in these fixtures renders a path", () => {
  // Swept over every case this file builds, including the root-level ones, so the invariant is
  // enforced once for all of them rather than restated per test - and so a future case added
  // above cannot quietly opt out of it.
  for (const offered of [
    REPOS,
    REPOS.slice(0, 4),
    ["/api", "/srv/api"],
    ["/api", "/api/"],
    ["/home/x/shared/api", "/home/y/shared/api"],
    ["/Users/dev/clients/acme/api", "/Users/dev/work/beta/api"],
    [...REPOS, "/Users/dev/work/beta/api"],
  ]) {
    assertNoPaths(repoOptionLabels(offered));
  }
});
