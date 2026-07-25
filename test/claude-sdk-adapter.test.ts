import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeSdkSpec, askUserQuestions, permissionPrompt, sdkPermissionMode } from "../src/server/harness/claude/sdk.ts";
import { sdkSubprocessEnv } from "../src/server/harness/claude/sdk-deps.ts";
import { driverDialog } from "../src/server/sdk/dialog.ts";
import type {
  ClaudeSdkDeps,
  ClaudeSdkMessage,
  ClaudeSdkPermissionResult,
  ClaudeSdkQuery,
  ClaudeSdkQueryOptions,
  ClaudeSdkUserMessage,
} from "../src/server/harness/claude/sdk-types.ts";
import type { SdkEvent } from "../src/server/harness/types.ts";

// What is at stake: this adapter is the only thing standing between the vendor's message
// stream and every surface in the app. If a permission callback is projected wrongly, a
// human clicks "No" and an agent is told yes; if a `/clear` rotation is missed, the card's
// note, queue and goal are stranded on a dead key; if an exit is swallowed, a card sits on
// the dashboard with a Send button that lies.
//
// It is driven here on a SCRIPTED message stream, with no `claude` binary anywhere - the
// `PaneDeps.pane` pattern applied to a subprocess. That is the whole reason `ClaudeSdkDeps`
// exists: everything under test below is the real projection code, the real pending-request
// bookkeeping and the real answer mapping, exercised without spawning an agent (which the
// first version of this suite did by accident, and which is why `restore` is now pointed at
// an unresumable row in `sdk-db.test.ts`).

/** A hand-driven query: frames go in when the test says so, controls are recorded. */
class FakeQuery implements ClaudeSdkQuery {
  readonly control: string[] = [];
  private queued: ClaudeSdkMessage[] = [];
  private waiting: ((m: IteratorResult<ClaudeSdkMessage>) => void) | null = null;
  private done = false;

  emit(message: ClaudeSdkMessage): void {
    const waiter = this.waiting;
    if (waiter) {
      this.waiting = null;
      waiter({ value: message, done: false });
      return;
    }
    this.queued.push(message);
  }

  end(): void {
    this.done = true;
    const waiter = this.waiting;
    if (waiter) {
      this.waiting = null;
      waiter({ value: undefined as never, done: true });
    }
  }

  async interrupt(): Promise<unknown> {
    this.control.push("interrupt");
    return undefined;
  }

  async setPermissionMode(mode: string): Promise<void> {
    this.control.push(`mode:${mode}`);
  }

  async setModel(model?: string): Promise<void> {
    this.control.push(`model:${model}`);
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<ClaudeSdkMessage> {
    for (;;) {
      const next = this.queued.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.done) return;
      const m = await new Promise<IteratorResult<ClaudeSdkMessage>>((r) => {
        this.waiting = r;
      });
      if (m.done) return;
      yield m.value;
    }
  }
}

interface Harnessed {
  query: FakeQuery;
  options: ClaudeSdkQueryOptions;
  /** Everything the streaming input has been handed, in order. */
  turns: ClaudeSdkUserMessage[];
}

function fakeDeps(): { deps: ClaudeSdkDeps; started: Promise<Harnessed> } {
  const query = new FakeQuery();
  let resolveStarted: (h: Harnessed) => void;
  const started = new Promise<Harnessed>((r) => {
    resolveStarted = r;
  });
  const deps: ClaudeSdkDeps = {
    executable: async () => "/fake/bin/claude",
    env: () => ({ PATH: "/usr/bin" }),
    query: async ({ prompt, options }) => {
      const turns: ClaudeSdkUserMessage[] = [];
      // Drain the streaming input in the background, exactly as the real CLI does. This is
      // what makes `send()` observable at all: it resolves when the message is ACCEPTED.
      void (async () => {
        for await (const turn of prompt) turns.push(turn);
      })();
      resolveStarted({ query, options, turns });
      return query;
    },
  };
  return { deps, started };
}

