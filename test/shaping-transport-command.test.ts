// The `command` transport: argv without a shell, a scrubbed environment, the request on stdin and
// the reply on stdout, a 256 KiB output cap, and a timeout that takes the whole process group.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Shaper, ShapingRequest } from "../src/shared/shaping.ts";
import { ShaperSchema } from "../src/shared/shaping.ts";
import {
  callCommand, COMMAND_OUTPUT_BYTES, receivedValues, redactReceived, removeScratch, shaperCommandEnv,
} from "../src/server/shaping/transports/command.ts";
import type { ShaperOf, TransportContext } from "../src/server/shaping/transports/types.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-shaper.mjs", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "shaping-command-"));
const worktree = join(scratch, "worktree");
mkdirSync(worktree);
after(() => rmSync(scratch, { recursive: true, force: true }));

function shaper(args: string[], extra: { env?: string[]; command?: string; stage?: "gather" | "select" } = {}): ShaperOf<"command"> {
  return ShaperSchema.parse({
    id: "fixture", label: "Fixture", stage: extra.stage ?? "gather",
    transport: { type: "command", command: extra.command ?? process.execPath, args, env: extra.env ?? [] },
  }) as ShaperOf<"command">;
}
function request(stage: "gather" | "select" = "gather"): ShapingRequest {
  return {
    protocol: 1, stage, task: "Retry failed charges",
    repo: { name: "billing-api", path: worktree },
    context: {
      taskId: "t_1", title: "Retry", kind: "ship", harness: "claude", runtime: "sdk", afterWork: null,
      labels: [], priority: null, repositories: [{ name: "billing-api", role: "primary", branch: null, baseSha: null, path: worktree }],
      caller: { user: null, agent: "claude", conversation: "t_1" },
    },
    limits: { maxBytes: 16384, deadlineMs: 5000 },
  };
}
function ctx(timeoutMs = 10_000, extra: Partial<TransportContext> = {}): TransportContext {
  return {
    deadline: Date.now() + timeoutMs, timeoutMs, signal: new AbortController().signal,
    scope: { shared: new Map(), defer() {} }, root: null, ...extra,
  };
}
function echoed(reply: Awaited<ReturnType<typeof callCommand>>) {
  assert.equal(reply.kind, "data", JSON.stringify(reply));
  const body = JSON.parse(JSON.parse((reply as { data: string }).data).guidance[0].body);
  return body as { argv: string[]; cwd: string; env: Record<string, string | null>; envKeys: string[]; request: ShapingRequest };
}

test("argv reaches the program verbatim, with no shell in between", async () => {
  const args = [FIXTURE, "echo", "$(echo injected)", "; rm -rf /", "*", "a b"];
  const seen = echoed(await callCommand(request(), shaper(args), ctx()));
  assert.deepEqual(seen.argv, ["echo", "$(echo injected)", "; rm -rf /", "*", "a b"]);
});

test("the request arrives on stdin and a gatherer runs in the worktree", async () => {
  const seen = echoed(await callCommand(request(), shaper([FIXTURE, "echo"]), ctx()));
  assert.deepEqual(seen.request, request());
  assert.equal(realpathSync(seen.cwd), realpathSync(worktree));
});

test("a selector runs in an empty directory of its own, removed afterwards", async () => {
  const seen = echoed(await callCommand(request("select"), shaper([FIXTURE, "echo"], { stage: "select" }), ctx()));
  assert.notEqual(realpathSync(worktree), seen.cwd);
  assert.match(seen.cwd, /mission-shaper-/);
  // Removed in the background once the call has settled, never before it answers.
  assert.equal(await until(() => !existsSync(seen.cwd)), true, "the scratch directory is removed after the call settles");
});

const until = async (done: () => boolean, ms = 10_000): Promise<boolean> => {
  for (let waited = 0; !done() && waited < ms; waited += 25) await new Promise((wake) => setTimeout(wake, 25));
  return done();
};

