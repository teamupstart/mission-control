import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What is at stake: a managed Pi session that looks dispatched and is running something
// else - a different model, a different conversation, or nothing at all.
//
// Every one of those is a REFUSAL in the adapter rather than a fallback, which is only
// checkable from outside. So this file drives the real `piSdkSpec` against a scripted Pi
// (`helpers/pi-sdk-fake.ts`): the event normalization, the turn accounting, the controls
// and the diagnostics are the shipped code. No `pi` is installed, no credential is read,
// no session file is opened, and no token is spent - and the fake has no path to any of
// those, which is what makes that a property rather than a promise.

const home = mkdtempSync(join(tmpdir(), "pi-sdk-adapter-"));
process.env.HARNESS_HOME = join(home, "state");

const { piSdkSpec, splitPiModelId, usageFrom, toolActivity } = await import(
  "../src/server/harness/pi/sdk.ts"
);
const { PiSdkError } = await import("../src/server/harness/pi/sdk-errors.ts");
/** The instance type behind the dynamically imported class, for the rejection predicates. */
type PiFailure = InstanceType<typeof PiSdkError>;
const {
  FakePiSdk,
  FakePiSession,
  collect,
  eventOfKind,
  fakePiSdkDeps,
  launchOptions,
  settle,
} = await import("./helpers/pi-sdk-fake.ts");

test.after(() => rmSync(home, { recursive: true, force: true }));

/** Launch against a scripted Pi and hand back everything a test needs to drive it. */
async function launch(
  over: Partial<import("../src/server/harness/types.ts").SdkLaunchOptions> = {},
  configure: (sdk: InstanceType<typeof FakePiSdk>) => void = () => {},
) {
  const sdk = new FakePiSdk();
  configure(sdk);
  const deps = fakePiSdkDeps(sdk);
  const handle = await piSdkSpec(deps).launch(launchOptions(over));
  const stream = collect(handle);
  await settle();
  return { sdk, deps, handle, ...stream };
}

// ---- model identity ------------------------------------------------------------------

test("a provider-qualified model id is split once, at its FIRST slash", () => {
  // Pi's own catalog emits ids whose model half carries slashes, so a split on the last
  // separator renames the model and a split on every one loses most of it. Bedrock's ids
  // are the ordinary case; the nested one is the case that makes the rule visible.
  assert.deepEqual(splitPiModelId("amazon-bedrock/deepseek.v3.2"), {
    provider: "amazon-bedrock",
    id: "deepseek.v3.2",
  });
  assert.deepEqual(splitPiModelId("openrouter/anthropic/claude-sonnet-5"), {
    provider: "openrouter",
    id: "anthropic/claude-sonnet-5",
  });
  // Nothing usable: Pi's catalog always qualifies, so a bare id came from somewhere else.
  assert.equal(splitPiModelId("deepseek.v3.2"), null);
  assert.equal(splitPiModelId("/leading"), null);
  assert.equal(splitPiModelId("trailing/"), null);
});

test("the exact model id reaches Pi's runtime and is never rewritten", async () => {
  const { sdk } = await launch({ model: "amazon-bedrock/deepseek.v3.2" });
  assert.deepEqual(sdk.created[0]!.model, {
    provider: "amazon-bedrock",
    id: "deepseek.v3.2",
  });

  const nested = await launch({ model: "openrouter/meta-llama/llama-4-maverick" });
  assert.deepEqual(nested.sdk.created[0]!.model, {
    provider: "openrouter",
    id: "meta-llama/llama-4-maverick",
  });
});

test("no model at all lets Pi follow its own configured default", async () => {
  const { sdk } = await launch({ model: null });
  assert.equal(sdk.created[0]!.model, null);
});

test("a model id with no provider half fails the launch rather than being guessed at", async () => {
  await assert.rejects(
    () => launch({ model: "deepseek.v3.2" }),
    (err: PiFailure) => {
      assert.equal(err.kind, "model-unavailable");
      assert.match(err.message, /provider-qualified/);
      return true;
    },
  );
});

