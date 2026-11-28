// Headless mode phase 8: the mod core. The controller, the glance layer and the daemon link run
// against the fake host and the fake daemon, so no engine and no model tokens are involved.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { bandFor, nextAttention, statusFor } from "../src/mod/attention.ts";
import { bannerLines } from "../src/mod/banner.ts";
import { MOD_API, MOD_VERSION } from "../src/mod/constants.ts";
import { createModCore, DAEMON_DOWN_NOTICE, type ModSessionFacts } from "../src/mod/core.ts";
import { daemonBaseUrl, readDaemonToken, tokenFileCandidates } from "../src/mod/daemon-link.ts";
import type { ModState } from "../src/mod/host.ts";
import type { HomeDispatchInbox } from "../src/shared/home-dispatch.ts";
import { findDisallowedModCalls, isAllowedModCall, pathLiterals } from "../scripts/mod-calls.mjs";
import { isFlagOffAnswer } from "../src/mod/client.ts";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CANNED_INBOX,
  CANNED_REGISTRATION,
  FAKE_SESSION_ID,
  createFakeDaemon,
  createFakeModHost,
} from "./helpers/home-dispatch-fakes.ts";
import { tempDir } from "./temp-root.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

const FACTS: ModSessionFacts = {
  sessionId: FAKE_SESSION_ID,
  cwd: "/fake/repo",
  modVersion: MOD_VERSION,
  source: "startup",
  entrypoint: "cli",
  interactive: true,
};

const NOTHING_WAITS: HomeDispatchInbox = {
  ...CANNED_INBOX,
  items: CANNED_INBOX.items.filter((item) => item.state !== "waiting"),
  needsYou: [],
  counts: { ...CANNED_INBOX.counts, waiting: 0 },
};

function setup(opts: { flag?: boolean; interactive?: boolean } = {}) {
  const daemon = createFakeDaemon({ flag: opts.flag ?? true });
  const fake = createFakeModHost({ daemon });
  const core = createModCore(fake.host, { ...FACTS, interactive: opts.interactive ?? true });
  return { daemon, fake, core };
}

const daemonPaths = (daemon: ReturnType<typeof createFakeDaemon>) => daemon.requests.map((r) => `${r.method} ${r.path}`);

test("flag off: the mod shows and opens nothing, and registers nothing", async () => {
  const { daemon, fake, core } = setup({ flag: false });
  await core.start();
  await core.tick();
  assert.equal(core.phase(), "connecting");
  assert.deepEqual(fake.calls.filter((c) => c.type !== "fetch"), []);
  assert.deepEqual(daemonPaths(daemon), ["GET /api/health", "GET /api/health"]);
});

test("the flag turning on later connects without a restart, and turning off clears everything", async () => {
  const { daemon, fake, core } = setup({ flag: false });
  await core.start();
  assert.equal(fake.paneOpens.length, 0);
  daemon.setFlag(true);
  await core.tick();
  assert.equal(core.phase(), "active");
  assert.equal(fake.paneOpens.length, 1);
  assert.ok(fake.bands.at(-1));
  daemon.setFlag(false);
  await core.tick();
  assert.equal(core.phase(), "connecting");
  assert.equal(fake.bands.at(-1), undefined);
  assert.equal(fake.statuses.at(-1), undefined);
  assert.equal(fake.banners.at(-1), undefined);
  assert.equal(fake.paneCloses, 1);
  // It reopens the pane when the flag comes back.
  daemon.setFlag(true);
  await core.tick();
  assert.equal(fake.paneOpens.length, 2);
});

test("daemon down: one notice per outage, then it connects when the daemon starts", async () => {
  const { daemon, fake, core } = setup();
  daemon.setDown(true);
  await core.start();
  await core.tick();
  await core.tick();
  assert.deepEqual(fake.notices, [DAEMON_DOWN_NOTICE]);
  assert.equal(fake.paneOpens.length, 0);
  daemon.setDown(false);
  await core.tick();
  assert.equal(core.phase(), "active");
  assert.deepEqual(fake.notices, [DAEMON_DOWN_NOTICE]);
  // A second outage says so again.
  daemon.setDown(true);
  await core.tick();
  assert.deepEqual(fake.notices, [DAEMON_DOWN_NOTICE, DAEMON_DOWN_NOTICE]);
  assert.equal(fake.bands.at(-1), undefined);
});

test("the pane opens once at session start, unfocused on Needs you, and not again on later polls", async () => {
  const { fake, core } = setup();
  await core.start();
  await core.tick();
  await core.tick();
  assert.deepEqual(fake.paneOpens, [{ tab: "needs-you" }]);
  assert.equal(fake.state.paneTab, "needs-you");
  assert.equal(fake.paneCloses, 0);
});

test("a pane that cannot be placed does not stop the glance layer", async () => {
  const daemon = createFakeDaemon();
  const fake = createFakeModHost({ daemon, placed: false });
  const core = createModCore(fake.host, FACTS);
  await core.start();
  assert.equal(core.phase(), "active");
  assert.ok(fake.bands.at(-1));
});

