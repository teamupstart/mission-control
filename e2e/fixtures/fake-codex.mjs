#!/usr/bin/env node
/**
 * A stand-in for the `codex` binary, speaking enough of `codex app-server` for the daemon's
 * Codex SDK driver to bind a thread, run turns, and go idle.
 *
 * The Codex sibling of `fake-claude.mjs`, and it exists for the same reason: nothing in
 * `src/` talks to a model API directly, so redirecting the binary is the whole cost dam.
 * `spawnAppServer` runs `<bin> app-server [...-c overrides]`, which is why the first argv
 * word is asserted below rather than assumed.
 *
 * WHY THIS FILE IS NOT `.mjs` AT THE PATH IT RUNS FROM
 * Unlike the Claude fake, nothing here re-spawns through the vendored SDK's extension
 * sniffing - `spawnAppServer` execs the resolved path directly. `writeFakeAgents` still
 * copies it to an extension-less path for symmetry with its sibling, and the shebang picks
 * the interpreter either way.
 *
 * THE TWO WIRES
 * 1. CONTROL: JSON-RPC 2.0 over stdio, one JSON object per line, both directions
 *    (`src/server/harness/codex/sdk-deps.ts`). `AppServerClient` correlates on `id`, and it
 *    does not require the server to echo `jsonrpc`, though this writes it anyway.
 * 2. TRANSCRIPT: the conversation the dashboard renders is NOT on that wire. It is the
 *    rollout JSONL this file writes, whose path is handed back from `thread/start` as
 *    `thread.path` and reaches the card through the driver's `bound` event. A fake that
 *    only answered the control wire would produce a live, correctly-modelled, permanently
 *    empty conversation - so writing that file is half of what this does.
 *
 * WHAT THE DRIVER ACTUALLY READS
 *   - `initialize`            -> handshake, result ignored
 *   - `thread/start`          -> binds: thread.id becomes agentSessionId, thread.path the rollout
 *   - `turn/start`            -> the response's turn.id is recorded BEFORE any notification
 *   - `turn/started`          -> card goes working
 *   - `turn/completed`        -> `turn_done`, card goes idle
 *   - `thread/status/changed` -> the idle backstop, redundant with turn/completed by design
 * Every notification is matched on `params.threadId` (`isCurrentThread`), so all of them
 * carry it.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

/** Fixed so a spec can assert against a known id; the driver only cares that it is stable. */
const THREAD_ID = process.env.MC_E2E_CODEX_THREAD_ID ?? "01999999-0000-7000-8000-000000000001";
const MODEL = "gpt-5-codex-e2e-mock";
const HELD_TURN = "hold the current turn open";
const HELD_TURN_MS = 5_000;

const recordDir = process.env.MC_E2E_RECORD_DIR;
if (recordDir) {
  mkdirSync(join(recordDir, "codex"), { recursive: true });
  writeFileSync(
    join(recordDir, "codex", `invocation-${Date.now()}-${process.pid}.json`),
    JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }, null, 2),
  );
}

// `spawnAppServer` is the only caller and it always leads with this word. Failing loudly
// here is what stops a future launch-path change from being absorbed as a silent no-op.
if (process.argv[2] !== "app-server") {
  process.stderr.write(`fake-codex: expected "app-server", got ${JSON.stringify(process.argv.slice(2))}\n`);
  process.exit(1);
}

// --- the rollout the dashboard actually renders ---------------------------------------

// HOME is the isolated daemon home under this suite (see `fixtures/daemon.ts`), so this is
// the real `~/.codex/sessions/...` layout without touching an operator's own.
const now = new Date();
const stamp = now.toISOString().replace(/[:.]/g, "-");
const rolloutDir = join(
  homedir(),
  ".codex",
  "sessions",
  String(now.getUTCFullYear()),
  String(now.getUTCMonth() + 1).padStart(2, "0"),
  String(now.getUTCDate()).padStart(2, "0"),
);
mkdirSync(rolloutDir, { recursive: true });
const rolloutPath = join(rolloutDir, `rollout-${stamp}-${THREAD_ID}.jsonl`);

/**
 * The head line every Codex reader keys on.
 *
 * `codexTranscript.locate` trusts a driver-reported `transcriptPath` only after
 * `rolloutBelongsToSession` re-reads this record and finds BOTH the cwd and the session id
 * matching the card. Written before `thread/start` answers, because the `bound` event that
 * carries the path is processed the moment it does.
 */
writeFileSync(
  rolloutPath,
  `${JSON.stringify({
    timestamp: now.toISOString(),
    type: "session_meta",
    payload: {
      id: THREAD_ID,
      timestamp: now.toISOString(),
      cwd: process.cwd(),
      source: "app-server",
      thread_source: "user",
      cli_version: "e2e-mock",
    },
  })}\n`,
);

