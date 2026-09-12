import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { Session } from "@shared/types.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";

// What is at stake: push instrumentation is the ONLY signal that says a session is
// working, idle, or waiting on you, and it belongs to exactly one of the two agents we
// ship. Everything that used to make that a Claude-shaped assumption was silent for the
// other one - the event switch answered `working` for anything it didn't recognize, the
// hook overlay was keyed by PANE with no idea whose agent had left it there, and the
// dispatcher waited 20 seconds on every launch for a first hook that Codex was never
// going to send.
//
// So these pin three things a hookless harness is owed:
//
//   1. It is not INTERPRETED by someone else's vocabulary. An ingest whose harness
//      declares no hooks is refused, not fed to a switch that will answer `working`.
//   2. It is not IMPERSONATED. A pane outlives the agent in it - quit Claude, start
//      Codex in the same tmux pane - and the overlay left behind must not become that
//      card's state, activity, permission mode, agent session id or transcript path.
//   3. It does not PAY for a capability it lacks. The dispatcher's readiness wait is
//      skipped rather than spent.
//
// Plus the drift guard the event vocabulary earned by being hand-kept in two installers.

// Set before importing anything that resolves the state dir / opens the db, and before
// the dispatcher module reads its timing constants at load.
const home = mkdtempSync(join(tmpdir(), "mission-harness-hooks-"));
process.env.HARNESS_HOME = join(home, "state");
/** Long enough that spending it is unmistakable next to the settle below. */
const HOOK_READY_MS = 800;
process.env.HARNESS_DISPATCH_HOOK_READY_MS = String(HOOK_READY_MS);
process.env.HARNESS_DISPATCH_SETTLE_MS = "10";

const { HARNESSES, hooksFor } = await import("../src/server/harness/index.ts");
const { claudeHooks } = await import("../src/server/harness/claude/hooks.ts");
const { CODEX_HOOK_EVENTS, codexHooks } = await import("../src/server/harness/codex/hooks.ts");
const { Registry, sessionEqual, sessionKey } = await import("../src/server/registry.ts");
const { Dispatcher } = await import("../src/server/dispatcher.ts");
const { codexHookOverride, prepareCodexLaunch } = await import("../src/server/harness/codex/launch.ts");
const { openDb } = await import("../src/server/db.ts");

after(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.HARNESS_DISPATCH_HOOK_READY_MS;
  delete process.env.HARNESS_DISPATCH_SETTLE_MS;
});

openDb();

const PANE = "%7";

function mkDiscovered(over: Partial<DiscoveredSession> = {}): DiscoveredSession {
  return {
    syntheticId: "sid",
    agent: "claude",
    name: "work",
    nameSource: "process",
    cwd: "/wt/one",
    gitBranch: null,
    pid: 1,
    tty: "ttys015",
    terminals: [mkMuxHandle({ session: "s", windowName: "w", windowIndex: 0, paneId: PANE })],
    startedAt: 0,
    ...over,
  } as DiscoveredSession;
}

// ---- the registry, and the shape of a spec -------------------------------------

test("every harness answers the hooks question with its own scope", () => {
  // Not "codex happens to have no hooks" - the `Record<AgentType, Harness>` makes each answer
  // a decision someone had to write down. A new agent id cannot compile without one.
  //
  // Codex's answer used to be a declared null and is now a spec: `harness/codex/launch.ts`
  // gets ten PascalCase events out of Codex by injecting `-c hooks.<Event>=[...]` at launch.
  // Pi reports machine-scoped hooks through its in-process extension.
  assert.ok(hooksFor("claude"), "claude installs machine-wide hooks");
  assert.ok(hooksFor("codex"), "codex attaches launch-scoped hooks");
  assert.equal(hooksFor("pi")?.scope, "machine", "Pi reports through its extension");
  for (const [id, h] of Object.entries(HARNESSES)) {
    assert.equal(h.hooks, hooksFor(id as keyof typeof HARNESSES), `${id} resolves to its own spec`);
  }
  assert.equal(claudeHooks.scope, "machine");
  assert.equal(codexHooks.scope, "launch");
});