test("the band's button opens the pane on Needs you with focus", async () => {
  const { fake, core } = setup();
  await core.start();
  const band = fake.bands.at(-1);
  assert.deepEqual(band?.button, { label: "1 Open Needs you", hotkey: "1" });
  await core.openNeedsYou();
  assert.deepEqual(fake.paneOpens.at(-1), { tab: "needs-you", focus: true });
});

test("registration carries the mod's version and the inbox is read for this session and repository", async () => {
  const { daemon, core } = setup();
  await core.start();
  const registration = daemon.requests.find((r) => r.pattern === "/dispatch/sessions");
  assert.equal((registration!.body as { clientVersion: string }).clientVersion, MOD_VERSION);
  assert.equal((registration!.body as { beforeFirstPrompt: boolean }).beforeFirstPrompt, true);
  const inbox = daemon.requests.find((r) => r.pattern === "/dispatch/inbox");
  assert.deepEqual(inbox?.query, { repo: CANNED_REGISTRATION.repoRoot, session: FAKE_SESSION_ID });
});

test("banner: the daemon's lines show at start and go away at the first prompt", async () => {
  const daemon = createFakeDaemon({
    routes: { "POST /dispatch/sessions": () => ({ body: { ...CANNED_REGISTRATION, banner: ["one", "two", "three"] } }) },
  });
  const fake = createFakeModHost({ daemon });
  const core = createModCore(fake.host, FACTS);
  await core.start();
  assert.deepEqual(fake.banners, [["one", "two", "three"]]);
  core.promptSubmitted();
  core.promptSubmitted();
  assert.deepEqual(fake.banners, [["one", "two", "three"], undefined]);
});

test("banner: with no lines from the daemon the mod builds the same three from the shared builder", () => {
  const lines = bannerLines({ ...CANNED_REGISTRATION, daemonVersion: MOD_VERSION });
  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /Mission Control/);
  assert.match(lines[2]!, /1 running \| 1 waiting on you \| I will ask how you want to start/);
  const mismatched = bannerLines({ ...CANNED_REGISTRATION, daemonVersion: "9.9.9" });
  assert.match(mismatched[2]!, /run mctl doctor/);
});

test("a prompt typed before the first connection does not bring the banner back", async () => {
  const { daemon, fake, core } = setup();
  daemon.setDown(true);
  await core.start();
  core.promptSubmitted();
  daemon.setDown(false);
  await core.tick();
  assert.deepEqual(fake.banners.filter((b) => b !== undefined), []);
  const registration = daemon.requests.find((r) => r.pattern === "/dispatch/sessions");
  assert.equal((registration!.body as { beforeFirstPrompt: boolean }).beforeFirstPrompt, false);
});

test("toasts are for new items only: none for what waited at start, one for each new ask", async () => {
  const { daemon, fake, core } = setup();
  await core.start();
  await core.tick();
  assert.deepEqual(fake.toasts, []);

  const second = { ...CANNED_INBOX.items[0]!, taskId: "mc-new1", title: "second task", pending: { ...CANNED_INBOX.items[0]!.pending!, reviewId: "review-2" } };
  const two: HomeDispatchInbox = { ...CANNED_INBOX, items: [...CANNED_INBOX.items, second], needsYou: [...CANNED_INBOX.needsYou, "mc-new1"] };
  daemon.override("GET /dispatch/inbox", () => ({ body: two }));
  await core.tick();
  assert.deepEqual(fake.toasts, ['Mission Control: "second task" asks a question']);
  await core.tick();
  assert.equal(fake.toasts.length, 1);
  assert.equal(fake.bands.at(-1)?.text, "◆ 2 tasks need you");
});

test("a task that becomes ready or fails toasts once", async () => {
  const { daemon, fake, core } = setup();
  await core.start();
  const done: HomeDispatchInbox = {
    ...CANNED_INBOX,
    items: CANNED_INBOX.items.map((item) => (item.state === "running" ? { ...item, state: "ready" as const } : item)),
  };
  daemon.override("GET /dispatch/inbox", () => ({ body: done }));
  await core.tick();
  await core.tick();
  assert.deepEqual(fake.toasts, ['Mission Control: "flaky test" is ready']);

  const failed: HomeDispatchInbox = {
    ...CANNED_INBOX,
    items: CANNED_INBOX.items.map((item) => (item.state === "running" ? { ...item, state: "failed" as const } : item)),
  };
  daemon.override("GET /dispatch/inbox", () => ({ body: failed }));
  await core.tick();
  await core.tick();
  assert.deepEqual(fake.toasts, ['Mission Control: "flaky test" is ready', 'Mission Control: "flaky test" failed']);
});

test("a bad inbox reply keeps what is shown, then the next good one updates it", async () => {
  const { daemon, fake, core } = setup();
  await core.start();
  const band = fake.bands.at(-1);
  const status = fake.statuses.at(-1);
  assert.ok(band && status);
  const shown = fake.bands.length + fake.statuses.length;

  daemon.override("GET /dispatch/inbox", () => ({ status: 500, body: { error: "boom" } }));
  await core.tick();
  daemon.override("GET /dispatch/inbox", () => ({ body: { items: "not an inbox" } }));
  await core.tick();
  assert.equal(core.phase(), "active");
  assert.equal(fake.bands.length + fake.statuses.length, shown);
  assert.equal(fake.bands.at(-1), band);
  assert.equal(core.inbox()?.needsYou.length, 1);
  assert.equal(fake.paneCloses, 0);

  daemon.override("GET /dispatch/inbox", () => ({ body: NOTHING_WAITS }));
  await core.tick();
  assert.equal(fake.bands.at(-1), undefined);
  assert.equal(fake.statuses.at(-1), undefined);
});

