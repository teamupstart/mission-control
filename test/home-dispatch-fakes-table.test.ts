// Headless mode phase 2: one table per fake, covering each public method and each documented
// failure mode, so a downstream phase can rely on the fakes without re-testing them.
//   fake daemon  handle, listen, close, setFlag, setDown, override, requests (HTTP and in process)
//   fake host    every ModHost member, every option, and the helpers that drive it
//   fake claude  every scripted reply and every failure key
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { connect } from "node:net";
import test, { after } from "node:test";
import type { ModAskAnswer } from "../src/mod/host.ts";
import {
  FAKE_SESSION_ID,
  FAKE_TOKEN,
  createFakeClaude,
  createFakeDaemon,
  createFakeModHost,
  type FakeClaude,
} from "./helpers/home-dispatch-fakes.ts";

/* ------------------------------------------------------------------ fake daemon */

interface DaemonCase {
  name: string;
  /** How the request is sent: over the loopback socket, or in process through `handle`. */
  via: "http" | "handle";
  method: "GET" | "POST";
  path: string;
  body?: string;
  headers?: Record<string, string>;
  /** Daemon state before the request. */
  setup?: { flag?: boolean; token?: string | null };
  status: number;
}

const GOOD_CONFIRM = JSON.stringify({ sessionId: FAKE_SESSION_ID, choice: "start" });
const CONFIRM = "/dispatch/drafts/draft-1/confirm";
const JSON_HEADERS = { "content-type": "application/json" };

const DAEMON_CASES: DaemonCase[] = [
  { name: "http GET health", via: "http", method: "GET", path: "/api/health", setup: { token: null }, status: 200 },
  { name: "http GET inbox with the token", via: "http", method: "GET", path: "/dispatch/inbox", headers: { "x-harness-token": FAKE_TOKEN }, status: 200 },
  { name: "http GET inbox without the token", via: "http", method: "GET", path: "/dispatch/inbox", status: 401 },
  { name: "http POST schema-valid JSON", via: "http", method: "POST", path: CONFIRM, body: GOOD_CONFIRM, headers: JSON_HEADERS, setup: { token: null }, status: 200 },
  { name: "http POST malformed JSON", via: "http", method: "POST", path: CONFIRM, body: "{not json", headers: JSON_HEADERS, setup: { token: null }, status: 400 },
  { name: "http POST schema-invalid JSON", via: "http", method: "POST", path: CONFIRM, body: JSON.stringify({ sessionId: FAKE_SESSION_ID, choice: "nope" }), headers: JSON_HEADERS, setup: { token: null }, status: 400 },
  { name: "http POST with an empty body", via: "http", method: "POST", path: CONFIRM, setup: { token: null }, status: 400 },
  { name: "http flag off", via: "http", method: "GET", path: "/dispatch/config", setup: { token: null, flag: false }, status: 404 },
  { name: "http unknown route", via: "http", method: "GET", path: "/nope", setup: { token: null }, status: 404 },
  { name: "handle GET config", via: "handle", method: "GET", path: "/dispatch/config", headers: { "x-harness-token": FAKE_TOKEN }, status: 200 },
  { name: "handle wrong method is unknown", via: "handle", method: "POST", path: "/dispatch/config", headers: { "x-harness-token": FAKE_TOKEN }, status: 404 },
];

for (const c of DAEMON_CASES) {
  test(`fake daemon table: ${c.name} answers ${c.status}`, async () => {
    const daemon = createFakeDaemon({ token: c.setup?.token === undefined ? FAKE_TOKEN : c.setup.token, flag: c.setup?.flag });
    const { url } = await daemon.listen();
    try {
      let status: number;
      if (c.via === "http") {
        status = (await fetch(url + c.path, { method: c.method, headers: c.headers, body: c.body })).status;
      } else {
        const parsed: unknown = c.body === undefined ? undefined : JSON.parse(c.body);
        status = (await daemon.handle(c.method, c.path, parsed, c.headers)).status;
      }
      assert.equal(status, c.status);
      assert.ok(daemon.requests.length >= 1, "every request is recorded");
    } finally {
      await daemon.close();
    }
  });
}