test("Codex launch overrides contain command handlers, not inert matcher fields", async () => {
  // Codex's hook schema is event -> matcher group -> hook handler. The former launch argv
  // stopped one level early at `{command=[node, bridge, event]}`. Its TOML was accepted,
  // but there was no `hooks` array and therefore no handler to run: in particular no
  // UserPromptSubmit, which left every dispatched Codex card without a Goal.
  const bridge = join(home, "bridge with a ' quote.mjs");
  writeFileSync(bridge, "");
  process.env.MISSION_CODEX_HOOK = bridge;
  let prepared: Awaited<ReturnType<typeof prepareCodexLaunch>>;
  try {
    // No Mission MCP requirement, so the hook overrides are still the whole of the argv -
    // which is what the exact indexing below depends on.
    prepared = await prepareCodexLaunch(false);
  } finally {
    delete process.env.MISSION_CODEX_HOOK;
  }

  assert.equal(prepared.instrumented, true);
  assert.equal(prepared.missionMcp, false, "nobody asked for it, so nothing registered it");
  assert.equal(prepared.args.at(-1), "--dangerously-bypass-hook-trust");
  const configArgs = prepared.args.slice(0, -1);
  assert.equal(configArgs.length, CODEX_HOOK_EVENTS.length * 2);
  for (const [i, event] of CODEX_HOOK_EVENTS.entries()) {
    assert.equal(configArgs[i * 2], "-c");
    assert.equal(configArgs[i * 2 + 1], codexHookOverride(event, bridge));
    assert.match(
      configArgs[i * 2 + 1]!,
      new RegExp(`^hooks\\.${event}=\\[\\{hooks=\\[\\{type="command",command=`),
      `${event} has no nested command handler`,
    );
  }
  const quoted = codexHookOverride("Stop", bridge, "/node's/bin");
  const encodedCommand = /command=("(?:\\.|[^"])*")/.exec(quoted)?.[1];
  assert.ok(encodedCommand, "the override carries no TOML string command");
  assert.match(JSON.parse(encodedCommand) as string, /'\/node'"'"'s\/bin'/);
});

test("Codex's events are all modelled, and PermissionRequest is not 'working'", () => {
  // The same fallback argument the Claude case below makes, plus the one event where the
  // fallback is not merely uninformative but INVERTED: `PermissionRequest` fires because
  // a human has to answer something, and a session blocked on a prompt reading as busy is
  // the opposite of the fact - on the only event that can ever report it, since nothing
  // else fires until the prompt is answered.
  const FALLBACK = JSON.stringify({ state: "working", activity: null });
  const filled = { prompt: "an ask", toolName: "shell", source: "startup", reason: "clear" };
  for (const event of codexHooks.events) {
    const r = codexHooks.toState({ agent: "codex", event, env: {}, ...filled } as never);
    assert.notEqual(JSON.stringify(r), FALLBACK, `${event} is installed but falls through toState`);
  }
  assert.equal(
    codexHooks.toState({ agent: "codex", event: "PermissionRequest", env: {} } as never).state,
    "awaiting_input",
  );
});

test("Claude's matcher events are a subset of the events it installs", () => {
  // A matcher for an event we never register is dead config; an event registered with
  // the wrong group shape is a hook Claude silently never runs.
  for (const e of claudeHooks.matcherEvents) {
    assert.ok(claudeHooks.events.includes(e), `${e} takes a matcher but is never installed`);
  }
  assert.ok(claudeHooks.events.length > 0);
});