test("a selector that locks a directory still answers; cleanup changes no permission, inside or outside", async (t) => {
  const warnings: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => warnings.push(args));
  const outside = mkdtempSync(join(tmpdir(), "shaping-outside-"));
  chmodSync(outside, 0o500);
  let cwd = "";
  try {
    const reply = await callCommand(request("select"), shaper([FIXTURE, "lock-cwd", outside], { stage: "select" }), ctx());
    assert.equal(reply.kind, "data", JSON.stringify(reply));
    cwd = JSON.parse((reply as { data: string }).data).guidance[0].body as string;
    assert.match(cwd, /mission-shaper-/);
    // Removal runs after the call settles, so its outcome is awaited rather than assumed.
    assert.equal(await until(() => warnings.length === 1), true, "the locked tree is reported, not unlocked");
    assert.match(String(warnings[0]![0]), /could not remove a selector's working directory/);
    assert.equal(existsSync(cwd), true, "a tree the shaper locked is left behind");
    assert.equal(statSync(outside).mode & 0o777, 0o500, "the link's target outside the tree keeps its permissions");
    assert.equal(statSync(join(cwd, "locked")).mode & 0o777, 0o000, "nor is anything inside the tree unlocked");
  } finally {
    chmodSync(outside, 0o700);
    rmSync(outside, { recursive: true, force: true });
    if (cwd) {
      chmodSync(join(cwd, "locked"), 0o700);
      rmSync(cwd, { recursive: true, force: true });
    }
  }
});

test("the call settles without waiting for a removal that never finishes", async (t) => {
  // A removal stuck on a huge tree, modelled as one that never completes.
  const removal = t.mock.method(fs.promises, "rm", () => new Promise<void>(() => {}));
  let cwd = "";
  try {
    const started = Date.now();
    const reply = await callCommand(request("select"), shaper([FIXTURE, "echo"], { stage: "select" }), ctx());
    assert.equal(reply.kind, "data", "the shaper's answer is not held back by cleanup");
    cwd = echoed(reply).cwd;
    assert.ok(Date.now() - started < 15_000);
    assert.ok(await until(() => removal.mock.callCount() >= 1), "removal was started, in the background");
  } finally {
    removal.mock.restore();
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  }
});

test("a working directory that cannot be removed is logged and left, and the call still settles", async (t) => {
  const warnings: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => warnings.push(args));
  const removal = t.mock.method(fs.promises, "rm", async () => { throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }); });
  let cwd = "";
  try {
    const reply = await callCommand(request("select"), shaper([FIXTURE, "echo"], { stage: "select" }), ctx());
    assert.equal(reply.kind, "data", "the shaper's answer is not lost to the cleanup");
    cwd = echoed(reply).cwd;
    assert.equal(await until(() => warnings.length === 1), true, "the failure is logged once");
    assert.equal(removal.mock.callCount(), 1, "removal is attempted once, with no permission change in between");
    assert.match(String(warnings[0]![0]), /could not remove a selector's working directory/);
  } finally {
    removal.mock.restore();
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  }
  await assert.doesNotReject(removeScratch(join(scratch, "never-created")), "removing nothing is not an error");
});

