import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  codexSdkSpec,
  commandApprovalPrompt,
  fileChangeSummary,
  itemActivity,
  turnInput,
  userInputQuestions,
} from "../src/server/harness/codex/sdk.ts";
import { readFrames, spawnAppServer } from "../src/server/harness/codex/sdk-deps.ts";
import { driverDialog } from "../src/server/sdk/dialog.ts";
import type { AppServerTransport } from "../src/server/harness/codex/app-server/client.ts";
import type { SdkEvent, SdkSessionHandle } from "../src/server/harness/types.ts";

// What is at stake: this adapter is the only thing standing between `codex app-server` and
// every surface in the app, and three of its decisions are the difference between an
// embedded Codex session that works and one that silently does not.
//
// A turn delivered with `turn/start` while another is running is ACCEPTED by the server,
// handed a fresh turn id, and then never run - so a `send` that chose wrongly would report
// success for a message the agent never reads. An approval answered against the wrong row
// tells the agent yes when a human clicked No. And a `clearContext` that did not re-bind
// would strand the card's note, queue, goal and work episode on a dead thread id.
//
// Everything below drives the REAL client, the REAL projections and the REAL answer mapping
// over scripted JSON-RPC frames - the `PaneDeps.pane` pattern applied to a subprocess - so
// no `codex` binary is involved. The frames themselves are copied from a live capture
// against codex-cli 0.145.0 (see `docs/plans/agent-sdk-sessions/phase-4-codex-driver.md`).

/**
 * A hand-driven app-server: every frame we send is recorded, and the test decides what
 * comes back.
 *
 * Responses are keyed by METHOD rather than by id, because that is what a test wants to
 * say ("thread/start answers with this thread"), and the client's id correlation is one of
 * the things under test - a fake that echoed ids from a different source would hide a
 * mismatch rather than catch it.
 */
class FakeServer implements AppServerTransport {
  readonly sent: Array<Record<string, unknown>> = [];
  pid = 4242;
  closed = false;
  private queued: unknown[] = [];
  private waiting: ((m: IteratorResult<unknown>) => void) | null = null;
  private ended = false;

  constructor(private readonly replies: Record<string, unknown | ((params: unknown) => unknown)>) {}

  send(frame: unknown): void {
    const msg = frame as Record<string, unknown>;
    this.sent.push(msg);
    const method = typeof msg.method === "string" ? msg.method : null;
    if (!method || msg.id === undefined) return;
    const reply = this.replies[method];
    if (reply === undefined) {
      this.push({ id: msg.id, error: { code: -32601, message: `no fake reply for ${method}` } });
      return;
    }
    const result = typeof reply === "function" ? (reply as (p: unknown) => unknown)(msg.params) : reply;
    this.push({ id: msg.id, result });
  }

  /** A frame from the server: a notification, or a request for us to answer. */
  push(frame: unknown): void {
    if (this.ended) return;
    const waiter = this.waiting;
    if (waiter) {
      this.waiting = null;
      waiter({ value: frame, done: false });
      return;
    }
    this.queued.push(frame);
  }

  notify(method: string, params: unknown): void {
    this.push({ method, params });
  }

  end(): void {
    this.ended = true;
    const waiter = this.waiting;
    if (waiter) {
      this.waiting = null;
      waiter({ value: undefined, done: true });
    }
  }

  get frames(): AsyncIterable<unknown> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const next = self.queued.shift();
          if (next !== undefined) {
            yield next;
            continue;
          }
          if (self.ended) return;
          const m = await new Promise<IteratorResult<unknown>>((r) => {
            self.waiting = r;
          });
          if (m.done) return;
          yield m.value;
        }
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.end();
  }

  /** Every request frame for one method, in order. */
  calls(method: string): Array<Record<string, unknown>> {
    return this.sent.filter((f) => f.method === method);
  }

  /** The one response we wrote for a server-to-client request id. */
  responseTo(id: number): Record<string, unknown> | undefined {
    return this.sent.find((f) => f.id === id && f.method === undefined);
  }
}

const THREAD = {
  id: "019f9b12-6914-7472-9771-7a5ed58d0163",
  path: "/Users/x/.codex/sessions/2026/07/25/rollout-2026-07-25T16-58-22-019f9b12.jsonl",
};

const SECOND_THREAD = {
  id: "019f9b1f-bdda-7190-b53a-a3318a3bb538",
  path: "/Users/x/.codex/sessions/2026/07/25/rollout-2026-07-25T17-12-56-019f9b1f.jsonl",
};

function threadResponse(thread: { id: string; path: string }, sandbox = "workspaceWrite") {
  return {
    thread: { ...thread, status: { type: "idle" }, turns: [] },
    model: "gpt-5.6-sol",
    modelProvider: "openai",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: { type: sandbox, writableRoots: [], networkAccess: false },
    reasoningEffort: "high",
  };
}

function defaultReplies(overrides: Record<string, unknown> = {}) {
  let turns = 0;
  return {
    initialize: { userAgent: "codex/0.145.0", codexHome: "/Users/x/.codex" },
    "thread/start": threadResponse(THREAD),
    "thread/resume": threadResponse(THREAD),
    "turn/start": () => ({ turn: { id: `turn-${++turns}`, status: "inProgress" } }),
    "turn/steer": () => ({ turnId: `turn-${turns}` }),
    "turn/interrupt": {},
    ...overrides,
  };
}

/** Launch a session on a scripted server and start collecting its events. */
async function launch(
  server: FakeServer,
  opts: Partial<Parameters<ReturnType<typeof codexSdkSpec>["launch"]>[0]> = {},
): Promise<{ handle: SdkSessionHandle; events: SdkEvent[]; drained: Promise<void> }> {
  const spec = codexSdkSpec({ connect: async () => server });
  const handle = await spec.launch({
    cwd: "/work/repo",
    prompt: "do the thing",
    model: null,
    effort: null,
    permissionMode: null,
    mcp: null,
    resume: null,
    ...opts,
  });
  const events: SdkEvent[] = [];
  const drained = (async () => {
    for await (const evt of handle.events) events.push(evt);
  })();
  return { handle, events, drained };
}

/** Let queued microtasks and the event pump settle. */
const settle = () => new Promise((r) => setTimeout(r, 5));

test("a launch initializes, starts a thread, binds it, and delivers turn one", async () => {
  const server = new FakeServer(defaultReplies());
  const { handle, events, drained } = await launch(server);
  await settle();

  const init = server.calls("initialize")[0];
  assert.ok(init, "no initialize was sent");
  const caps = (init.params as { capabilities: { optOutNotificationMethods: string[] } }).capabilities;
  // The delta firehose is muted at the handshake rather than filtered after it: these are
  // per-token frames on a stream this process parses line by line.
  assert.ok(caps.optOutNotificationMethods.includes("item/agentMessage/delta"));
  assert.ok(caps.optOutNotificationMethods.includes("turn/moderationMetadata"));

  // `bound` is what keeps the whole file-based read path working, and the rollout path is
  // REPORTED by the server rather than derived - that is the C5 guarantee for Codex.
  const bound = events.find((e) => e.kind === "bound");
  assert.deepEqual(bound, {
    kind: "bound",
    agentSessionId: THREAD.id,
    transcriptPath: THREAD.path,
    pid: 4242,
  });

  const turn = server.calls("turn/start")[0];
  assert.deepEqual((turn?.params as { input: unknown[] }).input, [
    { type: "text", text: "do the thing", text_elements: [] },
  ]);

  await handle.stop();
  await drained;
});