test("every event Claude installs is modelled, rather than landing on the fallback", () => {
  // The fallback - `working`, no activity - is the right answer for an event we did not
  // ask for and the wrong one for an event we install a hook for. Every payload field is
  // populated so that a modelled event always says SOMETHING; an event added to `events`
  // and forgotten in `toState` is then the only way to produce the bare fallback.
  const FALLBACK = JSON.stringify({ state: "working", activity: null });
  const filled = { prompt: "an ask", message: "a notice", toolName: "Bash", source: "startup", reason: "clear" };
  for (const event of claudeHooks.events) {
    const r = claudeHooks.toState({ agent: "claude", event, env: {}, ...filled } as never);
    assert.notEqual(JSON.stringify(r), FALLBACK, `${event} is installed but falls through toState`);
  }
  // And the fallback itself, which is what a newer Claude's unrecognized event gets: a
  // hook fired, so the process is alive and doing something, and the ticker keeps
  // whatever it last knew rather than being blanked by an event we cannot read.
  assert.equal(
    JSON.stringify(claudeHooks.toState({ event: "SomeFutureEvent", ...filled } as never)),
    FALLBACK,
  );
});

test("only the prompt event yields prompt text", () => {
  const ask = "make the pluggable hooks land";
  assert.equal(claudeHooks.promptText({ event: "UserPromptSubmit", prompt: ask } as never), ask);
  // The gate and the scaffolding filter are ONE call now, so a non-prompt event carrying
  // a `prompt` field cannot reach the goal store by a different door.
  assert.equal(claudeHooks.promptText({ event: "Stop", prompt: ask } as never), null);
  assert.equal(claudeHooks.promptText({ event: "PostToolUse", prompt: ask } as never), null);
});

test("hook adapters normalize work activity and completed turns without leaking raw names", () => {
  const taskNotification =
    "<task-notification><task-id>bg-1</task-id><status>completed</status></task-notification>";

  assert.equal(
    claudeHooks.workCycleSignal({ event: "UserPromptSubmit", prompt: taskNotification } as never),
    "work_started",
    "a machine continuation is lifecycle work even though it is not human intent",
  );
  assert.equal(
    claudeHooks.workCycleSignal({ event: "PreToolUse", toolName: "Bash" } as never),
    "work_started",
  );
  assert.equal(claudeHooks.workCycleSignal({ event: "Stop" } as never), "turn_completed");
  assert.equal(
    claudeHooks.workCycleSignal({ event: "Notification", message: "Claude is waiting for your input" } as never),
    null,
    "idle notification noise is not a completed turn",
  );

  assert.equal(
    codexHooks.workCycleSignal({ event: "UserPromptSubmit", prompt: "ship it" } as never),
    "work_started",
  );
  assert.equal(codexHooks.workCycleSignal({ event: "PostToolUse" } as never), "work_started");
  assert.equal(codexHooks.workCycleSignal({ event: "Stop" } as never), "turn_completed");
  assert.equal(
    codexHooks.workCycleSignal({ event: "PermissionRequest" } as never),
    null,
    "waiting for human attention does not complete a cycle",
  );
});

// ---- the drift the installers used to carry ------------------------------------

test("neither installer keeps its own copy of the event vocabulary", () => {
  // These two lists were written out twice, by hand, with a note in CLAUDE.md admitting
  // nothing caught the drift. The failure it invites is silent and asymmetric: an event
  // added to the repo installer and not to the packaged app's is a session state that
  // works for developers and for nobody else.
  for (const file of ["hooks/install.mjs", "src/main/integrations.ts"]) {
    const src = readFileSync(join(import.meta.dirname, "..", file), "utf8");
    assert.match(src, /claudeHooks/, `${file} should read the vocabulary off the spec`);
    for (const event of claudeHooks.events) {
      assert.doesNotMatch(
        src,
        new RegExp(`["']${event}["']`),
        `${file} names ${event} itself instead of reading it from the harness`,
      );
    }
  }
});

// ---- a hookless harness is not interpreted -------------------------------------

