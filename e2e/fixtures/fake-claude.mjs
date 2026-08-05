#!/usr/bin/env node
/**
 * A stand-in for the `claude` binary, speaking enough of Claude Code's control protocol
 * for the daemon's SDK-runtime driver to bind a session, run turns, and show a transcript.
 *
 * WHY THIS FILE HAS NO `.mjs` IN THE PATH IT IS INVOKED BY
 * The vendored Agent SDK decides how to spawn the executable it was pinned to:
 *
 *     hxe(path) = ![".js",".mjs",".tsx",".ts",".jsx"].some(r => path.endsWith(r))
 *
 * A path ending in one of those is run as `node <path>`; anything else is executed
 * directly. `writeFakeAgents` therefore copies this file to an extension-less path and
 * chmods it, so the `#!/usr/bin/env node` shebang is what picks the interpreter. Keeping
 * the SOURCE named `.mjs` is what lets the repo's own tooling still read it as ESM.
 *
 * WHAT THE DRIVER ACTUALLY READS
 * `ClaudeSdkSession.consume` reacts to exactly four things, so this only has to emit four:
 *   - `system`/`init`      -> binds the model
 *   - any frame with a new `session_id` -> emits `bound` (this is also how /clear rotates)
 *   - `assistant`          -> card goes to "working", activity = first line of text
 *   - `result`             -> `turn_done`, card goes idle
 *
 * AND THE TRANSCRIPT IS NOT ON THIS WIRE
 * None of those frames carry conversation text to the browser. The dashboard reads the
 * transcript from a FILE, re-derived on every poll by `resolveTranscriptPath`:
 *
 *     ~/.claude/projects/<cwd with every "/" and "." replaced by "-">/<session_id>.jsonl
 *
 * So a fake that only wrote to stdout would produce a live, idle, correctly-modelled card
 * with a permanently empty conversation. Writing that file is half of what this does.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

/** Fixed so a test can assert against a known id; the driver only cares that it is stable. */
const SESSION_ID = process.env.MC_E2E_SESSION_ID ?? "e2e00000-0000-4000-8000-000000000001";
function argvValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

// An explicit dispatch model is echoed by the real CLI's init frame. Keep the mock label
// for default launches, but preserve a pinned model so browser specs can exercise the
// production model-metadata resolver rather than a browser-side stub.
const MODEL = argvValue("--model") ?? "claude-e2e-mock";
const HELD_TURN = "hold the current turn open";
const HELD_TURN_MS = 5_000;
const SLOW_STOP = "E2E_SLOW_SESSION_STOP";
const SLOW_STOP_MS = 4_000;
const SLOW_WORKFLOW_CONTEXT = "E2E_SLOW_WORKFLOW_CONTEXT";
const SLOW_WORKFLOW_CONTEXT_MS = 5_000;
/**
 * The prompt that makes this CLI ask its human something, the way the real one does.
 *
 * The only frame here that travels UP the control protocol. Every other `control_request`
 * on this wire is the SDK asking the CLI something and this file answering; `can_use_tool`
 * is the CLI asking the SDK, which is how `AskUserQuestion` reaches
 * `ClaudeSdkSession.canUseTool` and becomes a card the dashboard can answer. Without it no
 * browser spec can reach the driver-request surface at all - the routes that answer one
 * (`/select-option`, `/submit-options`) refuse unless a real request is pending, because
 * the request id they echo is held by the driver.
 */
const ASK_TURN = "ask me which linter to use";

const recordDir = process.env.MC_E2E_RECORD_DIR;
if (recordDir) {
  mkdirSync(join(recordDir, "claude"), { recursive: true });
  const stamp = `${Date.now()}-${process.pid}`;
  writeFileSync(
    join(recordDir, "claude", `invocation-${stamp}.json`),
    JSON.stringify(
      {
        argv: process.argv.slice(2),
        cwd: process.cwd(),
        // The three the driver deliberately strips, so a test can prove a headless run is
        // not wearing the daemon's terminal identity.
        tmuxPane: process.env.TMUX_PANE ?? null,
        weztermPane: process.env.WEZTERM_PANE ?? null,
        termProgram: process.env.TERM_PROGRAM ?? null,
        entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT ?? null,
      },
      null,
      2,
    ),
  );
}

// --- headless one-shot mode (`claude -p`) ---------------------------------------------