test("a launch with no permission mode sends no posture at all", async () => {
  // The operator's own `~/.codex/config.toml` decides, which is byte-identical to what a
  // terminal dispatch with auto mode off produces. Inventing a sandbox here would silently
  // widen or narrow every embedded session.
  const server = new FakeServer(defaultReplies());
  const { handle, drained } = await launch(server);
  const start = server.calls("thread/start")[0]?.params as Record<string, unknown>;
  assert.deepEqual(start, { cwd: "/work/repo" });
  const turn = server.calls("turn/start")[0]?.params as Record<string, unknown>;
  assert.equal(turn.approvalPolicy, undefined);
  assert.equal(turn.approvalsReviewer, undefined);
  await handle.stop();
  await drained;
});

test("a mode, a model and an effort become thread and turn parameters", async () => {
  const server = new FakeServer(defaultReplies());
  const { handle, drained } = await launch(server, {
    permissionMode: "askForApproval",
    model: "gpt-5.6-sol",
    effort: "high",
  });
  assert.deepEqual(server.calls("thread/start")[0]?.params, {
    cwd: "/work/repo",
    model: "gpt-5.6-sol",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
  });
  // The sandbox is deliberately NOT re-stated per turn: `turn/start` takes a fully resolved
  // policy whose writable roots and network settings are the operator's, not ours.
  const turn = server.calls("turn/start")[0]?.params as Record<string, unknown>;
  assert.equal(turn.sandboxPolicy, undefined);
  assert.equal(turn.approvalPolicy, "on-request");
  assert.equal(turn.effort, "high");
  assert.equal(turn.model, "gpt-5.6-sol");
  await handle.stop();
  await drained;
});

test("a second turn steers while one is running, and starts when the thread is idle", async () => {
  const server = new FakeServer(defaultReplies());
  const { handle, drained } = await launch(server);
  await settle();
  server.notify("turn/started", { threadId: THREAD.id, turn: { id: "turn-1" } });
  await settle();

  // Running: `turn/start` here would be accepted and then never run.
  assert.equal(await handle.send({ text: "also mention heapsort" }), "steered");
  const steer = server.calls("turn/steer")[0]?.params as Record<string, unknown>;
  assert.equal(steer.expectedTurnId, "turn-1", "a steer must name the turn it expects");
  assert.equal(server.calls("turn/start").length, 1);

  server.notify("turn/completed", { threadId: THREAD.id, turn: { id: "turn-1" } });
  await settle();
  assert.equal(await handle.send({ text: "now do the next thing" }), "started");
  assert.equal(server.calls("turn/start").length, 2, "an idle thread takes a new turn");
  await handle.stop();
  await drained;
});

test("a steer against a turn that moved rejects rather than reporting delivery", async () => {
  const server = new FakeServer({
    ...defaultReplies(),
    // What the real server answers: `expected active turn id X but found Y`.
    "turn/steer": undefined as never,
  });
  const { handle, drained } = await launch(server);
  await settle();
  server.notify("turn/started", { threadId: THREAD.id, turn: { id: "turn-1" } });
  await settle();
  await assert.rejects(
    () => handle.send({ text: "too late" }),
    /no fake reply for turn\/steer/,
    "a refused delivery must reject - it is the only safe evidence that nothing landed",
  );
  await handle.stop();
  await drained;
});

test("a command approval becomes an answerable request, and its rows map to decisions", async () => {
  const server = new FakeServer(defaultReplies());
  const { handle, events, drained } = await launch(server);
  await settle();
  // Verbatim from a live capture, minus the fields nothing reads.
  server.push({
    method: "item/commandExecution/requestApproval",
    id: 0,
    params: {
      threadId: THREAD.id,
      turnId: "turn-1",
      itemId: "call_FmCSv8nEp7sDjYsNCTJUT4j7",
      startedAtMs: 1785013007078,
      environmentId: "local",
      reason: "Do you approve creating approval-probe.txt?",
      command: `/bin/zsh -lc "printf '%s\\n' yes > approval-probe.txt"`,
      cwd: "/work/repo",
      commandActions: [{ type: "unknown", command: "printf '%s\\n' yes > approval-probe.txt" }],
    },
  });
  await settle();

  const request = events.find((e) => e.kind === "request");
  assert.ok(request && request.kind === "request");
  assert.equal(request.request.kind, "approval");
  assert.match(request.request.prompt, /approve creating approval-probe.txt/);
  assert.match(request.request.prompt, /printf/);
  assert.deepEqual(
    request.request.options.map((o) => [o.number, o.label]),
    [[1, "Yes"], [2, "Yes, and don't ask again"], [3, "No"]],
  );

  // The projection every surface renders. `highlighted: 0` because a driver request has no
  // cursor - the point of the whole shape.
  const dialog = driverDialog(request.request);
  assert.equal(dialog.source, "driver");
  assert.equal(dialog.highlighted, 0);
  assert.equal(dialog.requestId, request.request.id);

  await handle.answer(request.request.id, { kind: "option", number: 3, label: "No" });
  assert.deepEqual(server.responseTo(0), {
    jsonrpc: "2.0",
    id: 0,
    result: { decision: "decline" },
  });
  await settle();
  assert.ok(events.some((e) => e.kind === "request_resolved" && e.requestId === request.request.id));
  await handle.stop();
  await drained;
});

test("an answer naming the wrong label for its row is refused", async () => {
  const server = new FakeServer(defaultReplies());
  const { handle, events, drained } = await launch(server);
  await settle();
  server.push({
    method: "item/commandExecution/requestApproval",
    id: 7,
    params: { threadId: THREAD.id, turnId: "t", itemId: "i", startedAtMs: 0, environmentId: null, command: "rm -rf /", cwd: "/work/repo", commandActions: [] },
  });
  await settle();
  const request = events.find((e) => e.kind === "request");
  assert.ok(request && request.kind === "request");
  // The number identifies and the label verifies - the same `optionRowMiss` rule the pane
  // walk applies, and the reason answering the wrong row of an approval is not possible.
  await assert.rejects(
    () => handle.answer(request.request.id, { kind: "option", number: 1, label: "No" }),
    /option 1 on this request is "Yes", not "No"/,
  );
  await assert.rejects(
    () => handle.answer("not-a-request", { kind: "option", number: 1, label: "Yes" }),
    /no pending request/,
  );
  await handle.stop();
  // Abandoned CLOSED: a request nobody answered must never read as approval.
  assert.deepEqual(server.responseTo(7), { jsonrpc: "2.0", id: 7, result: { decision: "cancel" } });
  await drained;
});

