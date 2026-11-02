// Incomplete or spoofed review data must never authorize a session prompt.
import test from "node:test";
import assert from "node:assert/strict";
import { observeCodeRabbit } from "../src/server/inspector/code-rabbit.ts";
import type { PrSnapshot, ThreadSnapshot } from "../src/server/inspector/github.ts";
import { preMergeBody, preMergeComment } from "./helpers/code-rabbit-pre-merge.ts";
import { preMergeFindings } from "../src/server/inspector/code-rabbit-pre-merge.ts";

const thread = (id = "one", author = "coderabbitai", actorType: string | null = "Bot"): ThreadSnapshot => ({
  id, isResolved: false, path: "src/a.ts", comments: [{
    id: `root-${id}`, databaseId: 1, author, actorType, body: "finding", createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z", url: `https://github.com/a/b/pull/1#discussion_r${id}`,
  }],
});
function input(threads: ThreadSnapshot[], hasNextPage = false, endCursor: string | null = null) {
  return { cwd: null, owner: "a", repo: "b", number: 1, snapshot: {
    state: "OPEN", headSha: "head", headRefName: "fix", title: "Fix", body: "", isDraft: false,
    createdAt: null, mergeable: "UNKNOWN", reviewDecision: null, checks: "none", reviews: [],
    reviewsPageInfo: { hasPreviousPage: false, startCursor: null },
    threads, threadsPageInfo: { hasNextPage, endCursor },
    issueComments: { comments: [], pageInfo: { hasNextPage: false, endCursor: null } },
  } as PrSnapshot };
}

test("only exact Bot roots qualify, including a terminal bot suffix and unresolved outdated threads", async () => {
  const human = thread("human", "human", "User");
  human.comments.push(thread().comments[0]!);
  const result = await observeCodeRabbit(input([
    thread(), thread("suffix", "CodeRabbitAI[bot]"), human,
    thread("spoof", "coderabbitai", "User"), thread("substring", "coderabbitai-helper"),
    { ...thread("resolved"), isResolved: true },
    Object.assign(thread("outdated"), { isOutdated: true }),
  ]));
  assert.equal(result.ok, true);
  assert.deepEqual(result.value?.filter((f) => !f.resolved).map((f) => f.id), ["one", "suffix", "outdated"]);
  assert.equal(result.value?.find((f) => f.id === "resolved")?.resolved, true);
});

test("summary pre-merge errors and warnings join inline findings; passed checks do not count", async () => {
  const i = input([thread()]);
  const comment = preMergeComment(preMergeBody(), "https://github.com/a/b/pull/1#issuecomment-70");
  i.snapshot.issueComments!.comments = [comment,
    { ...comment, id: "human", author: { __typename: "User", login: "coderabbitai" } },
    { ...comment, id: "other-bot", author: { __typename: "Bot", login: "coderabbitai-helper" } },
    { ...comment, id: "summary", body: "Ordinary summary, no pre-merge checks." },
  ];
  const observed = await observeCodeRabbit(i);
  assert.equal(observed.ok, true);
  assert.equal(observed.value!.filter((f) => !f.resolved).length, 4);
  assert.equal(observed.value!.filter((f) => f.resolved).length, 1);
  assert.ok(observed.value!.filter((f) => f.path === null).every((f) => f.url === comment.url));
  const edited = preMergeFindings({ ...comment, updatedAt: "2026-02-01T00:00:00Z",
    body: comment.body.replace("Unrelated review summary", "Changed summary") });
  assert.deepEqual(edited.value, preMergeFindings(comment).value, "unrelated summary edits do not re-arm checks");
  const changedDetails = preMergeFindings({ ...comment, body: preMergeBody("Error", "New unabridged resolution.") }).value!;
  assert.notEqual(changedDetails[0]!.identity, edited.value![0]!.identity);
  assert.equal(changedDetails[1]!.identity, edited.value![1]!.identity, "other checks keep their identities");
  assert.equal(preMergeFindings({ ...comment, body: preMergeBody("Passed") }).value![0]!.resolved, true);
});