test("an explicit model Pi does not offer is a launch failure, not a fallback", async () => {
  // The whole reason `SdkSpec.launch` rejects rather than degrades: substituting the
  // nearest model would bill a provider nobody selected against a card that looks correct.
  await assert.rejects(
    () =>
      launch({}, (sdk) => {
        sdk.createError = new PiSdkError(
          "model-unavailable",
          "Pi does not offer the model amazon-bedrock/deepseek.v3.2",
        );
      }),
    (err: PiFailure) => {
      assert.equal(err.kind, "model-unavailable");
      assert.match(err.message, /amazon-bedrock\/deepseek\.v3\.2/);
      return true;
    },
  );
});

test("a signed-out provider names the Pi login that repairs it", async () => {
  await assert.rejects(
    () =>
      launch({}, (sdk) => {
        sdk.createError = new Error("No API key found for provider amazon-bedrock");
      }),
    (err: PiFailure) => {
      assert.equal(err.kind, "provider-signed-out");
      assert.match(err.message, /\/login amazon-bedrock/);
      return true;
    },
  );
});

// ---- effort --------------------------------------------------------------------------

test("the launch effort is handed to Pi verbatim, and null leaves its default alone", async () => {
  const high = await launch({ effort: "high" });
  assert.equal(high.sdk.created[0]!.thinkingLevel, "high");
  const none = await launch({ effort: null });
  assert.equal(none.sdk.created[0]!.thinkingLevel, null);
});

test("a live effort change is applied to the session Pi is running", async () => {
  const { sdk, handle } = await launch();
  await handle.setEffort!("xhigh");
  assert.deepEqual(sdk.runtime.session.thinkingLevels, ["xhigh"]);
});

// ---- launch, binding, and turn one -----------------------------------------------------

test("a launch binds Pi's identity and transcript before it delivers turn one", async () => {
  const { sdk, events } = await launch();
  const bound = eventOfKind(events[0], "bound");
  assert.equal(bound.agentSessionId, "pi-session-1");
  assert.match(bound.transcriptPath ?? "", /pi-session-1\.jsonl$/);
  assert.equal(bound.modelId, "amazon-bedrock/deepseek.v3.2");
  // No subprocess exists: Pi's SDK runs inside the daemon. A pid here would name a process
  // nobody could look up.
  assert.equal(bound.pid, null);
  assert.equal(bound.cleared, undefined);
  // Turn one, and the driver was already subscribed when it went.
  assert.equal(sdk.runtime.session.deliveries[0]!.text, "do the thing");
  assert.equal(sdk.runtime.session.listenerCount, 1);
});

test("a launch hands Pi's in-process shell tools Mission Control's isolated environment", async () => {
  // The one thing this driver has to do that the other two get from a spawn boundary: Pi's
  // SDK runs in the DAEMON's process, so without this the bash tool inherits the daemon's
  // own MISSION_HOME, its loopback bearer and its terminal pane identity.
  const { sdk, deps } = await launch();
  assert.deepEqual(deps.toolEnvCalls, [["/repo", "/tmp/disposable-state"]]);
  assert.equal(sdk.created[0]!.toolEnv.MISSION_HOME, "/tmp/disposable-state");
});

test("a refused turn one fails the launch and disposes the runtime it created", async () => {
  const sdk = new FakePiSdk();
  sdk.runtime.session.refusal = new Error("ExpiredToken: the security token has expired");
  await assert.rejects(
    () => piSdkSpec(fakePiSdkDeps(sdk)).launch(launchOptions()),
    (err: PiFailure) => {
      assert.equal(err.kind, "credentials-expired");
      return true;
    },
  );
  // Nothing durable exists yet, so the only thing to unwind is the runtime.
  assert.equal(sdk.runtime.disposals, 1);
});

test("standing instructions ride Pi's system-prompt append, not turn one", async () => {
  // Pi declares an out-of-band channel on this runtime, so the dispatcher leaves the block
  // OUT of `prompt` and passes it separately. A driver that ignored it would deliver the
  // operator's rules nowhere at all - the failure is silent on both ends.
  const { sdk } = await launch({ standingInstructions: "never force-push" });
  assert.deepEqual(sdk.created[0]!.appendSystemPrompt, ["never force-push"]);
  // Turn one stays the intent alone.
  assert.equal(sdk.runtime.session.deliveries[0]!.text, "do the thing");

  // And a launch with no standing instructions appends nothing rather than an empty string.
  const none = await launch({ standingInstructions: "" });
  assert.deepEqual(none.sdk.created[0]!.appendSystemPrompt, []);
});

