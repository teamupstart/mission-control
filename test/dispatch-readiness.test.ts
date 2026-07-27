import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredSession } from "../src/server/discovery/correlate.ts";
import type { Session } from "@shared/types.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";

// "Discovered" is not "ready", and a successful tmux write is not a delivered prompt.
//
// Both were treated as though they were, and a dispatched task paid for it: discovery
// is a `ps` sweep, so it fired ~1.4s after the tmux spawn, a fixed 2s SETTLE_MS was
// taken as "the TUI must be up by now", and the opening prompt was pasted at
// 13:58:33.418 into an agent whose SessionStart hook did not fire until 13:58:34.065.
// tmux accepted the write - a pty swallows keystrokes just as happily when nothing is
// reading - so `injectPrompt` returned ok and the task was marked `running` against a
// session that sat empty for 13 minutes.
//
// These pin the two signals that replace the guesswork for pane-delivered prompts: the first
// hook (proof the agent can read) and the `working` transition (proof it actually did). Pi's
// native launch-message path is pinned separately below and never writes turn one to the pane.

const home = mkdtempSync(join(tmpdir(), "mission-dispatch-readiness-"));
process.env.MISSION_HOME = home;
process.env.MISSION_DISPATCH_ACCEPT_MS = "10";

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { Dispatcher } = await import("../src/server/dispatcher.ts");

after(() => rmSync(home, { recursive: true, force: true }));

openDb();

const CWD = "/wt/task-1";
/** Long enough to prove a wait resolves; short enough that a timeout test is instant. */
const BRIEF_MS = 50;

function mkDiscovered(over: Partial<DiscoveredSession> = {}): DiscoveredSession {
  return {
    syntheticId: "sid",
    agent: "claude",
    name: "work",
    nameSource: "process",
    cwd: CWD,
    gitBranch: "harness/task-1",
    nomistakesGated: false,
    pid: 1,
    tty: "ttys015",
    terminals: [mkMuxHandle({ session: "s", windowName: "w", windowIndex: 0, paneId: "%1" })],
    startedAt: 0,
    ...over,
  } as DiscoveredSession;
}

/** The hook the agent fires once its input loop exists. */
function sessionStart(registry: InstanceType<typeof Registry>, paneId = "%1"): void {
  registry.applyHook({
    agent: "claude",
    event: "SessionStart",
    sessionId: "agent-1",
    cwd: CWD,
    transcriptPath: null,
    env: { tmuxPane: paneId },
  });
}

test("waitForSessionAtCwd resolves on bare process discovery - it proves nothing about readiness", async () => {
  // Not a complaint about this method, a statement of its contract. This resolving
  // while `hooksSeen` is false IS the 647ms window the old dispatcher typed into.
  const registry = new Registry();
  registry.applyDiscovery([mkDiscovered({ syntheticId: "disc-1" })]);

  const s = await registry.waitForSessionAtCwd(CWD, BRIEF_MS);
  assert.ok(s, "the process is there");
  assert.equal(s?.hooksSeen, false, "...and it has not yet said it can read anything");
});

test("a dispatched pi launch binds its injected native session id", () => {
  const registry = new Registry();
  registry.applyDiscovery([
    mkDiscovered({ syntheticId: "pi-launched", agent: "pi", cwd: "/wt/pi-task" }),
  ]);

  const bound = registry.bindLaunchedAgentSession(
    "pi-launched",
    "pi",
    "019f7d35-beb8-7ae4-8b33-049e4f65cacd",
  );

  assert.equal(bound?.agentSessionId, "019f7d35-beb8-7ae4-8b33-049e4f65cacd");
  assert.equal(bound?.hooksSeen, false);
  assert.equal(registry.getSession("pi-launched")?.agentSessionId, bound?.agentSessionId);
});

test("the dispatcher does not wait for pi's lazily-created transcript", async () => {
  const registry = new Registry();
  registry.applyDiscovery([
    mkDiscovered({ syntheticId: "pi-ready", agent: "pi", cwd: "/wt/pi-ready" }),
  ]);
  const discovered = registry.getSession("pi-ready") as Session;
  const settles: number[] = [];
  const dispatcher = new Dispatcher(registry, undefined, {
    sleep: async (ms) => {
      settles.push(ms);
    },
  });
  const awaitReady = (
    dispatcher as unknown as {
      awaitReady(
        cwd: string,
        session: Session,
        prepared: boolean,
      ): Promise<{
        session: Session;
        instrumented: boolean;
      }>;
    }
  ).awaitReady.bind(dispatcher);

  const ready = await awaitReady("/wt/pi-ready", discovered, true);
  assert.equal(ready.session.id, "pi-ready");
  assert.equal(ready.instrumented, false);
  assert.deepEqual(settles, [2000]);
});

