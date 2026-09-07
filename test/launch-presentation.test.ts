import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent, Session, TranscriptMessage } from "../src/shared/types.ts";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";
import { mkOriginAndClone } from "./helpers/git-fixture.ts";

// Hiding launch instructions from conversations
// (docs/plans/hidden-launch-instructions/phase-1-durable-launch-presentation.md): a fresh
// Mission Control-managed conversation shows the human task request as its first user turn,
// while the complete composed prompt stays in the native transcript and in every
// server-side evidence read.
//
// What is at stake in nearly every case below is one bug class, and it is worse than the
// one the feature fixes: a projection that fires on the wrong turn DELETES a real human
// message from the log. So the tests that matter most here are the ones asserting that
// nothing happens - a resumed conversation, a manually discovered session, a task assigned
// into a live session, a `/clear`, and every historical transcript written before the
// marker table existed all keep their first user turn exactly as they have it today.

const home = mkdtempSync(join(tmpdir(), "mission-launch-presentation-"));
process.env.MISSION_HOME = home;
process.env.HERDR_BIN = join(home, "missing-herdr");
// Binaries that exist, so bin resolution can never be what fails a launch here. The
// terminal home itself is faked through the dispatcher's `spawn` seam - a test that reached
// the real backend would open tmux sessions on the machine running the suite.
process.env.MISSION_CLAUDE_BIN = "/bin/echo";
process.env.MISSION_PI_BIN = "/bin/echo";

const { openDb } = await import("../src/server/db.ts");
const {
  upsertSessionLaunchTurn,
  getSessionLaunchTurn,
  deleteSessionLaunchTurn,
  loadSessionLaunchTurns,
  moveSessionLaunchTurn,
  pruneSessionLaunchTurns,
} = await import("../src/server/db.ts");
const { launchTextFingerprint, launchEchoFingerprint, launchPresentationFor } = await import(
  "../src/server/launch-presentation.ts"
);
const { attributeTranscript } = await import("../src/server/transcript-attribution.ts");
const { Registry } = await import("../src/server/registry.ts");
const { Dispatcher } = await import("../src/server/dispatcher.ts");
const { withTaskKindContract } = await import("../src/server/task-contract.ts");
const { withMemoryPointer } = await import("../src/shared/memory.ts");
const { mkTask } = await import("./helpers/session-fixture.ts");
const { TaskManager } = await import("../src/server/tasks.ts");
const { SdkSupervisor } = await import("../src/server/sdk/supervisor.ts");
const { HARNESSES } = await import("../src/server/harness/index.ts");
const { projectLaunchPresentation } = await import("../src/web/lib/launch-presentation.ts");
const { yourMessages } = await import("../src/web/lib/conversation-yours.ts");
const { collectHits } = await import("../src/web/lib/find.ts");

/** Whole checkouts built by the git fixture, removed together. */
const assignRoots: string[] = [];

after(() => {
  rmSync(home, { recursive: true, force: true });
  for (const root of assignRoots) rmSync(root, { recursive: true, force: true });
  delete process.env.MISSION_CLAUDE_BIN;
  delete process.env.MISSION_PI_BIN;
  delete process.env.HERDR_BIN;
});

openDb();

let seq = 0;
function key(name: string): string {
  return `${name}-${++seq}`;
}

/** The shape a real ship dispatch composes: the operator's ask, then the platform's. */
const HUMAN = "tidy the flexbox helper";
const COMPOSED = `${HUMAN}\n\n## Mission Control execution authorization\nAct directly.`;

function mkMessage(over: Partial<TranscriptMessage> = {}): TranscriptMessage {
  return { id: `m-${++seq}`, role: "user", text: COMPOSED, tools: [], ts: 1_000, ...over };
}

function mkMarker(
  noteKey: string,
  over: Partial<{ prompt: string; displayText: string | null; messageId: string | null }> = {},
) {
  return {
    noteKey,
    fingerprint: launchTextFingerprint(over.prompt ?? COMPOSED),
    echoFingerprint: launchEchoFingerprint(over.prompt ?? COMPOSED),
    displayText: over.displayText === undefined ? HUMAN : over.displayText,
    messageId: over.messageId === undefined ? null : over.messageId,
    createdAt: 100,
    updatedAt: 100,
  };
}

type SdkHandle = import("../src/server/harness/types.ts").SdkSessionHandle;
type SdkEvent = import("../src/server/harness/types.ts").SdkEvent;
type SdkLaunchOptions = import("../src/server/harness/types.ts").SdkLaunchOptions;

/**
 * A driver that never emits, which is exactly what this file needs: every question here is
 * about what is true at the instant the supervisor takes ownership, before a single frame.
 */
function fakeHandle(): SdkHandle & { launchedWith: SdkLaunchOptions | null; end: () => void } {
  let ended = false;
  let waiting: (() => void) | null = null;
  const handle = {
    launchedWith: null as SdkLaunchOptions | null,
    end: (): void => {
      ended = true;
      const w = waiting;
      waiting = null;
      w?.();
    },
    events: {
      // Written as a hand-rolled iterator rather than a generator on purpose: this driver
      // never yields, and a `function*` that cannot reach a `yield` is a lint warning
      // describing exactly the property the fixture wants.
      [Symbol.asyncIterator](): AsyncIterator<SdkEvent> {
        return {
          async next(): Promise<IteratorResult<SdkEvent>> {
            if (!ended) await new Promise<void>((r) => (waiting = r));
            return { value: undefined as never, done: true };
          },
        };
      },
    },
    async send() {
      return "started" as const;
    },
    async sendIfIdle() {
      return "started" as const;
    },
    async interrupt() {},
    async answer() {},
    setPermissionMode: null,
    setEffort: null,
    setModel: null,
    clearContext: null,
    async stop() {
      handle.end();
    },
  };
  return handle as unknown as SdkHandle & {
    launchedWith: SdkLaunchOptions | null;
    end: () => void;
  };
}

/** Point Claude's harness slot at a scripted driver for the duration of one test. */
function withFakeClaudeDriver(
  launch: (opts: SdkLaunchOptions) => Promise<SdkHandle>,
): () => void {
  const real = HARNESSES.claude.sdk;
  HARNESSES.claude.sdk = {
    launch: async (opts) => {
      const handle = await launch(opts);
      (handle as { launchedWith?: SdkLaunchOptions }).launchedWith = opts;
      return handle;
    },
  };
  return () => {
    HARNESSES.claude.sdk = real;
  };
}

function mkDiscovered(over: Partial<DiscoveredSession> = {}): DiscoveredSession {
  const n = ++seq;
  return {
    syntheticId: `proc:ttys00${n}:${n}:0`,
    agent: "claude",
    name: "work",
    nameSource: "process",
    cwd: `/wt/task-${n}`,
    gitBranch: "harness/task",
    pid: n,
    tty: `ttys00${n}`,
    // A distinct mux identity per fixture: these tests share one database, and
    // `taskResourceOwnerForSession` matches a task to a session through its home name and
    // pane resource - so a reused identity would make one test's held worktree look like
    // the next test's session's.
    terminals: [mkMuxHandle({ session: `s${n}`, windowName: "w", windowIndex: 0, paneId: `%${n}` })],
    startedAt: 0,
    ...over,
  } as DiscoveredSession;
}