test("Failed pre-merge checks are repair candidates; Skipped checks are resolved", () => {
  const failed = preMergeFindings(preMergeComment(preMergeBody("Failed")));
  assert.equal(failed.value?.[0]?.resolved, false);
  const skipped = preMergeFindings(preMergeComment(preMergeBody("Skipped")));
  assert.equal(skipped.value?.[0]?.resolved, true);
});

test("unreadable or unmapped Full details prevent a complete pre-merge observation", async () => {
  const body = preMergeBody();
  for (const malformed of [
    body.replace("Use an online constraint migration.\n</details>", "Use an online constraint migration."),
    body.replace("</strong></summary>\n**Explanation**", "</strong>\n**Explanation**"),
    body.replace("<summary><strong>Full details:", "<div><strong>Full details:"),
    body.replace("Full details: Zero-Downtime Deployment Safety", "Full details: Unknown check"),
  ]) {
    const comment = preMergeComment(malformed, "https://github.com/a/b/pull/1#issuecomment-70");
    assert.equal(preMergeFindings(comment).ok, false, malformed);
    const i = input([]);
    i.snapshot.issueComments!.comments = [comment];
    assert.equal((await observeCodeRabbit(i)).ok, false, "unreadable details cannot become a complete observation");
  }
});

test("edits after nested details remain part of the owning check identity", () => {
  const detail = "<details><summary>Technical context</summary>Lock analysis.</details>\nOriginal full resolution.";
  const original = preMergeFindings(preMergeComment(preMergeBody("Error", detail)));
  const edited = preMergeFindings(preMergeComment(preMergeBody("Error", detail.replace("Original", "Updated"))));
  assert.equal(original.ok, true);
  assert.equal(edited.ok, true);
  assert.notEqual(original.value?.[0]?.identity, edited.value?.[0]?.identity);
  assert.equal(original.value?.[1]?.identity, edited.value?.[1]?.identity);
});

test("pre-merge format changes, partial markers and duplicate checks fail closed", () => {
  const comment = preMergeComment();
  for (const body of [
    comment.body.replace("<!-- pre_merge_checks_walkthrough_end -->", ""),
    comment.body.replace("![Error]", "![Unknown]"),
    comment.body.replace("| Title check |", "| Zero-Downtime Deployment Safety |"),
    "<!-- pre_merge_checks_walkthrough_start --><!-- pre_merge_checks_walkthrough_end -->",
    comment.body + "<!-- pre_merge_checks_walkthrough_start -->",
  ]) assert.equal(preMergeFindings({ ...comment, body }).ok, false, body);
  const htmlStatus = comment.body.replace("![Error](https://example.test/pre-merge.svg)", '<img alt="Error" src="check.svg">');
  assert.equal(preMergeFindings({ ...comment, body: htmlStatus }).value?.[0]?.resolved, false);
});

test("issue comments paginate within the shared observation budget and cannot return partial success", async () => {
  const i = input([]);
  const comment = preMergeComment(preMergeBody(), "https://github.com/a/b/pull/1#issuecomment-70");
  i.snapshot.issueComments!.pageInfo = { hasNextPage: true, endCursor: "comments-1" };
  const page = { comments: [comment], pageInfo: { hasNextPage: false, endCursor: null } };
  const limits = { pages: 20, bytes: 999999, elapsedMs: 1000 };
  const result = await observeCodeRabbit(i, undefined, () => 0, limits, async (cursor, remaining) => {
    assert.equal(cursor, "comments-1"); assert.equal(remaining, 1000);
    return { ok: true, value: page };
  });
  assert.equal(result.value?.filter((f) => !f.resolved).length, 3);
  assert.equal((await observeCodeRabbit(i, undefined, () => 0, limits, async () => ({ ok: false, error: "offline" }))).ok, false);
  for (const value of [
    { ...page, pageInfo: { hasNextPage: true, endCursor: "comments-1" } },
    { ...page, responseBytes: limits.bytes },
    { ...page, comments: [comment, comment] },
    { ...page, error: "malformed" },
    { ...page, comments: [{ ...comment, url: "https://github.com/a/b/pull/2#issuecomment-70" }] },
  ]) assert.equal((await observeCodeRabbit(i, undefined, () => 0, limits, async () => ({ ok: true, value }))).ok, false);
  assert.equal((await observeCodeRabbit(i, undefined, () => 0, { ...limits, pages: 1 }, async () => ({ ok: true, value: page }))).ok, false);
  delete i.snapshot.issueComments;
  assert.equal((await observeCodeRabbit(i)).ok, false, "missing issue-comment data is unknown, never zero");
});