/**
 * The OTHER protocol this binary has to speak.
 *
 * `src/server/llm/claude-cli.ts` runs `claude -p --output-format json` for the app's
 * offline work - the task titler, Foreman's verdicts, the goal refiner, the Inspector -
 * and it is nothing like the session control protocol below. It is one shot: prompt on
 * stdin, a single JSON object on stdout, exit.
 *
 * Worth stating plainly because it is the more expensive half in practice: a dispatch fires
 * the titler before the session ever starts, so an e2e run that faked only the session
 * would still have spent real tokens on every dispatch. The recorded argv from the first
 * run of this suite was `-p --output-format json --model claude-haiku-4-5`, which is a real
 * model id and a real bill.
 */
if (process.argv.includes("-p")) {
  const chunks = [];
  process.stdin.on("data", (c) => chunks.push(c));
  process.stdin.on("end", () => {
    const prompt = Buffer.concat(chunks).toString("utf8");
    const finish = () => {
      process.stdout.write(JSON.stringify({ result: headlessAnswer(prompt) }));
      process.exit(0);
    };
    // Keep one workflow compaction visibly in flight so the browser can prove an accepted
    // submission opens its run before this provider child finishes. The marker sits in the
    // dispatched session's intent, and the prompt prefix keeps its title call instant.
    if (
      prompt.includes(SLOW_WORKFLOW_CONTEXT)
      && prompt.includes("Compact workflow intent without rewriting it.")
    ) {
      setTimeout(finish, SLOW_WORKFLOW_CONTEXT_MS);
    } else {
      finish();
    }
  });
} else {
  runSession();
}

/**
 * One deterministic answer per kind of headless call.
 *
 * A workflow Persona review arrives on this same `-p` protocol, and its prompt embeds the
 * published Persona guidance verbatim ("# Published Persona guidance"). That gives a spec a
 * clean steering channel with no new wiring: plant a marker in the guidance of the Persona
 * it creates, and this fake answers that reviewer - and only that reviewer - with a fixed,
 * schema-valid verdict. A FAIL is what makes workflow specs deterministic: it parks the run
 * in `waiting_for_session`, a stable state, instead of completing it or bouncing through
 * parse-failure retries.
 *
 * Goal reconciliation also gets a schema-valid deterministic answer. Foreman's prompted
 * completion path intentionally requires a resolved objective, so returning the title reply
 * there would leave every browser-driven session permanently fail-closed. Everything else,
 * including the titler, keeps the fixed title reply below.
 */
function headlessAnswer(prompt) {
  if (
    prompt.includes(SLOW_WORKFLOW_CONTEXT)
    && prompt.includes("Compact workflow intent without rewriting it.")
  ) {
    return JSON.stringify({ constraints: [], acceptanceCriteria: [] });
  }
  if (prompt.includes("E2E_FAIL_VERDICT")) {
    return JSON.stringify({
      verdict: "fail",
      summary: "Deterministic e2e objection",
      requestedChanges: [
        {
          title: "E2E requested change",
          rationale: "This reviewer is scripted to ask for changes",
          evidence: [{ kind: "goal", quote: "deterministic e2e evidence" }],
        },
      ],
      confidence: 0.9,
    });
  }
  if (prompt.includes("E2E_PASS_VERDICT")) {
    return JSON.stringify({
      verdict: "pass",
      summary: "Deterministic e2e approval",
      approvalDetails: { reason: "This reviewer is scripted to approve", evidence: [] },
      confidence: 0.9,
    });
  }
  if (prompt.includes("You reconcile the intent of an AI coding session")) {
    const objective = prompt.match(
      /## The specific unresolved instruction to classify now\n([\s\S]*?)(?:\n\n## Conversation|\n\nNow output)/,
    )?.[1]?.trim() || "Complete the e2e task";
    return JSON.stringify({
      relationship: "initial",
      objective,
      goal: objective,
      focus: objective,
      reason: "This is the first substantive e2e instruction",
    });
  }
  // A fixed title, so the card's name is deterministic and a spec can assert on it
  // instead of on whatever the titler's fallback happens to title-case the task into.
  return "E2E Mock Session";
}

