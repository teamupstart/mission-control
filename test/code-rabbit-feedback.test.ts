// Incomplete or spoofed review data must never authorize a session prompt.
import test from "node:test";
import assert from "node:assert/strict";
import { observeCodeRabbit } from "../src/server/inspector/code-rabbit.ts";
import type { PrSnapshot, ThreadSnapshot } from "../src/server/inspector/github.ts";

const thread = (id = "one", author = "coderabbitai", actorType: string | null = "Bot"): ThreadSnapshot => ({
  id, isResolved: false, path: "src/a.ts", comments: [{
    id: `root-${id}`, databaseId: 1, author, actorType, body: "finding", createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z", url: `https://github.com/a/b/pull/1#discussion_r${id}`,
  }],
});
function input(threads: ThreadSnapshot[], hasNextPage = false, endCursor: string | null = null) {
  return { cwd: null, owner: "a", repo: "b", number: 1, snapshot: {
    threads, threadsPageInfo: { hasNextPage, endCursor },
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