/** Collect events until `stop` says we have what the test is about. */
async function collect(
  events: AsyncIterable<SdkEvent>,
  stop: (e: SdkEvent) => boolean,
): Promise<SdkEvent[]> {
  const out: SdkEvent[] = [];
  for await (const e of events) {
    out.push(e);
    if (stop(e)) break;
  }
  return out;
}

const INIT = (sessionId: string): ClaudeSdkMessage => ({
  type: "system",
  subtype: "init",
  session_id: sessionId,
});

function launchOpts(over: Record<string, unknown> = {}) {
  return {
    cwd: "/wt/one",
    prompt: "do the thing",
    model: null,
    effort: null,
    permissionMode: null,
    mcp: null,
    resume: null,
    ...over,
  } as Parameters<ReturnType<typeof claudeSdkSpec>["launch"]>[0];
}

test("the launch pins the binary, seeds turn one, and binds on init", async () => {
  const { deps, started } = fakeDeps();
  const handle = await claudeSdkSpec(deps).launch(launchOpts({ permissionMode: "auto" }));
  const { query, options, turns } = await started;

  // Pinned, never left to the SDK's own detection - which would fall back to the native CLI
  // inside the npm package, a different build from the one the operator logged in with.
  assert.equal(options.pathToClaudeCodeExecutable, "/fake/bin/claude");
  assert.equal(options.cwd, "/wt/one");
  assert.equal(options.permissionMode, "auto");
  // The ask channel's disallow and redirect are deliberately NOT rendered: an embedded
  // session's questions are answered on the card, which is what the redirect approximated.
  assert.ok(!("disallowedTools" in options), "AskUserQuestion must stay available");

  query.emit(INIT("agent-1"));
  const events = await collect(handle.events, (e) => e.kind === "bound");
  const bound = events.find((e) => e.kind === "bound");
  assert.equal(bound?.kind === "bound" && bound.agentSessionId, "agent-1");
  // No separate process to name: the SDK owns its subprocess, and 0 is the sentinel
  // `signalProcess` refuses.
  assert.equal(bound?.kind === "bound" && bound.pid, null);

  // The intent IS turn one - there is no paste to verify and no retry to get wrong.
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(turns.length, 1);
  assert.equal((turns[0]!.message.content as string), "do the thing");
  // And delivery is the transition to working, said before any assistant frame arrives.
  assert.ok(events.some((e) => e.kind === "state" && e.state === "working"));
});

test("an ordinary tool becomes a permission ask, and Yes allows it", async () => {
  const { deps, started } = fakeDeps();
  const handle = await claudeSdkSpec(deps).launch(launchOpts());
  const { query, options } = await started;
  query.emit(INIT("agent-1"));

  let resolved: ClaudeSdkPermissionResult | null = null;
  const pending = options.canUseTool(
    "Bash",
    { command: "rm -rf build" },
    {
      requestId: "req-1",
      signal: new AbortController().signal,
      title: "Claude wants to run a command",
      suggestions: [{ type: "addRules" }],
    },
  );
  void pending.then((r) => (resolved = r));

  const events = await collect(handle.events, (e) => e.kind === "request");
  const request = events.find((e) => e.kind === "request");
  assert.ok(request?.kind === "request");
  assert.equal(request.request.kind, "permission");
  // Three rows, because the CLI offered suggestions: the always-allow row exists only when
  // there is a real rule set behind it to persist.
  assert.deepEqual(
    request.request.options.map((o) => o.label),
    ["Yes", "Yes, and don't ask again", "No"],
  );
  // The prompt leads with the bridge's own sentence and carries the command underneath.
  assert.match(request.request.prompt, /Claude wants to run a command/);
  assert.match(request.request.prompt, /rm -rf build/);

  await handle.answer("req-1", { kind: "option", number: 1, label: "Yes" });
  await pending;
  assert.deepEqual(resolved, { behavior: "allow" });
});