test("a request this build cannot answer is refused rather than left hanging", async () => {
  const server = new FakeServer(defaultReplies());
  const { handle, events, drained } = await launch(server);
  await settle();
  server.push({ method: "mcpServer/elicitation/request", id: 3, params: {} });
  await settle();
  assert.equal(events.some((e) => e.kind === "request"), false);
  const answered = server.responseTo(3);
  assert.equal((answered?.error as { code: number }).code, -32601);
  await handle.stop();
  await drained;
});

test("a descendant thread request remains answerable by its correlation id", async () => {
  const server = new FakeServer(defaultReplies());
  const { handle, events, drained } = await launch(server);
  await settle();
  server.push({
    method: "item/tool/requestUserInput",
    id: 8,
    params: {
      threadId: "descendant-thread",
      turnId: "descendant-turn",
      itemId: "question",
      autoResolutionMs: null,
      questions: [
        {
          id: "choice",
          header: "Choice",
          question: "Proceed?",
          isOther: false,
          isSecret: false,
          options: [{ label: "Yes", description: "" }],
        },
      ],
    },
  });
  await settle();
  const request = events.findLast((event) => event.kind === "request");
  assert.ok(request && request.kind === "request");
  await handle.answer(request.request.id, { kind: "option", number: 1, label: "Yes" });
  assert.deepEqual(server.responseTo(8), {
    jsonrpc: "2.0",
    id: 8,
    result: { answers: { choice: { answers: ["Yes"] } } },
  });
  await handle.stop();
  await drained;
});

test("a request arriving before resume binds is retained", async () => {
  let server: FakeServer;
  const earlyRequest = {
    method: "item/tool/requestUserInput",
    id: 10,
    params: {
      threadId: THREAD.id,
      turnId: "turn-live",
      itemId: "early-question",
      autoResolutionMs: null,
      questions: [
        {
          id: "early",
          header: "",
          question: "Resume this work?",
          isOther: false,
          isSecret: false,
          options: [{ label: "Resume", description: "" }],
        },
      ],
    },
  };
  server = new FakeServer(
    defaultReplies({
      "thread/resume": () => {
        server.push(earlyRequest);
        return threadResponse(THREAD);
      },
    }),
  );
  const { handle, events, drained } = await launch(server, { resume: THREAD.id, prompt: "" });
  await settle();
  const request = events.find((event) => event.kind === "request");
  assert.ok(request && request.kind === "request");
  assert.equal(request.request.prompt, "Resume this work?");
  await handle.stop();
  await drained;
});

test("a file approval identifies bounded retained changes and releases them", async () => {
  const server = new FakeServer(defaultReplies());
  const { handle, events, drained } = await launch(server);
  await settle();
  server.notify("item/started", {
    threadId: "descendant-thread",
    turnId: "descendant-turn",
    startedAtMs: 0,
    item: {
      type: "fileChange",
      id: "file-1",
      status: "inProgress",
      changes: [
        { path: "src/one.ts", kind: { type: "update", move_path: null }, diff: "private patch text" },
        { path: "src/two.ts", kind: { type: "add" }, diff: "more private patch text" },
        { path: `src/${"long-".repeat(30)}.ts`, kind: { type: "delete" }, diff: "large patch" },
      ],
    },
  });
  server.push({
    method: "item/fileChange/requestApproval",
    id: 11,
    params: {
      threadId: "descendant-thread",
      turnId: "descendant-turn",
      itemId: "file-1",
      startedAtMs: 0,
      reason: null,
      grantRoot: null,
    },
  });
  await settle();
  const request = events.findLast((event) => event.kind === "request");
  assert.ok(request && request.kind === "request");
  assert.match(request.request.prompt, /Changes: update src\/one\.ts; add src\/two\.ts/);
  assert.doesNotMatch(request.request.prompt, /private patch text/);
  const summary = request.request.prompt.split("Changes: ")[1] ?? "";
  assert.ok(summary.length <= 120);
  await handle.answer(request.request.id, { kind: "option", number: 3, label: "No" });

  server.push({
    method: "item/fileChange/requestApproval",
    id: 12,
    params: {
      threadId: "descendant-thread",
      turnId: "descendant-turn",
      itemId: "file-1",
      startedAtMs: 1,
      reason: null,
      grantRoot: null,
    },
  });
  await settle();
  const fallback = events.findLast((event) => event.kind === "request");
  assert.ok(fallback && fallback.kind === "request");
  assert.equal(fallback.request.prompt, "Codex wants to apply a file change.");
  await handle.stop();
  await drained;
});

test("a request the server resolves itself clears the card", async () => {
  const server = new FakeServer(defaultReplies());
  const { handle, events, drained } = await launch(server);
  await settle();
  server.push({
    method: "item/commandExecution/requestApproval",
    id: 0,
    params: { threadId: THREAD.id, turnId: "t", itemId: "i", startedAtMs: 0, environmentId: null, command: "ls", cwd: "/work/repo", commandActions: [] },
  });
  await settle();
  const request = events.find((e) => e.kind === "request");
  assert.ok(request && request.kind === "request");
  // An auto-review approved it, or the turn was interrupted. Either way the ask is gone.
  server.notify("serverRequest/resolved", { threadId: THREAD.id, requestId: 0 });
  await settle();
  assert.ok(events.some((e) => e.kind === "request_resolved" && e.requestId === request.request.id));
  await handle.stop();
  await drained;
});

test("request_user_input becomes a form and answers by the ids Codex asked under", async () => {
  const server = new FakeServer(defaultReplies());
  const { handle, events, drained } = await launch(server);
  await settle();
  server.push({
    method: "item/tool/requestUserInput",
    id: 1,
    params: {
      threadId: THREAD.id,
      turnId: "turn-1",
      itemId: "item-1",
      autoResolutionMs: null,
      questions: [
        {
          id: "q-branch",
          header: "Branch",
          question: "Which branch should this land on?",
          isOther: false,
          isSecret: false,
          options: [
            { label: "main", description: "the default branch" },
            { label: "release", description: "" },
          ],
        },
        {
          id: "q-tests",
          header: "Tests",
          question: "Run the full suite?",
          isOther: false,
          isSecret: false,
          options: [{ label: "Yes", description: "" }, { label: "No", description: "" }],
        },
        {
          id: "q-notes",
          header: "Notes",
          question: "Any notes for the release?",
          isOther: true,
          isSecret: false,
          options: null,
        },
      ],
    },
  });
  await settle();
  const request = events.find((e) => e.kind === "request");
  assert.ok(request && request.kind === "request");
  assert.equal(request.request.kind, "question");
  assert.equal(request.request.questions?.length, 3);
  // Several questions is a FORM: its rows live on the questions, and flattening them would
  // offer one numbered list whose numbers mean nothing to the driver.
  assert.deepEqual(request.request.options, []);
  assert.equal(driverDialog(request.request).multiSelect, true);

  await handle.answer(request.request.id, {
    kind: "form",
    answers: [
      { question: "Which branch should this land on?", labels: ["release"] },
      { question: "Run the full suite?", labels: ["Yes"] },
      { question: "Any notes for the release?", labels: [], text: "Ship it" },
    ],
  });
  assert.deepEqual(server.responseTo(1), {
    jsonrpc: "2.0",
    id: 1,
    result: {
      answers: {
        "q-branch": { answers: ["release"] },
        "q-tests": { answers: ["Yes"] },
        "q-notes": { answers: ["Ship it"] },
      },
    },
  });
  await handle.stop();
  await drained;
});