function runSession() {

// --- the transcript file the dashboard actually renders -------------------------------

const projectDir = join(homedir(), ".claude", "projects", process.cwd().replace(/[/.]/g, "-"));
mkdirSync(projectDir, { recursive: true });
const transcriptPath = join(projectDir, `${SESSION_ID}.jsonl`);
// Created eagerly: `resolveTranscriptPath` returns null for a path that does not exist yet,
// and the `bound` event that carries it fires as soon as the first frame lands.
writeFileSync(transcriptPath, "");

let turn = 0;
function appendTurn(role, content) {
  turn += 1;
  const runtime = role === "assistant"
    ? {
        model: MODEL,
        // Fable's fixture deliberately mirrors the screenshot regression: 184k tokens is
        // 92% only under the incorrect 200k fallback, and 18% under its real 1M window.
        ...(MODEL === "claude-fable-5"
          ? {
              usage: {
                input_tokens: 184_000,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
                output_tokens: 100,
              },
            }
          : {}),
      }
    : {};
  appendFileSync(
    transcriptPath,
    `${JSON.stringify({
      type: role,
      uuid: `${role}-${turn}`,
      timestamp: new Date().toISOString(),
      message: { role, content, ...runtime },
    })}\n`,
  );
}

// --- the control protocol -------------------------------------------------------------

function emit(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function ok(requestId, response = {}) {
  emit({ type: "control_response", response: { subtype: "success", request_id: requestId, response } });
}

emit({ type: "system", subtype: "init", session_id: SESSION_ID, model: MODEL });

/**
 * The scripted reply.
 *
 * Echoes the prompt rather than returning a constant so a test that sends three messages
 * can tell the three replies apart - a constant would pass even if only the first turn
 * ever rendered.
 */
function replyTo(prompt) {
  return `Mock reply to: ${prompt}`;
}

/** The turn the CLI is running right now, and every prompt it has absorbed. */
let openTurn = null;
let slowStop = false;

/**
 * The `AskUserQuestion` this CLI raises on `ASK_TURN`, and the turn it is blocking.
 *
 * Two questions, one single-select and one multi-select, because that combination is what
 * `driverDialog` reads as a FORM - the shape answered whole through `/submit-options`,
 * which is the surface an operator actually meets. A single question would take the
 * row-at-a-time `/select-option` path instead and leave the form untested.
 */
const ASK_INPUT = {
  questions: [
    {
      question: "Which linter?",
      header: "Linter",
      options: [
        { label: "biome", description: "lint + format in one binary" },
        { label: "eslint", description: "widest plugin ecosystem" },
      ],
    },
    {
      question: "Which checks should run?",
      header: "Checks",
      multiSelect: true,
      options: [
        { label: "types", description: "tsc --noEmit" },
        { label: "tests", description: "the node:test suite" },
      ],
    },
  ],
};

/** Control requests this CLI has sent UP and is waiting on, by request id. */
const asked = new Map();

function ask(prompt) {
  const requestId = `ask-${++turn}`;
  asked.set(requestId, prompt);
  appendTurn("assistant", [
    { type: "tool_use", id: requestId, name: "AskUserQuestion", input: ASK_INPUT },
  ]);
  emit({
    type: "control_request",
    request_id: requestId,
    request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: ASK_INPUT },
  });
}

/**
 * The answer coming back down, written into the transcript the way the real CLI writes it.
 *
 * A user record carrying nothing but a `tool_result`, which is exactly the shape every
 * harness parser drops as machine noise (`claude/transcript.ts`) - so the conversation gets
 * NO account of the answer from this file. That is deliberate: the spec beside it asserts
 * the account comes from the review the daemon records instead, and a fake that narrated
 * the answer in assistant prose would let that spec pass with the feature removed.
 */
function answerAsked(requestId, response) {
  const prompt = asked.get(requestId);
  if (prompt === undefined) return;
  asked.delete(requestId);
  const picked = response?.updatedInput?.answers ?? {};
  appendTurn("user", [
    {
      type: "tool_result",
      tool_use_id: requestId,
      content: `Your questions have been answered: ${Object.entries(picked)
        .map(([question, answer]) => `"${question}"="${answer}"`)
        .join(", ")}.`,
    },
  ]);
  answer([prompt]);
}

/** How many `result` frames this fake has emitted, so each carries a distinct turn uuid. */
let results = 0;

/**
 * What one turn cost, in the vendor's exact `result`-frame shape.
 *
 * Load-bearing rather than decoration, because this frame IS the accounting path for a driven
 * session. The daemon reads `uuid`, `modelUsage` and `total_cost_usd` off it and writes the
 * ledger row a card's spend chip and the fleet total are both read from; a `result` with none
 * of them - which is what this fake used to emit - exercises the code that decides a turn is
 * unattributable, and never the code that records one.
 *
 * The key names and nesting are copied from a real frame off
 * `claude -p --output-format stream-json`, not from documentation. `cacheCreationInputTokens`
 * is the WRITE tier and `cacheReadInputTokens` the read one, and `input_tokens` on the flat
 * block excludes both - the conventions the ledger's columns assume.
 *
 * Costs are round and small so a spec can assert exact rendered strings: $2.50 a turn.
 */
function turnUsage() {
  results += 1;
  return {
    uuid: `${SESSION_ID}-result-${results}`,
    total_cost_usd: 2.5,
    num_turns: results,
    modelUsage: {
      [MODEL]: {
        inputTokens: 1_000,
        outputTokens: 500,
        cacheReadInputTokens: 20_000,
        cacheCreationInputTokens: 3_000,
        costUSD: 2.5,
      },
    },
    usage: {
      input_tokens: 1_000,
      output_tokens: 500,
      cache_read_input_tokens: 20_000,
      cache_creation_input_tokens: 3_000,
    },
  };
}

/**
 * Answer a turn and close it.
 *
 * One `result` however many prompts the turn took in, because that is the vendor's shape:
 * `result` means the CLI stopped, not that one message was retired.
 */
function answer(prompts) {
  for (const prompt of prompts) {
    const text = replyTo(prompt);
    appendTurn("assistant", [{ type: "text", text }]);
    emit({
      type: "assistant",
      session_id: SESSION_ID,
      message: { role: "assistant", content: [{ type: "text", text }] },
    });
  }
  emit({ type: "result", subtype: "success", session_id: SESSION_ID, ...turnUsage() });
}

const rl = createInterface({ input: process.stdin });

rl.on("line", (line) => {
  if (!line.trim()) return;
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return; // the real CLI tolerates noise on this pipe; so do we
  }

  if (frame.type === "control_request") {
    // Every subtype gets a success. `get_usage` arrives repeatedly (once per init and per
    // result) and the driver .catch()es a missing answer, but answering keeps the log clean.
    ok(frame.request_id, frame.request?.subtype === "get_usage" ? { rate_limits_available: false } : {});
    return;
  }

  // The reply to a `can_use_tool` this CLI sent up. Previously dropped on the floor, which
  // was harmless only while nothing here ever asked anything.
  if (frame.type === "control_response") {
    const { request_id: requestId, subtype, response } = frame.response ?? {};
    if (!asked.has(requestId)) return;
    // A denial is how the SDK abandons an ask nobody answered. The turn still has to end,
    // or the session hangs "working" for the rest of the spec.
    if (subtype !== "success" || response?.behavior !== "allow") {
      const prompt = asked.get(requestId);
      asked.delete(requestId);
      answer([prompt]);
      return;
    }
    answerAsked(requestId, response);
    return;
  }

  if (frame.type === "user") {
    const raw = frame.message?.content;
    // Content is a bare string on the seeded first turn and an array of blocks when the
    // composer attaches anything. Both shapes reach here.
    const prompt =
      typeof raw === "string"
        ? raw
        : Array.isArray(raw)
          ? raw.filter((b) => b?.type === "text").map((b) => b.text).join("\n")
          : "";

    appendTurn("user", prompt);
    if (prompt.includes(SLOW_STOP)) slowStop = true;

    // A message that arrives while a turn is open is ABSORBED BY THAT TURN, and the turn
    // still ends with exactly one `result`. That is what Claude Code does - it attaches the
    // message to the running turn as a `queued_command` rather than holding it for a
    // separate next turn - and modelling it here is the whole point of this branch. A fake
    // that answered every message with its own result would let a driver reserve one
    // completion per message and never notice the reservation it was owed for ever.
    if (openTurn) {
      openTurn.prompts.push(prompt);
      return;
    }

    // Blocks the turn on a human, which is the whole point: no `result` is emitted until the
    // answer comes back down, so the card stays "waiting on you" for the spec to act on.
    if (prompt === ASK_TURN) {
      ask(prompt);
      return;
    }

    // One deterministic busy window for the queued-turn browser specs. Ordinary prompts
    // still answer synchronously, so existing conversation specs keep their fast path. The
    // delay is inside the fake agent, not the dashboard or daemon, and therefore exercises
    // the real SDK busy state and pending-turn route without spending model tokens.
    if (prompt === HELD_TURN) {
      const turnState = { prompts: [prompt] };
      openTurn = turnState;
      setTimeout(() => {
        openTurn = null;
        answer(turnState.prompts);
      }, HELD_TURN_MS);
      return;
    }
    answer([prompt]);
  }
});

// Exiting early is what makes a card die: the driver turns any nonzero exit OR an early
// close into `{kind:"exited"}` and evicts the session. Stay alive until the SDK closes
// stdin, then leave cleanly.
rl.on("close", () => {
  if (slowStop) setTimeout(() => process.exit(0), SLOW_STOP_MS);
  else process.exit(0);
});

}