test("an ingest for a harness that declares no hooks is refused, not guessed at", () => {
  const original = HARNESSES.pi.hooks;
  HARNESSES.pi.hooks = null;
  try {
  const registry = new Registry();
  registry.applyDiscovery([mkDiscovered({ syntheticId: "pi-1", agent: "pi" })]);
  const before = registry.getSession("pi-1");

  registry.applyHook({
    agent: "pi",
    event: "Stop",
    sessionId: "pi-agent",
    cwd: "/wt/one",
    transcriptPath: null,
    env: { tmuxPane: PANE },
  });

  const after = registry.getSession("pi-1");
  assert.equal(after?.instrumented, false, "nothing pushed anything at us");
  assert.equal(after?.hooksSeen, false);
  assert.equal(after?.activity, before?.activity, "no activity line was invented");
  assert.equal(after?.agentSessionId, before?.agentSessionId, "no binding was written");
  } finally { HARNESSES.pi.hooks = original; }
});

test("a Codex ingest IS read now - the other half, and the one that used to be refused", () => {
  const registry = new Registry();
  registry.applyDiscovery([mkDiscovered({ syntheticId: "cx-live", agent: "codex" })]);

  registry.applyHook({
    agent: "codex",
    event: "UserPromptSubmit",
    sessionId: "cx-agent-live",
    cwd: "/wt/one",
    transcriptPath: null,
    prompt: "ship the codex harness",
    env: { tmuxPane: PANE },
  });

  const s = registry.getSession("cx-live");
  assert.equal(s?.instrumented, true);
  assert.equal(s?.hooksSeen, true);
  assert.equal(s?.state, "working");
  assert.equal(s?.agentSessionId, "cx-agent-live", "the binding a Codex hook carries is written");
});

// ---- a hookless harness is not impersonated ------------------------------------

test("a Claude hook does not speak for the Codex session now in that pane", () => {
  // The scenario, exactly: quit Claude, start Codex in the same tmux pane. The overlay
  // is keyed by pane, so without an agent on it the Codex card inherits Claude's last
  // state and activity - and reports itself `instrumented` while pushing nothing.
  const registry = new Registry();
  registry.applyDiscovery([mkDiscovered({ syntheticId: "cl-1", agent: "claude" })]);
  registry.applyHook({
    agent: "claude",
    event: "Notification",
    sessionId: "cl-agent",
    cwd: "/wt/one",
    transcriptPath: "/tmp/cl.jsonl",
    permissionMode: "plan",
    env: { tmuxPane: PANE },
  });
  assert.equal(registry.getSession("cl-1")?.state, "awaiting_input", "the Claude card did move");

  // Same pane, same cwd, different agent.
  registry.applyDiscovery([mkDiscovered({ syntheticId: "cx-2", agent: "codex" })]);
  const cx = registry.getSession("cx-2");
  assert.ok(cx);
  assert.equal(cx.instrumented, false, "it pushes nothing, so it must not claim to");
  assert.notEqual(cx.state, "awaiting_input", "it never said it was waiting on anyone");
  assert.equal(cx.permissionMode, null, "a Shift+Tab state it has no concept of");
  assert.equal(cx.transcriptPath, null, "Claude's transcript is not this session's");
  assert.equal(cx.agentSessionId, null, "...nor is Claude's session id, which keys its queue");
});

test("a Claude hook arriving at a pane Codex now holds writes to nothing", () => {
  // The other direction of the same property: the overlay is refused above, and the LIVE
  // card the event would have been applied to is refused here. `agentSessionId` is the
  // one that matters most - it keys the session's note, queue and cost.
  const registry = new Registry();
  registry.applyDiscovery([mkDiscovered({ syntheticId: "cx-3", agent: "codex" })]);

  registry.applyHook({
    agent: "claude",
    event: "UserPromptSubmit",
    sessionId: "cl-agent-2",
    cwd: "/wt/one",
    transcriptPath: "/tmp/cl2.jsonl",
    prompt: "a goal that belongs to another session",
    env: { tmuxPane: PANE },
  });

  const cx = registry.getSession("cx-3");
  assert.equal(cx?.agentSessionId, null);
  assert.equal(cx?.transcriptPath, null);
  assert.equal(cx?.goal, null, "and no goal was captured onto it");
});