test("a half-answered form is refused rather than sent short", async () => {
  const server = new FakeServer(defaultReplies());
  const { handle, events, drained } = await launch(server);
  await settle();
  server.push({
    method: "item/tool/requestUserInput",
    id: 2,
    params: {
      threadId: THREAD.id,
      turnId: "t",
      itemId: "i",
      autoResolutionMs: null,
      questions: [
        { id: "a", header: "", question: "First?", isOther: false, isSecret: false, options: [{ label: "yes", description: "" }] },
        { id: "b", header: "", question: "Second?", isOther: false, isSecret: false, options: [{ label: "no", description: "" }] },
      ],
    },
  });
  await settle();
  const request = events.find((e) => e.kind === "request");
  assert.ok(request && request.kind === "request");
  await assert.rejects(
    () => handle.answer(request.request.id, { kind: "form", answers: [{ question: "First?", labels: ["yes"] }] }),
    /"Second\?" was not answered/,
  );
  await assert.rejects(
    () =>
      handle.answer(request.request.id, {
        kind: "form",
        answers: [
          { question: "First?", labels: ["yes"], text: "maybe" },
          { question: "Second?", labels: ["no"] },
        ],
      }),
    /both a chosen option and custom text/,
  );
  await handle.stop();
  await drained;
});

test("clearContext starts a new thread on the same connection and re-binds the card", async () => {
  let started = 0;
  const server = new FakeServer({
    ...defaultReplies(),
    "thread/start": () => threadResponse(++started === 1 ? THREAD : SECOND_THREAD),
  });
  const { handle, events, drained } = await launch(server);
  await settle();
  assert.ok(handle.clearContext, "Codex declares a clearContext capability");
  server.push({
    method: "item/commandExecution/requestApproval",
    id: 9,
    params: {
      threadId: THREAD.id,
      turnId: "turn-1",
      itemId: "old-request",
      startedAtMs: 0,
      environmentId: null,
      command: "echo old",
      cwd: "/work/repo",
      commandActions: [],
    },
  });
  await settle();
  const oldRequest = events.findLast((event) => event.kind === "request");
  assert.ok(oldRequest && oldRequest.kind === "request");
  await handle.clearContext();
  await settle();

  const bounds = events.filter((e) => e.kind === "bound");
  assert.equal(bounds.length, 2, "a rotation has to re-bind, or the note and queue strand");
  assert.equal(bounds[1]?.kind === "bound" && bounds[1].agentSessionId, SECOND_THREAD.id);
  assert.equal(bounds[1]?.kind === "bound" && bounds[1].transcriptPath, SECOND_THREAD.path);
  // Codex's own word for the case, so its analytics do not read a second cold start.
  assert.equal(
    (server.calls("thread/start")[1]?.params as Record<string, unknown>).sessionStartSource,
    "clear",
  );
  assert.deepEqual(server.responseTo(9), {
    jsonrpc: "2.0",
    id: 9,
    result: { decision: "cancel" },
  });
  assert.ok(
    events.some(
      (event) =>
        event.kind === "request_resolved" && event.requestId === oldRequest.request.id,
    ),
  );

  server.notify("turn/started", { threadId: THREAD.id, turn: { id: "late-old-turn" } });
  server.notify("thread/tokenUsage/updated", {
    threadId: THREAD.id,
    turnId: "late-old-turn",
    tokenUsage: {
      total: { totalTokens: 10, inputTokens: 8, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 },
      last: { totalTokens: 10, inputTokens: 8, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 },
      modelContextWindow: 258400,
    },
  });
  server.notify("thread/status/changed", { threadId: THREAD.id, status: { type: "idle" } });
  await settle();
  await handle.send({ text: "new thread work" });
  assert.equal(server.calls("turn/steer").length, 0);
  assert.equal(
    (server.calls("turn/start").at(-1)?.params as { threadId: string }).threadId,
    SECOND_THREAD.id,
  );
  server.notify("turn/completed", { threadId: SECOND_THREAD.id, turn: { id: "turn-2" } });
  await settle();
  const done = events.filter((event) => event.kind === "turn_done").at(-1);
  assert.ok(done && done.kind === "turn_done");
  assert.equal(done.usage, null);
  await handle.stop();
  await drained;
});

test("a resume continues the thread it names and never re-sends the intent", async () => {
  const server = new FakeServer(defaultReplies());
  const { handle, events, drained } = await launch(server, { resume: THREAD.id, prompt: "" });
  await settle();
  assert.equal(server.calls("thread/start").length, 0);
  assert.equal((server.calls("thread/resume")[0]?.params as { threadId: string }).threadId, THREAD.id);
  // Re-sending the original intent would make the agent start the task over on top of
  // whatever it had already done.
  assert.equal(server.calls("turn/start").length, 0);
  assert.ok(events.some((event) => event.kind === "state" && event.state === "idle"));
  await handle.stop();
  await drained;
});

test("a resume restores an active turn and steers the next send", async () => {
  const idle = threadResponse(THREAD);
  const resumed = {
    ...idle,
    thread: {
      ...idle.thread,
      status: { type: "active", activeFlags: [] },
      turns: [{ id: "turn-live", status: "inProgress" }],
    },
  };
  const server = new FakeServer(defaultReplies({ "thread/resume": resumed }));
  const { handle, events, drained } = await launch(server, { resume: THREAD.id, prompt: "" });
  await settle();
  assert.ok(events.some((event) => event.kind === "state" && event.state === "working"));
  await handle.send({ text: "continue here" });
  assert.equal(server.calls("turn/start").length, 0);
  assert.deepEqual(server.calls("turn/steer")[0]?.params, {
    threadId: THREAD.id,
    input: [{ type: "text", text: "continue here", text_elements: [] }],
    expectedTurnId: "turn-live",
  });
  await handle.stop();
  await drained;
});

test("a mode change is refused when it would need a different sandbox", async () => {
  const server = new FakeServer(defaultReplies());
  const { handle, drained } = await launch(server, { permissionMode: "askForApproval" });
  await settle();
  assert.ok(handle.setPermissionMode);
  // Same sandbox, different reviewer: real, and applied on the next turn.
  await handle.setPermissionMode!("approveForMe");
  server.notify("turn/completed", { threadId: THREAD.id, turn: { id: "turn-1" } });
  await settle();
  await handle.send({ text: "next" });
  const second = server.calls("turn/start")[1]?.params as Record<string, unknown>;
  assert.equal(second.approvalsReviewer, "auto_review");

  // A different sandbox cannot be applied to a running thread - `thread/resume` looks like
  // it can and silently does not, so this refuses instead of lying.
  await assert.rejects(
    () => handle.setPermissionMode!("fullAccess"),
    /cannot move a running thread to danger-full-access - continue in a terminal and use \/permissions/,
  );
  await handle.stop();
  await drained;
});