/** The logical conversation key a session currently holds - what markers are stored under. */
function noteKeyOf(registry: InstanceType<typeof Registry>, sessionId: string): string {
  const s = registry.getSession(sessionId);
  assert.ok(s, "the session should exist");
  return s.agentSessionId ?? s.id;
}

function discover(
  registry: InstanceType<typeof Registry>,
  over: Partial<DiscoveredSession> = {},
): Session {
  const d = mkDiscovered(over);
  registry.applyDiscovery([d]);
  const s = registry.getSession(d.syntheticId);
  assert.ok(s, "discovery should register the session");
  return s;
}

// ---- fingerprint ----

test("the fingerprint is trim-insensitive and nothing else", () => {
  assert.equal(launchTextFingerprint(COMPOSED), launchTextFingerprint(`\n  ${COMPOSED}\t\n`));
  // Trimming is what the harness transcript adapters already do to user text. Anything
  // beyond it would let a turn we merely RESEMBLE match, and matching the wrong turn is how
  // a real human message would disappear from the log.
  assert.notEqual(launchTextFingerprint(COMPOSED), launchTextFingerprint(HUMAN));
  assert.notEqual(
    launchTextFingerprint(COMPOSED),
    launchTextFingerprint(COMPOSED.replace("Act directly.", "act directly.")),
  );
  assert.notEqual(
    launchTextFingerprint(COMPOSED),
    launchTextFingerprint(COMPOSED.replace("\n\n", "\n")),
  );
});

// ---- persistence ----

test("marker rows round-trip, replace, and delete", () => {
  const k = key("roundtrip");
  assert.equal(getSessionLaunchTurn(k), undefined);
  const marker = mkMarker(k);
  upsertSessionLaunchTurn(marker);
  assert.deepEqual(getSessionLaunchTurn(k), marker);
  assert.ok(loadSessionLaunchTurns().some((r) => r.noteKey === k));

  // A second dispatch into the same key IS the later launch. `created_at` survives the
  // replacement so a rewrite cannot reset the prune window.
  upsertSessionLaunchTurn({ ...marker, fingerprint: "beef", displayText: "later", updatedAt: 900 });
  assert.deepEqual(getSessionLaunchTurn(k), {
    noteKey: k,
    fingerprint: "beef",
    echoFingerprint: marker.echoFingerprint,
    displayText: "later",
    messageId: null,
    createdAt: 100,
    updatedAt: 900,
  });

  // The occurrence anchor round-trips, and a replacement can clear it: a later launch under
  // this key describes a different conversation, whose turn has its own id.
  upsertSessionLaunchTurn({ ...marker, messageId: "native-uuid", updatedAt: 950 });
  assert.equal(getSessionLaunchTurn(k)?.messageId, "native-uuid");
  upsertSessionLaunchTurn({ ...marker, messageId: null, updatedAt: 960 });
  assert.equal(getSessionLaunchTurn(k)?.messageId, null);

  deleteSessionLaunchTurn(k);
  assert.equal(getSessionLaunchTurn(k), undefined);
});

test("a null display projection is stored as null, not as an empty string", () => {
  // The two are different instructions: null OMITS the turn, "" would render a blank
  // bubble attributed to the operator.
  const k = key("null-display");
  upsertSessionLaunchTurn(mkMarker(k, { displayText: null }));
  assert.equal(getSessionLaunchTurn(k)?.displayText, null);
  deleteSessionLaunchTurn(k);
});

test("moveSessionLaunchTurn carries the row, and the moved row wins a conflict", () => {
  const from = key("move-from");
  const to = key("move-to");
  upsertSessionLaunchTurn(mkMarker(from));
  moveSessionLaunchTurn(from, to);
  assert.equal(getSessionLaunchTurn(from), undefined);
  assert.equal(getSessionLaunchTurn(to)?.displayText, HUMAN);

  // Nothing at the source: a no-op that must not disturb the target.
  moveSessionLaunchTurn(key("move-empty"), to);
  assert.equal(getSessionLaunchTurn(to)?.displayText, HUMAN);

  const from2 = key("move-from2");
  upsertSessionLaunchTurn({ ...mkMarker(from2), displayText: "followed the conversation" });
  moveSessionLaunchTurn(from2, to);
  assert.equal(getSessionLaunchTurn(to)?.displayText, "followed the conversation");
  deleteSessionLaunchTurn(to);
});

test("pruneSessionLaunchTurns keeps live keys, and an empty live set deletes nothing", () => {
  const live = key("prune-live");
  const dead = key("prune-dead");
  upsertSessionLaunchTurn({ ...mkMarker(live), updatedAt: 10 });
  upsertSessionLaunchTurn({ ...mkMarker(dead), updatedAt: 10 });
  // "Liveness unknown" is not "nothing is live" - pruneSessionGoals' safety property,
  // inherited whole. Read as a fact it would become `WHERE updated_at < ?`.
  assert.equal(pruneSessionLaunchTurns([], 1_000), 0);
  assert.ok(getSessionLaunchTurn(dead));
  assert.ok(pruneSessionLaunchTurns([live], 1_000) >= 1);
  assert.ok(getSessionLaunchTurn(live), "a live key is never touched, whatever its age");
  assert.equal(getSessionLaunchTurn(dead), undefined);
  deleteSessionLaunchTurn(live);
});

// ---- registry lifecycle ----

test("recordLaunchTurn stores under the session's logical key and survives a restart", () => {
  const before = new Registry();
  const d = mkDiscovered();
  before.applyDiscovery([d]);
  const marker = before.recordLaunchTurn(d.syntheticId, COMPOSED, HUMAN);
  assert.equal(marker?.noteKey, d.syntheticId);
  assert.equal(marker?.fingerprint, launchTextFingerprint(COMPOSED));
  assert.equal(marker?.displayText, HUMAN);

  const afterRestart = new Registry();
  afterRestart.applyDiscovery([d]);
  assert.equal(afterRestart.launchTurnFor(d.syntheticId)?.displayText, HUMAN);
});

test("an empty prompt is a resume, not a launch, and records nothing", () => {
  const registry = new Registry();
  const s = discover(registry);
  assert.equal(registry.recordLaunchTurn(s.id, "   \n ", HUMAN), null);
  assert.equal(registry.launchTurnFor(s.id), null);
  assert.equal(registry.recordLaunchTurn("no-such-session", COMPOSED, HUMAN), null);
});

test("a blank display projection narrows to null rather than to an empty bubble", () => {
  const registry = new Registry();
  const s = discover(registry);
  assert.equal(registry.recordLaunchTurn(s.id, COMPOSED, "   ")?.displayText, null);
});

