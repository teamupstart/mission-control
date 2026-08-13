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

import { filterRepos } from "../src/web/components/RepoCombobox.tsx";

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