test("effort and model changes ride the next turn, including model-supported max", async () => {
  const server = new FakeServer(defaultReplies());
  const { handle, drained } = await launch(server);
  await settle();
  await handle.setEffort!("xhigh");
  await handle.setModel!("gpt-5.6-codex");
  server.notify("turn/completed", { threadId: THREAD.id, turn: { id: "turn-1" } });
  await settle();
  await handle.send({ text: "next" });
  const second = server.calls("turn/start")[1]?.params as Record<string, unknown>;
  assert.equal(second.effort, "xhigh");
  assert.equal(second.model, "gpt-5.6-codex");
  await handle.setEffort!("max");
  server.notify("turn/completed", { threadId: THREAD.id, turn: { id: "turn-2" } });
  await settle();
  await handle.send({ text: "use the maximum" });
  const third = server.calls("turn/start")[2]?.params as Record<string, unknown>;
  assert.equal(third.effort, "max");
  await handle.stop();
  await drained;
});

test("turn lifecycle drives state, and usage rides turn_done exactly once", async () => {
  const server = new FakeServer(defaultReplies());
  const { handle, events, drained } = await launch(server);
  await settle();
  server.notify("turn/started", { threadId: THREAD.id, turn: { id: "turn-1" } });
  server.notify("item/started", {
    threadId: THREAD.id,
    turnId: "turn-1",
    startedAtMs: 0,
    item: { type: "commandExecution", id: "c1", command: "npm test", cwd: "/work/repo", processId: null, source: "agent", status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null },
  });
  server.notify("thread/tokenUsage/updated", {
    threadId: THREAD.id,
    turnId: "turn-1",
    tokenUsage: {
      total: { totalTokens: 1, inputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 },
      last: { totalTokens: 130, inputTokens: 100, cachedInputTokens: 40, cacheWriteInputTokens: 10, outputTokens: 30, reasoningOutputTokens: 12 },
      modelContextWindow: 258400,
    },
  });
  // Both arrive in this order against a real server; `finishTurn` is idempotent so the
  // backstop cannot double-report.
  server.notify("thread/status/changed", { threadId: THREAD.id, status: { type: "idle" } });
  server.notify("turn/completed", { threadId: THREAD.id, turn: { id: "turn-1" } });
  await settle();

  assert.ok(events.some((e) => e.kind === "state" && e.activity === "npm test"));
  const done = events.filter((e) => e.kind === "turn_done");
  assert.equal(done.length, 1, "a turn ends once, however many notifications say so");
  assert.deepEqual(done[0]?.kind === "turn_done" && done[0].usage, {
    input: 100,
    output: 30,
    cacheRead: 40,
    cacheWrite: 10,
    reasoningOutput: 12,
    modelId: "gpt-5.6-sol",
    // Tokens, never money: `codexPricing` owns that conversion for the ledger.
    costUsd: null,
  });
  await handle.stop();
  await drained;
});

test("a pull request is reported only with both halves of the provenance rule", async () => {
  const server = new FakeServer(defaultReplies());
  const { handle, events, drained } = await launch(server);
  await settle();
  const item = (over: Record<string, unknown>) => ({
    threadId: THREAD.id,
    turnId: "turn-1",
    completedAtMs: 0,
    item: {
      type: "commandExecution",
      id: "c",
      cwd: "/work/repo",
      processId: null,
      source: "agent",
      status: "completed",
      exitCode: 0,
      durationMs: 1,
      commandActions: [],
      ...over,
    },
  });
  // `gh pr view` prints the same URL. Only the COMMAND establishes authorship.
  server.notify("item/completed", item({
    command: `/bin/zsh -lc "gh pr view --web"`,
    commandActions: [{ type: "unknown", command: "gh pr view --web" }],
    aggregatedOutput: "https://github.com/o/r/pull/9\n",
  }));
  // The command with no URL is half a signal too.
  server.notify("item/completed", item({
    command: `/bin/zsh -lc "gh pr create --fill"`,
    commandActions: [{ type: "unknown", command: "gh pr create --fill" }],
    aggregatedOutput: "creating...\n",
  }));
  await settle();
  assert.equal(events.some((e) => e.kind === "pr_created"), false);

  // Both halves, and the `gh pr create` is only visible in the PARSED action - Codex wraps
  // the command in `/bin/zsh -lc "..."`, where the quote in front of `gh` defeats the
  // command matcher.
  server.notify("item/completed", item({
    command: `/bin/zsh -lc "gh pr create --fill"`,
    commandActions: [{ type: "unknown", command: "gh pr create --fill" }],
    aggregatedOutput: "https://github.com/o/r/pull/12\n",
  }));
  await settle();
  assert.deepEqual(
    events.filter((e) => e.kind === "pr_created"),
    [{ kind: "pr_created", url: "https://github.com/o/r/pull/12" }],
  );
  await handle.stop();
  await drained;
});

test("a retired thread cannot attribute a pull request to its replacement", async () => {
  let started = 0;
  const server = new FakeServer({
    ...defaultReplies(),
    "thread/start": () => threadResponse(++started === 1 ? THREAD : SECOND_THREAD),
  });
  const { handle, events, drained } = await launch(server);
  await settle();
  assert.ok(handle.clearContext);
  await handle.clearContext();
  await settle();

  const completion = (threadId: string, url: string) => ({
    threadId,
    turnId: "turn-pr",
    completedAtMs: 0,
    item: {
      type: "commandExecution",
      id: `pr-${threadId}`,
      command: `/bin/zsh -lc "gh pr create --fill"`,
      cwd: "/work/repo",
      processId: null,
      source: "agent",
      status: "completed",
      commandActions: [{ type: "unknown", command: "gh pr create --fill" }],
      aggregatedOutput: `${url}\n`,
      exitCode: 0,
      durationMs: 1,
    },
  });

  server.notify(
    "item/completed",
    completion(THREAD.id, "https://github.com/o/r/pull/41"),
  );
  server.notify(
    "item/completed",
    completion(SECOND_THREAD.id, "https://github.com/o/r/pull/42"),
  );
  await settle();
  assert.deepEqual(
    events.filter((event) => event.kind === "pr_created"),
    [{ kind: "pr_created", url: "https://github.com/o/r/pull/42" }],
  );
  await handle.stop();
  await drained;
});