test("a resume with no intent still delivers the standing-instruction block", async () => {
  // A resume has no turn one to compose the rules into, and coming back running under none
  // of them is the outcome an operator cannot see. Pi has no out-of-band channel on either
  // runtime, so the block rides as prose or nowhere.
  const { sdk } = await launch(
    { prompt: "", standingInstructionsPrompt: "never force-push", resume: "pi-session-1" },
    (sdk) => sdk.sessions.set("pi-session-1", "/fake/sessions/one.jsonl"),
  );
  assert.equal(sdk.runtime.session.deliveries[0]!.text, "never force-push");
});

test("a resume with neither intent nor rules sends nothing at all", async () => {
  const { sdk } = await launch({ prompt: "", resume: "pi-session-1" }, (sdk) =>
    sdk.sessions.set("pi-session-1", "/fake/sessions/one.jsonl"),
  );
  assert.deepEqual(sdk.runtime.session.deliveries, []);
});

// ---- resume --------------------------------------------------------------------------

test("a resume reopens the EXACT stored conversation", async () => {
  const { sdk } = await launch({ resume: "pi-session-1" }, (sdk) =>
    sdk.sessions.set("pi-session-1", "/fake/sessions/exact.jsonl"),
  );
  assert.equal(sdk.created[0]!.sessionPath, "/fake/sessions/exact.jsonl");
});

test("a fresh launch asks for a new durable session rather than any stored one", async () => {
  const { sdk } = await launch({ resume: null });
  assert.equal(sdk.created[0]!.sessionPath, null);
});

test("a resume whose conversation is gone fails rather than starting a look-alike", async () => {
  // The failure this refuses is silent: a fresh session under the old Mission Control id
  // leaves the note, the goal and the work episode attached to a conversation that no
  // longer exists, with a card that looks like it came back.
  await assert.rejects(
    () => launch({ resume: "pi-session-1" }),
    (err: PiFailure) => {
      assert.equal(err.kind, "resume-unavailable");
      assert.match(err.message, /no longer holds the session pi-session-1/);
      return true;
    },
  );
});

test("a session store that cannot be read is reported as itself", async () => {
  await assert.rejects(
    () =>
      launch({ resume: "pi-session-1" }, (sdk) => {
        sdk.listError = new Error("EACCES: permission denied");
      }),
    (err: PiFailure) => {
      assert.equal(err.kind, "resume-unavailable");
      assert.match(err.message, /could not read its session store/);
      return true;
    },
  );
});

// ---- project trust --------------------------------------------------------------------

test("an undecided checkout runs WITHOUT its project-local executable resources", async () => {
  // Phase 1 has no surface to ask trust on, so it must not silently grant it. Being
  // attached to Mission Control is not a trust decision.
  const { sdk } = await launch({}, (sdk) => {
    sdk.trustRequiring = true;
    sdk.trust = null;
  });
  assert.equal(sdk.created[0]!.trusted, false);
});

test("a checkout Pi has already refused stays refused", async () => {
  const { sdk } = await launch({}, (sdk) => {
    sdk.trustRequiring = true;
    sdk.trust = false;
  });
  assert.equal(sdk.created[0]!.trusted, false);
});

test("a durable trusted decision is consumed without prompting", async () => {
  const { sdk } = await launch({}, (sdk) => {
    sdk.trustRequiring = true;
    sdk.trust = true;
  });
  assert.equal(sdk.created[0]!.trusted, true);
});

test("a checkout with no trust-requiring resources needs no decision at all", async () => {
  // `trusted: true` here is not a grant - there is nothing to gate. Global Pi configuration
  // and the built-in coding tools are unaffected either way.
  const { sdk } = await launch({}, (sdk) => {
    sdk.trustRequiring = false;
    sdk.trust = null;
  });
  assert.equal(sdk.created[0]!.trusted, true);
});

// ---- capabilities this harness does not have -------------------------------------------