test("credentials and Mission Control state are scrubbed, ordinary variables kept, and named ones passed through", async () => {
  const names = ["SHAPER_FIXTURE_TOKEN", "SHAPER_FIXTURE_PLAIN", "SHAPER_FIXTURE_NAMED", "MISSION_API_TOKEN", "MISSION_HOME", "TMUX_PANE"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    SHAPER_FIXTURE_TOKEN: "secret-value", SHAPER_FIXTURE_PLAIN: "plain-value", SHAPER_FIXTURE_NAMED: "named-value",
    MISSION_API_TOKEN: "daemon-token", TMUX_PANE: "%1",
  });
  try {
    const transport = shaper([FIXTURE, "echo", ...names.map((name) => `env=${name}`)], {
      env: ["SHAPER_FIXTURE_NAMED", "MISSION_API_TOKEN", "MISSION_HOME"],
    });
    const seen = echoed(await callCommand(request(), transport, ctx()));
    assert.equal(seen.env.SHAPER_FIXTURE_NAMED, "named-value", "a named variable is passed through");
    assert.equal(seen.env.SHAPER_FIXTURE_PLAIN, "plain-value", "an ordinary variable survives the scrub");
    assert.equal(seen.env.SHAPER_FIXTURE_TOKEN, null, "a credential-shaped name is dropped unless named");
    assert.equal(seen.env.MISSION_API_TOKEN, null, "the daemon's token never reaches a shaper, even by name");
    assert.equal(seen.env.MISSION_HOME, null, "nor does the state home");
    assert.equal(seen.env.TMUX_PANE, null, "nor a pane identity");
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("a value carrying the daemon token is dropped, and named credentials are allowed", () => {
  const env = shaperCommandEnv({ PATH: "/usr/bin", HOLDS: "x-daemon-secret-y", ACME_TOKEN: "t", HOME: "/h" }, ["ACME_TOKEN", "HOLDS"], "daemon-secret");
  assert.equal(env.HOLDS, undefined);
  assert.equal(env.ACME_TOKEN, "t");
  assert.equal(env.HOME, "/h");
});

test("stdout of exactly 256 KiB is a reply, and one byte more fails the call", async () => {
  const atCap = await callCommand(request(), shaper([FIXTURE, "overflow", String(COMMAND_OUTPUT_BYTES)]), ctx());
  assert.equal(atCap.kind, "data", JSON.stringify(atCap).slice(0, 200));
  assert.equal((atCap as { data: string }).data.length, COMMAND_OUTPUT_BYTES, "every byte at the cap is kept");
  const over = await callCommand(request(), shaper([FIXTURE, "overflow", String(COMMAND_OUTPUT_BYTES + 1)]), ctx());
  assert.deepEqual(over, { kind: "failed", reason: "The command printed more than 256 KiB." });
});

test("a value the shaper was passed is redacted from its failure reason", async () => {
  const saved = process.env.SHAPER_FIXTURE_SECRET;
  process.env.SHAPER_FIXTURE_SECRET = "s3cret-passed-value";
  try {
    const reply = await callCommand(request(), shaper([FIXTURE, "leak", "SHAPER_FIXTURE_SECRET"], { env: ["SHAPER_FIXTURE_SECRET"] }), ctx());
    assert.deepEqual(reply, { kind: "failed", reason: "The command exited with code 4: could not authenticate with [redacted]" });
    assert.equal(JSON.stringify(reply).includes("s3cret-passed-value"), false);
  } finally {
    if (saved === undefined) delete process.env.SHAPER_FIXTURE_SECRET;
    else process.env.SHAPER_FIXTURE_SECRET = saved;
  }
});

test("a non-ASCII value split across two stderr chunks is still redacted whole", async () => {
  const saved = process.env.SHAPER_FIXTURE_UNICODE;
  process.env.SHAPER_FIXTURE_UNICODE = "sécret-ŵert-値値値";
  try {
    const reply = await callCommand(request(), shaper([FIXTURE, "leak-split", "SHAPER_FIXTURE_UNICODE"], { env: ["SHAPER_FIXTURE_UNICODE"] }), ctx());
    assert.deepEqual(reply, { kind: "failed", reason: "The command exited with code 4: could not authenticate with [redacted]" });
    const reason = (reply as { reason: string }).reason;
    assert.equal(reason.includes("値") || reason.includes("�"), false, "no piece of the value, and no broken character, survives");
  } finally {
    if (saved === undefined) delete process.env.SHAPER_FIXTURE_UNICODE;
    else process.env.SHAPER_FIXTURE_UNICODE = saved;
  }
});

test("an inherited value and a short named value are redacted from a failure reason too", async () => {
  const names = ["SHAPER_FIXTURE_INHERITED", "SHAPER_FIXTURE_SHORT"] as const;
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  // Not credential-shaped and not named, so the scrub passes it through to the child.
  process.env.SHAPER_FIXTURE_INHERITED = "inherited-plain-value";
  process.env.SHAPER_FIXTURE_SHORT = "x9";
  try {
    const inherited = await callCommand(request(), shaper([FIXTURE, "leak", "SHAPER_FIXTURE_INHERITED"]), ctx());
    assert.deepEqual(inherited, { kind: "failed", reason: "The command exited with code 4: could not authenticate with [redacted]" });
    const short = await callCommand(request(), shaper([FIXTURE, "leak", "SHAPER_FIXTURE_SHORT"], { env: ["SHAPER_FIXTURE_SHORT"] }), ctx());
    assert.deepEqual(short, { kind: "failed", reason: "The command exited with code 4: could not authenticate with [redacted]" });
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("a short named credential printed inside a word is still redacted", async () => {
  const saved = process.env.SHAPER_FIXTURE_SHORT;
  process.env.SHAPER_FIXTURE_SHORT = "x9";
  try {
    const reply = await callCommand(request(), shaper([FIXTURE, "leak-glued", "SHAPER_FIXTURE_SHORT"], { env: ["SHAPER_FIXTURE_SHORT"] }), ctx());
    assert.deepEqual(reply, { kind: "failed", reason: "The command exited with code 4: login failed for user[redacted]x" });
  } finally {
    if (saved === undefined) delete process.env.SHAPER_FIXTURE_SHORT;
    else process.env.SHAPER_FIXTURE_SHORT = saved;
  }
});

/** Inherited values only, none of them named by the operator. */
const inheritedOnly = (...values: string[]) => ({ values, named: new Set<string>() });

test("named values are redacted anywhere, inherited short ones only as whole tokens", () => {
  const named = receivedValues({ LANG: "C", TOKEN: "ab1", OTHER: "zz" }, ["TOKEN", "UNSET_NAME"]);
  assert.deepEqual([...named.named], ["ab1"], "only the named variables that were passed");
  assert.equal(redactReceived("tokenab1 and Code zz9", named), "token[redacted] and Code zz9", "named anywhere, inherited short as tokens");
  assert.equal(redactReceived("zz is C", named), "[redacted] is [redacted]");
});

test("redaction replaces long values anywhere and short ones only as whole tokens", () => {
  const values = receivedValues({ A: "abc-secret-xyz", B: "secret", LANG: "C", SHLVL: "1", EMPTY: "", UNSET: undefined });
  assert.deepEqual(values.values, ["abc-secret-xyz", "secret", "C", "1"], "longest first, empty and unset ignored");
  assert.deepEqual([...values.named], [], "nothing was named");
  assert.equal(redactReceived("token abc-secret-xyz and secret-ish", values), "token [redacted] and [redacted]-ish");
  assert.equal(redactReceived("Could not open C at line 1 of 10", values), "Could not open [redacted] at line [redacted] of 10");
  // A buffer whose front cut a value: the piece before the margin is dropped, a full match kept.
  assert.equal(redactReceived("ret-xyz tail abc-secret-xyz", values, 7), " tail [redacted]");
  assert.equal(redactReceived("secret then text", values, 3), "[redacted] then text", "a match across the margin is still a redaction");
});

test("overlapping values are redacted over their combined span, a value overlapping itself too", () => {
  assert.equal(redactReceived("xx abcdefghi yy", inheritedOnly("abcdef", "defghi")), "xx [redacted] yy", "no tail of the second value survives");
  assert.equal(redactReceived("xx defghi-abcdef yy", inheritedOnly("abcdef", "defghi")), "xx [redacted]-[redacted] yy", "separate values stay separate");
  assert.equal(redactReceived("<ababab>", inheritedOnly("abab")), "<[redacted]>", "a second copy that starts inside the first is covered");
  assert.equal(redactReceived("a1b 1 1-1", inheritedOnly("1")), "a1b [redacted] [redacted]-[redacted]", "short tokens next to each other");
});

test("redacting 256 KiB of shaper output with thousands of matches stays linear", () => {
  const values = inheritedOnly("aaaa", "aaab", ...Array.from({ length: 100 }, (_, i) => `value-${i}-unused`));
  const text = "a".repeat(256 * 1024);
  const started = Date.now();
  assert.equal(redactReceived(text, values), "[redacted]");
  const error = `rejected ${"tok1 ".repeat(50_000)}`;
  assert.equal(redactReceived(error, inheritedOnly("tok1")), `rejected ${"[redacted] ".repeat(50_000)}`);
  // Generous for a busy machine: the quadratic version took minutes on this input.
  assert.ok(Date.now() - started < 5_000, `took ${Date.now() - started} ms`);
});

test("a long value with many overlapping copies is found in linear time", () => {
  // 128 KiB of one character over 256 KiB of the same, the worst case for a search that
  // restarts at each match: every offset starts a copy, and each restart compared the whole
  // value again. That took about 4 s here, all of it on the event loop; this takes milliseconds.
  const value = "a".repeat(128 * 1024);
  const text = `x${"a".repeat(256 * 1024)}y`;
  const started = Date.now();
  assert.equal(redactReceived(text, inheritedOnly(value)), "x[redacted]y");
  assert.equal(redactReceived(`${value.slice(1)}b`, inheritedOnly(value)), `${value.slice(1)}b`, "one short of a copy is not a match");
  assert.ok(Date.now() - started < 1_000, `took ${Date.now() - started} ms`);
  // Overlap and whole-token edges, as before.
  assert.equal(redactReceived("<abXabXab>", inheritedOnly("abXab")), "<[redacted]>", "copies at 1 and 4 overlap");
  assert.equal(redactReceived("C1 C, xC", inheritedOnly("C")), "C1 [redacted], xC");
});

test("a value cut at the front of a long stderr tail never survives as a fragment", async () => {
  const saved = process.env.SHAPER_FIXTURE_LONG;
  process.env.SHAPER_FIXTURE_LONG = `long-${"v".repeat(400)}-value`;
  try {
    const reply = await callCommand(request(), shaper([FIXTURE, "leak-long", "SHAPER_FIXTURE_LONG"]), ctx());
    assert.equal(reply.kind, "failed");
    const reason = (reply as { reason: string }).reason;
    assert.equal(reason.includes("vvvv"), false, "no piece of the value is recorded");
    assert.match(reason, /\[redacted\]/);
  } finally {
    if (saved === undefined) delete process.env.SHAPER_FIXTURE_LONG;
    else process.env.SHAPER_FIXTURE_LONG = saved;
  }
});

test("a timeout answers timed_out long before a slow shaper would have answered", async () => {
  const started = Date.now();
  const reply = await callCommand(request(), shaper([FIXTURE, "slow", "60000"]), ctx(1_500));
  assert.deepEqual(reply, { kind: "timed_out", reason: "Timed out after 1.5 s." });
  // Bounded by the timeout and the drain, never by the shaper's own minute.
  assert.ok(Date.now() - started < 15_000, `settled after ${Date.now() - started} ms`);
});

test("a helper outside the process group that holds the pipes cannot keep them open after the call", async () => {
  const pipes = () => process.getActiveResourcesInfo().filter((name) => name === "PipeWrap").length;
  const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
  const pidFile = join(scratch, "escaped-helper.pid");
  rmSync(pidFile, { force: true });
  const before = pipes();
  try {
    // Stopped once the helper exists, so a slow Node start cannot decide what this proves.
    const controller = new AbortController();
    const pending = callCommand(request(), shaper([FIXTURE, "escape", pidFile]), ctx(120_000, { signal: controller.signal }));
    for (let waited = 0; !existsSync(pidFile) && waited < 60_000; waited += 50) await sleep(50);
    assert.ok(existsSync(pidFile), "the helper really was holding the pipes");
    controller.abort();
    const reply = await pending;
    assert.equal(reply.kind, "timed_out", "the call settles after its drain, not when the helper exits");
    let open = pipes();
    for (let waited = 0; open > before && waited < 3_000; waited += 50) { await sleep(50); open = pipes(); }
    assert.equal(open, before, "the daemon's ends of the shaper's pipes were closed");
  } finally {
    if (existsSync(pidFile)) {
      try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch { /* Already gone. */ }
    }
  }
});

test("a helper left in the group after a successful reply is reaped when the call settles", async () => {
  const pidFile = join(scratch, "orphan-helper.pid");
  rmSync(pidFile, { force: true });
  const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
  let pid = 0;
  try {
    const reply = await callCommand(request(), shaper([FIXTURE, "orphan-helper", pidFile]), ctx(30_000));
    assert.equal(reply.kind, "data", "the shaper answered normally");
    pid = Number(readFileSync(pidFile, "utf8"));
    let alive = true;
    for (let attempt = 0; attempt < 200 && alive; attempt++) {
      try { process.kill(pid, 0); await sleep(25); } catch { alive = false; }
    }
    assert.equal(alive, false, "the helper did not outlive the dry run");
  } finally {
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ } }
  }
});

test("a successful reply is kept when a helper in the group still holds the pipes", async () => {
  const pidFile = join(scratch, "pipe-helper.pid");
  rmSync(pidFile, { force: true });
  const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
  let pid = 0;
  try {
    const started = Date.now();
    // A generous timeout: the reply must come from the shaper's exit, not from the timeout.
    const reply = await callCommand(request(), shaper([FIXTURE, "pipe-helper", pidFile]), ctx(60_000));
    assert.equal(reply.kind, "data", JSON.stringify(reply).slice(0, 200));
    assert.match((reply as { data: string }).data, /answered while a helper held the pipes/);
    assert.ok(Date.now() - started < 30_000, `answered on exit, not at the timeout (${Date.now() - started} ms)`);
    pid = Number(readFileSync(pidFile, "utf8"));
    let alive = true;
    for (let attempt = 0; attempt < 200 && alive; attempt++) {
      try { process.kill(pid, 0); await sleep(25); } catch { alive = false; }
    }
    assert.equal(alive, false, "the helper holding the pipes was stopped");
  } finally {
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ } }
  }
});

test("a reply that arrives just before the deadline is kept, though a helper outside the group holds the pipes", async () => {
  const pidFile = join(scratch, "escape-answer.pid");
  rmSync(pidFile, { force: true });
  const timeoutMs = 6_000;
  const started = Date.now();
  // The shaper answers 300 ms before the call's deadline, inside the drain the old code waited.
  const answerAt = started + timeoutMs - 300;
  try {
    const reply = await callCommand(request(), shaper([FIXTURE, "escape-answer", pidFile, String(answerAt)]), ctx(timeoutMs));
    assert.equal(reply.kind, "data", JSON.stringify(reply).slice(0, 200));
    assert.match((reply as { data: string }).data, /answered just before the deadline/);
    assert.ok(Date.now() - started < timeoutMs, `returned within the call's budget (${Date.now() - started} ms)`);
  } finally {
    if (existsSync(pidFile)) {
      try { process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch { /* Already gone. */ }
    }
  }
});

test("a cleanup failure is logged through the call's redactor", async (t) => {
  const warnings: unknown[][] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => warnings.push(args));
  const saved = process.env.SHAPER_FIXTURE_SECRET;
  process.env.SHAPER_FIXTURE_SECRET = "s3cret-in-a-dir-name";
  // A removal that fails on a path the shaper named after the value it was handed.
  const removal = t.mock.method(fs.promises, "rm", async (path: string) => {
    throw new Error(`EACCES: permission denied, rmdir '${path}/cache-s3cret-in-a-dir-name'`);
  });
  let cwd = "";
  try {
    const reply = await callCommand(request("select"), shaper([FIXTURE, "echo"], { stage: "select", env: ["SHAPER_FIXTURE_SECRET"] }), ctx());
    assert.equal(reply.kind, "data");
    cwd = echoed(reply).cwd;
    assert.equal(await until(() => warnings.length === 1), true);
    const logged = JSON.stringify(warnings);
    assert.equal(logged.includes("s3cret-in-a-dir-name"), false, "the value is not in the daemon's log");
    assert.match(logged, /cache-\[redacted\]/);
  } finally {
    removal.mock.restore();
    if (cwd) rmSync(cwd, { recursive: true, force: true });
    if (saved === undefined) delete process.env.SHAPER_FIXTURE_SECRET;
    else process.env.SHAPER_FIXTURE_SECRET = saved;
  }
});

test("stopping a call kills its whole process group, descendants included", async () => {
  // Stopped only once the descendant exists, so how long Node takes to start on a busy machine
  // cannot decide what this test proves.
  const pidFile = join(scratch, "grandchild.pid");
  rmSync(pidFile, { force: true });
  const controller = new AbortController();
  const pending = callCommand(request(), shaper([FIXTURE, "grandchild", pidFile]), ctx(120_000, { signal: controller.signal }));
  const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
  for (let waited = 0; !existsSync(pidFile) && waited < 60_000; waited += 50) await sleep(50);
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.ok(pid > 0, "the shaper started its own child");
  controller.abort();
  assert.equal((await pending).kind, "timed_out");
  let alive = true;
  for (let attempt = 0; attempt < 200 && alive; attempt++) {
    try { process.kill(pid, 0); await sleep(50); } catch { alive = false; }
  }
  assert.equal(alive, false, "the shaper's own child was killed with it");
});

test("an abort stops the call at once", async () => {
  const controller = new AbortController();
  const pending = callCommand(request(), shaper([FIXTURE, "slow", "10000"]), ctx(10_000, { signal: controller.signal }));
  setTimeout(() => controller.abort(), 200);
  const started = Date.now();
  assert.equal((await pending).kind, "timed_out");
  assert.ok(Date.now() - started < 3_000);
});

test("a non-zero exit fails with its stderr, and a missing command is unavailable", async () => {
  const failed = await callCommand(request(), shaper([FIXTURE, "fail"]), ctx());
  assert.deepEqual(failed, { kind: "failed", reason: "The command exited with code 3: the shaper broke" });
  const missing = await callCommand(request(), shaper([], { command: "mission-no-such-shaper-binary" }), ctx());
  assert.equal(missing.kind, "unavailable");
  const absent = await callCommand(request(), shaper([], { command: join(scratch, "absent") }), ctx());
  assert.equal(absent.kind, "unavailable");
});

test("a gatherer with no local worktree is unavailable", async () => {
  const remote = { ...request(), repo: { name: "billing-api" } };
  assert.equal((await callCommand(remote, shaper([FIXTURE, "echo"]), ctx())).kind, "unavailable");
});

test("a ./ command needs a shaper folder and stays inside it", async () => {
  const relative = shaper([FIXTURE, "echo"], { command: "./run" });
  const registered = await callCommand(request(), relative, ctx());
  assert.equal(registered.kind, "unavailable");
  assert.match((registered as { reason: string }).reason, /only a shaper found in the shapers folder/);

  const folder = join(scratch, "folder");
  mkdirSync(folder);
  writeFileSync(join(folder, "run"), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`, { mode: 0o755 });
  symlinkSync("/bin/sh", join(folder, "escape"));
  const inside = await callCommand(request(), relative, ctx(10_000, { root: folder }));
  assert.equal(echoed(inside).argv[0], "echo");
  const escaping = await callCommand(request(), shaper([], { command: "./escape" }), ctx(10_000, { root: folder }));
  assert.equal(escaping.kind, "unavailable");
  assert.match((escaping as { reason: string }).reason, /outside the shaper's folder/);
});

test("a shaper definition cannot name a shell string or a relative path outside ./", () => {
  for (const command of ["bin/run", "../run", "./../run", "sh -c 'x'", ""]) {
    const parsed = ShaperSchema.safeParse({ id: "x", label: "X", stage: "gather", transport: { type: "command", command } });
    assert.equal(parsed.success, false, command);
  }
  const ok: Shaper = ShaperSchema.parse({ id: "x", label: "X", stage: "gather", transport: { type: "command", command: "node" } });
  assert.equal(ok.transport.type, "command");
});