test("the always-allow row hands back the CLI's own suggestions, and No denies", async () => {
  const { deps, started } = fakeDeps();
  const handle = await claudeSdkSpec(deps).launch(launchOpts());
  const { query, options } = await started;
  query.emit(INIT("agent-1"));
  const suggestions = [{ type: "addRules", rules: [{ toolName: "Bash" }] }];

  const always = options.canUseTool(
    "Bash",
    { command: "ls" },
    { requestId: "a", signal: new AbortController().signal, suggestions },
  );
  await collect(handle.events, (e) => e.kind === "request");
  await handle.answer("a", { kind: "option", number: 2, label: "Yes, and don't ask again" });
  // Verbatim: the rule set is the CLI's, composed for this exact call, and rewriting it here
  // would persist a permission nobody chose.
  assert.deepEqual(await always, { behavior: "allow", updatedPermissions: suggestions });

  const denied = options.canUseTool(
    "Bash",
    { command: "ls" },
    { requestId: "b", signal: new AbortController().signal },
  );
  await collect(handle.events, (e) => e.kind === "request");
  await handle.answer("b", { kind: "option", number: 2, label: "No" });
  const result = await denied;
  assert.equal(result.behavior, "deny");
});

test("a mislabelled row is refused rather than answered", async () => {
  const { deps, started } = fakeDeps();
  const handle = await claudeSdkSpec(deps).launch(launchOpts());
  const { query, options } = await started;
  query.emit(INIT("agent-1"));
  void options.canUseTool(
    "Bash",
    { command: "ls" },
    { requestId: "c", signal: new AbortController().signal },
  );
  await collect(handle.events, (e) => e.kind === "request");

  // The number identifies and the label VERIFIES. A caller answering row 1 while believing
  // it says something else has confirmed nothing, and confirming it anyway is how a
  // permission prompt gets the opposite of the answer a human gave.
  await assert.rejects(
    () => handle.answer("c", { kind: "option", number: 1, label: "No" }),
    /is "Yes", not "No"/,
  );
  await assert.rejects(
    () => handle.answer("nope", { kind: "option", number: 1, label: "Yes" }),
    /no pending request/,
  );
});

test("AskUserQuestion becomes a form, and the answers map goes back as updatedInput", async () => {
  const { deps, started } = fakeDeps();
  const handle = await claudeSdkSpec(deps).launch(launchOpts());
  const { query, options } = await started;
  query.emit(INIT("agent-1"));

  const input = {
    questions: [
      {
        question: "Which linter?",
        header: "Linter",
        multiSelect: false,
        options: [
          { label: "biome", description: "one binary" },
          { label: "eslint", description: "widest plugins" },
        ],
      },
      {
        question: "Which checks?",
        header: "Checks",
        multiSelect: true,
        options: [
          { label: "types", description: "tsc" },
          { label: "tests", description: "node:test" },
        ],
      },
    ],
  };
  const pending = options.canUseTool("AskUserQuestion", input, {
    requestId: "q1",
    signal: new AbortController().signal,
  });
  const events = await collect(handle.events, (e) => e.kind === "request");
  const request = events.find((e) => e.kind === "request");
  assert.ok(request?.kind === "request");
  assert.equal(request.request.kind, "question");
  assert.equal(request.request.questions?.length, 2);
  // A form's rows live on its questions. Flattened into one numbered list they would be
  // numbers the driver cannot map back - which is exactly why `driverDialog` refuses to.
  assert.deepEqual(request.request.options, []);
  const dialog = driverDialog(request.request);
  assert.equal(dialog.multiSelect, true);
  assert.deepEqual(dialog.options, []);
  assert.equal(dialog.questions?.[1]?.multiSelect, true);

  await handle.answer("q1", {
    kind: "form",
    answers: [
      { question: "Which linter?", labels: ["biome"] },
      { question: "Which checks?", labels: ["types", "tests"] },
    ],
  });
  const result = await pending;
  assert.equal(result.behavior, "allow");
  // The tool's own encoding: one string per question, several labels comma-joined. And the
  // rest of the input is preserved - `updatedInput` REPLACES the call's arguments.
  assert.deepEqual(result.behavior === "allow" && result.updatedInput, {
    ...input,
    answers: { "Which linter?": "biome", "Which checks?": "types, tests" },
  });
});