test("fake host table: the token option makes the host agree or disagree with a daemon's token", async () => {
  const daemon = createFakeDaemon({ token: "other-token" });
  const status = async (token?: string) =>
    (await createFakeModHost({ daemon, token }).host.fetch("/dispatch/config")).status;
  assert.equal(await status(), 401, "the default token does not match a daemon with another token");
  assert.equal(await status("other-token"), 200);
  assert.equal(await status("wrong"), 401);
});

test("fake daemon table: a client that drops mid-request is handled as a request error and the daemon keeps serving", async () => {
  const daemon = createFakeDaemon({ token: null });
  const { port, url } = await daemon.listen();
  try {
    await new Promise<void>((resolve) => {
      const socket = connect(port, "127.0.0.1", () => {
        // Promise a 500-byte body, send a few bytes of it, then reset the connection.
        socket.write("POST /dispatch/answers HTTP/1.1\r\nHost: x\r\nContent-Length: 500\r\nContent-Type: application/json\r\n\r\n{\"par");
        setTimeout(() => socket.resetAndDestroy(), 20);
      });
      socket.on("error", () => {});
      socket.on("close", () => resolve());
    });
    for (let waited = 0; daemon.requestErrors.length === 0 && waited < 2000; waited += 20) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(daemon.requestErrors.length, 1, "the request error reached the handler");
    assert.equal(daemon.requests.length, 0, "the dropped request was never answered");
    assert.equal((await fetch(url + "/api/health")).status, 200);
  } finally {
    await daemon.close();
  }
});

test("fake daemon table: a second listen is refused and the first listener stays usable", async () => {
  const daemon = createFakeDaemon({ token: null });
  const { url } = await daemon.listen();
  try {
    await assert.rejects(daemon.listen(), /already listening/);
    assert.equal((await fetch(url + "/api/health")).status, 200);
  } finally {
    await daemon.close();
  }
});

test("fake daemon table: setDown over HTTP and in process, setFlag, override and close", async () => {
  const daemon = createFakeDaemon({ token: null });
  const { url } = await daemon.listen();
  try {
    // setDown: the socket request fails and `handle` rejects, then both recover.
    daemon.setDown(true);
    await assert.rejects(fetch(url + "/api/health"));
    await assert.rejects(daemon.handle("GET", "/api/health"), /down/);
    daemon.setDown(false);
    assert.equal((await fetch(url + "/api/health")).status, 200);

    // setFlag: the capability follows the flag.
    const capabilities = async () =>
      ((await (await fetch(url + "/api/health")).json()) as { capabilities: string[] }).capabilities;
    daemon.setFlag(false);
    assert.equal((await capabilities()).includes("home-dispatch-v1"), false);
    daemon.setFlag(true);
    assert.equal((await capabilities()).includes("home-dispatch-v1"), true);

    // override: a route's reply, its status and a raw body, over the socket.
    daemon.override("GET /dispatch/inbox", () => ({ status: 409, body: { error: "busy" } }));
    assert.equal((await fetch(url + "/dispatch/inbox")).status, 409);
    daemon.override("GET /dispatch/config", () => ({ raw: "plain", contentType: "text/plain" }));
    assert.equal(await (await fetch(url + "/dispatch/config")).text(), "plain");

    // requests: recorded with method, pattern, params, query and parsed body.
    await fetch(url + "/dispatch/drafts/d9/confirm?x=1", { method: "POST", headers: JSON_HEADERS, body: GOOD_CONFIRM });
    const last = daemon.requests.at(-1)!;
    assert.deepEqual([last.method, last.pattern, last.params, last.query], ["POST", "/dispatch/drafts/:id/confirm", { id: "d9" }, { x: "1" }]);
    assert.deepEqual(last.body, { sessionId: FAKE_SESSION_ID, choice: "start" });
  } finally {
    await daemon.close();
  }
  // close: the server stops accepting connections, and closing twice is harmless.
  await assert.rejects(fetch(url + "/api/health"));
  await daemon.close();
});