test("a subagent of a retired thread cannot attribute a pull request either", async () => {
  // Inspector finding on #260. Retiring only the ROOT id left the abandoned thread's
  // children looking like threads of their own, so a delayed `gh pr create` completion from
  // one of them passed the guard and attached the old conversation's pull request to the
  // card that replaced it. PR authorship is proof-grade - it is what lets the Inspector
  // comment on a pull request under the operator's identity - so this is the one place the
  // driver has to fail closed.
  let started = 0;
  const server = new FakeServer({
    ...defaultReplies(),
    "thread/start": () => threadResponse(++started === 1 ? THREAD : SECOND_THREAD),
  });
  const { handle, events, drained } = await launch(server);
  await settle();

  // The server states the parentage itself, on the parent's own stream, BEFORE the clear.
  const OLD_CHILD = "019f9b00-aaaa-7000-8000-000000000001";
  server.notify("item/started", {
    threadId: THREAD.id,
    turnId: "turn-1",
    startedAtMs: 0,
    item: { type: "subAgentActivity", id: "sa-1", kind: "started", agentThreadId: OLD_CHILD, agentPath: "reviewer" },
  });
  await settle();

  assert.ok(handle.clearContext);
  await handle.clearContext();
  await settle();

  // A child of the NEW root, announced the other way the server states parentage.
  const NEW_CHILD = "019f9b00-bbbb-7000-8000-000000000002";
  server.notify("thread/started", {
    thread: { id: NEW_CHILD, parentThreadId: SECOND_THREAD.id, status: { type: "idle" }, turns: [] },
  });
  await settle();

  const prCompletion = (threadId: string, url: string) => ({
    threadId,
    turnId: "turn-pr",
    completedAtMs: 0,
    item: {
      type: "commandExecution",
      id: `pr-${threadId}`,
      command: `/bin/zsh -lc "gh pr create --fill"`,
      cwd: "/work/repo",
      processId: null,
      source: "agent",
      status: "completed",
      commandActions: [{ type: "unknown", command: "gh pr create --fill" }],
      aggregatedOutput: `${url}\n`,
      exitCode: 0,
      durationMs: 1,
    },
  });

  // The retired root's child: suppressed, because its root is retired.
  server.notify("item/completed", prCompletion(OLD_CHILD, "https://github.com/o/r/pull/51"));
  // A thread nobody ever told us about: also suppressed, because `isOwnTree` is a positive
  // proof rather than the absence of a retirement. This is the arm that fails CLOSED - the
  // same frame's ACTIVITY is still shown, since losing a legitimate subagent's ticker is a
  // cosmetic cost and adopting a stranger's pull request is not.
  server.notify("item/completed", prCompletion("019f9b00-cccc-7000-8000-000000000003", "https://github.com/o/r/pull/52"));
  // The live root's child: attributed, which is what keeps a real subagent PR adoptable.
  server.notify("item/completed", prCompletion(NEW_CHILD, "https://github.com/o/r/pull/53"));
  await settle();

  assert.deepEqual(
    events.filter((event) => event.kind === "pr_created"),
    [{ kind: "pr_created", url: "https://github.com/o/r/pull/53" }],
  );
  await handle.stop();
  await drained;
});

test("retired-thread bookkeeping is bounded, and forgetting falls the safe way", async () => {
  // Inspector r6 on #260: both collections grew for the life of a card. Bounding them is
  // only defensible because of HOW they are read - `isOwnTree` is a positive proof, not the
  // negation of `isRetired` - so this pins the consequence rather than the cap.
  //
  // Forget a parent edge and the child stops proving it belongs to the live root, so PR
  // attribution SUPPRESSES. That is the direction that matters: the alternative failure,
  // adopting a stranger's pull request, is the one AGENTS.md prices as unacceptable.
  const server = new FakeServer(defaultReplies());
  const { handle, events, drained } = await launch(server);
  await settle();

  const ORPHAN = "019f9b00-eeee-7000-8000-000000000005";
  server.notify("item/completed", {
    threadId: ORPHAN,
    turnId: "turn-pr",
    completedAtMs: 0,
    item: {
      type: "commandExecution",
      id: "pr-orphan",
      command: `/bin/zsh -lc "gh pr create --fill"`,
      cwd: "/work/repo",
      processId: null,
      source: "agent",
      status: "completed",
      commandActions: [{ type: "unknown", command: "gh pr create --fill" }],
      aggregatedOutput: "https://github.com/o/r/pull/61\n",
      exitCode: 0,
      durationMs: 1,
    },
  });
  await settle();
  // No parentage was ever stated for this thread - the same state an evicted edge leaves -
  // so nothing is attributed...
  assert.equal(events.some((e) => e.kind === "pr_created"), false);
  // ...while its activity is still shown, which is the cost that IS acceptable.
  assert.ok(events.some((e) => e.kind === "state" && (e.activity ?? "").includes("gh pr create")));
  await handle.stop();
  await drained;
});

test("a retired thread's subagent ask is answered closed, not put on the new card", async () => {
  let started = 0;
  const server = new FakeServer({
    ...defaultReplies(),
    "thread/start": () => threadResponse(++started === 1 ? THREAD : SECOND_THREAD),
  });
  const { handle, events, drained } = await launch(server);
  await settle();
  const OLD_CHILD = "019f9b00-dddd-7000-8000-000000000004";
  server.notify("item/started", {
    threadId: THREAD.id,
    turnId: "turn-1",
    startedAtMs: 0,
    item: { type: "subAgentActivity", id: "sa-2", kind: "started", agentThreadId: OLD_CHILD, agentPath: "reviewer" },
  });
  await settle();
  await handle.clearContext!();
  await settle();

  server.push({
    method: "item/commandExecution/requestApproval",
    id: 11,
    params: { threadId: OLD_CHILD, turnId: "t", itemId: "i", startedAtMs: 0, environmentId: null, command: "rm -rf /", cwd: "/work/repo", commandActions: [] },
  });
  await settle();
  // Cancelled rather than shown: it belongs to a conversation nobody is looking at, and an
  // ask nobody answered must never read as approval.
  assert.deepEqual(server.responseTo(11), { jsonrpc: "2.0", id: 11, result: { decision: "cancel" } });
  assert.equal(events.some((e) => e.kind === "request"), false);
  await handle.stop();
  await drained;
});

test("a clear survives a turn that finished while it was interrupting", async () => {
  // Inspector r8 on #260. Codex rejects an interrupt naming a turn that has already
  // completed, and the clear used to let that escape - so pressing Clear on a session that
  // had just gone idle failed, which is the moment an operator is most likely to press it.
  let started = 0;
  const server = new FakeServer({
    ...defaultReplies(),
    "thread/start": () => threadResponse(++started === 1 ? THREAD : SECOND_THREAD),
    // The race, made deterministic: the interrupt is refused, and the completion that
    // caused the refusal is already on the wire behind it.
    "turn/interrupt": undefined as never,
  });
  const { handle, events, drained } = await launch(server);
  await settle();
  server.notify("turn/started", { threadId: THREAD.id, turn: { id: "turn-1" } });
  await settle();
  server.notify("turn/completed", { threadId: THREAD.id, turn: { id: "turn-1" } });

  await handle.clearContext!();
  await settle();
  // The clear went through: a second thread, and the card re-bound to it.
  const bounds = events.filter((e) => e.kind === "bound");
  assert.equal(bounds.length, 2);
  assert.equal(bounds[1]?.kind === "bound" && bounds[1].agentSessionId, SECOND_THREAD.id);
  await handle.stop();
  await drained;
});

