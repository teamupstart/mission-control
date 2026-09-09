import { test } from "node:test";
import assert from "node:assert/strict";
import { GithubIssuesConfigSchema } from "../src/shared/task-source.ts";
import type { GithubIssuesConfig, WritebackNotice } from "../src/shared/task-source.ts";
import {
  ghCloseReason,
  ghIssueCloseArgs,
  ghIssueCommentArgs,
  writebackCommentBody,
  writebackResultFrom,
} from "../src/server/task-sources/github-issues.ts";
import type { RunResult } from "../src/server/util/exec.ts";

// What is at stake: these are the two calls that write onto an issue other people are
// reading, and both halves worth testing are pure - which argv leaves, and how one run
// reads back. Neither test spawns anything.
//
// Three claims carry the file:
//
//   1. The comment goes to the issue the TASK came from, addressed from that item's own
//      id rather than from a `repo` that may have been reconfigured since the sweep.
//   2. The stored close reason reaches `gh` in the spelling `gh` accepts. This is a bug
//      the schema cannot catch, because both spellings are valid strings.
//   3. A refusal, an unknown outcome and an already-closed issue are three different
//      answers, and collapsing any pair of them is a real failure mode: a retried
//      transition undoes a person, and six retries at an already-closed issue end in a
//      reported failure about an issue that is closed.

const cfg = (over: Partial<GithubIssuesConfig> = {}): GithubIssuesConfig => ({
  ...GithubIssuesConfigSchema.parse({}),
  ...over,
});

const notice = (over: Partial<WritebackNotice> = {}): WritebackNotice => ({
  signal: "pr-opened",
  action: "annotate",
  externalId: "acme/demo#7",
  externalUrl: "https://github.com/acme/demo/issues/7",
  taskTitle: "Fix the parser",
  prUrl: "https://github.com/acme/demo/pull/9",
  repoRoot: "/repo",
  outcome: null,
  observedAt: 1_700_000_000_000,
  ...over,
});

const res = (over: Partial<RunResult> = {}): RunResult =>
  ({ stdout: "", stderr: "", code: 0, outcomeUnknown: false, ...over }) as RunResult;

// ---- addressing the issue ----

// The item's own id, not the source's `repo`. `externalIdFor` composes that id from the
// issue URL for exactly this reason: it is stable, and a `repo` reconfigured (or left
// empty to resolve from origin) after the sweep would otherwise aim a comment at a
// different repository than the issue is in.
test("the comment is addressed from the item's own id, not the configured repo", () => {
  const args = ghIssueCommentArgs(cfg({ repo: "someone/else" }), notice());
  assert.deepEqual(args.slice(0, 5), [
    "issue",
    "comment",
    "7",
    "--repo",
    "acme/demo",
  ]);
});

// The fallback shape: an id `externalIdFor` could not parse is the URL itself, and `gh`
// resolves a URL on its own. `--repo` alongside a URL is the one combination gh refuses,
// so it must not be passed.
test("an item id that is a bare URL is passed to gh without --repo", () => {
  const args = ghIssueCommentArgs(
    cfg({ repo: "acme/demo" }),
    notice({ externalId: "https://github.com/acme/demo/issues/7" }),
  );
  assert.equal(args[2], "https://github.com/acme/demo/issues/7");
  assert.equal(args.includes("--repo"), false);
});

// The last fallback, where neither the id nor a url names a repository: the configured
// `repo` is all there is, and it is better than nothing.
test("the configured repo is the fallback when the item names none", () => {
  const args = ghIssueCommentArgs(
    cfg({ repo: "acme/demo" }),
    notice({ externalId: "7", externalUrl: null }),
  );
  assert.deepEqual(args.slice(0, 5), ["issue", "comment", "7", "--repo", "acme/demo"]);
});

// ---- what a person reads ----

test("a pr-opened comment names the pull request, the task, and who wrote it", () => {
  const body = writebackCommentBody(notice());
  assert.match(body, /Mission Control/);
  assert.match(body, /opened a pull request/);
  assert.match(body, /https:\/\/github\.com\/acme\/demo\/pull\/9/);
  assert.match(body, /Task: Fix the parser/);
});