test("a form refuses a half answer and a single-select given two", async () => {
  const { deps, started } = fakeDeps();
  const handle = await claudeSdkSpec(deps).launch(launchOpts());
  const { query, options } = await started;
  query.emit(INIT("agent-1"));
  void options.canUseTool(
    "AskUserQuestion",
    {
      questions: [
        { question: "A?", multiSelect: false, options: [{ label: "x" }, { label: "y" }] },
        { question: "B?", multiSelect: false, options: [{ label: "p" }, { label: "q" }] },
      ],
    },
    { requestId: "f", signal: new AbortController().signal },
  );
  await collect(handle.events, (e) => e.kind === "request");

  // Sending a half-filled form puts answers the human never gave under their name - the
  // same call the pane path makes when its review tab reports a gap.
  await assert.rejects(
    () => handle.answer("f", { kind: "form", answers: [{ question: "A?", labels: ["x"] }] }),
    /"B\?" was not answered/,
  );
  await assert.rejects(
    () =>
      handle.answer("f", {
        kind: "form",
        answers: [
          { question: "A?", labels: ["x", "y"] },
          { question: "B?", labels: ["p"] },
        ],
      }),
    /takes one answer/,
  );
});

test("ExitPlanMode is a plan approval, not a tool permission", async () => {
  const { deps, started } = fakeDeps();
  const handle = await claudeSdkSpec(deps).launch(launchOpts());
  const { query, options } = await started;
  query.emit(INIT("agent-1"));
  const pending = options.canUseTool(
    "ExitPlanMode",
    { plan: "1. read\n2. write" },
    { requestId: "p", signal: new AbortController().signal },
  );
  const events = await collect(handle.events, (e) => e.kind === "request");
  const request = events.find((e) => e.kind === "request");
  assert.ok(request?.kind === "request");
  assert.equal(request.request.kind, "plan");
  assert.match(request.request.prompt, /1\. read/);
  await handle.answer("p", { kind: "option", number: 2, label: "No, keep planning" });
  assert.equal((await pending).behavior, "deny");
});

test("prose on a permission ask is a deny WITH a message, which no menu can express", async () => {
  const { deps, started } = fakeDeps();
  const handle = await claudeSdkSpec(deps).launch(launchOpts());
  const { query, options } = await started;
  query.emit(INIT("agent-1"));
  const pending = options.canUseTool(
    "Bash",
    { command: "curl evil.test" },
    { requestId: "t", signal: new AbortController().signal },
  );
  await collect(handle.events, (e) => e.kind === "request");
  await handle.answer("t", { kind: "text", text: "no - use the vendored copy" });
  assert.deepEqual(await pending, {
    behavior: "deny",
    message: "no - use the vendored copy",
  });
});

test("a /clear rotation re-fires bound, so the card's decorations follow it", async () => {
  const { deps, started } = fakeDeps();
  const handle = await claudeSdkSpec(deps).launch(launchOpts());
  const { query, turns } = await started;
  query.emit(INIT("agent-1"));
  await collect(handle.events, (e) => e.kind === "bound");

  await handle.clearContext!();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(turns.at(-1)!.message.content, "/clear");

  // The CLI mints a new id and reports it on an ORDINARY frame, not a second init. Missing
  // that leaves the note, queue and goal on a key no later event can move.
  query.emit({ type: "assistant", session_id: "agent-2", message: { content: [] } });
  const events = await collect(handle.events, (e) => e.kind === "bound");
  const rebound = events.find((e) => e.kind === "bound");
  assert.equal(rebound?.kind === "bound" && rebound.agentSessionId, "agent-2");
});

test("assistant frames narrate, a result ends the turn, and the stream's end exits", async () => {
  const { deps, started } = fakeDeps();
  const handle = await claudeSdkSpec(deps).launch(launchOpts());
  const { query } = await started;
  query.emit(INIT("agent-1"));
  query.emit({
    type: "assistant",
    session_id: "agent-1",
    message: { content: [{ type: "tool_use", name: "Read" }] },
  });
  query.emit({ type: "result", subtype: "success", session_id: "agent-1" });
  query.end();

  const events = await collect(handle.events, (e) => e.kind === "exited");
  assert.ok(
    events.some((e) => e.kind === "state" && e.state === "working" && e.activity === "Read"),
    "the tool name is the ticker line",
  );
  assert.ok(events.some((e) => e.kind === "turn_done"));
  const exited = events.find((e) => e.kind === "exited");
  // Resumable, because it bound: there is an id on disk to pick back up after a restart.
  assert.equal(exited?.kind === "exited" && exited.resumable, true);
});

