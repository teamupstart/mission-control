import assert from "node:assert/strict";
import test from "node:test";
import { trailingRead } from "../src/web/lib/trailing-read.ts";

function controlledRead() {
  const started: Array<() => void> = [];
  const read = () => new Promise<void>((resolve) => { started.push(resolve); });
  return { started, read };
}

test("calls made during a slow read share one trailing read, and every read lands", async () => {
  const { started, read } = controlledRead();
  const refresh = trailingRead(read);
  const settled: string[] = [];
  const first = refresh().then(() => settled.push("first"));
  const second = refresh().then(() => settled.push("second"));
  const third = refresh().then(() => settled.push("third"));
  assert.equal(started.length, 1, "one read in flight, however many invalidations arrive");

  started[0]!();
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started.length, 2, "the trailing read starts once the first lands");
  assert.deepEqual(settled, ["first"], "a caller waits for a read that began after its call");

  started[1]!();
  await Promise.all([second, third]);
  assert.deepEqual(settled, ["first", "second", "third"]);
  assert.equal(started.length, 2);
});

test("a failed read still lets the trailing read run, and an idle refresh starts at once", async () => {
  let calls = 0;
  let fail!: (error: Error) => void;
  const refresh = trailingRead(() => {
    calls += 1;
    return calls === 1 ? new Promise<void>((_, reject) => { fail = reject; }) : Promise.resolve();
  });
  const first = refresh();
  const trailing = refresh();
  fail(new Error("inventory unavailable"));
  await assert.rejects(first, /inventory unavailable/);
  await trailing;
  assert.equal(calls, 2);
  await refresh();
  assert.equal(calls, 3);
});