test("discardLaunchTurn rolls back a marker whose delivery failed - and only that one", () => {
  const registry = new Registry();
  const s = discover(registry);
  const marker = registry.recordLaunchTurn(s.id, COMPOSED, HUMAN);
  registry.discardLaunchTurn(marker);
  assert.equal(registry.launchTurnFor(s.id), null);
  assert.equal(getSessionLaunchTurn(s.id), undefined);
  registry.discardLaunchTurn(null); // a no-op, not a throw

  // A later dispatch into the same key owns the row now. A failed EARLIER launch rolling
  // back must not delete the marker that succeeded.
  const stale = registry.recordLaunchTurn(s.id, COMPOSED, "first ask");
  const current = registry.recordLaunchTurn(s.id, `${COMPOSED} again`, "second ask", 5_000);
  registry.discardLaunchTurn(stale);
  assert.equal(registry.launchTurnFor(s.id)?.displayText, "second ask");
  assert.equal(current?.displayText, "second ask");
});

test("a marker follows the FIRST bind of a native conversation id", () => {
  const registry = new Registry();
  const d = mkDiscovered();
  registry.applyDiscovery([d]);
  // The dispatcher's write: hooks have not fired, so it lands under the synthetic id.
  registry.recordLaunchTurn(d.syntheticId, COMPOSED, HUMAN);

  const native = `agent-launch-${seq}`;
  registry.applyHook({
    agent: "claude",
    event: "SessionStart",
    sessionId: native,
    cwd: d.cwd,
    transcriptPath: null,
    env: { tmuxPane: (d.terminals[0] as { paneId: string }).paneId },
  });

  assert.equal(registry.getSession(d.syntheticId)?.agentSessionId, native);
  assert.equal(registry.launchTurnFor(d.syntheticId)?.displayText, HUMAN);
  assert.equal(getSessionLaunchTurn(d.syntheticId), undefined, "nothing strands under the old key");
  assert.equal(getSessionLaunchTurn(native)?.displayText, HUMAN);
});

test("a Pi-shaped launch rebind carries the marker (bindLaunchedAgentSession)", () => {
  // Pi's turn one travelled in the launch argv, so its marker is written under the
  // synthetic key and this rebind is the first bind the guard allows.
  const registry = new Registry();
  const d = mkDiscovered({ agent: "pi" });
  registry.applyDiscovery([d]);
  registry.recordLaunchTurn(d.syntheticId, COMPOSED, HUMAN);

  const piId = "019f7d35-beb8-7ae4-8b33-049e4f65cacd";
  const bound = registry.bindLaunchedAgentSession(d.syntheticId, "pi", piId);
  assert.equal(bound?.agentSessionId, piId);
  assert.equal(getSessionLaunchTurn(piId)?.displayText, HUMAN);
  assert.equal(getSessionLaunchTurn(d.syntheticId), undefined);
});

test("a marker does NOT cross a native-to-native rotation - the /clear case", () => {
  // The whole reason `moveLaunchTurnOnInitialBind` is not `moveForemanInviteKey`. A clear
  // starts a new logical conversation whose first turn is whatever is said next; carrying
  // the marker into it would let the projection swallow a real human message.
  const registry = new Registry();
  const d = mkDiscovered();
  registry.applyDiscovery([d]);
  const first = `agent-before-clear-${seq}`;
  registry.applyHook({
    agent: "claude",
    event: "SessionStart",
    sessionId: first,
    cwd: d.cwd,
    transcriptPath: null,
    env: { tmuxPane: (d.terminals[0] as { paneId: string }).paneId },
  });
  registry.recordLaunchTurn(d.syntheticId, COMPOSED, HUMAN);
  assert.equal(getSessionLaunchTurn(first)?.displayText, HUMAN, "recorded under the native key");

  const replacement = `agent-after-clear-${seq}`;
  registry.applyHook({
    agent: "claude",
    event: "SessionStart",
    sessionId: replacement,
    cwd: d.cwd,
    transcriptPath: null,
    env: { tmuxPane: (d.terminals[0] as { paneId: string }).paneId },
  });

  assert.equal(registry.getSession(d.syntheticId)?.agentSessionId, replacement);
  assert.equal(
    registry.launchTurnFor(d.syntheticId),
    null,
    "the replacement conversation inherits no launch marker",
  );
  assert.equal(getSessionLaunchTurn(replacement), undefined);
  assert.equal(getSessionLaunchTurn(first)?.displayText, HUMAN, "the old row is stranded, not moved");
});

test("registry prune drops orphaned markers and never a live session's", () => {
  const registry = new Registry();
  const d = mkDiscovered();
  registry.applyDiscovery([d]); // first sweep: liveness is now known
  registry.recordLaunchTurn(d.syntheticId, COMPOSED, HUMAN);
  const orphan = key("registry-orphan");
  upsertSessionLaunchTurn({ ...mkMarker(orphan), updatedAt: 10 });

  assert.equal(
    new Registry().pruneLaunchTurns(Date.now() + 60_000),
    0,
    "an unswept registry refuses to prune - liveness unknown",
  );

  assert.ok(registry.pruneLaunchTurns(Date.now() + 60_000) >= 1, "the orphan went");
  assert.equal(getSessionLaunchTurn(orphan), undefined);
  assert.ok(
    getSessionLaunchTurn(d.syntheticId),
    "the live session's marker stayed, despite its age",
  );
});

test("the marker is not denormalized onto the session snapshot", () => {
  // It is a per-message transcript decoration, not a card field. Shipping it on `Session`
  // would put a fingerprint of the operator's prompt on every sweep, to every browser.
  const registry = new Registry();
  const s = discover(registry);
  const seen: Session[] = [];
  registry.on("event", (e: ServerEvent) => {
    if (e.type === "session_upsert" && e.session.id === s.id) seen.push(e.session);
  });
  registry.recordLaunchTurn(s.id, COMPOSED, HUMAN);
  for (const snapshot of [s, ...seen]) {
    assert.ok(!JSON.stringify(snapshot).includes(launchTextFingerprint(COMPOSED)));
  }
});

// ---- normalization overlay ----

test("attribution marks the matching launch turn and preserves every native field", () => {
  const launch = mkMessage({ id: "native-uuid", ts: 42, tools: [{ name: "Bash" }] });
  const [marked] = attributeTranscript("s1", [launch], mkMarker("s1"));
  assert.deepEqual(marked, { ...launch, presentation: { kind: "launch", displayText: HUMAN } });
  // The native text is untouched on the wire. Every server-side evidence consumer reads
  // this same object.
  assert.equal(marked?.text, COMPOSED);
});

