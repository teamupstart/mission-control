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
    process.stdout.write(JSON.stringify({ result: headlessAnswer(prompt) }));
    process.exit(0);
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
 * Everything else (the titler, the goal refiner) keeps the fixed title reply below.
 */
function headlessAnswer(prompt) {
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
    const finish = () => {
      const answer = replyTo(prompt);
      appendTurn("assistant", [{ type: "text", text: answer }]);

      emit({
        type: "assistant",
        session_id: SESSION_ID,
        message: { role: "assistant", content: [{ type: "text", text: answer }] },
      });
      emit({ type: "result", subtype: "success", session_id: SESSION_ID });
    };

    // One deterministic busy window for the queued-turn browser spec. Ordinary prompts
    // still answer synchronously, so existing conversation specs keep their fast path. The
    // delay is inside the fake agent, not the dashboard or daemon, and therefore exercises
    // the real SDK busy state and pending-turn route without spending model tokens.
    if (prompt === HELD_TURN) setTimeout(finish, HELD_TURN_MS);
    else finish();
  }
});

// Exiting early is what makes a card die: the driver turns any nonzero exit OR an early
// close into `{kind:"exited"}` and evicts the session. Stay alive until the SDK closes
// stdin, then leave cleanly.
rl.on("close", () => process.exit(0));

}