test("a session that never bound exits unresumable", async () => {
  const { deps, started } = fakeDeps();
  const handle = await claudeSdkSpec(deps).launch(launchOpts());
  const { query } = await started;
  query.end();
  const events = await collect(handle.events, (e) => e.kind === "exited");
  const exited = events.find((e) => e.kind === "exited");
  assert.equal(exited?.kind === "exited" && exited.resumable, false);
});

test("stop denies what is parked, so the CLI is never left waiting on an answer", async () => {
  const { deps, started } = fakeDeps();
  const handle = await claudeSdkSpec(deps).launch(launchOpts());
  const { query, options } = await started;
  query.emit(INIT("agent-1"));
  const pending = options.canUseTool(
    "Bash",
    { command: "ls" },
    { requestId: "s", signal: new AbortController().signal },
  );
  await collect(handle.events, (e) => e.kind === "request");
  await handle.stop();
  // Left unanswered, the subprocess hangs on exit holding a control request nothing will
  // ever resolve.
  assert.equal((await pending).behavior, "deny");
  assert.ok(query.control.includes("interrupt"));
});

test("live controls delegate, and a mode this CLI has never heard of is refused", async () => {
  const { deps, started } = fakeDeps();
  const handle = await claudeSdkSpec(deps).launch(launchOpts());
  const { query } = await started;
  query.emit(INIT("agent-1"));
  await handle.setPermissionMode!("acceptEdits");
  await handle.setModel!("claude-opus-5");
  assert.deepEqual(query.control, ["mode:acceptEdits", "model:claude-opus-5"]);
  // `askForApproval` is a Codex profile sharing our union. The SDK validates the value, so
  // passing it through would fail the call for a reason no operator typed.
  await assert.rejects(() => handle.setPermissionMode!("askForApproval"), /no permission mode/);
});

test("the resume argv continues the conversation and states nothing else about it", () => {
  // No `--model` or mode flags ride along: a resumed session carries its own, and
  // re-stating them would silently change a conversation the operator asked to CONTINUE.
  assert.deepEqual([...claudeSdkSpec(fakeDeps().deps).resumeArgv("agent-9")], [
    "--resume",
    "agent-9",
  ]);
});

test("the subprocess env drops the daemon's own pane, or every hook binds to it", () => {
  // Machine-installed `~/.claude/settings.json` hooks fire inside this subprocess too, and
  // the bridge reports TMUX_PANE as the pane it believes it is in. A daemon started from a
  // terminal would hand its own down, and `findSessionByEnv` prefers a pane key over
  // everything else - so every embedded session's hooks would land on one stranger's card.
  const env = sdkSubprocessEnv({ PATH: "/bin", TMUX_PANE: "%3", WEZTERM_PANE: "7", TERM_PROGRAM: "x" });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.TMUX_PANE, undefined);
  assert.equal(env.WEZTERM_PANE, undefined);
  assert.equal(env.TERM_PROGRAM, undefined);
});

test("the pure projections stand on their own", () => {
  // A malformed tool input degrades to nothing rather than to an empty form the human
  // could never submit; the caller then falls through to the permission shape.
  assert.deepEqual(askUserQuestions({}), []);
  assert.deepEqual(askUserQuestions({ questions: [{ question: "", options: [] }] }), []);
  // The bridge's own sentence wins; the tool name is the fallback, never the raw input -
  // which for a Write is a whole file body.
  assert.equal(permissionPrompt("Write", { content: "x".repeat(9000) }, {}), "Claude wants to use Write");
  assert.equal(sdkPermissionMode("readOnly"), null);
  assert.equal(sdkPermissionMode("plan"), "plan");
  assert.equal(sdkPermissionMode(null), null);
});