test("attribution leaves everything that is not that turn alone", () => {
  const marker = mkMarker("s1");
  const cases: Array<[string, TranscriptMessage]> = [
    ["an assistant turn quoting the whole prompt", mkMessage({ role: "assistant" })],
    ["a human follow-up", mkMessage({ text: `${HUMAN} in the other file too` })],
    ["a turn whose text merely starts with the request", mkMessage({ text: HUMAN })],
    ["a tool-only turn", mkMessage({ text: "", tools: [{ name: "Bash" }] })],
  ];
  for (const [what, message] of cases) {
    const [out] = attributeTranscript("s1", [message], marker);
    assert.equal(out?.presentation, undefined, what);
    assert.deepEqual(out, message, what);
  }
  // And with no marker at all - every historical transcript, every manual session.
  const [plain] = attributeTranscript("s1", [mkMessage()]);
  assert.equal(plain?.presentation, undefined);
});

test("attribution says nothing about presentation when it says nothing at all", () => {
  // No session id is the "not a real read" case the origin overlay already refuses, and
  // the array is returned by identity so nothing downstream re-renders on it.
  const messages = [mkMessage()];
  assert.equal(attributeTranscript(undefined, messages, mkMarker("s1")), messages);
});

test("origin and presentation are independent fields on one turn", () => {
  // Authorship and visibility are different questions. A launch turn is the operator's, so
  // it carries no origin; a Foreman turn is not a launch, so it carries no presentation.
  // The overlay must be able to express either without the other.
  const marker = mkMarker("s1");
  const [launch] = attributeTranscript("s1", [mkMessage()], marker);
  assert.equal(launch?.origin, undefined);
  assert.equal(launch?.presentation?.kind, "launch");
  assert.ok(!("origin" in (launch?.presentation ?? {})));
});

test("launchPresentationFor refuses a turn under no marker, and an assistant turn", () => {
  assert.equal(launchPresentationFor(mkMessage(), null), null);
  assert.equal(launchPresentationFor(mkMessage({ role: "assistant" }), mkMarker("s1")), null);
  assert.equal(launchPresentationFor(mkMessage({ text: "" }), mkMarker("s1")), null);
  assert.deepEqual(launchPresentationFor(mkMessage(), mkMarker("s1")), {
    kind: "launch",
    displayText: HUMAN,
  });
});

// ---- browser projection ----

test("the projection replaces the launch text and keeps the turn's identity", () => {
  const launch = mkMessage({ id: "native-uuid", ts: 42, tools: [{ name: "Read" }] });
  const reply = mkMessage({ role: "assistant", text: "done" });
  const marked = attributeTranscript("s1", [launch, reply], mkMarker("s1"));

  const visible = projectLaunchPresentation(marked);
  assert.equal(visible.length, 2);
  assert.equal(visible[0]?.text, HUMAN);
  // Id, role, timestamp and tools are the native record's, so a find hit and a Yours row
  // still jump to the turn the log actually rendered.
  assert.equal(visible[0]?.id, "native-uuid");
  assert.equal(visible[0]?.ts, 42);
  assert.deepEqual(visible[0]?.tools, [{ name: "Read" }]);
  assert.equal(visible[1], reply, "an unmarked turn is returned by identity");
});

test("a null display projection omits the turn rather than inventing prose", () => {
  const marked = attributeTranscript("s1", [mkMessage()], mkMarker("s1", { displayText: null }));
  assert.deepEqual(projectLaunchPresentation(marked), []);
});

test("the projection is a no-op for messages carrying no presentation", () => {
  const messages = [mkMessage(), mkMessage({ role: "assistant", text: "hi" })];
  assert.deepEqual(projectLaunchPresentation(messages), messages);
});

test("the hidden text is unreachable through find, and the human request is not", () => {
  const marked = attributeTranscript(
    "s1",
    [mkMessage({ id: "launch" }), mkMessage({ id: "reply", role: "assistant", text: "on it" })],
    mkMarker("s1"),
  );
  const visible = projectLaunchPresentation(marked);
  const rows = visible.map((message) => ({
    kind: "turn" as const,
    id: message.id,
    ts: message.ts,
    message,
  }));

  const hidden = collectHits(rows, "Mission Control execution authorization", { caseSensitive: false }, "claude");
  assert.deepEqual(hidden, [], "a hidden turn that is still searchable is the half-fix");
  const found = collectHits(rows, "tidy the flexbox", { caseSensitive: false }, "claude");
  assert.equal(found.length, 1, "and find is looking at a real list");
  assert.equal(found[0]?.rowId, "launch", "the hit still addresses the native turn");
  assert.equal(found[0]?.scope, "user", "and is attributed to the operator, not the platform");
});

test("the Yours rail indexes the human request, not the platform contract", () => {
  const marked = attributeTranscript("s1", [mkMessage({ id: "launch" })], mkMarker("s1"));
  const { yours, injected } = yourMessages(projectLaunchPresentation(marked));
  assert.deepEqual(injected, [], "a launch is the operator's own request, not typed for them");
  assert.equal(yours.length, 1);
  assert.equal(yours[0]?.text, HUMAN);
  assert.equal(yours[0]?.id, "launch", "so a click still jumps to the rendered turn");
});

// ---- launch seams ----

test("the SDK marker is durable BEFORE the session can stream", async () => {
  // The ordering that makes the whole feature work on this runtime. `SdkSupervisor.start`
  // accepts turn one before the session is registered and before its event pump begins, so
  // a marker written after either of those races its own transcript: the first `init` frame
  // can already carry turn one, and the conversation would open showing the launch contract.
  //
  // Proven by asking the registry at the instant registration happens, which is the earliest
  // moment anything could read the session at all.
  const registry = new Registry();
  const supervisor = new SdkSupervisor(registry);
  const observedAtRegistration: Array<string | null | undefined> = [];
  const realRegister = registry.registerSdkSession.bind(registry);
  registry.registerSdkSession = ((input: Parameters<typeof realRegister>[0]) => {
    observedAtRegistration.push(getSessionLaunchTurn(input.id)?.displayText);
    return realRegister(input);
  }) as typeof registry.registerSdkSession;

  const handle = fakeHandle();
  const restore = withFakeClaudeDriver(async () => handle);
  try {
    const session = await supervisor.start({
      agent: "claude",
      name: "Add a toggle",
      cwd: "/wt/one",
      prompt: COMPOSED,
      acceptedGoalPrompt: HUMAN,
      launchPresentation: { prompt: COMPOSED, displayText: HUMAN },
      model: null,
      effort: null,
      permissionMode: null,
      mcp: null,
      taskId: "task-launch",
    });
    assert.deepEqual(observedAtRegistration, [HUMAN], "the row was already there");
    // Under the PROVISIONAL key, which for a fresh SDK session is its own id.
    assert.equal(registry.launchTurnFor(session.id)?.fingerprint, launchTextFingerprint(COMPOSED));
    // And the driver still received the complete composed prompt.
    assert.equal(handle.launchedWith?.prompt, COMPOSED);

    // A daemon restart reloads the row rather than replaying turn one.
    assert.equal(new Registry().launchTurnFor(session.id), null, "no session yet");
    const restarted = new Registry();
    restarted.registerSdkSession({ id: session.id, agent: "claude", name: "n", cwd: "/wt/one" });
    assert.equal(restarted.launchTurnFor(session.id)?.displayText, HUMAN);
  } finally {
    restore();
    handle.end();
  }
});

