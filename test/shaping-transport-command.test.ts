// The `command` transport: argv without a shell, a scrubbed environment, the request on stdin and
// the reply on stdout, a 256 KiB output cap, and a timeout that takes the whole process group.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Shaper, ShapingRequest } from "../src/shared/shaping.ts";
import { SHAPING_LIMITS, ShaperManifestSchema, ShaperSchema, ShapingResultSchema } from "../src/shared/shaping.ts";
import {
  callCommand, COMMAND_OUTPUT_BYTES, receivedValues, redactReceived, removeScratch, shaperCommandEnv,
} from "../src/server/shaping/transports/command.ts";
import { scrubResolved } from "../src/server/shaping/references.ts";
import type { ShaperOf, TransportContext } from "../src/server/shaping/transports/types.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-shaper.mjs", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "shaping-command-"));
const worktree = join(scratch, "worktree");
mkdirSync(worktree);
after(() => rmSync(scratch, { recursive: true, force: true }));

function shaper(args: string[], extra: { env?: string[]; command?: string; stage?: "gather" | "select" } = {}): ShaperOf<"command"> {
  const definition = {
    id: "fixture", label: "Fixture", stage: extra.stage ?? "gather",
    transport: { type: "command", command: extra.command ?? process.execPath, args, env: extra.env ?? [] },
  };
  // A `./` command is a discovered shaper's: only a manifest may name one.
  const schema = definition.transport.command.startsWith("./") ? ShaperManifestSchema : ShaperSchema;
  return schema.parse(definition) as ShaperOf<"command">;
}
function request(stage: "gather" | "select" = "gather"): ShapingRequest {
  return {
    protocol: 1, stage, task: "Retry failed charges",
    repo: { name: "billing-api", path: worktree },
    context: {
      taskId: "t_1", title: "Retry", kind: "ship", harness: "claude", runtime: "sdk", afterWork: null,
      labels: [], priority: null, repositories: [{ slot: "repo-01", name: "billing-api", role: "primary", branch: null, baseSha: null, path: worktree }],
      target: "repo-01",
      caller: { user: null, agent: "claude", conversation: "t_1" },
    },
    limits: { maxBytes: 16384, deadlineMs: 5000 },
  };
}
function ctx(timeoutMs = 10_000, extra: Partial<TransportContext> = {}): TransportContext {
  return {
    deadline: Date.now() + timeoutMs, timeoutMs, signal: new AbortController().signal,
    scope: { shared: new Map(), defer() {} }, root: null, trace: null, workUnitId: null, ...extra,
  } as TransportContext;
}
/** A data reply decoded: the text as written, or the value a scrubbed reply already is. */
function decoded(reply: Awaited<ReturnType<typeof callCommand>>): any {
  const data = (reply as { data: unknown }).data;
  return typeof data === "string" ? JSON.parse(data) : data;
}
function echoed(reply: Awaited<ReturnType<typeof callCommand>>) {
  assert.equal(reply.kind, "data", JSON.stringify(reply));
  const body = JSON.parse(decoded(reply).guidance[0].body);
  return body as { argv: string[]; cwd: string; env: Record<string, string | null>; envKeys: string[]; request: ShapingRequest };
}