test("the first prompt touches nothing while the flag is off or after a modApi mismatch", async () => {
  const off = setup({ flag: false });
  await off.core.start();
  off.core.promptSubmitted();
  assert.deepEqual(off.fake.calls.filter((c) => c.type !== "fetch"), []);

  const daemon = createFakeDaemon({
    routes: { "POST /dispatch/sessions": () => ({ body: { ...CANNED_REGISTRATION, minModApi: MOD_API + 1 } }) },
  });
  const fake = createFakeModHost({ daemon });
  const core = createModCore(fake.host, FACTS);
  await core.start();
  core.promptSubmitted();
  assert.deepEqual(fake.calls.filter((c) => c.type !== "fetch"), []);
});

test("band and status exist only while something needs you", async () => {
  const { daemon, fake, core } = setup();
  await core.start();
  assert.equal(fake.bands.at(-1)?.tone, "warning");
  assert.match(fake.statuses.at(-1)!, /logging cleanup needs you/);
  daemon.override("GET /dispatch/inbox", () => ({ body: NOTHING_WAITS }));
  await core.tick();
  assert.equal(fake.bands.at(-1), undefined);
  assert.equal(fake.statuses.at(-1), undefined);
});

test("a blocked item makes the band an error and the pure helpers agree", () => {
  const blocked: HomeDispatchInbox = {
    ...CANNED_INBOX,
    items: CANNED_INBOX.items.map((item) => (item.state === "waiting" ? { ...item, state: "blocked" as const, pending: undefined } : item)),
  };
  assert.equal(bandFor(blocked)?.tone, "error");
  assert.equal(bandFor(NOTHING_WAITS), undefined);
  assert.equal(statusFor(NOTHING_WAITS), undefined);
  assert.deepEqual(nextAttention(null, CANNED_INBOX).toasts, []);
  const seen = nextAttention(null, CANNED_INBOX).memory;
  assert.deepEqual(nextAttention(seen, CANNED_INBOX).toasts, []);
});

test("a modApi mismatch leaves the mod inert: nothing shown, nothing polled, the clock stopped", async () => {
  const daemon = createFakeDaemon({
    routes: { "POST /dispatch/sessions": () => ({ body: { ...CANNED_REGISTRATION, minModApi: MOD_API + 1 } }) },
  });
  const fake = createFakeModHost({ daemon });
  const core = createModCore(fake.host, FACTS);
  await core.start();
  await core.tick();
  assert.equal(core.phase(), "inert");
  assert.equal(fake.activeClocks(), 0);
  assert.deepEqual(fake.calls.filter((c) => c.type !== "fetch"), []);
  assert.equal(daemon.requests.some((r) => r.pattern === "/dispatch/inbox"), false);
});

test("a session with no one at the prompt is inert and never calls the daemon", async () => {
  const { daemon, fake, core } = setup({ interactive: false });
  await core.start();
  assert.equal(core.phase(), "inert");
  assert.equal(daemon.requests.length, 0);
  assert.equal(fake.calls.length, 0);
});

test("the inbox is polled when five seconds have passed, not before", async () => {
  const { daemon, fake, core } = setup();
  await core.start();
  assert.deepEqual(fake.clockPeriods(), [5000]);
  const inboxRequests = () => daemon.requests.filter((r) => r.pattern === "/dispatch/inbox").length;
  const first = inboxRequests();
  await fake.advance(4999);
  assert.equal(inboxRequests(), first);
  await fake.advance(1);
  assert.equal(inboxRequests(), first + 1);
  await fake.advance(5000);
  assert.equal(inboxRequests(), first + 2);
  core.stop();
  assert.deepEqual(fake.clockPeriods(), []);
});

test("a refused token says so once and the pane is never opened", async () => {
  const daemon = createFakeDaemon({ token: "another-token" });
  const fake = createFakeModHost({ daemon });
  const core = createModCore(fake.host, FACTS);
  await core.start();
  await core.tick();
  assert.equal(fake.notices.length, 1);
  assert.match(fake.notices[0]!, /mctl doctor/);
  assert.equal(fake.paneOpens.length, 0);
});

test("the mod reaches only /api/health and /dispatch/*", async () => {
  assert.deepEqual(findDisallowedModCalls(root), []);
  const allowed = { exact: ["/api/health"], prefixes: ["/dispatch/"] };
  assert.equal(isAllowedModCall("/api/health", allowed), true);
  assert.equal(isAllowedModCall("/dispatch/inbox?repo=x", allowed), true);
  assert.equal(isAllowedModCall("/api/tasks", allowed), false);
  assert.equal(isAllowedModCall("/dispatchx", allowed), false);
  const { daemon, core } = setup();
  await core.start();
  for (const request of daemon.requests) assert.ok(isAllowedModCall(request.path, allowed), request.path);
});