test("a hookless session still takes the passive path", () => {
  // The point of refusing all of the above is NOT to leave the card frozen: everything
  // the poller reads off disk still applies. Pinned because "ignore the hook" and
  // "ignore the session" are one edit apart.
  const registry = new Registry();
  registry.applyDiscovery([mkDiscovered({ syntheticId: "cx-4", agent: "codex" })]);
  registry.applyPassiveActivity(registry.getSession("cx-4") as Session, {
    state: "idle",
    lastActivity: Date.now(),
  });
  registry.applyDiscovery([mkDiscovered({ syntheticId: "cx-4", agent: "codex" })]);

  assert.equal(registry.getSession("cx-4")?.state, "idle", "read off disk, not off a hook");
  assert.equal(registry.getSession("cx-4")?.stateConfirmed, true, "a fresh rollout marker confirms the state");
  assert.equal(registry.getSession("cx-4")?.instrumented, false, "passive proof does not impersonate hooks");
});

test("passive state does not cross a reused pane into a new process", () => {
  const registry = new Registry();
  const old = mkDiscovered({
    syntheticId: "cx-old",
    agent: "codex",
    agentSessionId: "rollout-old",
    transcriptPath: "/rollouts/old.jsonl",
  } as Partial<DiscoveredSession>);
  registry.applyDiscovery([old]);
  registry.applyPassiveActivity(registry.getSession(old.syntheticId) as Session, {
    state: "idle",
    lastActivity: Date.now(),
  });
  registry.applyDiscovery([old]);
  assert.equal(registry.getSession(old.syntheticId)?.stateConfirmed, true, "the original occupant owns the read");

  const replacement = mkDiscovered({
    syntheticId: "cx-new",
    agent: "codex",
    pid: 2,
    startedAt: 2,
    agentSessionId: "rollout-new",
    transcriptPath: "/rollouts/new.jsonl",
  } as Partial<DiscoveredSession>);
  registry.applyDiscovery([replacement]);

  const live = registry.getSession(replacement.syntheticId);
  assert.equal(live?.state, "working", "process discovery's unconfirmed default survives");
  assert.equal(live?.stateConfirmed, false, "the prior pane occupant cannot confirm this card");
});

test("passive state does not cross a transcript change on the same process", () => {
  const registry = new Registry();
  const before = mkDiscovered({
    syntheticId: "cx-clear",
    agent: "codex",
    agentSessionId: "rollout-before",
    transcriptPath: "/rollouts/before.jsonl",
  } as Partial<DiscoveredSession>);
  registry.applyDiscovery([before]);
  registry.applyPassiveActivity(registry.getSession(before.syntheticId) as Session, {
    state: "idle",
    lastActivity: Date.now(),
  });

  // The process, pane and learned conversation id are unchanged, but discovery has
  // observed a different exact source. Isolating the path proves it is part of the
  // attribution check rather than merely metadata carried beside the synthetic id.
  const after = mkDiscovered({
    ...before,
    transcriptPath: "/rollouts/after.jsonl",
  } as Partial<DiscoveredSession>);
  registry.applyDiscovery([after]);

  const live = registry.getSession(after.syntheticId);
  assert.equal(live?.state, "working");
  assert.equal(live?.stateConfirmed, false, "the previous rollout cannot confirm the cleared conversation");
});

// ---- attribution: what a hook may be refused FOR --------------------------------

test("a hook whose session id contradicts the OPEN ROLLOUT is refused", () => {
  // Codex discovery reads the rollout the exact pid holds open (`annotateCodexRollouts`),
  // so its agent session id is evidence off the process table. A hook carrying a
  // different one is another process's - typically a second Codex sharing the cwd - and
  // must not move this card or poison its pane overlay.
  const registry = new Registry();
  registry.applyDiscovery([
    mkDiscovered({
      syntheticId: "cx-att",
      agent: "codex",
      agentSessionId: "rollout-abc",
      transcriptPath: "/rollouts/abc.jsonl",
    } as Partial<DiscoveredSession>),
  ]);
  const before = registry.getSession("cx-att");

  registry.applyHook({
    agent: "codex",
    event: "UserPromptSubmit",
    sessionId: "rollout-zzz",
    cwd: "/wt/one",
    transcriptPath: null,
    prompt: "not this session's prompt",
    env: { tmuxPane: PANE },
  });

  const after = registry.getSession("cx-att");
  assert.equal(after?.agentSessionId, "rollout-abc", "the witnessed binding stands");
  assert.equal(after?.instrumented, before?.instrumented, "no overlay was written for it");
  assert.equal(after?.activity, before?.activity);
});