test("a launch carrying Mission MCP is refused rather than quietly dropped", async () => {
  const sdk = new FakePiSdk();
  await assert.rejects(
    () =>
      piSdkSpec(fakePiSdkDeps(sdk)).launch(
        launchOptions({
          mcp: {
            env: { MISSION_HOME: "/tmp/x" },
          } as unknown as import("../src/server/harness/types.ts").SdkLaunchOptions["mcp"],
        }),
      ),
    /no MCP client/,
  );
  assert.deepEqual(sdk.created, [], "nothing may be created for a launch we cannot honour");
});

test("a multi-repository launch is refused rather than starting without write access", async () => {
  const sdk = new FakePiSdk();
  await assert.rejects(
    () => piSdkSpec(fakePiSdkDeps(sdk)).launch(launchOptions({ extraDirs: ["/other-repo"] })),
    /multi-repository write grant/,
  );
  assert.deepEqual(sdk.created, []);
});

test("Pi has no permission modes, so the handle declares none rather than stubbing one", async () => {
  const { handle } = await launch();
  assert.equal(handle.setPermissionMode, null);
  assert.notEqual(handle.setEffort, null);
  assert.notEqual(handle.setModel, null);
  assert.notEqual(handle.clearContext, null);
});

test("there is no request to answer in Phase 1, and asking says so", async () => {
  const { handle } = await launch();
  await assert.rejects(() => handle.answer("req-1", { kind: "text", text: "yes" }), /no pending request/);
});

// ---- delivery ---------------------------------------------------------------------------

test("a send resolves at Pi's acceptance boundary, not when the turn ends", async () => {
  // The ack `injectPrompt` never had. If this resolved on turn completion, every dispatch
  // would block until the agent was finished and the outbox would have nothing to release.
  const { sdk, handle } = await launch({ prompt: "" });
  const session = sdk.runtime.session;
  let resolved = false;
  const sending = handle.send({ text: "hello" }).then((disposition) => {
    resolved = true;
    return disposition;
  });
  assert.equal(await sending, "started");
  assert.equal(resolved, true);
  // Pi's own promise is still open - the turn is running.
  assert.equal(session.streaming, true);
});

test("a send into a busy session steers rather than claiming a second turn", async () => {
  const { sdk, handle } = await launch();
  const session = sdk.runtime.session;
  assert.equal(session.streaming, true, "turn one is running");
  assert.equal(await handle.send({ text: "also do this" }), "steered");
  const steer = session.deliveries.at(-1)!;
  assert.equal(steer.steered, true);
  assert.equal(steer.behavior, "steer");
});

test("the steering behaviour rides EVERY send, so a turn starting mid-call cannot refuse it", async () => {
  // Pi reads `streamingBehavior` only inside its own streaming branch, so sending it
  // unconditionally is harmless when idle and closes the window where a turn begins between
  // our reading of `idle` and Pi's - which Pi answers by throwing.
  const { sdk } = await launch();
  assert.equal(sdk.runtime.session.deliveries[0]!.behavior, "steer");
});

test("sendIfIdle refuses a busy session and starts an idle one", async () => {
  const { sdk, handle } = await launch();
  const session = sdk.runtime.session;
  const before = session.deliveries.length;
  assert.equal(await handle.sendIfIdle({ text: "queued work" }), null);
  // And delivered NOTHING. This path backs Mission Control's editable outbox, which keeps
  // the row and retries on the next confirmed idle - so a driver that steered the message
  // and then said "not delivered" would have the agent read it twice.
  assert.equal(session.deliveries.length, before);
  session.finish();
  await settle();
  assert.equal(await handle.sendIfIdle({ text: "queued work" }), "started");
  assert.equal(session.deliveries.at(-1)!.text, "queued work");
  // The idle path withholds the behaviour precisely so Pi refuses rather than queues.
  assert.equal(session.deliveries.at(-1)!.behavior, undefined);
});