/* ------------------------------------------------------------------ fake mod host */

const ASK = { header: "H", question: "Q?", options: [{ label: "A" }] };

test("fake host table: ask serves queued answers, then a function, then dismisses", async () => {
  const queued: ModAskAnswer[] = [{ kind: "pick", label: "A" }, { kind: "other", text: "typed" }];
  const list = createFakeModHost({ answers: queued });
  assert.deepEqual(await list.host.ask(ASK), queued[0]);
  assert.deepEqual(await list.host.ask(ASK), queued[1]);
  assert.deepEqual(await list.host.ask(ASK), { kind: "dismissed" });
  assert.equal(list.dialogs.length, 3);

  const fn = createFakeModHost({ answers: (q) => ({ kind: "pick", label: q.options[0]!.label }) });
  assert.deepEqual(await fn.host.ask(ASK), { kind: "pick", label: "A" });
  assert.deepEqual(await createFakeModHost().host.ask(ASK), { kind: "dismissed" });
});

test("fake host table: paneOpen placed true and false records the open request", async () => {
  const cases = [
    { options: {}, expected: true },
    { options: { placed: true }, expected: true },
    { options: { placed: false }, expected: false },
  ];
  for (const c of cases) {
    const fake = createFakeModHost(c.options);
    const request = { tab: "tasks" as const, taskId: "mc-1", focus: true };
    assert.deepEqual(await fake.host.paneOpen(request), { isPlaced: c.expected });
    assert.deepEqual(fake.paneOpens, [request]);
    assert.deepEqual(fake.calls, [{ type: "paneOpen", opts: request }]);
  }
});

test("fake host table: every other ModHost member records exactly what it was given", async () => {
  const daemon = createFakeDaemon();
  const fake = createFakeModHost({ daemon, env: { A: "1" }, initialState: { chatSince: 3 } });
  const h = fake.host;
  const band = { text: "b", tone: "error" as const, button: { label: "open inbox", hotkey: "1" } };
  const actions: [string, () => unknown, () => unknown][] = [
    ["notice", () => h.notice("n"), () => fake.notices],
    ["toast", () => h.toast("t"), () => fake.toasts],
    ["status set", () => h.status("s"), () => fake.statuses],
    ["status cleared", () => h.status(undefined), () => fake.statuses],
    ["band", () => h.band(band), () => fake.bands],
    ["band cleared", () => h.band(undefined), () => fake.bands],
    ["fillPrompt", () => h.fillPrompt("/mission-dispatch "), () => fake.prompts],
    ["modelWrite", () => h.modelWrite({ source: "prompt-nudge", text: "m" }), () => fake.modelWrites],
    ["link", () => h.link("http://x/"), () => fake.links],
    ["paneClose", () => h.paneClose(), () => fake.paneCloses],
  ];
  const seen: unknown[] = [];
  for (const [, act, read] of actions) {
    await act();
    seen.push(structuredClone(read()));
  }
  assert.deepEqual(seen, [
    ["n"], ["t"], ["s"], ["s", undefined], [band], [band, undefined], ["/mission-dispatch "],
    [{ source: "prompt-nudge", text: "m" }], ["http://x/"], 1,
  ]);
  assert.deepEqual(fake.calls.map((c) => c.type), [
    "notice", "toast", "status", "status", "band", "band", "fillPrompt", "modelWrite", "link", "paneClose",
  ]);

  // env, fetch with a daemon (GET and POST) and fetch without one.
  assert.equal(h.env("A"), "1");
  assert.equal(h.env("MISSING"), undefined);
  assert.equal((await h.fetch("/dispatch/config")).status, 200);
  const posted = await h.fetch(CONFIRM, { method: "POST", body: JSON.parse(GOOD_CONFIRM) });
  assert.equal(posted.status, 200);
  assert.deepEqual(fake.fetches.map((f) => f.path), ["/dispatch/config", CONFIRM]);
  assert.equal(daemon.requests.at(-1)!.headers["x-harness-surface"], "mod");
  await assert.rejects(createFakeModHost().host.fetch("/dispatch/config"), /no daemon/);

  // paneState: get, set and update, including an unset key.
  assert.equal(await h.paneState.get("chatSince"), 3);
  assert.equal(await h.paneState.get("draftId"), undefined);
  await h.paneState.set("draftId", "d1");
  await h.paneState.update("chatSince", (n) => (n ?? 0) + 2);
  assert.deepEqual([await h.paneState.get("draftId"), await h.paneState.get("chatSince")], ["d1", 5]);
  assert.deepEqual(fake.state, { chatSince: 5, draftId: "d1" });
});