test("the daemon link follows the clients' order for port, state dir and token", async () => {
  assert.equal(daemonBaseUrl({}), "http://127.0.0.1:7317");
  assert.equal(daemonBaseUrl({ FLEET_PORT: "9000" }), "http://127.0.0.1:9000");
  assert.equal(daemonBaseUrl({ MISSION_PORT: "8000", FLEET_PORT: "9000" }), "http://127.0.0.1:8000");
  assert.equal(daemonBaseUrl({ MISSION_PORT: "nope" }), "http://127.0.0.1:7317");
  assert.deepEqual(tokenFileCandidates({ MISSION_HOME: "/state", HOME: "/home/a" }), ["/state/token"]);
  assert.deepEqual(tokenFileCandidates({ HOME: "/home/a", MISSION_API_TOKEN_FILE: "/run/t" }), [
    "/run/t",
    "/home/a/.mission-control/token",
    "/home/a/.fleet-control/token",
    "/home/a/.ai-harness/token",
  ]);
  assert.equal(await readDaemonToken({ MISSION_API_TOKEN: " direct " }, async () => assert.fail("no file read")), "direct");
  const files = new Map([["/home/a/.fleet-control/token", "old-dir-token\n"]]);
  const read = async (path: string) => {
    const text = files.get(path);
    if (text === undefined) throw new Error("ENOENT");
    return text;
  };
  assert.equal(await readDaemonToken({ HOME: "/home/a" }, read), "old-dir-token");
  assert.equal(await readDaemonToken({ HOME: "/home/none" }, read), "");
});

test("a token refused during an active poll clears the display once and recovers", async () => {
  const { daemon, fake, core } = setup();
  await core.start();
  assert.equal(core.phase(), "active");
  assert.ok(fake.bands.at(-1));

  daemon.override("GET /dispatch/inbox", () => ({ status: 401, body: { error: "unauthorized" } }));
  await core.tick();
  assert.equal(core.phase(), "connecting");
  assert.equal(fake.bands.at(-1), undefined);
  assert.equal(fake.statuses.at(-1), undefined);
  assert.equal(fake.banners.at(-1), undefined);
  assert.equal(fake.paneCloses, 1);
  assert.equal(fake.notices.filter((n) => /mctl doctor/.test(n)).length, 1);

  daemon.override("GET /dispatch/inbox", () => ({ body: CANNED_INBOX }));
  await core.tick();
  assert.equal(core.phase(), "active");
  assert.ok(fake.bands.at(-1));
  assert.equal(fake.paneOpens.length, 2);
});

test("the scheduled clock callback polls the inbox and updates the display", async () => {
  const { daemon, fake, core } = setup();
  await core.start();
  assert.equal(fake.activeClocks(), 1);
  const before = daemon.requests.filter((r) => r.pattern === "/dispatch/inbox").length;
  assert.ok(fake.bands.at(-1));

  daemon.override("GET /dispatch/inbox", () => ({ body: NOTHING_WAITS }));
  await fake.tick();
  assert.equal(daemon.requests.filter((r) => r.pattern === "/dispatch/inbox").length, before + 1);
  assert.equal(fake.bands.at(-1), undefined);
  assert.equal(fake.statuses.at(-1), undefined);
});

test("a replaced ask on the same task toasts once, and not again on the next poll", async () => {
  const { daemon, fake, core } = setup();
  await core.start();
  const waiting = CANNED_INBOX.items[0]!;
  const replaced: HomeDispatchInbox = {
    ...CANNED_INBOX,
    items: [{ ...waiting, pending: { ...waiting.pending!, reviewId: "review-2", question: "Keep or delete the new logger?" } }, ...CANNED_INBOX.items.slice(1)],
  };
  daemon.override("GET /dispatch/inbox", () => ({ body: replaced }));
  await core.tick();
  assert.deepEqual(fake.toasts, ['Mission Control: "logging cleanup" asks a question']);
  await core.tick();
  assert.equal(fake.toasts.length, 1);
});

function gate() {
  let release!: () => void;
  const opened = new Promise<void>((resolve) => { release = resolve; });
  return { opened, release };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a session ended while registration is in flight draws and opens nothing afterward", async () => {
  const held = gate();
  const daemon = createFakeDaemon({
    routes: { "POST /dispatch/sessions": async () => { await held.opened; return { body: CANNED_REGISTRATION }; } },
  });
  const fake = createFakeModHost({ daemon });
  const core = createModCore(fake.host, FACTS);
  const started = core.start();
  await flush();
  core.stop();
  held.release();
  await started;
  assert.deepEqual(fake.calls.filter((c) => c.type !== "fetch"), []);
  assert.deepEqual(fake.state, {});
  assert.equal(daemon.requests.some((r) => r.pattern === "/dispatch/inbox"), false);
});

test("a session ended while an inbox poll is in flight updates nothing afterward", async () => {
  const held = gate();
  const daemon = createFakeDaemon();
  const fake = createFakeModHost({ daemon });
  const core = createModCore(fake.host, FACTS);
  await core.start();
  const before = fake.calls.filter((c) => c.type !== "fetch" && c.type !== "paneClose").length;
  daemon.override("GET /dispatch/inbox", async () => { await held.opened; return { body: NOTHING_WAITS }; });
  const ticking = core.tick();
  await flush();
  core.stop();
  held.release();
  await ticking;
  assert.equal(fake.calls.filter((c) => c.type !== "fetch" && c.type !== "paneClose").length, before);
  assert.ok(fake.bands.at(-1));
});