test("THE regression: a /clear rebinds, because a remembered id is not evidence", () => {
  // The guard above must read `discoveredIdentity` - what discovery witnessed - and NOT
  // `Session.agentSessionId`, which is also where a binding learned from a previous hook
  // lives. A `/clear` mints a new agent session id on the same pane, so a guard reading
  // the session field refuses the very event that is supposed to rebind the card - and
  // its note, queue and goal stay keyed on a dead id that no later hook can move either,
  // because every one of them now disagrees too.
  const registry = new Registry();
  registry.applyDiscovery([mkDiscovered({ syntheticId: "cl-clear", agent: "claude" })]);

  registry.applyHook({
    agent: "claude",
    event: "UserPromptSubmit",
    sessionId: "before-clear",
    cwd: "/wt/one",
    transcriptPath: "/t/before.jsonl",
    env: { tmuxPane: PANE },
  });
  assert.equal(registry.getSession("cl-clear")?.agentSessionId, "before-clear");

  registry.applyHook({
    agent: "claude",
    event: "UserPromptSubmit",
    sessionId: "after-clear",
    cwd: "/wt/one",
    transcriptPath: "/t/after.jsonl",
    env: { tmuxPane: PANE },
  });
  assert.equal(registry.getSession("cl-clear")?.agentSessionId, "after-clear", "the pane rebound");
  assert.equal(registry.getSession("cl-clear")?.transcriptPath, "/t/after.jsonl");
});

// ---- a hookless harness does not pay for the capability -------------------------

test("the dispatcher skips the readiness wait when no hooks were prepared for the launch", async () => {
  // 20 seconds of certain silence on every dispatch, before the prompt was even typed.
  // `awaitReady` is private and the full `dispatch()` needs a worktree and a real spawn,
  // so it is called directly - the wait is the only behavior under test.
  //
  // The REASON to skip changed with Codex's hooks. It used to be "this harness declares
  // none, and never will"; it is now per-LAUNCH, because Codex's hooks are injected as
  // `-c hooks.*` overrides rather than installed once - so a dispatch whose bridge bundle
  // was missing (`prepareCodexLaunch` returning `instrumented: false`) has the same
  // certain silence ahead of it, and must not be charged for it.
  const registry = new Registry();
  registry.applyDiscovery([
    mkDiscovered({ syntheticId: "cx-d", agent: "codex", cwd: "/wt/codex" }),
    mkDiscovered({
      syntheticId: "cl-d",
      agent: "claude",
      cwd: "/wt/claude",
      terminals: [mkMuxHandle({ windowIndex: 1, paneId: "%8" })],
      tty: "ttys016",
      pid: 2,
    }),
  ]);
  const dispatcher = new Dispatcher(registry);
  const awaitReady = (cwd: string, s: Session, prepared?: boolean): Promise<{ instrumented: boolean }> =>
    (
      dispatcher as unknown as {
        awaitReady(c: string, s: Session, p?: boolean): Promise<{ instrumented: boolean }>;
      }
    ).awaitReady(cwd, s, prepared);

  const codexStart = Date.now();
  const codex = await awaitReady("/wt/codex", registry.getSession("cx-d") as Session, false);
  const codexMs = Date.now() - codexStart;

  assert.equal(codex.instrumented, false, "nothing was wired up, so nothing will report");
  assert.ok(
    codexMs < HOOK_READY_MS / 2,
    `an uninstrumented launch should fall straight through to the settle, took ${codexMs}ms`,
  );

  // ...while a launch that DID wire hooks up still gets the full wait: the signal exists,
  // we just have no evidence yet, and shortening that is the regression this whole
  // readiness mechanism was built to fix. Codex, so the pin is about the flag and not
  // about which harness it is.
  const waitedStart = Date.now();
  await awaitReady("/wt/codex", registry.getSession("cx-d") as Session, true);
  assert.ok(
    Date.now() - waitedStart >= HOOK_READY_MS,
    "a launch that CAN report readiness is still waited on",
  );

  const claudeStart = Date.now();
  await awaitReady("/wt/claude", registry.getSession("cl-d") as Session);
  assert.ok(
    Date.now() - claudeStart >= HOOK_READY_MS,
    "Claude's hooks are installed once, so its dispatch never passes the flag and always waits",
  );
});