test("fake host table: clocks, drawPane and press, with their failure mode", async () => {
  const fake = createFakeModHost();
  let ticks = 0;
  const stopA = fake.host.clockEvery(1000, () => { ticks += 1; });
  const stopB = fake.host.clockEvery(5000, async () => { ticks += 10; });
  assert.equal(fake.activeClocks(), 2);
  await fake.tick();
  assert.equal(ticks, 11);
  stopA();
  await fake.tick();
  assert.equal(ticks, 21);
  stopB();
  assert.equal(fake.activeClocks(), 0);

  // Registering one callback twice gives two independent clocks.
  let shared = 0;
  const tickShared = () => { shared += 1; };
  const stopFirst = fake.host.clockEvery(1000, tickShared);
  const stopSecond = fake.host.clockEvery(1000, tickShared);
  await fake.tick();
  stopFirst();
  assert.equal(fake.activeClocks(), 1);
  await fake.tick();
  assert.equal(shared, 3);
  stopSecond();

  await assert.rejects(fake.press("Open"), /no button "Open"/);
  const view = fake.drawPane({ tab: "tasks", placement: "inline", bodyColumns: 40 });
  assert.deepEqual(fake.views, [{ props: { tab: "tasks", placement: "inline", bodyColumns: 40 }, view }]);
  await assert.rejects(fake.press("Open"), /no button "Open"/);
  let pressed = 0;
  view.buttons.push({ label: "Open", press: () => { pressed += 1; } });
  await fake.press("Open");
  assert.equal(pressed, 1);
  assert.deepEqual(fake.calls.map((c) => c.type), ["view", "press"]);
});

/* ------------------------------------------------------------------ fake claude */

const claudes: FakeClaude[] = [];
after(() => { for (const c of claudes) c.cleanup(); });
const fresh = (initial: Parameters<typeof createFakeClaude>[0] = {}) => {
  const fake = createFakeClaude(initial);
  claudes.push(fake);
  return fake;
};
const run = (fake: FakeClaude, ...args: string[]) => spawnSync(fake.path, args, { cwd: "/", encoding: "utf8" });

interface ClaudeCase {
  name: string;
  args: string[];
  initial?: Parameters<typeof createFakeClaude>[0];
  status: number;
  stdout?: RegExp;
  stderr?: RegExp;
}