test("a session ended while the pane-tab write is pending never opens the pane", async () => {
  const held = gate();
  const daemon = createFakeDaemon();
  const fake = createFakeModHost({ daemon });
  const slow = {
    ...fake.host,
    paneState: {
      set: async <K extends keyof ModState>(key: K, value: ModState[K]) => {
        if (key === "paneTab") await held.opened;
        await fake.host.paneState.set(key, value);
      },
    },
  };
  const core = createModCore(slow, FACTS);
  const started = core.start();
  await flush();
  core.stop();
  held.release();
  await started;
  assert.deepEqual(fake.paneOpens, []);
  assert.equal(fake.paneCloses, 0);
});

test("the band's button pressed as the session ends does not open the pane", async () => {
  const held = gate();
  let hold = false;
  const daemon = createFakeDaemon();
  const fake = createFakeModHost({ daemon });
  const slow = {
    ...fake.host,
    paneState: {
      set: async <K extends keyof ModState>(key: K, value: ModState[K]) => {
        if (hold && key === "paneTab") await held.opened;
        await fake.host.paneState.set(key, value);
      },
    },
  };
  const core = createModCore(slow, FACTS);
  await core.start();
  const opensBefore = fake.paneOpens.length;
  hold = true;
  const press = core.openNeedsYou();
  await flush();
  core.stop();
  held.release();
  await press;
  assert.equal(fake.paneOpens.length, opensBefore);
});

function slowPaneOpen() {
  const held = gate();
  const daemon = createFakeDaemon();
  const fake = createFakeModHost({ daemon });
  let hold = false;
  const host = {
    ...fake.host,
    paneOpen: async (opts: Parameters<typeof fake.host.paneOpen>[0]) => {
      const placed = await fake.host.paneOpen(opts);
      if (hold) await held.opened;
      return placed;
    },
  };
  return { held, daemon, fake, host, hold: () => { hold = true; } };
}

test("the band's button: a session that ends while the pane is opening gets the pane closed", async () => {
  const { held, fake, host, hold } = slowPaneOpen();
  const core = createModCore(host, FACTS);
  await core.start();
  const closesBefore = fake.paneCloses;
  hold();
  const press = core.openNeedsYou();
  await flush();
  core.stop();
  held.release();
  await press;
  // Once for the pane the session had open when it stopped, once for the open that finished after.
  assert.equal(fake.paneCloses, closesBefore + 2);
});

test("the band's button: a flag turned off while the pane is opening does not leave the pane open", async () => {
  const { held, daemon, fake, host, hold } = slowPaneOpen();
  const core = createModCore(host, FACTS);
  await core.start();
  hold();
  const press = core.openNeedsYou();
  await flush();
  daemon.setFlag(false);
  await core.tick();
  const closesAfterFlag = fake.paneCloses;
  held.release();
  await press;
  assert.equal(core.phase(), "connecting");
  assert.equal(fake.paneCloses, closesAfterFlag + 1);
});

test("stopping an active core closes its pane, and stopping an inert one calls nothing", async () => {
  const { fake, core } = setup();
  await core.start();
  assert.equal(fake.paneOpens.length, 1);
  core.stop();
  assert.equal(fake.paneCloses, 1);
  core.stop();
  assert.equal(fake.paneCloses, 1);

  const off = setup({ flag: false });
  await off.core.start();
  off.core.stop();
  assert.equal(off.fake.paneCloses, 0);
});

test("an inbox that keeps refusing the token notices once, not on every reconnect", async () => {
  const { daemon, fake, core } = setup();
  await core.start();
  daemon.override("GET /dispatch/inbox", () => ({ status: 401, body: { error: "unauthorized" } }));
  for (let i = 0; i < 4; i++) await core.tick();
  assert.equal(fake.notices.filter((n) => /mctl doctor/.test(n)).length, 1);
  daemon.override("GET /dispatch/inbox", () => ({ body: CANNED_INBOX }));
  await core.tick();
  await core.tick();
  // A fresh refusal after a success says so again.
  daemon.override("GET /dispatch/inbox", () => ({ status: 401, body: { error: "unauthorized" } }));
  await core.tick();
  assert.equal(fake.notices.filter((n) => /mctl doctor/.test(n)).length, 2);
});

test("a pane open that fails is retried on the next tick, and one that succeeded is never repeated", async () => {
  const daemon = createFakeDaemon();
  const fake = createFakeModHost({ daemon });
  let failures = 1;
  const flaky = {
    ...fake.host,
    paneOpen: async (opts: Parameters<typeof fake.host.paneOpen>[0]) => {
      if (failures-- > 0) throw new Error("ui.open refused");
      return fake.host.paneOpen(opts);
    },
  };
  const core = createModCore(flaky, FACTS);
  await core.start();
  assert.equal(core.phase(), "active");
  assert.equal(fake.paneOpens.length, 0);
  assert.ok(fake.bands.at(-1));
  await core.tick();
  assert.equal(fake.paneOpens.length, 1);
  await core.tick();
  await core.tick();
  assert.equal(fake.paneOpens.length, 1);
});

