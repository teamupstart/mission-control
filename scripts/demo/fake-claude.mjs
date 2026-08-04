#!/usr/bin/env node
/**
 * A stand-in for the `claude` binary that plays scripted, token-free demo sessions.
 *
 * Derived from `e2e/fixtures/fake-claude.mjs`: the same two protocols (the SDK session
 * control wire, and the `-p --output-format json` one-shots the daemon's own background
 * jobs use) and the same load-bearing trick - the transcript the dashboard renders is a
 * FILE this process writes itself, never a payload on the control wire. Kept as a
 * separate file rather than an edit to the e2e fixture because that fixture is a
 * deliberately minimal, determinism-critical test asset; this one instead reads a
 * directory of scenario scripts and plays them out with pacing, tool chips, and real file
 * writes, which the e2e suite has no use for. See docs/plans/demo-mode/ for the contract
 * this implements.
 *
 * WHY THIS FILE HAS NO EXTENSION AT THE PATH IT RUNS FROM
 * The vendored Agent SDK spawns `node <path>` for anything ending in one of
 * `.js`/`.mjs`/`.ts`/`.jsx`/`.tsx`, and execs anything else directly. `launch.mjs` copies
 * this file to an extension-less path and chmods it so the `#!/usr/bin/env node` shebang
 * picks the interpreter, exactly like `e2e/fixtures/fake-agents.ts` does for its fake.
 *
 * WHAT THE DRIVER ACTUALLY READS off the control wire (`ClaudeSdkSession.consume`):
 *   - `system`/`init`      -> binds the model
 *   - a frame with a new `session_id` -> emits `bound`
 *   - `assistant`          -> card goes to "working", activity = tool name or first text line
 *   - `result`             -> `turn_done`, card goes idle
 *   - `control_request` with `can_use_tool` -> the "waiting on you" card
 *
 * SCENARIO SCHEMA (also documented in README.md's "Demo mode" section)
 * Each `*.json` file under `MISSION_DEMO_SCENARIO_DIR` is one scenario:
 *   {
 *     "title": "Fix the flaky retry test",
 *     "match": ["flaky", "retry"],        // substrings (case-insensitive) to match against
 *                                          // the dispatched prompt; omit or [] to never
 *                                          // match by content
 *     "default": false,                   // picked when nothing else matches
 *     "steps": [
 *       { "kind": "assistant", "text": "...", "delayMs": 800 },
 *       { "kind": "tool", "name": "Edit"|"Write"|"Bash"|"TodoWrite", "input": {...}, "delayMs": 500 },
 *       { "kind": "editFile", "path": "src/foo.ts", "content": "...", "delayMs": 300 },
 *       { "kind": "ask", "questions": [ { "question", "header", "options": [{"label","description"}], "multiSelect"? } ] },
 *       { "kind": "result" }
 *     ]
 *   }
 * Steps play in order, each after its own `delayMs` (default 0), with the turn held open
 * the whole time - that pacing plus emitting an `assistant` frame per step is what keeps
 * the card visibly "working" rather than looking stalled. An `ask` step blocks the turn on
 * an `AskUserQuestion` control request and only resumes the remaining steps once the
 * dashboard answers it. A scenario with no explicit trailing `"result"` step still ends
 * the turn once its steps run out.
 */
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const SESSION_ID = process.env.MC_DEMO_SESSION_ID ?? randomUUID();

function argvValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const MODEL = argvValue("--model") ?? "claude-demo-mock";

// --- scenario loading -------------------------------------------------------------------

const FALLBACK_SCENARIOS = [
  {
    title: "Demo session",
    match: [],
    default: true,
    steps: [
      { kind: "assistant", text: "Working on it.", delayMs: 600 },
      { kind: "result" },
    ],
  },
];

/** Every scenario in `MISSION_DEMO_SCENARIO_DIR`, or the built-in fallback if none load. */
function loadScenarios() {
  const dir = process.env.MISSION_DEMO_SCENARIO_DIR;
  if (!dir) return FALLBACK_SCENARIOS;
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return FALLBACK_SCENARIOS;
  }
  const scenarios = [];
  for (const file of files) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, file), "utf8"));
      if (parsed && Array.isArray(parsed.steps)) scenarios.push(parsed);
    } catch {
      // A malformed scenario file loses only itself, not the whole demo.
    }
  }
  return scenarios.length > 0 ? scenarios : FALLBACK_SCENARIOS;
}