test("a direct supervisor caller that supplies no presentation is unchanged", async () => {
  const registry = new Registry();
  const supervisor = new SdkSupervisor(registry);
  const handle = fakeHandle();
  const restore = withFakeClaudeDriver(async () => handle);
  try {
    const session = await supervisor.start({
      agent: "claude",
      name: "direct",
      cwd: "/wt/direct",
      prompt: COMPOSED,
      model: null,
      effort: null,
      permissionMode: null,
      mcp: null,
      taskId: null,
    });
    assert.equal(registry.launchTurnFor(session.id), null);
    assert.equal(getSessionLaunchTurn(session.id), undefined);
  } finally {
    restore();
    handle.end();
  }
});

/** A repo a worktree can actually be cut from, optionally carrying an agent-memory index. */
function seedRepo(name: string, withMemory = false): string {
  const repo = join(home, name);
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@test"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
  writeFileSync(join(repo, "file.txt"), "base\n");
  if (withMemory) {
    mkdirSync(join(repo, ".agents", "memory"), { recursive: true });
    writeFileSync(join(repo, ".agents", "memory", "MEMORY.md"), "# Memory index\n");
  }
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "base"]);
  return repo;
}

/**
 * Drive one real TERMINAL dispatch to the delivery boundary.
 *
 * The whole point of reaching it through `Dispatcher.dispatch` rather than calling the
 * recorder directly is the ORDER: the marker has to exist by the time the prompt crosses
 * into the runtime, and has to be gone again if that crossing fails. Neither is observable
 * from a unit call. `spawn` stands in for the terminal home and supplies the discovery and
 * the readiness hook the real launch would produce.
 */
async function terminalDispatch(options: {
  agent: "claude" | "pi";
  repo: string;
  taskId: string;
  intent: string;
  deliver: "accept" | "throw";
  /** Resolves the marker under Pi's pre-minted conversation key, read at spawn time. */
  piSessionKey?: () => { fingerprint: string; displayText: string | null } | null;
}): Promise<{
  registry: InstanceType<typeof Registry>;
  /** The marker as it stood at the instant the prompt was handed to the pane. */
  atDelivery: { fingerprint: string; displayText: string | null } | null;
  /** The marker as it stood at the instant the agent process was launched. */
  atSpawn: { fingerprint: string; displayText: string | null } | null;
  delivered: string | null;
  sessionId: string | null;
}> {
  const registry = new Registry();
  registry.upsertTask(
    mkTask({
      id: options.taskId,
      status: "dispatching",
      repoRoot: options.repo,
      title: "Launch presentation",
      intent: options.intent,
      agent: options.agent,
    }),
  );
  let atDelivery: { fingerprint: string; displayText: string | null } | null = null;
  let delivered: string | null = null;
  let sessionId: string | null = null;
  let worktree: string | null = null;
  let atSpawn: { fingerprint: string; displayText: string | null } | null = null;
  const dispatcher = new Dispatcher(registry, async () => {}, {
    resolveRuntime: () => "terminal",
    missionMcpDescriptor: async () => null,
    spawn: async (_label, _short, cwd) => {
      worktree = cwd;
      // Asked at the instant the process is launched. For Pi this is the assertion that
      // matters: turn one travels in this argv, so a marker recorded any later is a marker
      // that was missing while the conversation already existed.
      atSpawn = options.piSessionKey?.() ?? null;
      const discovered = mkDiscovered({ agent: options.agent, cwd, syntheticId: `sid-${options.taskId}` });
      registry.applyDiscovery([discovered]);
      sessionId = discovered.syntheticId;
      // Readiness: a hooked agent proves it can READ before the dispatcher types.
      registry.applyHook({
        agent: options.agent,
        event: "SessionStart",
        sessionId: `native-${options.taskId}`,
        cwd,
        transcriptPath: null,
        env: { tmuxPane: (discovered.terminals[0] as { paneId: string }).paneId },
      });
      return `home-${options.taskId}`;
    },
    inject: async (_session, text) => {
      delivered = text;
      // Asked at the exact instant the prompt is handed over. This is the assertion the
      // whole helper exists for: the marker has to be durable BEFORE this line.
      const marker = registry.launchTurnFor(sessionId!);
      atDelivery = marker
        ? { fingerprint: marker.fingerprint, displayText: marker.displayText }
        : null;
      if (options.deliver === "throw") throw new Error("the pane vanished");
      // The agent acknowledging the paste. A hooked session waits for the `working`
      // transition only `UserPromptSubmit` can produce, so without this the dispatcher
      // rightly fails the task and we would be testing the rollback path twice.
      registry.applyHook({
        agent: options.agent,
        event: "UserPromptSubmit",
        sessionId: `native-${options.taskId}`,
        cwd: worktree!,
        transcriptPath: null,
        prompt: text,
        env: { tmuxPane: "%1" },
      });
      return { ok: true, pasted: true, submitVerified: true };
    },
  });
  await dispatcher.dispatch(options.taskId);
  return { registry, atDelivery, atSpawn, delivered, sessionId };
}

test("a terminal launch marker exists BEFORE the paste, and matches what was pasted", async () => {
  const repo = seedRepo("terminal-launch");
  const intent = "sort out the flexbox helper";
  const run = await terminalDispatch({
    agent: "claude",
    repo,
    taskId: "task-terminal-ok",
    intent,
    deliver: "accept",
  });

  assert.ok(run.delivered, "the dispatch reached the delivery boundary");
  assert.ok(
    run.delivered!.includes("## Mission Control execution authorization"),
    "the agent is still given the whole composed contract",
  );
  // Recorded before the paste, and fingerprinting the text that was actually pasted.
  assert.deepEqual(run.atDelivery, {
    fingerprint: launchTextFingerprint(run.delivered!),
    displayText: intent,
  });
  assert.equal(run.registry.getTask("task-terminal-ok")?.status, "running");
  // And it followed the hook binding, which had already landed before delivery.
  assert.equal(getSessionLaunchTurn(`native-task-terminal-ok`)?.displayText, intent);
});

test("a terminal launch whose delivery fails rolls its marker back", async () => {
  // A marker with no delivery behind it would tell the dashboard to project a turn nothing
  // ever wrote, and the next real human message under that key is what it would be compared
  // against - so this is a correctness rollback, not tidiness.
  const repo = seedRepo("terminal-launch-fail");
  const run = await terminalDispatch({
    agent: "claude",
    repo,
    taskId: "task-terminal-fail",
    intent: "this one never arrives",
    deliver: "throw",
  });

  assert.ok(run.atDelivery, "the marker existed at the attempted paste");
  assert.equal(run.registry.launchTurnFor(run.sessionId!), null, "and is gone again");
  assert.equal(getSessionLaunchTurn("native-task-terminal-fail"), undefined);
  assert.equal(run.registry.getTask("task-terminal-fail")?.status, "failed");
});