test("a session ended while a pane retry is pending starts no inbox request", async () => {
  const held = gate();
  const daemon = createFakeDaemon();
  const fake = createFakeModHost({ daemon });
  let mode: "fail" | "hold" | "ok" = "fail";
  const host = {
    ...fake.host,
    paneOpen: async (opts: Parameters<typeof fake.host.paneOpen>[0]) => {
      if (mode === "fail") throw new Error("ui.open refused");
      if (mode === "hold") await held.opened;
      return fake.host.paneOpen(opts);
    },
  };
  const core = createModCore(host, FACTS);
  await core.start();
  assert.equal(core.phase(), "active");
  const inboxRequests = () => daemon.requests.filter((r) => r.pattern === "/dispatch/inbox").length;
  const before = inboxRequests();
  mode = "hold";
  const ticking = core.tick();
  await flush();
  core.stop();
  held.release();
  await ticking;
  assert.equal(inboxRequests(), before);
});

test("a 404 that is not the flag-off answer is an error, not the flag being off", async () => {
  const { daemon, fake, core } = setup();
  await core.start();
  assert.equal(core.phase(), "active");
  // The daemon forgets the route: not the flag, so nothing is cleared and the poll keeps trying.
  daemon.override("GET /dispatch/inbox", () => ({ status: 404, body: { error: "not found" } }));
  const bandsBefore = fake.bands.length;
  await core.tick();
  assert.equal(core.phase(), "active");
  assert.equal(fake.bands.length, bandsBefore);
  // The flag-off answer is the one that clears it.
  daemon.setFlag(false);
  await core.tick();
  assert.equal(core.phase(), "connecting");
});

test("registration tells the daemon the launcher is off while its gate is closed, so no banner promises it", async () => {
  const { daemon, core } = setup();
  await core.start();
  const registration = daemon.requests.find((r) => r.pattern === "/dispatch/sessions")!;
  assert.equal((registration.body as { launcherDisabled: boolean }).launcherDisabled, true);
});

