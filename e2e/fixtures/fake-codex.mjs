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
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

/** Stable per fake process, so one spec can hold two independent Codex sessions at once. */
const DEFAULT_THREAD_ID = `01999999-0000-7000-8000-${String(process.pid).padStart(12, "0").slice(-12)}`;
const THREAD_ID = process.env.MC_E2E_CODEX_THREAD_ID ?? DEFAULT_THREAD_ID;
const MODEL = "gpt-5-codex-e2e-mock";
const HELD_TURN = "hold the current turn open";
const FINAL_ANSWER_HELD_TURN = "hold the current turn open and finish with only a final answer";
const HELD_TURN_MS = 5_000;
const SEE_WORK_TOUR_MARKER = "[Mission Control See the work tour demo]";
/**
 * The prompt that leaves a RUN of executed commands in the rollout.
 *
 * Deliberately the same constant `fake-claude.mjs` answers, because the claim the terminal
 * rendering makes is agent-independent: a stretch of commands is ONE record whoever ran them.
 * One probe, two harnesses, and a spec that can assert the same three commands on both.
 *
 * The records are the shape a real rollout writes, which is the part that matters - measured
 * against `~/.codex/sessions`, a working stretch reads:
 *
 *   event_msg/agent_message          <- the preamble prose
 *   response_item/custom_tool_call   <- the commands, as their OWN records
 *   response_item/custom_tool_call_output
 *   response_item/reasoning
 *   response_item/custom_tool_call
 *
 * so the `reasoning` and `custom_tool_call_output` records are written here too. They carry no
 * message and must not break the run apart; a fake that omitted them could not tell a reader
 * that folds correctly from one that only looks like it does.
 */
const TOOL_RUN_TURN = "E2E_TERMINAL_RUN";
/**
 * The commands the run executes, as Codex really records them.
 *
 * Not a bare command string: the `exec` tool takes a freeform script, so the command sits
 * inside a `tools.exec_command({...})` call, and in the object-literal form (unquoted key)
 * that a rollout actually contains. Reading the command back out of this wrapper is the other
 * half of what the terminal record has to get right - a fake that passed `{"command": "..."}`
 * would prove nothing, because that shape already worked.
 */
const RUN_COMMANDS = [
  "rg PersonaDirective src test",
  "git status --short",
  "sed -n '1,40p' src/server/registry.ts",
];

const recordDir = process.env.MC_E2E_RECORD_DIR;
if (recordDir) {
  mkdirSync(join(recordDir, "codex"), { recursive: true });
  writeFileSync(
    join(recordDir, "codex", `invocation-${Date.now()}-${process.pid}.json`),
    JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }, null, 2),
  );
}

