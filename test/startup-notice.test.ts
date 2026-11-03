import assert from "node:assert/strict";
import test from "node:test";
import {
  announceStartupNotice, startupNoticePage, STARTUP_NOTICE_CONFIRM_MS, STARTUP_NOTICE_FALLBACK_MS,
  type StartupNoticePort,
} from "../src/main/startup-notice.ts";
import { MIGRATION_IN_PROGRESS_NOTICE } from "../scripts/migration-runtime.mjs";

function port(overrides: Partial<StartupNoticePort> = {}) {
  const log: string[] = [];
  const shown: string[] = [];
  const windows: Array<{body: string; holdMs: number}> = [];
  const value: StartupNoticePort = {
    supported: () => true,
    show: (body, onShown) => { shown.push(body); onShown(); },
    fallback: async (body, holdMs) => { windows.push({body, holdMs}); },
    log: (line) => log.push(line),
    ...overrides,
  };
  return {value, log, shown, windows};
}

const fast = {confirmMs: 30, fallbackMs: 60};

test("a deferred launch posts its notice and leaves as soon as the OS shows it, with no window", async () => {
  const p = port();
  const started = Date.now();
  await announceStartupNotice(MIGRATION_IN_PROGRESS_NOTICE, p.value, {confirmMs: 60_000, fallbackMs: 60_000});
  assert.ok(Date.now() - started < 1_000, "the launch waited out its bound after the notice was shown");
  assert.deepEqual(p.shown, [MIGRATION_IN_PROGRESS_NOTICE]);
  assert.deepEqual(p.windows, [], "a confirmed notification needs no fallback window");
  assert.match(p.log[0]!, /startup deferred: Mission Control is installing an update/);
});

for (const [name, overrides] of [
  ["notifications are unavailable", {supported: () => false, show: () => { throw new Error("must not post"); }}],
  ["support cannot even be read", {supported: () => { throw new Error("no notification center"); }}],
  ["the post fails", {show: () => { throw new Error("notification center unavailable"); }}],
  ["the OS never confirms the post", {show: () => {}}],
] as const) {
  test(`when ${name}, the person still sees the notice, in a window bounded by the fallback hold`, async () => {
    const p = port(overrides as Partial<StartupNoticePort>);
    await announceStartupNotice(MIGRATION_IN_PROGRESS_NOTICE, p.value, fast);
    assert.deepEqual(p.windows, [{body: MIGRATION_IN_PROGRESS_NOTICE, holdMs: fast.fallbackMs}]);
    assert.ok(p.log.some((line) => /showing it in a window/.test(line)), p.log.join("\n"));
  });
}

test("a fallback window that never reports closing, or that throws, cannot hold the bundle", async () => {
  const hung = port({supported: () => false, fallback: () => new Promise<void>(() => {})});
  const started = Date.now();
  await announceStartupNotice("in progress", hung.value, fast);
  assert.ok(Date.now() - started < 2_000, "a hung window held the launch past its bound");

  const throwing = port({supported: () => false, fallback: () => { throw new Error("no display"); }});
  await announceStartupNotice("in progress", throwing.value, fast);
  assert.match(throwing.log.at(-1)!, /could not show the startup notice window: Error: no display/);

  const rejecting = port({supported: () => false, fallback: () => Promise.reject(new Error("window crashed"))});
  await announceStartupNotice("in progress", rejecting.value, fast);
  assert.match(rejecting.log.at(-1)!, /window crashed/);
});

test("the shipped bounds stay a small fraction of the helper's two-minute bundle-exit wait", () => {
  assert.ok(STARTUP_NOTICE_CONFIRM_MS + STARTUP_NOTICE_FALLBACK_MS + 500 <= 15_000);
});

test("the fallback page shows the notice as text, runs nothing, and loads nothing", () => {
  const page = startupNoticePage(MIGRATION_IN_PROGRESS_NOTICE);
  assert.match(page, /<h1>Update in progress<\/h1>/);
  assert.ok(page.includes(MIGRATION_IN_PROGRESS_NOTICE));
  assert.match(page, /default-src 'none'/);
  assert.doesNotMatch(page, /<script|https?:\/\//);
  assert.match(page, /prefers-color-scheme: dark/);
  const hostile = startupNoticePage(`<img src=x onerror="alert(1)"> & "quoted"`);
  assert.ok(hostile.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &quot;quoted&quot;"));
  assert.doesNotMatch(hostile, /<img/);
});