test("deleted or unknown authors are unknown; empty complete connections are zero", async () => {
  assert.equal((await observeCodeRabbit(input([thread("one", "unknown", null)]))).ok, false);
  assert.deepEqual((await observeCodeRabbit(input([]))).value, []);
  const malformed = input([]);
  malformed.snapshot.threadError = "Malformed connection";
  assert.equal((await observeCodeRabbit(malformed)).ok, false);
  delete malformed.snapshot.threadError;
  delete malformed.snapshot.threadsPageInfo;
  assert.equal((await observeCodeRabbit(malformed)).ok, false);
});

test("root URLs match repository casing while retaining the exact origin and PR boundary", async () => {
  const root = thread();
  const adopted = { ...input([root]), owner: "A", repo: "B" };
  assert.equal((await observeCodeRabbit(adopted)).ok, true);
  root.comments[0]!.url = "https://github.com/A/B/pull/1#discussion_rOne";
  const result = await observeCodeRabbit(input([root]));
  assert.equal(result.ok, true);
  assert.equal(result.value?.[0]?.url, root.comments[0]!.url);
  for (const url of [
    "https://github.com/a/other/pull/1#discussion_r1",
    "https://github.com/other/b/pull/1#discussion_r1",
    "https://github.com/a/b/pull/10#discussion_r1",
    "https://github.com/a/b/pull/1/extra#discussion_r1",
    "https://github.com.evil.test/a/b/pull/1#discussion_r1",
    "http://github.com/a/b/pull/1#discussion_r1",
  ]) {
    root.comments[0]!.url = url;
    assert.equal((await observeCodeRabbit(adopted)).ok, false, url);
  }
});

test("page two is included; replies do not change the root generation identity", async () => {
  const first = thread();
  const a = await observeCodeRabbit(input([first], true, "cursor"), async () => ({ ok: true, value: {
    threads: [thread("two")], pageInfo: { hasNextPage: false, endCursor: null },
  } }));
  assert.equal(a.value?.length, 2);
  first.comments.push({ ...first.comments[0]!, body: "new reply" });
  assert.equal((await observeCodeRabbit(input([first]))).value?.[0]?.identity, a.value?.[0]?.identity);
  first.comments[0]!.body = "edited finding";
  assert.notEqual((await observeCodeRabbit(input([first]))).value?.[0]?.identity, a.value?.[0]?.identity);
});

test("provider failure, cursor loops, missing cursors, repeated roots and all resource caps fail closed", async () => {
  assert.equal((await observeCodeRabbit(input([], true, "a"), async () => ({ ok: false, error: "offline" }))).ok, false);
  assert.equal((await observeCodeRabbit(input([], true))).ok, false);
  assert.equal((await observeCodeRabbit(input([], true, "a"), async () => ({ ok: true, value: {
    threads: [], pageInfo: { hasNextPage: true, endCursor: "a" },
  } }))).ok, false);
  assert.equal((await observeCodeRabbit(input([thread(), thread()]))).ok, false);
  for (const limits of [
    { pages: 1, bytes: 99999, elapsedMs: 100 },
    { pages: 20, bytes: 1, elapsedMs: 100 },
    { pages: 20, bytes: 99999, elapsedMs: 0 },
  ]) assert.equal((await observeCodeRabbit(input([], true, "a"), undefined, () => 1, limits)).ok, false);
});