const TRACE = { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01", tracestate: "mc=launch" };

test("a command shaper gets the launch's trace context, and never one inherited or configured", async () => {
  const names = ["TRACEPARENT", "TRACESTATE", "traceparent"] as const;
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  // The daemon's own context, which belongs to whatever started the daemon.
  process.env.TRACEPARENT = "00-11111111111111111111111111111111-2222222222222222-01";
  process.env.TRACESTATE = "vendor=ambient";
  process.env.traceparent = "00-33333333333333333333333333333333-4444444444444444-01";
  try {
    // The shaper even names the variables itself: they are removed first, in any case.
    const named = { env: ["TRACEPARENT", "TRACESTATE", "traceparent"] };
    const env = (args: string[]) => [...args, "env=TRACEPARENT", "env=TRACESTATE", "env=traceparent"];
    const withTrace = echoed(await callCommand(request(), shaper(env([FIXTURE, "echo"]), named), ctx(10_000, { trace: TRACE })));
    assert.match(withTrace.env.TRACEPARENT!, /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/, "well-formed");
    assert.deepEqual(withTrace.env, { TRACEPARENT: TRACE.traceparent, TRACESTATE: TRACE.tracestate, traceparent: null });
    const parentOnly = echoed(await callCommand(request(), shaper(env([FIXTURE, "echo"]), named),
      ctx(10_000, { trace: { traceparent: TRACE.traceparent } })));
    assert.deepEqual(parentOnly.env, { TRACEPARENT: TRACE.traceparent, TRACESTATE: null, traceparent: null }, "no TRACESTATE without one");
    const none = echoed(await callCommand(request(), shaper(env([FIXTURE, "echo"]), named), ctx()));
    assert.deepEqual(none.env, { TRACEPARENT: null, TRACESTATE: null, traceparent: null }, "with no context, none at all");
    assert.equal(none.envKeys.some((key) => /^trace(parent|state)$/i.test(key)), false);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("a command shaper gets the run's work unit id as WORK_UNIT_ID when there is one, and never one inherited or configured", async () => {
  const names = ["WORK_UNIT_ID", "work_unit_id"] as const;
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.WORK_UNIT_ID = "wu-from-the-daemon";
  process.env.work_unit_id = "wu-lower-case";
  try {
    const named = { env: ["WORK_UNIT_ID", "work_unit_id"] };
    const args = [FIXTURE, "echo", "env=WORK_UNIT_ID", "env=work_unit_id"];
    const present = echoed(await callCommand(request(), shaper(args, named), ctx(10_000, { workUnitId: "wu_01JD5Z" })));
    assert.deepEqual(present.env, { WORK_UNIT_ID: "wu_01JD5Z", work_unit_id: null });
    const absent = echoed(await callCommand(request(), shaper(args, named), ctx()));
    assert.deepEqual(absent.env, { WORK_UNIT_ID: null, work_unit_id: null }, "with none, nothing at all");
    assert.equal(absent.envKeys.some((key) => /^work_unit_id$/i.test(key)), false);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("a work unit id is never redacted: it is an opaque id, not a credential", async () => {
  const reply = await callCommand(request(), shaper([FIXTURE, "leak", "WORK_UNIT_ID"]), ctx(10_000, { workUnitId: "wu_01JD5Z" }));
  assert.deepEqual(reply, { kind: "failed", reason: "The command exited with code 4: could not authenticate with wu_01JD5Z" });
});

test("a trace value is never redacted: it is neither a credential nor a reference", async () => {
  const saved = process.env.SHAPER_FIXTURE_SECRET;
  process.env.SHAPER_FIXTURE_SECRET = "s3cret-passed-value";
  try {
    const reply = await callCommand(request(), shaper([FIXTURE, "leak", "TRACEPARENT"], { env: ["SHAPER_FIXTURE_SECRET"] }),
      ctx(10_000, { trace: TRACE }));
    assert.deepEqual(reply, { kind: "failed", reason: `The command exited with code 4: could not authenticate with ${TRACE.traceparent}` });
  } finally {
    if (saved === undefined) delete process.env.SHAPER_FIXTURE_SECRET;
    else process.env.SHAPER_FIXTURE_SECRET = saved;
  }
});

test("an unset named variable that matches an inherited property cannot break reply scrubbing", async () => {
  const reply = await callCommand(request("select"), shaper([FIXTURE, "ok"], { env: ["constructor", "toString"], stage: "select" }), ctx());
  assert.equal(reply.kind, "data", JSON.stringify(reply));
  assert.equal(decoded(reply).guidance[0].body, "first entry for billing-api");
});

test("a named variable called __proto__ is an own property of the child's environment", () => {
  const base = JSON.parse('{"__proto__":"proto-value","PATH":"/usr/bin:/bin"}') as NodeJS.ProcessEnv;
  const env = shaperCommandEnv(base, ["__proto__"], "", null, "wu_01JD5Z");
  assert.ok(Object.hasOwn(env, "__proto__"), Object.keys(env).join(","));
  assert.equal(Object.getOwnPropertyDescriptor(env, "__proto__")?.value, "proto-value");
  assert.ok(Object.keys(env).includes("__proto__"), "and is enumerated, so a spawn passes it on");
  assert.equal(env.WORK_UNIT_ID, "wu_01JD5Z");
});

test("a named value a command reprints with its whitespace normalized is redacted and marked", async () => {
  const saved = process.env.SHAPER_FIXTURE_SPACED;
  process.env.SHAPER_FIXTURE_SPACED = "Jane\t\tDoe";
  try {
    const failed = await callCommand(request(), shaper([FIXTURE, "leak-normalized", "SHAPER_FIXTURE_SPACED"], { env: ["SHAPER_FIXTURE_SPACED"] }), ctx());
    assert.deepEqual(failed, { kind: "failed", reason: "The command exited with code 4: could not authenticate with [SHAPER_FIXTURE_SPACED redacted]", redacted: true });
    // The reply's redactor, which the engine runs over reasons built from a reply, agrees.
    const reply = await callCommand(request("select"), shaper([FIXTURE, "ok"], { env: ["SHAPER_FIXTURE_SPACED"], stage: "select" }), ctx());
    assert.equal(reply.kind, "data");
    const data = reply as { redact?: (text: string) => string; holdsNamed?: (text: string) => boolean };
    assert.equal(data.holdsNamed?.("note for Jane Doe"), true);
    assert.equal(data.redact?.("note for Jane Doe"), "note for [SHAPER_FIXTURE_SPACED redacted]");
  } finally {
    if (saved === undefined) delete process.env.SHAPER_FIXTURE_SPACED;
    else process.env.SHAPER_FIXTURE_SPACED = saved;
  }
});

test("a command's stderr cut inside a widened spelling of a named value is not quoted", async () => {
  const saved = process.env.SHAPER_FIXTURE_SPACED;
  process.env.SHAPER_FIXTURE_SPACED = "Jane Doe";
  try {
    const reply = await callCommand(request(), shaper([FIXTURE, "leak-spaced", "SHAPER_FIXTURE_SPACED", "50000"], { env: ["SHAPER_FIXTURE_SPACED"] }), ctx());
    assert.equal(reply.kind, "failed");
    const reason = (reply as { reason: string }).reason;
    assert.equal(reason.includes("Doe"), false, reason);
    assert.equal(reason, "The command exited with code 4: its stderr is not quoted: it was too long to scrub safely");
  } finally {
    if (saved === undefined) delete process.env.SHAPER_FIXTURE_SPACED;
    else process.env.SHAPER_FIXTURE_SPACED = saved;
  }
});

test("a named __proto__ variable reaches a command shaper's process", async () => {
  const saved = Object.getOwnPropertyDescriptor(process.env, "__proto__")?.value as string | undefined;
  process.env["__proto__"] = "proto-value-77c1";
  try {
    const seen = echoed(await callCommand(request(), shaper([FIXTURE, "echo", "env=__proto__"], { env: ["__proto__"] }), ctx()));
    // The echoed value is the passed variable, which the reply scrub removes under its name.
    assert.equal(seen.env["__proto__"], "[__proto__ redacted]");
    assert.ok(seen.envKeys.includes("__proto__"), "the child's environment holds it");
  } finally {
    if (saved === undefined) delete process.env["__proto__"];
    else process.env["__proto__"] = saved;
  }
});

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
    // The child received it and echoed it, and the echo is scrubbed from the reply under its name.
    assert.equal(seen.env.SHAPER_FIXTURE_NAMED, "[SHAPER_FIXTURE_NAMED redacted]", "a named variable is passed through");
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
    assert.deepEqual(reply, { kind: "failed", reason: "The command exited with code 4: could not authenticate with [redacted]", redacted: true },
      "a named value removed from the reason marks the reply redacted");
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
    assert.deepEqual(reply, { kind: "failed", reason: "The command exited with code 4: could not authenticate with [redacted]", redacted: true });
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
    assert.deepEqual(inherited, { kind: "failed", reason: "The command exited with code 4: could not authenticate with [redacted]" },
      "an inherited value is redacted, but only a named one is a credential the reply is marked for");
    const short = await callCommand(request(), shaper([FIXTURE, "leak", "SHAPER_FIXTURE_SHORT"], { env: ["SHAPER_FIXTURE_SHORT"] }), ctx());
    assert.deepEqual(short, { kind: "failed", reason: "The command exited with code 4: could not authenticate with [redacted]", redacted: true });
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("a wall-clock jump while a call starts does not end it early", async () => {
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow.call(Date) + offset;
  try {
    // The call reads its start synchronously; the clock then moves an hour forward before it
    // resolves the executable, so a budget counted on the wall clock is gone before the spawn.
    const pending = callCommand(request(), shaper([FIXTURE, "ok"]), ctx(30_000));
    offset = 3_600_000;
    const reply = await pending;
    assert.equal(reply.kind, "data", JSON.stringify(reply));
  } finally {
    Date.now = realNow;
  }
});

test("a reply's redactor treats a version as an identifier: named values go, short inherited ones stay", async () => {
  const names = ["SHAPER_FIXTURE_ZERO", "SHAPER_FIXTURE_SHORT"] as const;
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  // Values no runner's environment holds, so an inherited "4" or "0" elsewhere cannot change
  // what these assertions see.
  process.env.SHAPER_FIXTURE_ZERO = "ʘ";
  process.env.SHAPER_FIXTURE_SHORT = "фq";
  try {
    const reply = await callCommand(request(), shaper([FIXTURE, "ok"], { env: ["SHAPER_FIXTURE_SHORT"] }), ctx(30_000));
    assert.equal(reply.kind, "data");
    const redact = (reply as { redact: (text: string, options?: { identifier?: boolean }) => string }).redact;
    assert.equal(redact("r-ʘ", { identifier: true }), "r-ʘ", "a short inherited value is no credential in a version");
    assert.equal(redact("seen ʘ."), "seen [redacted].", "a reason still drops it as a whole token");
    assert.equal(redact("r-фq-build", { identifier: true }), "r-[redacted]-build", "a named value goes, however short");
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("a named credential the shaper echoes in its reply's content is scrubbed before the engine sees it", async () => {
  const saved = process.env.SHAPER_FIXTURE_SECRET;
  process.env.SHAPER_FIXTURE_SECRET = "s3cret-passed-value";
  try {
    const reply = await callCommand(request(), shaper([FIXTURE, "guidance-leak", "SHAPER_FIXTURE_SECRET"], { env: ["SHAPER_FIXTURE_SECRET"] }), ctx());
    assert.equal(reply.kind, "data");
    assert.equal((reply as { redacted?: boolean }).redacted, true);
    assert.equal(JSON.stringify(decoded(reply)).includes("s3cret-passed-value"), false, "no copy survives anywhere in the reply");
    const parsed = decoded(reply) as { guidance: Array<{ id: string; title: string; body: string; path: string }>; repo: { facts: Record<string, string>; summary: string }; notes?: string[] };
    assert.deepEqual(parsed.guidance.map((entry) => entry.id), ["kept"], "an entry whose id held the value is dropped, never renamed");
    assert.deepEqual(parsed.guidance[0], { id: "kept", title: "token [SHAPER_FIXTURE_SECRET redacted]",
      body: "use [SHAPER_FIXTURE_SECRET redacted] to sign in", path: "docs/[SHAPER_FIXTURE_SECRET redacted].md" });
    assert.deepEqual(parsed.repo.facts, { language: "typescript", owner: "team [SHAPER_FIXTURE_SECRET redacted]" },
      "a fact named after the value is dropped; one holding it is scrubbed");
    assert.equal(parsed.repo.summary, "summary with [SHAPER_FIXTURE_SECRET redacted]");
    assert.equal(parsed.notes, undefined, "the reply's own notes are left as written");
    const dropped = (reply as { redactionNotes?: string[] }).redactionNotes ?? [];
    assert.equal(dropped.length, 2, "each drop is reported beside the reply");
    assert.match(dropped.join(" "), /dropped because its id contained the value of SHAPER_FIXTURE_SECRET/);
  } finally {
    if (saved === undefined) delete process.env.SHAPER_FIXTURE_SECRET;
    else process.env.SHAPER_FIXTURE_SECRET = saved;
  }
});

test("a redacted reply with a deeply nested unknown field settles, and its clean entries still count", async () => {
  const saved = process.env.SHAPER_FIXTURE_SECRET;
  process.env.SHAPER_FIXTURE_SECRET = "s3cret-passed-value";
  try {
    const reply = await callCommand(request(), shaper([FIXTURE, "deep-leak", "SHAPER_FIXTURE_SECRET"], { env: ["SHAPER_FIXTURE_SECRET"] }), ctx());
    assert.equal(reply.kind, "data", "the call settles; nothing is serialised again");
    assert.equal((reply as { redacted?: boolean }).redacted, true);
    assert.deepEqual(decoded(reply).guidance, [{ id: "clean", body: "a clean entry with [SHAPER_FIXTURE_SECRET redacted]" }]);
  } finally {
    if (saved === undefined) delete process.env.SHAPER_FIXTURE_SECRET;
    else process.env.SHAPER_FIXTURE_SECRET = saved;
  }
});

test("overlapping named values are removed over their combined span, so no fragment of either survives", () => {
  const resolved = [{ name: "FIRST", value: "abcdef" }, { name: "SECOND", value: "defghi" }];
  const reply = { guidance: [{ id: "e", body: "xx abcdefghi yy", title: "defghi-abcdef" }] };
  const scrubbed = scrubResolved(reply, resolved);
  const entry = (scrubbed.data as { guidance: Array<{ body: string; title: string }> }).guidance[0]!;
  assert.equal(entry.body, "xx [FIRST, SECOND redacted] yy", "replacing one first would have left \"ghi\" behind");
  assert.equal(entry.title, "[SECOND redacted]-[FIRST redacted]", "separate values stay separate");
  // A value overlapping itself.
  const self = scrubResolved({ guidance: [{ id: "e", body: "<ababab>" }] }, [{ name: "AB", value: "abab" }]);
  assert.equal((self.data as { guidance: Array<{ body: string }> }).guidance[0]!.body, "<[AB redacted]>");
});

test("a scrubbed field never grows past its schema limit, so a reply at its limits stays valid", () => {
  // A two-character credential becomes a far longer marker: each field must still fit.
  const title = `${"t".repeat(509)}x9z`; // 512, the title's limit
  const version = `${"v".repeat(253)}x9z`; // 256, the version's limit
  const reply = { version, guidance: [{ id: "e", title, path: `${"p".repeat(1021)}x9z`, body: "b" }], repo: { facts: { owner: `${"o".repeat(4)}x9` } } };
  const before = ShapingResultSchema.safeParse(reply);
  assert.equal(before.success, true, "valid as written");
  const scrubbed = scrubResolved(structuredClone(reply), [{ name: "TOKEN", value: "x9" }]);
  assert.equal(scrubbed.redacted, true);
  const after = ShapingResultSchema.safeParse(scrubbed.data);
  assert.equal(after.success, true, after.success ? "" : JSON.stringify(after.error.issues[0]));
  const entry = (scrubbed.data as typeof reply).guidance[0]!;
  assert.equal(entry.title.length, 512);
  assert.equal(entry.title.includes("x9"), false, "and the value is gone");
  assert.equal((scrubbed.data as typeof reply).version.length, 256);
  assert.equal((scrubbed.data as typeof reply).repo.facts.owner, "oooo[TOKEN redacted]", "a field well within its limit keeps the whole marker");
});

test("a named value split by a NUL is still found, so stripping the NUL can never rejoin it", () => {
  const resolved = [{ name: "TOKEN", value: "s3cret-passed" }];
  const reply = { guidance: [{ id: "e", body: "use s3cret-\u0000passed here" }, { id: "by-s3cret-pa\u0000ssed", body: "keyed by it" }],
    repo: { facts: { owner: "s3c\u0000ret-passed" } } };
  const scrubbed = scrubResolved(reply, resolved);
  assert.equal(scrubbed.redacted, true);
  const text = JSON.stringify(scrubbed.data);
  assert.equal(text.includes("s3cret-passed") || text.includes("\\u0000"), false, "no NUL is left to strip, and no credential behind one");
  const data = scrubbed.data as typeof reply;
  assert.deepEqual(data.guidance.map((entry) => entry.id), ["e"], "an id holding the value behind a NUL is dropped too");
  assert.equal(data.guidance[0]!.body, "use [TOKEN redacted] here");
  assert.equal(data.repo.facts.owner, "[TOKEN redacted]");
});

test("redacting many targets that share a short value stays bounded", () => {
  // 32 named variables with one two-character value, over 256 KiB of it: every offset matches.
  const resolved = Array.from({ length: 32 }, (_, i) => ({ name: `VAR_${i}`, value: "aa" }));
  const reply = { guidance: [{ id: "e", body: "a".repeat(256 * 1024) }] };
  const started = Date.now();
  const scrubbed = scrubResolved(reply, resolved);
  const elapsed = Date.now() - started;
  const body = (scrubbed.data as typeof reply).guidance[0]!.body;
  assert.equal(body.startsWith("[VAR_0, VAR_1"), true, "one span, naming every variable that holds the value");
  assert.equal(body.includes("a]") || body.endsWith("a"), false);
  // About 13 ms here; the per-match version took about 700 ms and 600 MB of heap on this input.
  assert.ok(elapsed < 250, `took ${elapsed} ms`);
});

test("a field already over its limit is left for the schema to refuse, not clipped into validity", () => {
  const reply = { guidance: [{ id: "e", title: "t".repeat(513), body: "nothing named here" }] };
  const scrubbed = scrubResolved(structuredClone(reply), [{ name: "TOKEN", value: "x9" }]);
  assert.equal(scrubbed.redacted, false, "nothing was removed");
  assert.equal((scrubbed.data as typeof reply).guidance[0]!.title.length, 513);
  assert.equal(ShapingResultSchema.safeParse(scrubbed.data).success, false, "so the engine still refuses it");
});

test("a marker or note never repeats a credential that the variable's own name contains", () => {
  const resolved = [{ name: "TOKEN_X9", value: "X9" }];
  const reply = { guidance: [{ id: "e", body: "use X9 here" }, { id: "by-X9", body: "keyed by it" }] };
  const scrubbed = scrubResolved(reply, resolved);
  const text = JSON.stringify(scrubbed.data) + scrubbed.notes.join(" ");
  assert.equal(text.includes("X9"), false, "neither the marker nor the note names TOKEN_X9");
  assert.equal((scrubbed.data as typeof reply).guidance[0]!.body, "use [redacted] here");
  assert.match(scrubbed.notes[0]!, /contained the value of a passed variable/);
});

test("redaction is bounded as it is built, and skips fields the engine discards", () => {
  // 256 KiB of a two-character value, each replaced by a far longer marker naming two variables.
  const resolved = [{ name: "FIRST_VARIABLE", value: "x9" }, { name: "SECOND_VARIABLE", value: "x9" }];
  const body = "x9 ".repeat(80 * 1024);
  const reply = { guidance: [{ id: "e", body }], extra: { unread: "x9 ".repeat(1024) } };
  const started = Date.now();
  const scrubbed = scrubResolved(reply, resolved);
  const out = (scrubbed.data as typeof reply).guidance[0]!.body;
  assert.ok(out.length <= SHAPING_LIMITS.replyText, `the body is ${out.length} characters`);
  assert.equal(out.includes("x9"), false);
  assert.equal((scrubbed.data as typeof reply).extra.unread.length, 3 * 1024, "an unknown field is left unread, as the engine discards it");
  assert.ok(Date.now() - started < 1_000);
});

test("a reply invalid as sent is left exactly as sent, so no rewrite can make it pass", () => {
  const resolved = [{ name: "TOKEN", value: "s3cret-value" }];
  const cases = {
    "an entry with no body": { guidance: [{ id: "by-s3cret-value" }, { id: "fine", body: "ok" }] },
    "one entry over the bound": { guidance: Array.from({ length: SHAPING_LIMITS.replyEntries + 1 }, (_, i) => ({ id: i === 0 ? "by-s3cret-value" : `e${i}`, body: "b" })) },
    // A long value inside an oversized title: replacing it with a short marker would bring the
    // title within its limit, and the engine would accept a reply the protocol refuses.
    "an oversized title a replacement would shorten": { guidance: [{ id: "e", body: "b", title: `${"t".repeat(500)}${"s3cret-value".repeat(4)}` }] },
  };
  const long = [{ name: "TOKEN", value: "s3cret-value".repeat(4) }];
  for (const [label, reply] of Object.entries(cases)) {
    const before = structuredClone(reply);
    assert.equal(ShapingResultSchema.safeParse(reply).success, false, `${label}: invalid as sent`);
    const scrubbed = scrubResolved(reply, label.startsWith("an oversized") ? long : resolved);
    assert.deepEqual(scrubbed.data, before, `${label}: left as sent`);
    assert.deepEqual([scrubbed.redacted, scrubbed.notes], [false, []]);
    assert.equal(ShapingResultSchema.safeParse(scrubbed.data).success, false, `${label}: so the engine refuses it`);
  }
});

test("an authenticated proxy URL the shaper inherited is scrubbed from its reply, whole, in part and decoded", async () => {
  const saved = process.env.HTTPS_PROXY;
  // Percent-encoded in the URL, as it must be: a tool can print the decoded `pr0xy@pass!`.
  process.env.HTTPS_PROXY = "http://proxyuser:pr0xy%40pass%21@proxy.example:8080";
  try {
    const reply = await callCommand(request(), shaper([FIXTURE, "proxy-leak", "HTTPS_PROXY"]), ctx(30_000));
    assert.equal(reply.kind, "data");
    assert.equal((reply as { redacted?: boolean }).redacted, true);
    const text = JSON.stringify(decoded(reply));
    assert.equal(text.includes("pr0xy") || text.includes("proxyuser:"), false, "neither the URL nor the password, in any form, survives");
    assert.deepEqual(decoded(reply).guidance.map((entry: { body: string }) => entry.body),
      ["reached through [HTTPS_PROXY redacted]", "password [HTTPS_PROXY redacted]", "decoded [HTTPS_PROXY redacted]"]);
    // A proxy without credentials is ordinary configuration, passed and echoed as written.
    process.env.HTTPS_PROXY = "http://proxy.example:8080";
    const plain = await callCommand(request(), shaper([FIXTURE, "proxy-leak", "HTTPS_PROXY"]), ctx(30_000));
    assert.equal((plain as { redacted?: boolean }).redacted, undefined);
    assert.equal(decoded(plain).guidance[0].body, "reached through http://proxy.example:8080");
  } finally {
    if (saved === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = saved;
  }
});


test("a proxy password holding an unescaped @ is read as the URL parser reads it, in full", async () => {
  const saved = process.env.HTTPS_PROXY;
  // The parser ends the userinfo at the LAST "@": the password is "pr0xy@pass".
  process.env.HTTPS_PROXY = "http://proxyuser:pr0xy@pass@proxy.example:8080";
  try {
    const reply = await callCommand(request(), shaper([FIXTURE, "proxy-leak", "HTTPS_PROXY"]), ctx(30_000));
    assert.equal(reply.kind, "data");
    const text = JSON.stringify(decoded(reply));
    assert.equal(text.includes("pr0xy") || text.includes("@pass"), false, "no prefix or suffix of the password survives");
    assert.deepEqual(decoded(reply).guidance.map((entry: { body: string }) => entry.body),
      ["reached through [HTTPS_PROXY redacted]", "password [HTTPS_PROXY redacted]", "decoded [HTTPS_PROXY redacted]"]);
  } finally {
    if (saved === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = saved;
  }
});

test("a reply holding no named value is returned byte for byte", async () => {
  const reply = await callCommand(request(), shaper([FIXTURE, "ok"]), ctx());
  assert.equal(reply.kind, "data");
  assert.equal((reply as { redacted?: boolean }).redacted, undefined);
  assert.equal(typeof (reply as { data: unknown }).data, "string");
});

test("a short named credential printed inside a word is still redacted", async () => {
  const saved = process.env.SHAPER_FIXTURE_SHORT;
  process.env.SHAPER_FIXTURE_SHORT = "x9";
  try {
    const reply = await callCommand(request(), shaper([FIXTURE, "leak-glued", "SHAPER_FIXTURE_SHORT"], { env: ["SHAPER_FIXTURE_SHORT"] }), ctx());
    assert.deepEqual(reply, { kind: "failed", reason: "The command exited with code 4: login failed for user[redacted]x", redacted: true });
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
    const aborted = Date.now();
    const reply = await pending;
    const settledIn = Date.now() - aborted;
    assert.equal(reply.kind, "timed_out", "the call settles, not when the helper exits");
    // At once: the engine reuses a timed-out call's slot after a short grace, so its process and
    // pipes must be released by then. The drain this replaced waited a full second.
    assert.ok(settledIn < 500, `settled ${settledIn} ms after the abort`);
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

test("an overflow settles as soon as the cap is crossed, though a helper outside the group holds the pipes", async () => {
  const pidFile = join(scratch, "overflow-helper.pid");
  const startedFile = join(scratch, "overflow-started");
  rmSync(pidFile, { force: true });
  rmSync(startedFile, { force: true });
  let pid = 0;
  try {
    const reply = await callCommand(request(), shaper([FIXTURE, "escape-overflow", pidFile, startedFile]), ctx(30_000));
    const answered = Date.now();
    pid = Number(readFileSync(pidFile, "utf8"));
    assert.deepEqual(reply, { kind: "failed", reason: `The command printed more than ${COMMAND_OUTPUT_BYTES / 1024} KiB.` });
    // The drain this replaces waited a full second after the cap; the answer now comes at once.
    const sinceOutput = answered - Number(readFileSync(startedFile, "utf8"));
    assert.ok(sinceOutput < 900, `answered ${sinceOutput} ms after the shaper started writing`);
  } finally {
    if (pid > 0) { try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ } }
  }
});

test("a ./ command needs a shaper folder and stays inside it", async () => {
  // Registration refuses a ./ command; the transport still refuses one with no folder, so an
  // entry stored by any other path cannot run it either.
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