const SCENARIOS = loadScenarios();

/** The scenario whose `match` substrings hit the prompt, else the flagged default, else the first. */
function selectScenario(prompt) {
  const lower = prompt.toLowerCase();
  for (const scenario of SCENARIOS) {
    const patterns = Array.isArray(scenario.match) ? scenario.match : [];
    if (patterns.some((p) => typeof p === "string" && p && lower.includes(p.toLowerCase()))) {
      return scenario;
    }
  }
  return SCENARIOS.find((s) => s.default) ?? SCENARIOS[0];
}

// --- headless one-shot mode (`claude -p`) -----------------------------------------------
//
// `src/server/llm/claude-cli.ts` runs `claude -p --output-format json` for the daemon's own
// offline work - the task titler and the goal refiner run through the daemon in every demo
// session; the Foreman's own calls do NOT reach this file, because the launcher gives the
// Foreman child the real `claude` bin in its own environment. One shot: prompt on stdin, a
// single JSON object on stdout, exit.

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
 * One deterministic answer per kind of headless call this file recognizes by the RULES
 * text every caller embeds verbatim in its prompt. Unrecognized callers (for example an
 * ad-hoc Persona review with no scripted verdict) get the matched scenario's title as
 * plain text, which fails that caller's own schema - the same limitation the e2e fixture
 * accepts, and every caller here already has a deterministic-degradation fallback for a
 * parse miss (see `fallbackWorkflowContext` and friends), so this never blocks a demo.
 */