test("a turn starting between the idle check and Pi's own is refused, not steered", async () => {
  // The race `sendIfIdle`'s refusal exists for. The pre-check is an optimization; what makes
  // this safe is that Pi has no way to queue a message it was given no behaviour for.
  const { sdk, handle } = await launch({ prompt: "" });
  const session = sdk.runtime.session;
  session.idle = true;
  session.streaming = true;
  const before = session.deliveries.length;
  assert.equal(await handle.sendIfIdle({ text: "must not be steered" }), null);
  assert.equal(session.deliveries.length, before);
});

test("an image attachment is read and encoded before it reaches Pi", async () => {
  const png = join(home, "shot.png");
  writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const { sdk, handle } = await launch({ prompt: "" });
  await handle.send({ text: "look", images: [{ path: png, mediaType: null }] });
  assert.deepEqual(sdk.runtime.session.deliveries[0]!.images, [
    { data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"), mimeType: "image/png" },
  ]);
});

test("an attachment whose type cannot be established is refused by name", async () => {
  const blob = join(home, "mystery.bin");
  writeFileSync(blob, "not an image");
  const { handle } = await launch({ prompt: "" });
  await assert.rejects(
    () => handle.send({ text: "look", images: [{ path: blob, mediaType: null }] }),
    /cannot tell what kind of image/,
  );
});

// ---- interrupt, clear, stop --------------------------------------------------------------

test("interrupt aborts the running turn and is a no-op on an idle one", async () => {
  const { sdk, handle } = await launch();
  const session = sdk.runtime.session;
  await handle.interrupt();
  assert.equal(session.aborts, 1);
  session.finish();
  await settle();
  // Interrupting a session that just finished must not error - being a moment late is not
  // a failure, and the pane path's Escape is a no-op on an idle composer too.
  await handle.interrupt();
  assert.equal(session.aborts, 1);
});

test("clearing context rebinds to the replacement conversation and says it was a clear", async () => {
  const { sdk, handle, events } = await launch();
  const first = sdk.runtime.session;
  await handle.clearContext!();
  await settle();
  const rebind = eventOfKind(events.filter((event) => event.kind === "bound").at(-1), "bound");
  assert.equal(rebind.agentSessionId, "replacement-1");
  assert.equal(rebind.cleared, true);
  // The old conversation's listener is gone, so a late event from it reaches nobody, and
  // the replacement has exactly one.
  assert.equal(first.listenerCount, 0);
  assert.equal(sdk.runtime.session.listenerCount, 1);
});

test("a clear that arrives MID-TURN aborts the old run and does not settle the new one", async () => {
  // The gap this closes: `clearContext` replaces the conversation while a turn may still be
  // in flight, and `deliver`'s continuation reads instance state - `this.settled`,
  // `completeTurn`, `note` - that the rebind has already moved onto the replacement. If the
  // OLD turn's completion were observed after that swap, its turn_done and its idle would be
  // published against a conversation that never ran it.
  const { sdk, handle, events } = await launch();
  const first = sdk.runtime.session;

  await handle.send({ text: "a turn that will not finish before the clear" });
  await settle();
  assert.equal(first.streaming, true, "the old conversation is mid-turn");

  await handle.clearContext!();
  await settle();

  assert.equal(first.aborts, 1, "Pi aborts the running turn as part of the replacement");
  assert.equal(first.streaming, false);
  const replacement = sdk.runtime.session;
  assert.notEqual(replacement, first);

  // Now let the abandoned turn's prompt settle LATE, which is the race itself.
  const turnDoneBefore = events.filter((event) => event.kind === "turn_done").length;
  first.finish();
  await settle();

  assert.equal(
    events.filter((event) => event.kind === "turn_done").length,
    turnDoneBefore,
    "the abandoned turn must not retire a reservation against the replacement",
  );
  // And the replacement is still the live conversation, still subscribed, still idle.
  assert.equal(sdk.runtime.session, replacement);
  assert.equal(replacement.listenerCount, 1);
  assert.equal(first.listenerCount, 0);
});

test("events from the replacement conversation reach the stream", async () => {
  const { sdk, handle, events } = await launch();
  await handle.clearContext!();
  await settle();
  const before = events.length;
  sdk.runtime.session.emit({ type: "agent_start" }, { type: "agent_settled" });
  await settle();
  assert.ok(events.length > before, "the driver re-subscribed to the replacement");
  assert.equal(events.at(-1)!.kind, "state");
});

test("a refused clear leaves the session usable rather than half-replaced", async () => {
  const { sdk, handle } = await launch();
  sdk.runtime.newSessionError = new Error("AccessDeniedException: not authorized");
  await assert.rejects(() => handle.clearContext!(), (err: PiFailure) => {
    assert.equal(err.kind, "access-denied");
    return true;
  });
  sdk.runtime.newSessionError = null;
  await handle.clearContext!();
  await settle();
  assert.equal(sdk.runtime.newSessions, 1);
});

test("stop aborts before disposing, reports an exit, and ends the stream", async () => {
  const { sdk, handle, events, done } = await launch();
  await handle.stop();
  await done;
  const session = sdk.runtime.session;
  // Aborted BEFORE disposal: `dispose` does not stop a running turn, so a session that was
  // streaming would go on spending against a conversation nobody is looking at.
  assert.equal(session.aborts, 1);
  assert.equal(sdk.runtime.disposals, 1);
  const exited = eventOfKind(events.at(-1), "exited");
  assert.equal(exited.resumable, true);
});

test("every control refuses after the driver has stopped", async () => {
  const { handle } = await launch();
  await handle.stop();
  await assert.rejects(() => handle.send({ text: "too late" }), /driver has stopped/);
  await assert.rejects(() => handle.sendIfIdle({ text: "too late" }), /driver has stopped/);
  await assert.rejects(() => handle.setEffort!("low"), /driver has stopped/);
  await assert.rejects(() => handle.setModel!("anthropic/claude-sonnet-5"), /driver has stopped/);
  await assert.rejects(() => handle.clearContext!(), /driver has stopped/);
  // Stopping twice is not a second stop.
  await handle.stop();
});

test("a live model change reaches Pi's session and updates what the card reports", async () => {
  const { sdk, handle, events } = await launch();
  await handle.setModel!("amazon-bedrock/anthropic.claude-3-5-sonnet");
  assert.deepEqual(sdk.runtime.session.modelChanges, [
    { provider: "amazon-bedrock", id: "anthropic.claude-3-5-sonnet" },
  ]);
  // And a model id Pi cannot even parse is refused before it reaches the session.
  await assert.rejects(() => handle.setModel!("bare-id"), /is not a Pi model id/);
  assert.equal(sdk.runtime.session.modelChanges.length, 1);
  assert.ok(events.length > 0);
});

// ---- pure helpers ---------------------------------------------------------------------

test("usage is reported flat, and deliberately carries no ledger identity", () => {
  const usage = usageFrom({
    modelId: "amazon-bedrock/deepseek.v3.2",
    stopReason: "stop",
    errorMessage: null,
    usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, reasoning: 3, costUsd: 0.02 },
  });
  assert.deepEqual(usage, {
    input: 10,
    output: 4,
    cacheRead: 2,
    cacheWrite: 1,
    reasoningOutput: 3,
    modelId: "amazon-bedrock/deepseek.v3.2",
    costUsd: 0.02,
  });
  // `turnId` and `models` travel together or not at all, and Pi mints no turn identity that
  // survives a restart - a resumed conversation would re-record turns already paid for.
  assert.equal("turnId" in usage!, false);
  assert.equal("models" in usage!, false);
  assert.equal(usageFrom(null), null);
  assert.equal(
    usageFrom({ modelId: null, stopReason: "stop", errorMessage: null, usage: null }),
    null,
  );
});