test("Pi fingerprints the memory-pointer prefixed text it actually launched with", async () => {
  // Pi's only channel is turn one, so the repository-memory pointer is composed INTO the
  // positional prompt. Fingerprinting the pre-pointer `intent` instead would silently never
  // match, and every Pi dispatch would render its launch contract in full.
  const repo = seedRepo("pi-launch", true);
  const intent = "read the memory index first";
  // Pi's conversation id is minted by `preparePiLaunch` inside the dispatch, so the test
  // cannot know it up front. It is the only launch-turn row in this file's database that is
  // keyed by a uuid, which is enough to find it at spawn time.
  const piKeyed = (): { fingerprint: string; displayText: string | null } | null => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const row = loadSessionLaunchTurns().find((m) => uuid.test(m.noteKey));
    return row ? { fingerprint: row.fingerprint, displayText: row.displayText } : null;
  };
  const run = await terminalDispatch({
    agent: "pi",
    repo,
    taskId: "task-pi",
    intent,
    deliver: "accept",
    piSessionKey: piKeyed,
  });

  // Pi is never pasted to: its turn one travelled in the argv.
  assert.equal(run.delivered, null, "Pi must not be typed at - that would run the task twice");
  // And the marker was already durable when that argv was handed to the process. Recorded
  // after discovery instead, the conversation would exist - with turn one already written -
  // before anything could project it, and SSE never re-decorates a frame it already sent.
  assert.ok(run.atSpawn, "Pi's launch marker must be durable before the process starts");
  assert.equal(run.atSpawn!.displayText, intent);
  const marker = run.registry.launchTurnFor(run.sessionId!);
  assert.ok(marker, "a Pi dispatch still records its launch presentation");
  assert.equal(marker!.displayText, intent);
  assert.notEqual(
    marker!.fingerprint,
    launchTextFingerprint(withTaskKindContract(
      run.registry.getTask("task-pi")!,
      intent,
      { planSkills: null, workflowEvidence: false },
    )),
    "the pointer really did change the delivered text, so this test can tell the two apart",
  );
  assert.equal(
    marker!.fingerprint,
    launchTextFingerprint(withMemoryPointer(withTaskKindContract(
      run.registry.getTask("task-pi")!,
      intent,
      { planSkills: null, workflowEvidence: false },
    ))),
    "and the fingerprint is of the pointer-prefixed text Pi was launched with",
  );
});

test("a task ASSIGNED into a live conversation records no launch marker", async () => {
  // The exclusion that protects an existing conversation. This seam types a composed
  // contract into a session that is already mid-conversation, so its turn is a message
  // among others - not the turn that started anything. A marker here would tell the
  // dashboard to substitute the operator's task text for one real message and, worse, would
  // sit under a key whose transcript already holds turns that could fingerprint-match.
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  // A real clone of a real origin, because `assign` refuses an agent whose checkout it
  // could not reset - and it asks git that question directly. A bare `git init` repo has a
  // commit no origin ref has, which is exactly the "holding work" refusal.
  const { root, clone: cwd } = mkOriginAndClone("mission-launch-assign-");
  assignRoots.push(root);
  const discovered = mkDiscovered({
    cwd,
    syntheticId: "assign-sid",
    gitRoot: cwd,
    repoRoot: cwd,
  } as Partial<DiscoveredSession>);
  registry.applyDiscovery([discovered]);
  registry.applyHook({
    agent: "claude",
    event: "Stop",
    sessionId: "assign-native",
    cwd,
    transcriptPath: null,
    env: { tmuxPane: (discovered.terminals[0] as { paneId: string }).paneId },
  });
  assert.equal(registry.getSession("assign-sid")?.state, "idle", "fixture must actually be idle");
  registry.setForemanInvite("assign-sid", "dispatch");
  registry.upsertTask(mkTask({ id: "assign-task", repoRoot: cwd, intent: "and now do this" }));

  // Annotated rather than inferred: assigned only inside the `inject` callback, which the
  // checker cannot see running, so an inferred `null` narrows to `never` at every read.
  const typedTexts: string[] = [];
  const result = await tasks.assign("assign-task", "assign-sid", {
    paneReady: async () => ({ ok: true }),
    // The handover a reused agent gets: reset onto origin, context cleared, branch
    // detached. A `/clear` is part of that, which is the second reason no marker may be
    // recorded here - the conversation this task lands in is a brand new one.
    reset: async () => ({ ok: true, error: null, root: null, cleared: true, detached: true }),
    confirmReset: true,
    inject: async (_session, text) => {
      typedTexts.push(text);
      return { ok: true, pasted: true, submitVerified: true };
    },
    rename: async () => ({ ok: true }),
  });

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(typedTexts.length, 1, "the assignment reached the pane");
  assert.ok(
    typedTexts[0]!.includes("## Mission Control execution authorization"),
    "an assigned task still carries the platform contract to the agent",
  );
  assert.equal(registry.launchTurnFor("assign-sid"), null, "and the log still shows it");
  assert.equal(getSessionLaunchTurn("assign-native"), undefined);
});

// ---- the occurrence anchor (Inspector round 1) ----

test("a repeated launch prompt renders as the real message it is", () => {
  // The defect a fingerprint alone cannot avoid. Nothing stops the same bytes arriving twice:
  // `deliverIntent` retries an unacknowledged paste by design, and automation can resend an
  // intent verbatim. Matching on text alone projected BOTH, so a real later message was
  // replaced by the human request - or omitted outright under a null projection.
  const launch = mkMessage({ id: "launch-turn" });
  const repeat = mkMessage({ id: "repeat-turn" });
  assert.equal(launch.text, repeat.text, "the fixture's whole point: identical bytes");

  const bound: string[] = [];
  const out = attributeTranscript("s1", [launch, repeat], mkMarker("s1"), (id) => bound.push(id));

  assert.deepEqual(bound, ["launch-turn"], "the first match is claimed, once");
  assert.equal(out[0]?.presentation?.displayText, HUMAN, "the launch turn projects");
  assert.equal(out[1]?.presentation, undefined, "the repeat is left alone");
  assert.deepEqual(out[1], repeat, "byte-for-byte the turn the transcript recorded");

  // And the projection agrees: one visible request, one visible repeat.
  const visible = projectLaunchPresentation(out);
  assert.deepEqual(visible.map((m) => m.text), [HUMAN, COMPOSED]);
});

test("an anchored marker projects only its own turn, whatever the text says", () => {
  // Once anchored the fingerprint is not consulted at all. A turn carrying the launch bytes
  // under a different id is a different turn, and this is what says so.
  const marker = mkMarker("s1", { messageId: "the-launch" });
  const [same] = attributeTranscript("s1", [mkMessage({ id: "the-launch" })], marker);
  assert.equal(same?.presentation?.displayText, HUMAN);

  const [other] = attributeTranscript("s1", [mkMessage({ id: "some-other-turn" })], marker);
  assert.equal(other?.presentation, undefined);

  // Nor does an anchored marker re-claim: the callback must not fire.
  const bound: string[] = [];
  attributeTranscript("s1", [mkMessage({ id: "some-other-turn" })], marker, (id) => bound.push(id));
  assert.deepEqual(bound, []);
});