test("waitForReadySessionAtCwd does NOT resolve on discovery alone", async () => {
  const registry = new Registry();
  registry.applyDiscovery([mkDiscovered({ syntheticId: "boot-1" })]);

  // The whole fix in one assertion: a booting agent is not a ready one.
  assert.equal(await registry.waitForReadySessionAtCwd(CWD, "boot-1", BRIEF_MS), null);
});

test("waitForReadySessionAtCwd resolves once the agent's first hook lands", async () => {
  const registry = new Registry();
  registry.applyDiscovery([mkDiscovered({ syntheticId: "boot-2" })]);

  const ready = registry.waitForReadySessionAtCwd(CWD, "boot-2", 5000);
  sessionStart(registry); // the TUI is up, ~4s after exec in the real trace
  const s = await ready;

  assert.ok(s, "a hook fired, so the input loop exists");
  assert.equal(s?.hooksSeen, true);
});

test("waitForReadySessionAtCwd short-circuits for an agent that is ALREADY hooked", async () => {
  // A re-dispatch into a live session must not wait for a hook that already fired.
  const registry = new Registry();
  registry.applyDiscovery([mkDiscovered({ syntheticId: "warm-1" })]);
  sessionStart(registry);

  const s = await registry.waitForReadySessionAtCwd(CWD, "warm-1", BRIEF_MS);
  assert.equal(s?.hooksSeen, true);
});

test("a null from waitForReadySessionAtCwd means no evidence, not 'not ready'", async () => {
  // An agent with no hooks installed can never satisfy this, and refusing to dispatch
  // to it would be a regression - so the dispatcher falls back to the old fixed sleep
  // on exactly this null. Pinned so nobody "fixes" the null into a throw.
  const registry = new Registry();
  registry.applyDiscovery([mkDiscovered({ syntheticId: "hookless-1" })]);

  assert.equal(await registry.waitForReadySessionAtCwd(CWD, "hookless-1", BRIEF_MS), null);
  assert.equal(registry.getSession("hookless-1")?.state !== "exited", true, "it is alive and well");
});

test("waitForReadySessionAtCwd stops waiting when the discovered process exits", async () => {
  // The registry deliberately lingers exited sessions so the dashboard can show the
  // transition. That retained snapshot still carries its old pane id, but it is not a
  // dispatch target. The readiness wait must surface the exit instead of spending the
  // full hook timeout and handing that stale pane back to the dispatcher.
  const registry = new Registry();
  registry.applyDiscovery([mkDiscovered({ syntheticId: "exited-1" })]);

  const startedAt = Date.now();
  const ready = registry.waitForReadySessionAtCwd(CWD, "exited-1", 5000);
  registry.applyDiscovery([]);

  assert.equal(await ready, null);
  assert.ok(Date.now() - startedAt < 1000, "an observed exit should end the readiness wait");
  assert.equal(registry.getSession("exited-1")?.state, "exited", "the lingered snapshot remains visible");
});

test("waitForReadySessionAtCwd observes an exit that happened before subscription", async () => {
  const registry = new Registry();
  registry.applyDiscovery([mkDiscovered({ syntheticId: "already-exited" })]);
  registry.applyDiscovery([]);

  const startedAt = Date.now();
  const ready = await registry.waitForReadySessionAtCwd(CWD, "already-exited", 5000);

  assert.equal(ready, null);
  assert.ok(Date.now() - startedAt < 1000, "an earlier exit should not spend the readiness timeout");
});

test("the dispatcher skips its fallback settle after readiness observes an exit", async () => {
  const registry = new Registry();
  registry.applyDiscovery([mkDiscovered({ syntheticId: "settle-exited" })]);
  const discovered = registry.getSession("settle-exited") as Session;
  const dispatcher = new Dispatcher(registry);
  const awaitReady = (
    dispatcher as unknown as {
      awaitReady(cwd: string, session: Session): Promise<{ session: Session }>;
    }
  ).awaitReady.bind(dispatcher);

  const startedAt = Date.now();
  const ready = awaitReady(CWD, discovered);
  registry.applyDiscovery([]);

  await assert.rejects(ready, /agent session exited before the initial prompt could be sent/);
  assert.ok(
    Date.now() - startedAt < 1000,
    "an observed exit should not spend the fallback settle interval",
  );
});

test("waitForSessionAtCwd does not accept an exited upsert", async () => {
  const source = new Registry();
  source.applyDiscovery([mkDiscovered({ syntheticId: "retained-exit" })]);
  source.applyDiscovery([]);
  const exited = source.getSession("retained-exit") as Session;
  const registry = new Registry();

  const waiting = registry.waitForSessionAtCwd(CWD, BRIEF_MS);
  registry.emit("event", { type: "session_upsert", session: exited });

  assert.equal(await waiting, null);
});