test("a tool's activity line is bounded and collapses its whitespace", () => {
  assert.equal(toolActivity("read", null), "read");
  assert.equal(toolActivity("bash", "git   status\n"), "bash: git status");
  const long = toolActivity("bash", "x".repeat(500));
  assert.ok(long.length < 120, long);
  assert.ok(long.endsWith("…"));
});

test("a session that never binds a file still reports an honest transcript path", async () => {
  const sdk = new FakePiSdk(new FakePiSession("in-memory", { sessionFile: null }));
  const handle = await piSdkSpec(fakePiSdkDeps(sdk)).launch(launchOptions());
  const { events } = collect(handle);
  await settle();
  assert.equal(eventOfKind(events[0], "bound").transcriptPath, null);
});

// `createRuntime` against a stand-in vendor.
//
// Everything above drives `piSdkSpec`, which is the right level for behaviour an operator
// can see. The ordering below is not visible from there: it only shows up when a SECOND
// factory invocation - the one a clear performs, while the previous session is still live
// and still answering - fails partway. The real vendor cannot be steered into that, because
// the model lookup that fails on the second invocation would already have failed on the
// first.
const { createRuntime } = await import("../src/server/harness/pi/sdk-deps.ts");

/** A `ModelRuntime` stand-in offering exactly the ids it was built with, and no others. */
function modelRuntime(name: string, offered: string[]) {
  return {
    name,
    getModel: (provider: string, id: string) =>
      offered.includes(id) ? { provider, id, name } : undefined,
    hasConfiguredAuth: () => true,
    checkAuth: async () => ({}),
  };
}