function appendRollout(type, message) {
  appendFileSync(
    rolloutPath,
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "event_msg",
      payload: { type, message },
    })}\n`,
  );
}

// --- the control wire -----------------------------------------------------------------

function write(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

const respond = (id, result) => write({ jsonrpc: "2.0", id, result });
const notify = (method, params) => write({ jsonrpc: "2.0", method, params });

/** A Turn, in the shape `TurnStartedNotification` and `TurnCompletedNotification` carry. */
const turnOf = (id, status) => ({ id, items: [], itemsView: "full", status });

function thread(status) {
  return {
    id: THREAD_ID,
    sessionId: THREAD_ID,
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    modelProvider: "openai",
    createdAt: Math.floor(Date.now() / 1000),
    updatedAt: Math.floor(Date.now() / 1000),
    recencyAt: null,
    status,
    path: rolloutPath,
    cwd: process.cwd(),
    cliVersion: "e2e-mock",
    source: "appServer",
    threadSource: "user",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    title: null,
    turns: [],
  };
}

/**
 * The scripted reply, echoing its prompt so a spec sending several messages can tell the
 * replies apart - a constant would pass even if only the first turn ever rendered.
 */
const replyTo = (prompt) => `Mock reply to: ${prompt}`;

let turnSeq = 0;
/** The turn being held open, if any, and every prompt it has absorbed. */
let openTurn = null;

const textOf = (input) =>
  (Array.isArray(input) ? input : [])
    .filter((part) => part?.type === "text")
    .map((part) => part.text)
    .join("\n");

function runTurn(turnId, input) {
  const prompt = textOf(input);

  appendRollout("user_message", prompt);
  notify("turn/started", { threadId: THREAD_ID, turn: turnOf(turnId, "inProgress") });
  notify("thread/status/changed", {
    threadId: THREAD_ID,
    status: { type: "active", activeFlags: [] },
  });

  const finish = (prompts) => {
    openTurn = null;
    for (const answered of prompts) appendRollout("agent_message", replyTo(answered));
    // ONE completion, however many prompts the turn absorbed - a steer joins the turn that
    // is running rather than creating another completion to wait for.
    notify("turn/completed", { threadId: THREAD_ID, turn: turnOf(turnId, "completed") });
    // The backstop the driver deliberately keeps: both fire today, in this order, and
    // `finishTurn` is idempotent.
    notify("thread/status/changed", { threadId: THREAD_ID, status: { type: "idle" } });
  };

  // One deterministic busy window, the same contract `fake-claude.mjs` offers, so the
  // queued-turn specs can meet a genuinely busy driver on either harness. Ordinary prompts
  // still answer synchronously and keep every other spec's fast path.
  if (prompt === HELD_TURN) {
    const turnState = { prompts: [prompt] };
    openTurn = turnState;
    setTimeout(() => finish(turnState.prompts), HELD_TURN_MS);
    return;
  }
  finish([prompt]);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return; // the real server tolerates noise on this pipe; so do we
  }
  const { id, method, params } = frame ?? {};
  if (typeof method !== "string" || id === undefined) return;

  switch (method) {
    case "initialize":
      respond(id, { userAgent: "fake-codex/e2e" });
      return;
    case "thread/start":
    case "thread/resume":
      respond(id, {
        thread: thread({ type: "idle" }),
        model: MODEL,
        modelProvider: "openai",
        serviceTier: null,
        cwd: process.cwd(),
        instructionSources: [],
        approvalPolicy: params?.approvalPolicy ?? "onRequest",
        approvalsReviewer: params?.approvalsReviewer ?? "user",
        sandbox: { type: "workspaceWrite" },
        reasoningEffort: null,
      });
      return;
    case "turn/start": {
      const turnId = `turn-${++turnSeq}`;
      // Answered BEFORE a single notification is written, and the turn's own frames are
      // deferred a tick behind it. The driver records `activeTurnId` from this response as
      // well as from `turn/started`, so a `turn/completed` that overtook the response would
      // be matched against a turn the driver has not adopted yet - and the response would
      // then re-adopt an already-finished turn and leave the card working for ever. The
      // real server cannot invert these two; neither may this.
      respond(id, { turn: turnOf(turnId, "inProgress") });
      setImmediate(() => runTurn(turnId, params?.input));
      return;
    }
    case "turn/steer": {
      // A steer joins the turn already running: its text is answered by that turn, and no
      // second `turn/completed` is ever sent for it. A fake that completed a steer
      // separately would hand the driver an extra completion and hide the accounting bug
      // this pair of harnesses exists to keep honest.
      if (openTurn) openTurn.prompts.push(textOf(params?.input));
      respond(id, {});
      return;
    }
    case "turn/interrupt":
      respond(id, {});
      return;
    default:
      // Unknown methods get an empty result rather than an error: this fake implements the
      // frames the driver needs, and a refusal would turn an unrelated future call into a
      // session-killing rejection.
      respond(id, {});
  }
});

// Closing stdin is `spawnAppServer`'s graceful stop. Leaving on it is what keeps the card
// alive until the daemon says otherwise - an early exit reads as a crashed driver.
process.stdin.on("close", () => process.exit(0));