function headlessAnswer(prompt) {
  // `src/server/workflows/context.ts`'s `compactPrompt` - the workflow intent compactor.
  if (prompt.includes("Compact workflow intent without rewriting it.")) {
    return JSON.stringify({ constraints: [], acceptanceCriteria: [] });
  }
  // `src/server/goal/prompt.ts`'s `RULES` - the intent/goal reconciler that runs after
  // every human instruction, including the seeded first one.
  if (prompt.includes("You reconcile the intent of an AI coding session")) {
    const objective = prompt.match(
      /## The specific unresolved instruction to classify now\n([\s\S]*?)(?:\n\n## Conversation|\n\nNow output)/,
    )?.[1]?.trim() || "Complete the demo task";
    return JSON.stringify({
      relationship: "initial",
      objective,
      goal: objective,
      focus: objective,
      reason: "The first substantive instruction of this demo session",
    });
  }
  // `src/server/task-title.ts`'s `RULES` - names an untitled dispatch. Answering with the
  // matched scenario's own title is what puts a real name on the card instead of one the
  // fallback heuristic guesses from the intent's first line. Matched against the extracted
  // task text, not the whole prompt: `RULES` itself uses "Fix flaky ... on Reset" as a
  // worked example, and matching the raw prompt would hit `bug-fix.json`'s own "flaky"/"fix"
  // patterns on every dispatch regardless of what was actually typed.
  if (prompt.includes("You name coding tasks for a dispatch board")) {
    const intent = prompt.match(/## The task text\n([\s\S]*?)\n\nNow output the title/)?.[1]?.trim() || prompt;
    const scenario = selectScenario(intent);
    return JSON.stringify({ title: scenario.title || "Demo session" });
  }
  return selectScenario(prompt).title || "Demo session";
}

function runSession() {

// --- the transcript file the dashboard actually renders ----------------------------------

const projectDir = join(homedir(), ".claude", "projects", process.cwd().replace(/[/.]/g, "-"));
mkdirSync(projectDir, { recursive: true });
const transcriptPath = join(projectDir, `${SESSION_ID}.jsonl`);
// Created eagerly: `resolveTranscriptPath` returns null for a path that does not exist
// yet, and the `bound` event that carries it fires as soon as the first frame lands.
writeFileSync(transcriptPath, "");

let turn = 0;
function appendTurn(role, content) {
  turn += 1;
  appendFileSync(
    transcriptPath,
    `${JSON.stringify({
      type: role,
      uuid: `${role}-${turn}`,
      timestamp: new Date().toISOString(),
      message: { role, content, ...(role === "assistant" ? { model: MODEL } : {}) },
    })}\n`,
  );
}

// --- the control protocol -----------------------------------------------------------------

function emit(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function ok(requestId, response = {}) {
  emit({ type: "control_response", response: { subtype: "success", request_id: requestId, response } });
}

emit({ type: "system", subtype: "init", session_id: SESSION_ID, model: MODEL });

/** Append one assistant turn to the transcript AND put it on the wire, so the activity
 * ticker (tool name, or first line of prose) updates the moment the step plays. */
function deliver(contentBlocks) {
  appendTurn("assistant", contentBlocks);
  emit({ type: "assistant", session_id: SESSION_ID, message: { role: "assistant", content: contentBlocks } });
}

/** Write a scenario's file into the session's cwd - the real git worktree dispatch cut -
 * refusing anything that would land outside it. */
function writeScenarioFile(relPath, content) {
  const cwd = process.cwd();
  const target = resolve(cwd, String(relPath ?? ""));
  if (target !== cwd && !target.startsWith(cwd + sep)) return;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, String(content ?? ""));
}

/** Requests this CLI sent UP (`AskUserQuestion`) and has not been answered for yet, by
 * request id, holding the steps still to play once the answer comes back. */
const asked = new Map();

/** Whether a turn is currently running - guards new prompts from starting a second
 * scenario while one is already mid-flight (steps pacing, or an `ask` pending). */
let turnOpen = false;

function finishTurn() {
  turnOpen = false;
  emit({ type: "result", subtype: "success", session_id: SESSION_ID });
}

/** Play a scenario's remaining steps, one at a time, each after its own `delayMs`. */
function runSteps(steps) {
  if (!steps || steps.length === 0) {
    finishTurn();
    return;
  }
  const [step, ...rest] = steps;
  const delayMs = Number(step?.delayMs) || 0;
  setTimeout(() => {
    switch (step?.kind) {
      case "assistant":
        deliver([{ type: "text", text: String(step.text ?? "") }]);
        runSteps(rest);
        return;
      case "tool":
        deliver([{ type: "tool_use", id: `tool-${++turn}`, name: step.name ?? "tool", input: step.input ?? {} }]);
        runSteps(rest);
        return;
      case "editFile":
        writeScenarioFile(step.path, step.content);
        runSteps(rest);
        return;
      case "ask": {
        const requestId = `ask-${++turn}`;
        const input = { questions: Array.isArray(step.questions) ? step.questions : [] };
        asked.set(requestId, rest);
        appendTurn("assistant", [{ type: "tool_use", id: requestId, name: "AskUserQuestion", input }]);
        emit({
          type: "control_request",
          request_id: requestId,
          request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input },
        });
        return; // the turn stays open until the control_response for this request arrives
      }
      case "result":
      default:
        finishTurn();
    }
  }, delayMs);
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
    // Every subtype gets a success. `get_usage` arrives repeatedly and the driver
    // `.catch()`es a missing answer, but answering keeps the log clean.
    ok(frame.request_id, frame.request?.subtype === "get_usage" ? { rate_limits_available: false } : {});
    return;
  }

  // The reply to a `can_use_tool` this CLI sent up for an `ask` step.
  if (frame.type === "control_response") {
    const { request_id: requestId, subtype, response } = frame.response ?? {};
    const remaining = asked.get(requestId);
    if (remaining === undefined) return;
    asked.delete(requestId);
    // A denial is how the SDK abandons an ask nobody answered. The turn still has to end,
    // or the card would stay "working" for the rest of the demo.
    if (subtype !== "success" || response?.behavior !== "allow") {
      finishTurn();
      return;
    }
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
    runSteps(remaining);
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

    // A message that arrives while a turn is already running (steps still pacing, or an
    // `ask` pending) is absorbed into the transcript for the record, but does not start a
    // second scenario - the one already in flight still owns the only `result` this turn
    // will get.
    if (turnOpen) return;

    turnOpen = true;
    runSteps(selectScenario(prompt).steps);
  }
});

// Exiting early is what makes a card die: the driver turns any nonzero exit OR an early
// close into `{kind:"exited"}` and evicts the session. Stay alive until the SDK closes
// stdin, then leave cleanly.
rl.on("close", () => process.exit(0));

}