test("the anchor is written once and never re-pointed", () => {
  const registry = new Registry();
  const s = discover(registry);
  registry.recordLaunchTurn(s.id, COMPOSED, HUMAN);
  assert.equal(registry.launchTurnFor(s.id)?.messageId, null, "unanchored at dispatch");

  registry.bindLaunchTurnMessage(s.id, "first-sighting");
  assert.equal(registry.launchTurnFor(s.id)?.messageId, "first-sighting");
  assert.equal(getSessionLaunchTurn(noteKeyOf(registry, s.id))?.messageId, "first-sighting");

  // A later read that somehow matched something else must not steal the projection.
  registry.bindLaunchTurnMessage(s.id, "a-later-turn");
  assert.equal(registry.launchTurnFor(s.id)?.messageId, "first-sighting");

  // Unknown session, empty id, and no marker are all no-ops rather than throws.
  registry.bindLaunchTurnMessage("no-such-session", "x");
  registry.bindLaunchTurnMessage(s.id, "");
  const bare = discover(registry);
  registry.bindLaunchTurnMessage(bare.id, "y");
  assert.equal(registry.launchTurnFor(bare.id), null);
});

test("a re-dispatch under one key does not inherit the previous launch's anchor", () => {
  // The stale-anchor trap. A replacement launch describes a different conversation whose turn
  // has its own id; carrying the old anchor would point the projection at a turn that is no
  // longer there, and the new launch contract would render in full for ever.
  const registry = new Registry();
  const s = discover(registry);
  registry.recordLaunchTurn(s.id, COMPOSED, HUMAN);
  registry.bindLaunchTurnMessage(s.id, "old-turn");
  assert.equal(registry.launchTurnFor(s.id)?.messageId, "old-turn");

  registry.recordLaunchTurn(s.id, `${COMPOSED} take two`, "take two", 9_000);
  assert.equal(registry.launchTurnFor(s.id)?.messageId, null, "the new launch starts unanchored");
  assert.equal(registry.launchTurnFor(s.id)?.displayText, "take two");
});

test("the anchor survives the initial bind, so a bound conversation stays projected", () => {
  const registry = new Registry();
  const d = mkDiscovered();
  registry.applyDiscovery([d]);
  registry.recordLaunchTurn(d.syntheticId, COMPOSED, HUMAN);
  registry.bindLaunchTurnMessage(d.syntheticId, "turn-one");

  const native = `agent-anchor-${seq}`;
  registry.applyHook({
    agent: "claude",
    event: "SessionStart",
    sessionId: native,
    cwd: d.cwd,
    transcriptPath: null,
    env: { tmuxPane: (d.terminals[0] as { paneId: string }).paneId },
  });

  assert.equal(registry.launchTurnFor(d.syntheticId)?.messageId, "turn-one");
  assert.equal(getSessionLaunchTurn(native)?.messageId, "turn-one");
});

// ---- the launch echo, and the completion deadlock it used to cause ----
//
// A managed launch reaches the Goal pipeline through two doors that cannot see each other:
// the supervisor captures the operator's own request when the conversation binds, and the
// composed prompt built from that request is then delivered to the agent, whose prompt hook
// reports it back. Both look like accepted human instructions, so both opened a revision.
//
// The second one is not a cosmetic duplicate. `refine` has to reconcile it against the
// first, reads the platform's contract sections as an `amend` that does not preserve the
// objective, and parks the revision unresolved with `relationship: "unclear"` - permanently,
// because the retry key is set and nothing clears it. `resolvedSessionIntent` then returns
// null for the rest of the session's life, and Foreman's prompted wrap-up skips it at "the
// latest instruction has unresolved intent" on every tick, so a dispatched ship task never
// reaches the Workflow it was bound to and simply sits idle.

/** Bind a native conversation so the marker, the goal and the hook share one note key. */
function boundSession(
  registry: InstanceType<typeof Registry>,
): { id: string; noteKey: string; cwd: string } {
  const d = mkDiscovered();
  const cwd = d.cwd!;
  registry.applyDiscovery([d]);
  const native = `agent-echo-${seq}`;
  registry.applyHook({
    agent: "claude",
    event: "SessionStart",
    sessionId: native,
    cwd,
    transcriptPath: null,
    env: { tmuxPane: (d.terminals[0] as { paneId: string }).paneId },
  });
  return { id: d.syntheticId, noteKey: native, cwd };
}

function submitPrompt(
  registry: InstanceType<typeof Registry>,
  noteKey: string,
  cwd: string,
  prompt: string,
): void {
  registry.applyHook({
    agent: "claude",
    event: "UserPromptSubmit",
    sessionId: noteKey,
    cwd,
    transcriptPath: null,
    prompt,
    env: {},
  });
}

/** One completed turn: the agent works and parks, advancing the work-cycle generation. */
function workAndPark(
  registry: InstanceType<typeof Registry>,
  noteKey: string,
  cwd: string,
): void {
  registry.applyHook({
    agent: "claude", event: "PreToolUse", sessionId: noteKey, cwd,
    transcriptPath: null, env: {}, toolName: "Edit",
  });
  registry.applyHook({
    agent: "claude", event: "Stop", sessionId: noteKey, cwd, transcriptPath: null, env: {},
  });
}

test("a launch already seeded into the Goal does not open a second revision from its hook echo", () => {
  const registry = new Registry();
  const { id, noteKey, cwd } = boundSession(registry);

  // The supervisor's door: the operator's own words, captured when the conversation bound.
  registry.recordLaunchTurn(id, COMPOSED, HUMAN);
  registry.captureAcceptedPrompt(id, HUMAN, noteKey);
  assert.equal(registry.getGoal(id)?.promptRevision, 1);

  // The agent's door: the SAME launch, whitespace-collapsed by `substantivePrompt`.
  submitPrompt(registry, noteKey, cwd, COMPOSED);

  const goal = registry.getGoal(id);
  assert.equal(goal?.promptRevision, 1, "the launch echo must not open a second revision");
  assert.equal(goal?.pendingPrompts.length, 1, "and must not queue a second reconciliation");
  assert.equal(goal?.pendingPrompts[0]?.prompt, HUMAN);
});

test("the echo guard needs a seeded Goal, so a hook-only launch still captures one", () => {
  // Terminal and Pi launches have no supervisor door - the hook IS the only capture. A
  // guard keyed on the fingerprint alone would leave those sessions with no Goal at all.
  const registry = new Registry();
  const { id, noteKey, cwd } = boundSession(registry);
  registry.recordLaunchTurn(id, COMPOSED, HUMAN);

  submitPrompt(registry, noteKey, cwd, COMPOSED);

  assert.equal(registry.getGoal(id)?.promptRevision, 1, "the first delivery must still land");

  // Only the duplicate is refused - which also absorbs the identical turn `deliverIntent`
  // writes when it retries an unacknowledged paste.
  submitPrompt(registry, noteKey, cwd, COMPOSED);
  assert.equal(registry.getGoal(id)?.promptRevision, 1, "a retried paste is not a new ask");
});