/**
 * A vendor stand-in whose services differ per factory invocation, so which one the runtime
 * ended up holding is observable. `newSession` re-enters the factory exactly as Pi's does.
 */
function standInVendor(runtimes: Array<ReturnType<typeof modelRuntime>>) {
  let call = 0;
  let factory: (target: unknown) => Promise<unknown>;
  const target = {
    cwd: "/tmp/stand-in",
    agentDir: "/tmp/stand-in/agent",
    sessionManager: {},
  };
  const vendor = {
    getAgentDir: () => target.agentDir,
    createAgentSessionServices: async () => ({
      cwd: target.cwd,
      agentDir: target.agentDir,
      modelRuntime: runtimes[Math.min(call++, runtimes.length - 1)],
      settingsManager: {},
      resourceLoader: {},
      diagnostics: [],
    }),
    createAgentSessionFromServices: async () => ({ session: {}, events: [] }),
    createBashToolDefinition: () => ({ name: "bash" }),
    SessionManager: { open: () => ({}), create: () => ({}) },
    createAgentSessionRuntime: async (f: (t: unknown) => Promise<unknown>) => {
      factory = f;
      await factory(target);
      return {
        session: { on: () => {}, off: () => {}, setModel: async () => {} },
        setRebindSession: () => {},
        newSession: async () => {
          await factory(target);
          return { cancelled: false };
        },
        dispose: async () => {},
      };
    },
  };
  return vendor as unknown as typeof import("@earendil-works/pi-coding-agent");
}

function runtimeOptions() {
  return {
    cwd: "/tmp/stand-in",
    sessionPath: null,
    model: { provider: "amazon-bedrock", id: "deepseek.v3.2" },
    thinkingLevel: null,
    trusted: false,
    appendSystemPrompt: [],
    toolEnv: {},
  };
}

test("a clear that fails partway leaves the live session resolving against its OWN services", async () => {
  // First invocation offers the model, second does not: the credential lapsed or the model
  // was withdrawn between turns, which is the case the vendor itself surfaces as a throw.
  const live = modelRuntime("live", ["deepseek.v3.2"]);
  const runtime = await createRuntime(
    standInVendor([live, modelRuntime("half-built", [])]),
    runtimeOptions(),
  );

  await assert.rejects(
    () => runtime.newSession(),
    (err: unknown) => (err as PiFailure).kind === "model-unavailable",
  );

  // The old session is still the live one, so the model runtime it reaches has to be the
  // one it is actually running on - not the services the failed clear half-built.
  await assert.rejects(
    () => runtime.session.setModel({ provider: "amazon-bedrock", id: "nope" }),
    (err: unknown) => /amazon-bedrock\/nope/.test((err as PiFailure).message),
  );
  await runtime.session.setModel({ provider: "amazon-bedrock", id: "deepseek.v3.2" });
});

test("a clear that succeeds does move the live session onto the replacement services", async () => {
  const runtime = await createRuntime(
    standInVendor([modelRuntime("first", []), modelRuntime("second", ["deepseek.v3.2"])]),
    { ...runtimeOptions(), model: null },
  );
  await runtime.newSession();
  // `second` offers the model and `first` does not, so this resolving at all is the proof.
  await runtime.session.setModel({ provider: "amazon-bedrock", id: "deepseek.v3.2" });
});