test("a clear does NOT proceed when the interrupt failed and the turn is still running", async () => {
  // The other half, and the reason the rejection is re-examined instead of swallowed:
  // abandoning a thread with work still on it is what the interrupt exists to prevent.
  const server = new FakeServer({ ...defaultReplies(), "turn/interrupt": undefined as never });
  const { handle, drained } = await launch(server);
  await settle();
  server.notify("turn/started", { threadId: THREAD.id, turn: { id: "turn-1" } });
  await settle();
  await assert.rejects(() => handle.clearContext!(), /no fake reply for turn\/interrupt/);
  // No replacement thread was started, so the card still points at the live conversation.
  assert.equal(server.calls("thread/start").length, 1);
  await handle.stop();
  await drained;
});

test("clearContext stops whatever the old thread was still running", async () => {
  let started = 0;
  const server = new FakeServer({
    ...defaultReplies(),
    "thread/start": () => threadResponse(++started === 1 ? THREAD : SECOND_THREAD),
  });
  const { handle, drained } = await launch(server);
  await settle();
  server.notify("turn/started", { threadId: THREAD.id, turn: { id: "turn-1" } });
  await settle();
  await handle.clearContext!();
  // The old thread is abandoned, not archived - so a turn left running on it would go on
  // spending tokens against a conversation nobody can see any more.
  assert.deepEqual(server.calls("turn/interrupt")[0]?.params, {
    threadId: THREAD.id,
    turnId: "turn-1",
  });
  await handle.stop();
  await drained;
});

test("a rejected clear keeps the old thread bound and usable", async () => {
  let started = 0;
  const server = new FakeServer({
    ...defaultReplies(),
    "thread/start": () => {
      started += 1;
      if (started === 1) return threadResponse(THREAD);
      throw new Error("replacement refused");
    },
  });
  const { handle, events, drained } = await launch(server);
  await settle();

  await assert.rejects(() => handle.clearContext!(), /replacement refused/);
  assert.deepEqual(
    events.filter((event) => event.kind === "bound"),
    [{
      kind: "bound",
      agentSessionId: THREAD.id,
      transcriptPath: THREAD.path,
      pid: 4242,
    }],
  );

  server.notify("turn/completed", { threadId: THREAD.id, turn: { id: "turn-1" } });
  await settle();
  assert.ok(events.some((event) => event.kind === "turn_done"));

  await handle.send({ text: "continue on the old thread" });
  assert.equal(server.calls("turn/steer").length, 0);
  assert.equal(server.calls("turn/start").length, 2);
  assert.equal(
    (server.calls("turn/start")[1]?.params as Record<string, unknown>).threadId,
    THREAD.id,
  );
  await handle.stop();
  await drained;
});

test("a frame this build cannot read costs an activity line, never the session", async () => {
  const server = new FakeServer(defaultReplies());
  const { handle, events, drained } = await launch(server);
  await settle();
  // `item` missing entirely: shaped nothing like the generated type, on a protocol whose
  // own docs call several of these params unstable.
  server.notify("item/completed", { threadId: THREAD.id, turnId: "turn-1" });
  server.notify("turn/started", { threadId: THREAD.id, turn: { id: "turn-1" } });
  await settle();
  assert.equal(events.some((e) => e.kind === "exited"), false, "the session must survive it");
  // ...and the very next well-formed frame is still read.
  server.notify("turn/completed", { threadId: THREAD.id, turn: { id: "turn-1" } });
  await settle();
  assert.ok(events.some((e) => e.kind === "turn_done"));
  await handle.stop();
  await drained;
});

test("an unreadable request is answered with an error, not left blocking the turn", async () => {
  const server = new FakeServer(defaultReplies());
  const { handle, events, drained } = await launch(server);
  await settle();
  // The agent is BLOCKED until each of these settles, so silence is the worst outcome
  // available - worse than refusing, because a refusal at least ends the turn.
  //
  // A form whose questions are not a list degrades to "nothing to draw" and takes the
  // ordinary "cannot answer" refusal...
  server.push({ method: "item/tool/requestUserInput", id: 5, params: { questions: "nope" } });
  // ...and a payload the projection actually throws on takes the guarded one.
  server.push({
    method: "item/commandExecution/requestApproval",
    id: 6,
    params: { threadId: THREAD.id, reason: { not: "a string" } },
  });
  await settle();
  assert.equal((server.responseTo(5)?.error as { code: number }).code, -32601);
  assert.equal((server.responseTo(6)?.error as { code: number }).code, -32602);
  assert.equal(events.some((e) => e.kind === "request"), false);
  assert.equal(events.some((e) => e.kind === "exited"), false);
  await handle.stop();
  await drained;
});

test("the connection ending is an exit the supervisor can evict on", async () => {
  const server = new FakeServer(defaultReplies());
  const { events, drained } = await launch(server);
  await settle();
  server.end();
  await drained;
  const exited = events.at(-1);
  assert.equal(exited?.kind, "exited");
  // A thread we learned the id of can be picked up by the next daemon; one that never bound
  // has nothing to continue.
  assert.equal(exited?.kind === "exited" && exited.resumable, true);
});

test("a launch whose handshake fails throws and leaves no subprocess behind", async () => {
  const server = new FakeServer({});
  const spec = codexSdkSpec({ connect: async () => server });
  await assert.rejects(
    () =>
      spec.launch({
        cwd: "/work/repo",
        prompt: "go",
        model: null,
        effort: null,
        permissionMode: null,
        mcp: null,
        resume: null,
      }),
    /no fake reply for initialize/,
  );
  // `SdkSpec.launch` rejects rather than degrades, and nothing durable exists yet - so the
  // only thing to unwind is the connection.
  assert.equal(server.closed, true);
});

test("stop interrupts a live turn before it closes the connection", async () => {
  const server = new FakeServer(defaultReplies());
  const { handle, drained } = await launch(server);
  await settle();
  server.notify("turn/started", { threadId: THREAD.id, turn: { id: "turn-1" } });
  await settle();
  await handle.stop();
  await drained;
  assert.deepEqual(server.calls("turn/interrupt")[0]?.params, {
    threadId: THREAD.id,
    turnId: "turn-1",
  });
  assert.equal(server.closed, true);
});