test("the echo guard expires with the opening turn, so re-sending the launch text later counts", () => {
  // A marker lives as long as its conversation does. Matching on it alone would suppress
  // the launch text FOREVER - so a human who scrolls back, copies the prompt out of the
  // transcript and sends it again to rerun the task would be silently ignored. The window
  // is the opening turn, which is the only turn a launch can be delivered in.
  const registry = new Registry();
  const { id, noteKey, cwd } = boundSession(registry);
  registry.recordLaunchTurn(id, COMPOSED, HUMAN);
  registry.captureAcceptedPrompt(id, HUMAN, noteKey);

  submitPrompt(registry, noteKey, cwd, COMPOSED);
  assert.equal(registry.getGoal(id)?.promptRevision, 1, "the launch echo is still absorbed");

  // ...and a redelivery inside that same opening turn still is, which is the retry
  // `deliverIntent` writes for an unacknowledged paste.
  submitPrompt(registry, noteKey, cwd, COMPOSED);
  assert.equal(registry.getGoal(id)?.promptRevision, 1, "a same-turn retry is not a new ask");

  workAndPark(registry, noteKey, cwd);

  // The agent has parked, so the only thing that can send this text now is a person.
  submitPrompt(registry, noteKey, cwd, COMPOSED);
  const goal = registry.getGoal(id);
  assert.equal(goal?.promptRevision, 2, "re-sending the launch after the turn is an instruction");
  assert.equal(goal?.pendingPrompts.at(-1)?.prompt, COMPOSED.replace(/\s+/g, " ").trim());
});

test("the inverted ordering falls back to capturing, and lands in the reconciler's easy direction", () => {
  // The guard needs a revision to already exist, so which door counts is WHICHEVER ARRIVES
  // FIRST rather than the supervisor by definition. On a dispatch that is the supervisor -
  // the bind rides the driver's init frame and the hook cannot fire until the agent holds
  // the prompt - but the fallback is documented in docs/sessions.md as a guarantee, so it is
  // pinned here rather than left to the ordering holding forever.
  //
  // What matters is the DIRECTION of the failure. Inverted, the composed prompt establishes
  // the objective and the operator's request follows as revision two: still two revisions,
  // but a narrower ask against a broader objective, which is the ordinary `steer` the
  // reconciler reads - not the `amend` that could not keep the objective as its prefix and
  // wedged the session. Nothing is discarded either way.
  const registry = new Registry();
  const { id, noteKey, cwd } = boundSession(registry);
  registry.recordLaunchTurn(id, COMPOSED, HUMAN);

  // The hook's own text, which reaches the Registry already whitespace-collapsed.
  const echoed = COMPOSED.replace(/\s+/g, " ").trim();

  submitPrompt(registry, noteKey, cwd, COMPOSED);
  assert.equal(registry.getGoal(id)?.promptRevision, 1, "an unseeded hook echo is the capture");
  assert.equal(registry.getGoal(id)?.objective, echoed);

  registry.captureAcceptedPrompt(id, HUMAN, noteKey);

  const goal = registry.getGoal(id);
  assert.equal(goal?.promptRevision, 2, "the late supervisor prompt is queued, never dropped");
  assert.equal(goal?.pendingPrompts.at(-1)?.prompt, HUMAN);
  assert.equal(goal?.objective, echoed, "and the first arrival keeps the objective");
});

test("a real instruction after the launch still opens its own revision", () => {
  const registry = new Registry();
  const { id, noteKey, cwd } = boundSession(registry);
  registry.recordLaunchTurn(id, COMPOSED, HUMAN);
  registry.captureAcceptedPrompt(id, HUMAN, noteKey);

  submitPrompt(registry, noteKey, cwd, COMPOSED);
  submitPrompt(registry, noteKey, cwd, "also rename the helper");

  const goal = registry.getGoal(id);
  assert.equal(goal?.promptRevision, 2, "the human's next ask is not the launch");
  assert.equal(goal?.pendingPrompts.at(-1)?.prompt, "also rename the helper");
});

test("a marker written before the echo fingerprint existed degrades to capturing", () => {
  // No backfill is possible - the composed prompt is deliberately never stored, so the value
  // cannot be recomputed for an existing row and a guessed one would suppress a real
  // instruction. An upgraded database must therefore fall back to the duplicate that shipped
  // without the column rather than to silence.
  //
  // The null has to arrive through the LOAD, not through a mutation of a live marker: it is
  // the boot path that an upgraded install actually takes, and it is the one that would
  // regress if `rowToLaunchTurn` ever started defaulting the column instead of carrying it.
  const legacyKey = key("legacy-echo");
  upsertSessionLaunchTurn({ ...mkMarker(legacyKey), echoFingerprint: null });

  const registry = new Registry();
  assert.equal(registry.launchTurnFor(legacyKey), null, "not a session yet, just a row");
  const d = mkDiscovered();
  const cwd = d.cwd!;
  registry.applyDiscovery([d]);
  registry.applyHook({
    agent: "claude",
    event: "SessionStart",
    sessionId: legacyKey,
    cwd,
    transcriptPath: null,
    env: { tmuxPane: (d.terminals[0] as { paneId: string }).paneId },
  });
  assert.equal(registry.launchTurnFor(d.syntheticId)?.echoFingerprint, null, "loaded as null");

  registry.captureAcceptedPrompt(d.syntheticId, HUMAN, legacyKey);
  submitPrompt(registry, legacyKey, cwd, COMPOSED);

  assert.equal(
    registry.getGoal(d.syntheticId)?.promptRevision,
    2,
    "an unrecognizable echo captures rather than disappearing",
  );
});

test("launchEchoFingerprint matches across the whitespace collapse, and only that", () => {
  // What the hook does to a prompt: `substantivePrompt` flattens every whitespace run to a
  // single space, so a launch composed with `\n\n` between its sections arrives as one line.
  assert.equal(
    launchEchoFingerprint(COMPOSED),
    launchEchoFingerprint(COMPOSED.replace(/\s+/g, " ")),
  );
  assert.notEqual(
    launchTextFingerprint(COMPOSED),
    launchTextFingerprint(COMPOSED.replace(/\s+/g, " ")),
    "the byte-exact fingerprint is why a second one was needed",
  );
  // Still a fingerprint, not a similarity score: text the launch merely resembles must miss.
  assert.notEqual(launchEchoFingerprint(COMPOSED), launchEchoFingerprint(`${COMPOSED} and more`));
  assert.notEqual(launchEchoFingerprint(HUMAN), launchEchoFingerprint(COMPOSED));
});