function workflowImageManifest(prompt) {
  const lines = prompt.split("\n");
  const start = lines.findIndex((line) => /^`{3,}workflow-image-manifest-untrusted$/.test(line));
  if (start < 0) return [];
  const fence = lines[start].match(/^`+/)?.[0] ?? "```";
  const end = lines.indexOf(fence, start + 1);
  if (end < 0) return [];
  try {
    const parsed = JSON.parse(lines.slice(start + 1, end).join("\n"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Identify the MIME from the pixels Codex received, independently of the prompt manifest. */
function rasterMimeType(bytes) {
  const ascii = (offset, value) => bytes.subarray(offset, offset + value.length).toString("ascii") === value;
  if (
    bytes.length >= 8
    && bytes[0] === 0x89
    && ascii(1, "PNG\r\n\x1a\n")
  ) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  return null;
}

function codexWorkflowAnswer(prompt) {
  if (prompt.includes("E2E_FAIL_VERDICT")) {
    return JSON.stringify({
      verdict: "fail",
      summary: "Deterministic Codex e2e objection",
      requestedChanges: [{
        title: "E2E Codex requested change",
        rationale: "This Codex reviewer is scripted to object",
        evidence: [{ kind: "goal", quote: "deterministic e2e evidence" }],
      }],
      confidence: 0.9,
    });
  }
  if (prompt.includes("E2E_PASS_VERDICT")) {
    return JSON.stringify({
      verdict: "pass",
      summary: "Deterministic Codex e2e approval",
      approvalDetails: { reason: "This Codex reviewer received native image pixels", evidence: [] },
      confidence: 0.9,
    });
  }
  return "E2E Codex Mock";
}

/** The workflow provider path is `codex exec --image ... -`, not the live app-server wire. */
if (process.argv[2] === "exec") {
  await new Promise((done) => {
    const imagePaths = [];
    for (let index = 3; index < process.argv.length; index++) {
      if (process.argv[index] === "--image" && process.argv[index + 1]) {
        imagePaths.push(process.argv[++index]);
      }
    }
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => {
      const prompt = Buffer.concat(chunks).toString("utf8");
      const manifest = workflowImageManifest(prompt);
      const observed = imagePaths.map((path) => {
        const bytes = readFileSync(path);
        return {
          mimeType: rasterMimeType(bytes),
          bytes: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      });
      const valid = manifest.length === observed.length && observed.every((image, index) =>
        image.bytes === manifest[index]?.bytes
        && image.sha256 === manifest[index]?.sha256
        && image.mimeType === manifest[index]?.mimeType);
      if (recordDir && manifest.length > 0) {
        writeFileSync(
          join(recordDir, "codex", `workflow-image-boundary-${Date.now()}-${process.pid}.json`),
          JSON.stringify({ valid, manifest, observed, imagePathCount: imagePaths.length }, null, 2),
        );
      }
      if (!valid) {
        process.stderr.write("fake-codex: workflow image bytes did not match --image inputs (MIME or digest)\n");
        process.exitCode = 1;
        done();
        return;
      }
      process.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "fake-workflow-codex" })}\n`);
      process.stdout.write(`${JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: codexWorkflowAnswer(prompt) },
      })}\n`);
      process.stdout.write(`${JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 120, cached_input_tokens: 0, output_tokens: 40 },
      })}\n`);
      done();
    });
    process.stdin.resume();
  });
  process.exit(process.exitCode ?? 0);
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

/** One `response_item` record, the envelope every non-`event_msg` rollout record wears. */
function appendItem(payload) {
  appendFileSync(
    rolloutPath,
    `${JSON.stringify({ timestamp: new Date().toISOString(), type: "response_item", payload })}\n`,
  );
}

/**
 * One executed command, with the records a real rollout surrounds it with.
 *
 * The reasoning record leads and the output record trails, which is the order Codex writes and
 * the order that matters here: both sit BETWEEN two commands of the same run.
 */
function appendCommand(turnId, index, command) {
  const callId = `call-${turnId}-${index}`;
  appendItem({ type: "reasoning", summary: [], content: [] });
  appendItem({
    type: "custom_tool_call",
    call_id: callId,
    name: "exec",
    arguments: `const r = await tools.exec_command({\n  cmd: ${JSON.stringify(command)},\n  workdir: ${JSON.stringify(process.cwd())},\n});\ntext(r.output);\n`,
  });
  appendItem({ type: "custom_tool_call_output", call_id: callId, output: "mock output" });
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

  const finish = (prompts, finalAnswerOnly = false) => {
    openTurn = null;
    for (const answered of prompts) appendRollout("agent_message", replyTo(answered));
    if (finalAnswerOnly) {
      // The production regression: app-server delivered the final response but neither of
      // its redundant lifecycle notifications reached Mission Control. `final_answer` is
      // itself a root-turn completion signal, so the driver must release the outbox from
      // this frame alone.
      notify("item/completed", {
        threadId: THREAD_ID,
        turnId,
        completedAtMs: Date.now(),
        item: {
          type: "agentMessage",
          id: `message-${turnId}`,
          text: replyTo(prompts.at(-1)),
          phase: "final_answer",
          memoryCitation: null,
        },
      });
      return;
    }
    // ONE completion, however many prompts the turn absorbed - a steer joins the turn that
    // is running rather than creating another completion to wait for.
    notify("turn/completed", { threadId: THREAD_ID, turn: turnOf(turnId, "completed") });
    // The backstop the driver deliberately keeps: both fire today, in this order, and
    // `finishTurn` is idempotent.
    notify("thread/status/changed", { threadId: THREAD_ID, status: { type: "idle" } });
  };

  // A preamble, then a run of commands, then the echoed reply - the shape a real working
  // stretch has. The reply is written last for the same reason it is on the Claude side: its
  // arrival is what tells a spec the records above it have already reached the browser.
  if (prompt === TOOL_RUN_TURN) {
    appendRollout("agent_message", "Mock reply before the run");
    RUN_COMMANDS.forEach((command, index) => appendCommand(turnId, index, command));
    finish([prompt]);
    return;
  }

  // One deterministic busy window, the same contract `fake-claude.mjs` offers, so the
  // queued-turn specs can meet a genuinely busy driver on either harness. Ordinary prompts
  // still answer synchronously and keep every other spec's fast path.
  if (prompt === HELD_TURN) {
    const turnState = { prompts: [prompt] };
    // The cancel handle and the completion the interrupt has to emit, held on the turn so
    // `turn/interrupt` can end it the way the real app-server does. Acknowledging that RPC
    // without ending the turn would leave the card working until this timer fired anyway,
    // and a spec asserting the interrupt landed would pass on a build where it never
    // reached the driver.
    turnState.timer = setTimeout(() => finish(turnState.prompts), HELD_TURN_MS);
    turnState.interrupt = () => {
      clearTimeout(turnState.timer);
      // No agent message: the turn was cut off, so it never finished saying anything.
      finish([]);
    };
    openTurn = turnState;
    return;
  }
  // The product-tour task asks a real model to pause before opening Mission Control's MCP
  // review channel. The browser spec posts the identical review-channel payload directly,
  // as the MCP bundle itself does, while this cost-free fake holds the agent lifecycle in a
  // genuine Working state long enough for the Board stop to observe it. Resolution and this
  // timer then converge on Idle without any model tokens.
  if (prompt.includes(SEE_WORK_TOUR_MARKER)) {
    const turnState = { prompts: [prompt] };
    turnState.timer = setTimeout(() => finish(turnState.prompts), HELD_TURN_MS);
    turnState.interrupt = () => {
      clearTimeout(turnState.timer);
      finish([]);
    };
    openTurn = turnState;
    return;
  }
  if (prompt === FINAL_ANSWER_HELD_TURN) {
    const turnState = { prompts: [prompt] };
    openTurn = turnState;
    setTimeout(() => finish(turnState.prompts, true), HELD_TURN_MS);
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
    case "turn/interrupt": {
      // Ends the running turn rather than merely acknowledging it - see the held-turn branch
      // in `runTurn` for why an acknowledgement alone would let a spec pass for the wrong
      // reason. A late interrupt (nothing running) is a plain success, which is what the
      // driver's own early return already assumes.
      const running = openTurn;
      respond(id, {});
      running?.interrupt?.();
      return;
    }
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