test("the mod-calls scan ignores a path quoted in a comment and still catches a real call", () => {
  const root = tempDir("mod-calls-");
  try {
    mkdirSync(join(root, "src/mod"), { recursive: true });
    writeFileSync(join(root, "src/mod/allowed-calls.json"), JSON.stringify({ exact: ["/api/health"], prefixes: ["/dispatch/"] }));
    writeFileSync(join(root, "src/mod/prose.ts"), [
      '// Once it called "/api/removed" and may call "/dispatch/ok".',
      '/** An example: `/api/planned` in a block comment, and "/api/also-planned". */',
      'export const url = "http://127.0.0.1:1/dispatch/real"; // trailing "/api/nope"',
    ].join("\n"));
    assert.deepEqual(findDisallowedModCalls(root), []);
    writeFileSync(join(root, "src/mod/call.ts"), 'export const bad = "/api/secret"; // fine\n');
    assert.deepEqual(findDisallowedModCalls(root).map((f) => f.path), ["/api/secret"]);
    // A `//` inside a string is not a comment, and a trailing comment is not a literal.
    assert.deepEqual(pathLiterals('const u = "http://x/api/y"; // "/api/gone"'), ["http://x/api/y"]);
    // A regex literal that ends in `//` is not a comment: a disallowed path later on the line is still found.
    writeFileSync(join(root, "src/mod/call.ts"), 'const parts = path.split(/\\//); const bad = "/api/hidden"; // trailing\n');
    assert.deepEqual(findDisallowedModCalls(root).map((f) => f.path), ["/api/hidden"]);
    // Division and a slash inside a regex class do not confuse it, and a comment after them is still blanked.
    const tricky = 'const half = total / 2; const re = /[/]x/g; const ok = "/api/health"; // "/api/gone"';
    assert.deepEqual(pathLiterals(tricky), ["/api/health"]);
    assert.deepEqual(pathLiterals('return /a\\/b/.test(x) && "/api/seen"'), ["/api/seen"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one definition of the flag-off answer serves every daemon call: only a 404 carrying the feature", () => {
  assert.equal(isFlagOffAnswer(404, { error: "This feature is disabled.", feature: "headless-mode" }), true);
  assert.equal(isFlagOffAnswer(404, { error: "not found" }), false);
  assert.equal(isFlagOffAnswer(404, null), false);
  assert.equal(isFlagOffAnswer(404, undefined), false);
  assert.equal(isFlagOffAnswer(404, "headless-mode"), false);
  assert.equal(isFlagOffAnswer(200, { feature: "headless-mode" }), false);
  assert.equal(isFlagOffAnswer(401, { feature: "headless-mode" }), false);
});

test("the write queue runs a read-modify-write after the writes queued before it, so none is overwritten", async () => {
  const { runQueued } = await import("../src/mod/write-queue.ts");
  const queue = { writes: Promise.resolve() as Promise<void> };
  const store = { value: 0 };
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  // A write is in flight (held); an update is queued behind it and must read what the write left.
  const write = runQueued(queue, undefined, async () => { await held; store.value = 10; });
  const update = runQueued(queue, undefined, async () => { const current = store.value; store.value = current + 1; });
  release();
  await Promise.all([write, update]);
  assert.equal(store.value, 11);

  // A turn whose guard has gone false is skipped, and a task that throws does not stop the queue.
  let alive = true;
  const skipped = runQueued(queue, () => alive, async () => { store.value = -1; });
  alive = false;
  await skipped;
  assert.equal(store.value, 11);
  await runQueued(queue, undefined, async () => { throw new Error("refused"); });
  await runQueued(queue, undefined, async () => { store.value = 12; });
  assert.equal(store.value, 12);
});

test("a refused pane open gives back its claim, and only its own", async () => {
  const { releaseClaim } = await import("../src/mod/pane-owner.ts");
  const holder = { owner: 3 as number | null };
  // This session's claim is released.
  assert.equal(releaseClaim(holder, 3), true);
  assert.equal(holder.owner, null);
  // A replacement that has claimed the pane since keeps its claim.
  holder.owner = 4;
  assert.equal(releaseClaim(holder, 3), false);
  assert.equal(holder.owner, 4);
  // Nothing to release when nobody holds it.
  holder.owner = null;
  assert.equal(releaseClaim(holder, 3), false);
  assert.equal(holder.owner, null);
});

test("a multi-line notice becomes one line: the engine draws newlines as replacement characters", async () => {
  const { noticeLine } = await import("../src/mod/notice-text.ts");
  assert.equal(
    noticeLine("Repo: /repo\nKind: ship\nAfter work: no mistakes review\n\nDescription:\nadd retries to the webhook client"),
    "Repo: /repo · Kind: ship · After work: no mistakes review · Description: add retries to the webhook client",
  );
  // Context Claude added follows the same rule, and a single line, spaces and CRLF are kept sane.
  assert.equal(noticeLine("Description:\nadd retries\n\nContext Claude added:\nsee client.ts"), "Description: add retries · Context Claude added: see client.ts");
  assert.equal(noticeLine("Started mc-1: ship, in repo."), "Started mc-1: ship, in repo.");
  assert.equal(noticeLine("  a  \r\n  b  "), "a · b");
  assert.equal(noticeLine("\n\n"), "");
});

test("the mod-calls scan walks nested template literals, so a disallowed path cannot hide behind one", () => {
  const root = tempDir("mod-calls-nested-");
  try {
    mkdirSync(join(root, "src/mod"), { recursive: true });
    writeFileSync(join(root, "src/mod/allowed-calls.json"), JSON.stringify({ exact: ["/api/health"], prefixes: ["/dispatch/"] }));
    const scan = (source: string) => {
      writeFileSync(join(root, "src/mod/case.ts"), source);
      return findDisallowedModCalls(root).map((f) => f.path);
    };

    // A path built from a template with a nested template is judged by its static prefix.
    assert.deepEqual(scan("const p = `/api/${flag ? `yes` : `no`}`;\n"), ["/api/"]);
    // A real call after a nested template on the same line is still found (the old tokenizer closed on the inner backtick).
    assert.deepEqual(scan("const x = `${a ? `b` : `c`}`; const bad = \"/api/secret\";\n"), ["/api/secret"]);
    // Deeper nesting, an object literal in the expression, and a string containing a backtick.
    assert.deepEqual(scan("const x = `${fn({ k: `${y ? `1` : '`'}` })}`; const bad = '/api/deep';\n"), ["/api/deep"]);
    // An expression that contains a comment and braces does not end the template early.
    assert.deepEqual(scan("const x = `${/* } */ a}`; const bad = \"/api/after\";\n"), ["/api/after"]);

    // Allowed shapes stay allowed: a dispatch route built with an interpolated id, and the health path.
    assert.deepEqual(scan("const u = `/dispatch/drafts/${encodeURIComponent(id)}/confirm`; const h = \"/api/health\";\n"), []);
    // Comments still never count, including one that quotes a nested template.
    assert.deepEqual(scan("// `/api/${flag ? `a` : `b`}` is not a call\nconst ok = 1;\n"), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the mod-calls scan treats a $ in a quoted path as an ordinary character, and only ${ as an interpolation", () => {
  const root = tempDir("mod-calls-dollar-");
  try {
    mkdirSync(join(root, "src/mod"), { recursive: true });
    writeFileSync(join(root, "src/mod/allowed-calls.json"), JSON.stringify({ exact: ["/api/health"], prefixes: ["/dispatch/"] }));
    const scan = (source: string) => {
      writeFileSync(join(root, "src/mod/case.ts"), source);
      return findDisallowedModCalls(root).map((f) => f.path);
    };
    // A plain string with a $ in it is still read to its closing quote and judged.
    assert.deepEqual(scan("fetch(\"/api/$secret\");\n"), ["/api/$secret"]);
    assert.deepEqual(scan("fetch('/api/a$b$c');\n"), ["/api/a$b$c"]);
    assert.deepEqual(scan("fetch(\"/api/$\");\n"), ["/api/$"]);
    // A $ inside a template that is not an interpolation is the same.
    assert.deepEqual(scan("const u = `/api/$notInterpolated`;\n"), ["/api/$notInterpolated"]);
    // An interpolation still ends the static prefix, and allowed shapes stay allowed.
    assert.deepEqual(scan("const u = `/api/${x}`;\n"), ["/api/"]);
    assert.deepEqual(scan("const u = `/dispatch/drafts/${id}/confirm`; const c = \"/dispatch/a$b\";\n"), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the mod-calls scan treats a regex literal inside ${} as one unit, so its braces do not end the template early", () => {
  const root = tempDir("mod-calls-regex-");
  try {
    mkdirSync(join(root, "src/mod"), { recursive: true });
    writeFileSync(join(root, "src/mod/allowed-calls.json"), JSON.stringify({ exact: ["/api/health"], prefixes: ["/dispatch/"] }));
    const scan = (source: string) => {
      writeFileSync(join(root, "src/mod/case.ts"), source);
      return findDisallowedModCalls(root).map((f) => f.path);
    };
    // A lone `{` or `}` in a regex must not shift the brace count; the comment after it stays a comment.
    assert.deepEqual(scan("const x = `${/\\{/.test(y)}`; // \"/api/in-comment\"\nconst ok = 1;\n"), []);
    assert.deepEqual(scan("const x = `${/}/.test(y)}`; // \"/api/in-comment\"\nconst ok = 1;\n"), []);
    assert.deepEqual(scan("const x = `${/[{]/.test(y)}`; // \"/api/in-comment\"\nconst ok = 1;\n"), []);
    // A brace quantifier balances on its own and is still read correctly.
    assert.deepEqual(scan("const x = `${/a{2}/.test(y)}`; const bad = \"/api/after\";\n"), ["/api/after"]);
    // Division is not a regex: the template ends where it should and a later call is found.
    assert.deepEqual(scan("const x = `${a / b}`; const bad = \"/api/div\";\n"), ["/api/div"]);
    assert.deepEqual(scan("const x = `${a / b / c}` + `${/\\}/.test(d)}`; const bad = '/api/two';\n"), ["/api/two"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the mod-calls scan judges a plain quoted string whole: ${ is only an interpolation in a template", () => {
  const root = tempDir("mod-calls-plain-");
  try {
    mkdirSync(join(root, "src/mod"), { recursive: true });
    writeFileSync(join(root, "src/mod/allowed-calls.json"), JSON.stringify({ exact: ["/api/health"], prefixes: ["/dispatch/"] }));
    const scan = (source: string) => {
      writeFileSync(join(root, "src/mod/case.ts"), source);
      return findDisallowedModCalls(root).map((f) => f.path);
    };
    // Static literals containing `${`: the whole path is judged, not the prefix before it.
    assert.deepEqual(scan("fetch(\"/dispatch/a${b}/c\");\n"), []);
    assert.deepEqual(scan("fetch(\"/api/health${b}/secret\");\n"), ["/api/health${b}/secret"]);
    assert.deepEqual(scan("fetch('/api/foo${bar}/secret');\n"), ["/api/foo${bar}/secret"]);
    // The same text in a template is dynamic, so its static prefix is judged.
    assert.deepEqual(scan("fetch(`/api/health${b}/secret`);\n"), []);
    assert.deepEqual(scan("fetch(`/api/foo${bar}/secret`);\n"), ["/api/foo"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the mod-calls scan reads source with a real tokenizer: no regex, comment or space can hide a call", () => {
  const root = tempDir("mod-calls-tokens-");
  try {
    mkdirSync(join(root, "src/mod"), { recursive: true });
    writeFileSync(join(root, "src/mod/allowed-calls.json"), JSON.stringify({ exact: ["/api/health"], prefixes: ["/dispatch/"] }));
    const scan = (source: string) => {
      writeFileSync(join(root, "src/mod/case.ts"), source);
      return findDisallowedModCalls(root).map((f) => f.path);
    };
    // A path whose query has a space is one literal, judged whole.
    assert.deepEqual(scan('fetch("/api/tasks?search=needs review");\n'), ["/api/tasks?search=needs review"]);
    assert.deepEqual(scan("fetch(`/api/tasks?q=a b`);\n"), ["/api/tasks?q=a b"]);
    assert.deepEqual(scan('fetch("/dispatch/inbox?repo=my repo");\n'), []);
    // A regex after a control-flow condition is a regex: its closing `//` does not hide a later call.
    assert.deepEqual(scan('if (ok) /\\//.test(value); const bad = "/api/hidden";\n'), ["/api/hidden"]);
    assert.deepEqual(scan('while (x) /\\//.exec(v); const bad = "/api/loop";\n'), ["/api/loop"]);
    // A regex inside `${}` with a brace in it does not end the template early, so a URL's `//` after
    // it is inside a string and a later call is still found.
    assert.deepEqual(scan("const s = `${/[}]/.test(`http://x`)}`; const bad = \"/api/hidden\";\n"), ["/api/hidden"]);
    // A comment inside `${}` is a comment: the path it quotes is not a call.
    assert.deepEqual(scan('const s = `/dispatch/${id /* "/api/comment-only" */}`;\n'), []);
    // .tsx files are read as TSX, and a JSX attribute's string is a literal like any other.
    writeFileSync(join(root, "src/mod/case.ts"), "export {};\n");
    writeFileSync(join(root, "src/mod/view.tsx"), 'export const v = <a href="/api/jsx">x</a>;\n');
    assert.deepEqual(findDisallowedModCalls(root).map((f) => f.path), ["/api/jsx"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