test("the MCP descriptor becomes launch-scoped config, all three keys or none", async () => {
  const server = new FakeServer(defaultReplies());
  let args: readonly string[] = [];
  const spec = codexSdkSpec({
    connect: async (a) => {
      args = a;
      return server;
    },
  });
  const handle = await spec.launch({
    cwd: "/work/repo",
    prompt: "",
    model: null,
    effort: null,
    permissionMode: null,
    mcp: { serverName: "mission-control", command: "/usr/bin/node", args: ["/d/mcp.mjs"], env: {} },
    resume: null,
  });
  // Rendered by `mission-mcp.ts`, not composed here: one descriptor, whichever launch
  // grammar the harness speaks.
  assert.deepEqual(args, [
    "-c", 'mcp_servers.mission-control.command="/usr/bin/node"',
    "-c", 'mcp_servers.mission-control.args=["/d/mcp.mjs"]',
    "-c", "mcp_servers.mission-control.env={}",
  ]);
  await handle.stop();
});

// ---- the pure projections, on their own ------------------------------------------------

test("an approval prompt leads with the reason and shows what is being run", () => {
  assert.equal(
    commandApprovalPrompt({
      threadId: "t", turnId: "u", itemId: "i", startedAtMs: 0, environmentId: "local",
      reason: "Allow me to create the file?", command: "printf yes > f", cwd: "/work/repo",
    }),
    "Allow me to create the file?\n\nprintf yes > f\nin /work/repo",
  );
  // A human shown only "Yes" / "No" has not been shown what they are approving, so there is
  // always a sentence even when the agent gave no reason.
  assert.equal(
    commandApprovalPrompt({
      threadId: "t", turnId: "u", itemId: "i", startedAtMs: 0, environmentId: null,
    }),
    "Codex wants to run a command.",
  );
});

test("a question with no options remains available for a custom answer", () => {
  const questions = userInputQuestions({
    threadId: "t", turnId: "u", itemId: "i", autoResolutionMs: null,
    questions: [
      { id: "a", header: "H", question: "Pick one", isOther: false, isSecret: false, options: [{ label: "x", description: "why x" }] },
      { id: "b", header: "", question: "Free text", isOther: true, isSecret: false, options: null },
    ],
  });
  assert.deepEqual(questions, [
    {
      question: "Pick one",
      header: "H",
      options: [{ number: 1, label: "x", detail: "why x" }],
    },
    {
      question: "Free text",
      options: [],
    },
  ]);
});

test("two questions sharing a text are refused rather than silently collapsed", async () => {
  // Inspector finding on #260. A question is identified by its TEXT the whole way up -
  // SessionRequestQuestion, /submit-options, and driverFormAnswer, which refuses a second
  // entry naming the same text. So two Codex questions with one text cannot be carried:
  // keeping either would leave the response answering one id twice and omitting the other,
  // and the agent blocked on an ask the human already believes they completed.
  const server = new FakeServer(defaultReplies());
  const { handle, events, drained } = await launch(server);
  await settle();
  server.push({
    method: "item/tool/requestUserInput",
    id: 13,
    params: {
      threadId: THREAD.id,
      turnId: "turn-1",
      itemId: "dupes",
      autoResolutionMs: null,
      questions: [
        { id: "q-a", header: "First", question: "Which branch?", isOther: false, isSecret: false, options: [{ label: "main", description: "" }] },
        { id: "q-b", header: "Second", question: "Which branch?", isOther: false, isSecret: false, options: [{ label: "release", description: "" }] },
      ],
    },
  });
  await settle();
  // No card, and - the part that matters - no silence either: the turn ends with an error
  // Codex can read and re-ask differently.
  assert.equal(events.some((event) => event.kind === "request"), false);
  const refusal = server.responseTo(13);
  assert.equal((refusal?.error as { code: number }).code, -32602);
  assert.match((refusal?.error as { message: string }).message, /share the text "Which branch\?"/);
  await handle.stop();
  await drained;
});

test("a secret question is refused explicitly instead of rendered as ordinary text", async () => {
  const server = new FakeServer(defaultReplies());
  const { handle, events, drained } = await launch(server);
  await settle();
  server.push({
    method: "item/tool/requestUserInput",
    id: 12,
    params: {
      threadId: THREAD.id,
      turnId: "turn-1",
      itemId: "secret",
      autoResolutionMs: null,
      questions: [
        {
          id: "password",
          header: "Credential",
          question: "Enter the deployment password",
          isOther: true,
          isSecret: true,
          options: null,
        },
      ],
    },
  });
  await settle();
  assert.equal(events.some((event) => event.kind === "request"), false);
  const response = server.responseTo(12);
  assert.equal((response?.error as { code: number }).code, -32602);
  assert.match(
    (response?.error as { message: string }).message,
    /secret question "Enter the deployment password" cannot be shown safely/,
  );
  await handle.stop();
  await drained;
});

test("a subprocess spawn error rejects launch with its diagnostic", async () => {
  const missing = `${process.cwd()}/missing-codex-app-server-binary`;
  const spec = codexSdkSpec({
    connect: async (args, cwd) => spawnAppServer(missing, args, cwd, process.env),
  });
  await assert.rejects(
    () =>
      spec.launch({
        cwd: process.cwd(),
        prompt: "do the thing",
        model: null,
        effort: null,
        permissionMode: null,
        mcp: null,
        resume: null,
      }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /ENOENT/);
      assert.match(err.message, /missing-codex-app-server-binary/);
      return true;
    },
  );
});

test("JSONL framing preserves a UTF-8 code point split across chunks", async () => {
  const encoded = Buffer.from('{"text":"café"}\n');
  const split = encoded.indexOf(0xc3) + 1;
  const frames: unknown[] = [];
  for await (const frame of readFrames(
    { stdout: Readable.from([encoded.subarray(0, split), encoded.subarray(split)]) },
    { error: null },
  )) {
    frames.push(frame);
  }
  assert.deepEqual(frames, [{ text: "café" }]);
});

test("file change summaries name kinds and moved paths without patch text", () => {
  const summary = fileChangeSummary([
    {
      path: "src/old.ts",
      kind: { type: "update", move_path: "src/new.ts" },
      diff: "do not include this",
    },
  ]);
  assert.equal(summary, "update src/old.ts -> src/new.ts");
});

test("the activity line says what the session is doing, on one line", () => {
  assert.equal(
    itemActivity({ type: "commandExecution", id: "c", command: "npm test\n  --watch", cwd: "/", processId: null, source: "agent", status: "inProgress", commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null }),
    "npm test --watch",
  );
  assert.equal(
    itemActivity({ type: "agentMessage", id: "m", text: "\nI'll run that.\nThen report.", phase: null, memoryCitation: null }),
    "I'll run that.",
  );
  assert.equal(itemActivity({ type: "reasoning", id: "r", summary: [], content: [] }), "Thinking");
  assert.equal(itemActivity({ type: "userMessage", id: "u", clientId: null, content: [] }), null);
});

test("an image rides as a local path, and the text follows it", () => {
  // The app-server runs on this machine under this daemon, so there is nothing to base64.
  assert.deepEqual(turnInput({ text: "what is wrong here?", images: [{ path: "/state/up/1.png", mediaType: "image/png" }] }), [
    { type: "localImage", path: "/state/up/1.png" },
    { type: "text", text: "what is wrong here?", text_elements: [] },
  ]);
});