// The completion's OWN words, not a sentence we invented for it.
test("a completion comment carries the outcome the task recorded", () => {
  const body = writebackCommentBody(
    notice({ signal: "task-completed", outcome: "shipped in #9, no follow-up needed" }),
  );
  assert.match(body, /shipped in #9, no follow-up needed/);
  assert.match(body, /Pull request: https:\/\/github\.com\/acme\/demo\/pull\/9/);
});

// A completion with nothing to say gets no filler. The pull request is the fact; a
// manufactured sentence would be words nobody wrote appearing under our name.
test("a completion with no outcome and no pull request still says what happened", () => {
  const body = writebackCommentBody(
    notice({ signal: "task-completed", outcome: null, prUrl: null }),
  );
  assert.match(body, /Mission Control finished the task/);
  assert.equal(/Pull request:/.test(body), false);
  assert.match(body, /Task: Fix the parser/);
});

// Nothing of OURS crosses into somebody else's tracker - the same restraint `PushDraft`
// imposes on the other outward verb.
test("the comment leaks no worktree, task id, or status", () => {
  const body = writebackCommentBody(notice({ signal: "task-completed", outcome: "done" }));
  assert.equal(/worktree|task-|status/i.test(body), false);
});

// ---- the close reason: the whole bug the mapping exists to prevent ----
//
// Asserted by the EMITTED ARGV, not by round-tripping the schema value. A test that only
// checked the stored spelling would pass while every close failed, because both spellings
// are valid strings and only one of them is a thing `gh` accepts.

test("the stored not-planned reason reaches gh as the two-word spelling", () => {
  const args = ghIssueCloseArgs(cfg({ closeReason: "not-planned" }), notice());
  const i = args.indexOf("--reason");
  assert.notEqual(i, -1, "the close carries no reason at all");
  assert.equal(args[i + 1], "not planned");
});

test("the default close reason is completed, and passes through unchanged", () => {
  assert.equal(cfg().closeReason, "completed");
  const args = ghIssueCloseArgs(cfg(), notice());
  assert.equal(args[args.indexOf("--reason") + 1], "completed");
  assert.equal(ghCloseReason("completed"), "completed");
});

test("the close is addressed the same way the comment is", () => {
  assert.deepEqual(ghIssueCloseArgs(cfg(), notice()).slice(0, 5), [
    "issue",
    "close",
    "7",
    "--repo",
    "acme/demo",
  ]);
});

// ---- reading one run ----

test("a clean exit is a success carrying the caller's detail", () => {
  const r = writebackResultFrom(res({ code: 0 }), "commented");
  assert.deepEqual(r, { error: null, outcomeUnknown: false, detail: "commented" });
});

// Nothing was written, so a retry cannot duplicate. That is what `outcomeUnknown: false`
// asserts, and it is the only reading that lets the worker back off and try again.
test("a non-zero exit is a retry-safe refusal that names the reason", () => {
  const r = writebackResultFrom(
    res({ code: 1, stderr: "GraphQL: Could not resolve to an Issue (addComment)" }),
    "commented",
  );
  assert.equal(r.outcomeUnknown, false);
  assert.equal(r.detail, null);
  assert.match(r.error!, /Could not resolve to an Issue/);
});

// A child that died rather than answering: our timeout, the OOM killer, a signal. GitHub
// may well have taken the request first, so this is the one answer that must never be
// retried automatically - see `WritebackResult.outcomeUnknown`.
test("a killed child is unknown, never a refusal", () => {
  const r = writebackResultFrom(res({ code: null, outcomeUnknown: true }), "commented");
  assert.equal(r.outcomeUnknown, true);
  assert.equal(r.detail, null);
  assert.match(r.error!, /may have landed/);
});

// The desired state already holds. Read as a failure, this would burn six retries reaching
// a state that is already true and then report a failure about a closed issue.
test("an already-closed issue reads as success, not as a refusal", () => {
  const r = writebackResultFrom(
    res({ code: 1, stderr: "! Issue acme/demo#7 (Fix the parser) is already closed" }),
    "closed as completed",
  );
  assert.equal(r.error, null);
  assert.equal(r.outcomeUnknown, false);
  assert.equal(r.detail, "already closed");
});

// `gh` error text can carry local filesystem paths, which is why `issue-create.ts` keeps
// process output off its success path. The same rule applies here.
test("a refusal's detail is one line and bounded", () => {
  const long = `${"x".repeat(5_000)}\nsecond line`;
  const r = writebackResultFrom(res({ code: 1, stderr: long }), "commented");
  assert.equal(r.error!.includes("second line"), false);
  assert.ok(r.error!.length < 1_100, "the refusal carried an unbounded blob of output");
});