test("the dispatcher refuses an exited session instead of targeting its lingered pane", async () => {
  // Discovery snapshots deliberately linger after exit. The failed dispatch this pins
  // observed the process, waited for readiness, then recovered that exited snapshot and
  // sent its initial prompt to a pane tmux had already removed.
  const registry = new Registry();
  registry.applyDiscovery([
    mkDiscovered({ syntheticId: "exited-dispatch", agent: "codex", cwd: "/wt/exited" }),
  ]);
  const discovered = registry.getSession("exited-dispatch") as Session;
  const dispatcher = new Dispatcher(registry);
  const awaitReady = (
    dispatcher as unknown as {
      awaitReady(c: string, s: Session, p?: boolean): Promise<{ instrumented: boolean }>;
    }
  ).awaitReady.bind(dispatcher);

  const ready = awaitReady("/wt/exited", discovered, true);
  registry.applyDiscovery([]);

  await assert.rejects(ready, /agent session exited before the initial prompt could be sent/);
});

test("hand-run Pi binds through a pane or unique cwd and only settled completes its cycle", () => {
  for (const pane of [true, false]) {
    const registry = new Registry();
    const id = `hand-pi-${pane}`;
    const discovered = mkDiscovered({ syntheticId: id, agent: "pi", agentSessionId: null,
      terminals: [mkMuxHandle({ backend: pane ? "tmux" : "herdr", paneId: PANE })] });
    registry.applyDiscovery([discovered]);
    const base = { agent: "pi" as const, sessionId: `pi-conversation-${pane}`, cwd: "/wt/one", transcriptPath: "/tmp/pi.jsonl", env: pane ? { tmuxPane: PANE } : {} };
    registry.applyHook({ ...base, event: "SessionStart" });
    assert.equal(registry.getSession(id)?.agentSessionId, base.sessionId);
    assert.equal(registry.getSession(id)?.transcriptPath, base.transcriptPath);
    registry.applyHook({ ...base, event: "UserPromptSubmit", prompt: "work" });
    assert.equal(registry.getSession(id)?.state, "working");
    const before = registry.getSession(id)?.workCycle?.generation;
    registry.applyHook({ ...base, event: "agent_end" });
    assert.equal(registry.getSession(id)?.workCycle?.generation, before);
    registry.applyHook({ ...base, event: "Stop" });
    assert.equal(registry.getSession(id)?.state, "idle");
    assert.equal(registry.getSession(id)?.workCycle?.generation, (before ?? 0) + 1);
    // A Herdr hook has no legacy pane env key. Its resolved session must retain Stop
    // across discovery, even before the passive reader catches up with the transcript.
    registry.applyPassiveActivity(registry.getSession(id)!, { state: "working", lastActivity: Date.now() });
    registry.applyDiscovery([discovered]);
    assert.equal(registry.getSession(id)?.state, "idle");
    assert.equal(registry.getSession(id)?.instrumented, true);
  }
});