const CLAUDE_CASES: ClaudeCase[] = [
  { name: "--version", args: ["--version"], initial: { version: "9.9.9" }, status: 0, stdout: /^9\.9\.9 \(Claude Code\)\n$/ },
  { name: "-v", args: ["-v"], status: 0, stdout: /\(Claude Code\)/ },
  { name: "plugin --help with marketplaces", args: ["plugin", "--help"], status: 0, stdout: /marketplace/ },
  { name: "plugin --help without marketplaces", args: ["plugin", "--help"], initial: { marketplaceSupported: false }, status: 0, stdout: /^((?!marketplace)[\s\S])*$/ },
  { name: "plugin list, none installed", args: ["plugin", "list"], status: 0, stdout: /^$/ },
  { name: "plugin list --json", args: ["plugin", "list", "--json"], initial: { plugins: [{ id: "a@b", version: "1", scope: "user", enabled: false }] }, status: 0, stdout: /"enabled":false/ },
  { name: "plugin list, text", args: ["plugin", "list"], initial: { plugins: [{ id: "a@b", version: "1", scope: "user", enabled: true }] }, status: 0, stdout: /a@b \(1, user, enabled\)/ },
  { name: "marketplace add", args: ["plugin", "marketplace", "add", "/m"], status: 0, stdout: /Added marketplace \/m/ },
  { name: "install with --scope", args: ["plugin", "install", "--scope", "project", "a@b"], status: 0, stdout: /Installed a@b/ },
  { name: "uninstall", args: ["plugin", "uninstall", "a@b"], status: 0, stdout: /Uninstalled a@b/ },
  { name: "validate", args: ["plugin", "validate", "/p"], status: 0, stdout: /Validation passed/ },
  { name: "test", args: ["plugin", "test", "/p"], status: 0, stdout: /Validation passed/ },
  { name: "unknown plugin command", args: ["plugin", "frobnicate"], status: 1, stderr: /unknown plugin command frobnicate/ },
  { name: "a session launch", args: ["--resume", "x"], status: 0 },
  ...(["list", "marketplace add", "install", "uninstall", "validate", "test"] as const).map((key): ClaudeCase => ({
    name: `scripted failure of ${key}`,
    args: key === "marketplace add" ? ["plugin", "marketplace", "add", "/m"] : key === "list" ? ["plugin", "list"] : ["plugin", key, "a@b"],
    initial: { failures: { [key]: { exitCode: 7, stderr: `${key} failed` } } },
    status: 7,
    stderr: new RegExp(`${key} failed`),
  })),
];

for (const c of CLAUDE_CASES) {
  test(`fake claude table: ${c.name} exits ${c.status}`, () => {
    const fake = fresh(c.initial);
    const result = run(fake, ...c.args);
    assert.equal(result.status, c.status, result.stderr);
    if (c.stdout) assert.match(result.stdout, c.stdout);
    if (c.stderr) assert.match(result.stderr, c.stderr);
    assert.deepEqual(fake.invocations().map((i) => i.argv), [c.args]);
  });
}

test("fake claude table: state, update, setInstalledVersion, staged version, failure counts and launches", () => {
  const fake = fresh({ stagedVersion: "3.0.0", failures: { install: { exitCode: 2, stderr: "x", times: 2 } } });
  assert.deepEqual([run(fake, "plugin", "install", "a@b").status, run(fake, "plugin", "install", "a@b").status, run(fake, "plugin", "install", "a@b").status], [2, 2, 0]);
  assert.equal(fake.state().plugins[0]!.version, "3.0.0");
  fake.setInstalledVersion("1.0.0", "a@b");
  assert.equal(fake.state().plugins.find((p) => p.id === "a@b")!.version, "1.0.0");
  fake.setInstalledVersion("2.0.0");
  assert.equal(fake.state().plugins.find((p) => p.id === "mission-control@mission-control")!.version, "2.0.0");
  fake.update({ version: "4.0.0" });
  assert.equal(run(fake, "--version").stdout, "4.0.0 (Claude Code)\n");
  run(fake, "--dangerously-skip-permissions");
  const launches = fake.launches();
  assert.deepEqual(launches.map((l) => l.argv), [["--dangerously-skip-permissions"]]);
  assert.equal(launches[0]!.cwd, realpathSync("/"));
  assert.ok(fake.invocations().every((i) => i.cwd.length > 0 && i.at > 0));
});