test("the dispatcher does not retry delivery through an evicted session snapshot", async () => {
  const session = { id: "retry-exited", state: "idle" } as Session;
  let live: Session | undefined = session;
  let sends = 0;
  const registry = {
    getSession: () => live,
    waitForPromptAcceptedAtCwd: () => Promise.resolve(false),
  } as unknown as InstanceType<typeof Registry>;
  const dispatcher = new Dispatcher(
    registry,
    undefined,
    {
      inject: async () => {
        sends += 1;
        live = undefined;
        return { ok: true, pasted: true, submitVerified: true };
      },
    },
  );
  const deliverIntent = (
    dispatcher as unknown as {
      deliverIntent(id: string, intent: string, cwd: string, instrumented: boolean): Promise<void>;
    }
  ).deliverIntent.bind(dispatcher);

  await assert.rejects(
    deliverIntent(session.id, "do the work", CWD, true),
    /agent session exited before the initial prompt could be sent/,
  );
  assert.equal(sends, 1);
});

test("the dispatcher creates no acknowledgement listener for an already-exited session", async () => {
  let waits = 0;
  let sends = 0;
  const registry = {
    getSession: () => undefined,
    waitForPromptAcceptedAtCwd: () => {
      waits += 1;
      return Promise.resolve(false);
    },
  } as unknown as InstanceType<typeof Registry>;
  const dispatcher = new Dispatcher(
    registry,
    undefined,
    {
      inject: async () => {
        sends += 1;
        return { ok: true, pasted: true, submitVerified: true };
      },
    },
  );
  const deliverIntent = (
    dispatcher as unknown as {
      deliverIntent(id: string, intent: string, cwd: string, instrumented: boolean): Promise<void>;
    }
  ).deliverIntent.bind(dispatcher);

  await assert.rejects(
    deliverIntent("already-exited", "do the work", CWD, true),
    /agent session exited before the initial prompt could be sent/,
  );
  assert.equal(waits, 0, "no listener should survive until the acknowledgement timeout");
  assert.equal(sends, 0);
});

test("the dispatcher cancels acknowledgement listeners when injection does not complete", async (t) => {
  for (const name of ["failed result", "thrown error"] as const) {
    await t.test(name, async () => {
      const registry = new Registry();
      registry.applyDiscovery([mkDiscovered({ syntheticId: `inject-${name}` })]);
      const listenersBefore = registry.listenerCount("event");
      const dispatcher = new Dispatcher(
        registry,
        undefined,
        {
          inject: async () => {
            await Promise.resolve();
            registry.applyDiscovery([]);
            if (name === "thrown error") throw new Error("terminal write crashed");
            return {
              ok: false,
              error: "pane disappeared",
              pasted: false,
              submitVerified: false,
            };
          },
        },
      );
      const deliverIntent = (
        dispatcher as unknown as {
          deliverIntent(id: string, intent: string, cwd: string, instrumented: boolean): Promise<void>;
        }
      ).deliverIntent.bind(dispatcher);

      await assert.rejects(deliverIntent(`inject-${name}`, "do the work", CWD, true));
      assert.equal(registry.listenerCount("event"), listenersBefore);
    });
  }
});

test("waitForPromptAcceptedAtCwd resolves true on the working transition", async () => {
  const registry = new Registry();
  registry.applyDiscovery([mkDiscovered({ syntheticId: "accept-1" })]);
  sessionStart(registry);

  // Subscribe BEFORE typing - the hook can beat the caller's next line.
  const accepted = registry.waitForPromptAcceptedAtCwd(CWD, 5000);
  registry.applyHook({
    agent: "claude",
    event: "UserPromptSubmit",
    sessionId: "agent-1",
    cwd: CWD,
    transcriptPath: null,
    env: { tmuxPane: "%1" },
  });

  assert.equal(await accepted, true);
});

test("waitForPromptAcceptedAtCwd resolves false when the agent just sits there", async () => {
  // The observed failure: text written to the pty, agent never ingests it, state stays
  // idle. This false is what turns a silent lie into a loud dispatch failure.
  const registry = new Registry();
  registry.applyDiscovery([mkDiscovered({ syntheticId: "swallow-1" })]);
  sessionStart(registry);

  assert.equal(await registry.waitForPromptAcceptedAtCwd(CWD, BRIEF_MS), false);
});

test("waitForPromptAcceptedAtCwd ignores a `working` session at a DIFFERENT cwd", async () => {
  // Worktrees are one-per-task, and that isolation is what makes cwd a safe key here.
  const registry = new Registry();
  registry.applyDiscovery([
    mkDiscovered({ syntheticId: "mine-1" }),
    mkDiscovered({ syntheticId: "other-1", cwd: "/wt/task-2", terminals: [mkMuxHandle({ session: "o", paneId: "%2" })] }),
  ]);

  const accepted = registry.waitForPromptAcceptedAtCwd(CWD, BRIEF_MS);
  registry.applyHook({
    agent: "claude",
    event: "UserPromptSubmit",
    sessionId: "agent-2",
    cwd: "/wt/task-2",
    transcriptPath: null,
    env: { tmuxPane: "%2" },
  });

  assert.equal(await accepted, false, "someone else's prompt is not evidence about mine");
});