for (const backend of ["tmux", "herdr"] as const) {
  test(`${backend} hook overlays are pruned after eviction and expiry on later ingest`, (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
    const registry = new Registry();
    const departed = mkDiscovered({
      syntheticId: `overlay-departed-${backend}`,
      agent: "pi",
      agentSessionId: `overlay-conversation-${backend}`,
      terminals: [mkMuxHandle({ backend, paneId: "departed" })],
    });
    registry.applyDiscovery([departed]);
    const departedKey = sessionKey(registry.getSession(departed.syntheticId)!);
    assert.equal(departedKey, `${backend}:departed`);
    registry.applyHook({
      agent: "pi", event: "Stop", sessionId: departed.agentSessionId!,
      cwd: departed.cwd, transcriptPath: null,
      env: backend === "tmux" ? { tmuxPane: "departed" } : {},
    });
    // State alone cannot prove memory cleanup: an expired overlay is ignored even
    // when it remains in the map. Inspect storage, but exercise only public writers.
    const overlays = (registry as unknown as { overlays: ReadonlyMap<string, unknown> }).overlays;
    assert.ok(overlays.has(departedKey));
    registry.applyDiscovery([]);
    t.mock.timers.tick(9_000);
    assert.equal(registry.getSession(departed.syntheticId), undefined, "the normal eviction timer removed the session");

    t.mock.timers.tick(29 * 60_000);
    const live = mkDiscovered({
      syntheticId: `overlay-live-${backend}`,
      agent: "pi",
      agentSessionId: `overlay-live-conversation-${backend}`,
      terminals: [mkMuxHandle({ backend, paneId: "live" })],
    });
    registry.applyDiscovery([live]);
    const hook = {
      agent: "pi" as const, event: "Stop", sessionId: live.agentSessionId!,
      cwd: live.cwd, transcriptPath: null,
      env: backend === "tmux" ? { tmuxPane: "live" } : {},
    };
    registry.applyHook(hook);
    assert.equal(overlays.size, 2, "both pane overlays are still inside the 30-minute TTL");

    t.mock.timers.tick(2 * 60_000);
    registry.applyHook(hook);
    assert.equal(overlays.has(departedKey), false, "later ingest deletes expired entries regardless of pane-key origin");
    assert.deepEqual([...overlays.keys()], [`${backend}:live`], "the fresh overlay survives the sweep");
    registry.applyDiscovery([live]);
    assert.equal(registry.getSession(live.syntheticId)?.state, "idle");
  });
}

test("keyless hooks cannot retain an overlay for an ambiguous or conflicting conversation", () => {
  const first = mkDiscovered({ syntheticId: "keyless-first", agent: "pi", agentSessionId: "first-conversation",
    terminals: [mkMuxHandle({ backend: "herdr", paneId: "first" })] });
  const second = mkDiscovered({ syntheticId: "keyless-second", agent: "pi", agentSessionId: "second-conversation",
    terminals: [mkMuxHandle({ backend: "herdr", paneId: "second" })] });
  for (const sessions of [[first, second], [first]]) {
    const registry = new Registry();
    registry.applyDiscovery(sessions);
    registry.applyHook({ agent: "pi", event: "Stop", sessionId: "unrelated-conversation",
      cwd: first.cwd, transcriptPath: null, env: {} });
    registry.applyDiscovery(sessions);
    for (const session of sessions) {
      assert.equal(registry.getSession(session.syntheticId)?.state, "working");
      assert.equal(registry.getSession(session.syntheticId)?.instrumented, false);
    }
  }
});

test("native Pi effort changes survive the session SSE comparator", () => {
  const registry = new Registry();
  registry.applyDiscovery([mkDiscovered({ syntheticId: "native-effort", agent: "pi" })]);
  const base = { sessionId: "native-effort-id", cwd: "/wt/one", env: { tmuxPane: PANE } };
  registry.applyStatusLine({ ...base, nativeEffort: "minimal", ts: 1 });
  const minimal = registry.getSession("native-effort")!;
  registry.applyStatusLine({ ...base, nativeEffort: "off", thinkingEnabled: false, ts: 2 });
  const off = registry.getSession("native-effort")!;
  assert.equal(minimal.meta?.nativeEffort, "minimal");
  assert.equal(off.meta?.nativeEffort, "off");
  assert.equal(sessionEqual(minimal, off), false);
  registry.applyStatusLine({ ...base, effort: "high", ts: 3 });
  assert.equal(registry.getSession("native-effort")?.meta?.nativeEffort, null);
});
