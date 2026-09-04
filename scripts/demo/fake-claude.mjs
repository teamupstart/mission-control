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
 * RESUME (`--resume=<id>`) IS A CONTINUATION, NOT A NEW SESSION
 * The daemon relaunches every `suspended` session at boot, and the seeded fleet is built out
 * of exactly those. So this player adopts the resumed id as its own, appends to the
 * transcript already at that path instead of truncating it, and continues its record
 * numbering - see `resumedSessionId()` for what breaks otherwise.
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
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

function argvValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/**
 * The session id a `--resume` asks this process to CONTINUE, or null for a fresh session.
 *
 * Load-bearing for the seeded fleet, and the reason this is not just `randomUUID()`.
 * `SdkSupervisor.resume()` relaunches every `suspended` row on boot with the harness-native
 * id the driver last reported, and the vendored SDK renders that as a single `--resume=<id>`
 * argv element (never `--resume <id>` - but both are read here, because which one the SDK
 * emits is its choice, not a contract). Minting a fresh id instead would make the driver
 * re-bind the card to it (`ClaudeSdkSession.consume` re-binds on ANY new `session_id`), and
 * `resolveTranscriptPath` would then derive `<the new id>.jsonl` - an empty file this
 * process had just created. The card would come back with its whole conversation gone.
 */
function resumedSessionId() {
  for (const arg of process.argv) {
    if (arg.startsWith("--resume=")) return arg.slice("--resume=".length) || null;
  }
  return argvValue("--resume") ?? null;
}

const RESUMED_SESSION_ID = resumedSessionId();
const SESSION_ID = process.env.MC_DEMO_SESSION_ID ?? RESUMED_SESSION_ID ?? randomUUID();

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

/** Every scenario in `dir` (default `MISSION_DEMO_SCENARIO_DIR`), or the built-in fallback. */
export function loadScenarios(dir = process.env.MISSION_DEMO_SCENARIO_DIR) {
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

/**
 * The scenario whose `match` substrings hit the prompt, else the flagged default, else the
 * first.
 *
 * Takes its scenarios as an argument rather than reading the module's own, so the routing can
 * be asserted directly - `test/demo-seed.test.ts` pins every seeded intent against the
 * shipped table, because a scenario that silently shadows another shows up only as a demo
 * whose conversation is about the wrong task.
 */
export function selectScenario(scenarios, prompt) {
  const lower = String(prompt ?? "").toLowerCase();
  for (const scenario of scenarios) {
    const patterns = Array.isArray(scenario.match) ? scenario.match : [];
    if (patterns.some((p) => typeof p === "string" && p && lower.includes(p.toLowerCase()))) {
      return scenario;
    }
  }
  return scenarios.find((s) => s.default) ?? scenarios[0];
}

/**
 * The prompt `SdkSupervisor.resume` sends a session whose turn was still open at shutdown.
 *
 * Matched as a PREFIX of the real text rather than quoted whole: the daemon owns that sentence,
 * and a scenario table pinned to its full wording would silently stop recognising a continuation
 * the day someone rephrased the second half of it.
 */
export const CONTINUATION_MARKER = "Mission Control restarted while your previous turn";

/**
 * The scenario that continues `original`, or null when nothing declares itself its continuation.
 *
 * A continuation is the one prompt every restored session receives WORD FOR WORD, so matching on
 * its text alone can only ever reach one scenario - which is why the demo could hold exactly one
 * waiting-on-you card before this: a second one came back asking the first one's questions. The
 * fix is to route a continuation by the work it belongs to, which the scenario file declares as
 * `"continues": "<the original scenario's title>"`.
 */
export function continuationFor(scenarios, original) {
  if (!original?.title) return null;
  return scenarios.find((scenario) => scenario.continues === original.title) ?? null;
}

/**
 * What to play for a restored session's continuation turn.
 *
 * `originalIntent` is this session's FIRST human turn, read back out of its own transcript - the
 * only thing on hand that says what the session was ever about, since the continuation prompt
 * says nothing about it. Falls back to ordinary prompt matching, which reaches the generic
 * continuation scenario, so a session whose work declares no continuation still comes back
 * re-asking rather than silently idle.
 */
export function selectContinuation(scenarios, originalIntent, prompt) {
  const original = selectScenario(scenarios, originalIntent);
  return continuationFor(scenarios, original) ?? selectScenario(scenarios, prompt);
}

/**
 * The first human turn in a transcript this player wrote earlier: the dispatched intent.
 *
 * Reads the records rather than remembering anything, because a resumed player is a NEW process
 * with no memory of the run it is continuing - the transcript file is the only thing that
 * survived. Tolerant by construction: a record shape it does not recognise is skipped, and no
 * user turn at all answers null rather than throwing on a file another build wrote.
 */
export function firstUserPrompt(lines) {
  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.type !== "user") continue;
    const content = record.message?.content;
    if (typeof content === "string" && content.trim()) return content;
    if (Array.isArray(content)) {
      const text = content.filter((b) => b?.type === "text").map((b) => b.text).join("\n").trim();
      if (text) return text;
    }
  }
  return null;
}

const SCENARIOS = loadScenarios();

/** `selectScenario` bound to this process's own loaded table. */
function pick(prompt) {
  return selectScenario(SCENARIOS, prompt);
}

// --- headless one-shot mode (`claude -p`) -----------------------------------------------
//
// `src/server/llm/claude-cli.ts` runs `claude -p --output-format json` for the daemon's own
// offline work - the task titler and the goal refiner run through the daemon in every demo
// session, and every Persona review a seeded Workflow run performs; the Foreman's own calls do
// NOT reach this file, because the launcher gives the Foreman child the real `claude` bin in its
// own environment. One shot: prompt on stdin, a single JSON object on stdout, exit.

// Guarded so a test can import the scenario matcher without this file trying to BE a
// session - importing a script must not run it. The same guard `launch.mjs` uses, and true
// under every way this file is actually launched: the SDK execs the extension-less copy
// through its shebang (`process.argv[1]` is that path), and `claude-cli.ts` spawns it the
// same way.
if (import.meta.url === `file://${process.argv[1]}`) {
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
}

/**
 * The marker a Persona's own guidance carries to make this player REFUSE its next review.
 *
 * The steering channel is the guidance rather than a flag on this process, because a review
 * prompt embeds the published guidance verbatim (`buildPersonaPrompt`'s
 * "# Published Persona guidance" section) and that is the only per-reviewer channel a scripted
 * fake gets. Same trick as `e2e/fixtures/fake-claude.mjs`'s `E2E_FAIL_VERDICT`; nothing in the
 * shipped demo uses it yet, and a scenario that wants to show a repair round is what it is for.
 */
export const DEMO_FAIL_VERDICT_MARKER = "DEMO_FAIL_VERDICT";

/** The two markers `buildPersonaPrompt` always emits, and no other caller here does. */
const PERSONA_REVIEW_MARKERS = ["# Published Persona guidance", "A pass must have"];

/**
 * The reviewer's own name, taken from the first heading of the guidance the prompt quotes.
 *
 * Read out of the prompt rather than invented, because the verdict's summary is rendered on the
 * run's reviewer card and "Demo approval" on four cards says nothing - `Intent Conformance Judge`
 * beside `Code Risk Reviewer` is what makes a seeded run legible as a pipeline. The prompt never
 * states the Persona name as a field, so the guidance's `# Heading` is the honest source.
 */
export function personaUnderReview(prompt) {
  return quotedGuidance(prompt).match(/^#{1,3} (.+)$/m)?.[1]?.trim() || "Reviewer";
}

/**
 * Just the guidance the prompt quotes, up to the section after it.
 *
 * Both reads below are scoped to this slice rather than to the whole prompt, and that is the
 * difference between a per-reviewer channel and a trap: the prompt also carries the session's
 * diff and transcript as untrusted evidence, so a fail marker matched anywhere would let the
 * REVIEWED WORK decide its own verdict.
 */
function quotedGuidance(prompt) {
  const after = String(prompt ?? "").split("# Published Persona guidance")[1] ?? "";
  // The NEXT section by name, not "the next `# ` line": the guidance is Markdown and its own
  // first line is usually a `#` heading, which is exactly the line this has to keep.
  return after.split("# Prior Persona feedback")[0] ?? after;
}

/**
 * A schema-valid `PersonaVerdict` for one review, passing unless the guidance asks otherwise.
 *
 * Pass is the default because the demo's one seeded run exists to show a CLEAN end-to-end
 * completion - the pipeline agreeing on round one, which is the outcome an operator has never
 * seen if every screenshot they have of the feature is a refusal. It is a fixed answer and not a
 * judgement: this process cannot read a diff, and pretending to would be worse than saying so.
 */
export function personaVerdict(prompt) {
  const persona = personaUnderReview(prompt);
  if (quotedGuidance(prompt).includes(DEMO_FAIL_VERDICT_MARKER)) {
    return {
      verdict: "fail",
      summary: `${persona} is asking for one change`,
      requestedChanges: [
        {
          title: "Scripted demo objection",
          rationale: `${persona} is scripted to refuse so the repair round is visible.`,
          evidence: [{ kind: "goal", quote: "scripted demo evidence" }],
        },
      ],
      confidence: 0.9,
    };
  }
  return {
    verdict: "pass",
    summary: `${persona}: no objection`,
    approvalDetails: {
      reason: `${persona} found nothing to send back: the change matches what was asked and the`
        + " tests in the diff cover the behaviour it adds.",
      evidence: [],
    },
    confidence: 0.9,
  };
}

/**
 * One deterministic answer per kind of headless call this file recognizes by the RULES
 * text every caller embeds verbatim in its prompt. Unrecognized callers get the matched
 * scenario's title as plain text, which fails that caller's own schema - the same limitation the
 * e2e fixture accepts, and every caller here already has a deterministic-degradation fallback for
 * a parse miss (see `fallbackWorkflowContext` and friends), so this never blocks a demo.
 *
 * A workflow Persona review is deliberately NOT left to that degradation. It has no fallback:
 * `parsePersonaVerdict` returning null is an infrastructure failure, and three of those block the
 * run (`MAX_INFRA_ATTEMPTS`) - so a seeded Workflow with real reviewers in it would end
 * `Workflow blocked` on the demo's own showcase card rather than `⌁ Approved`.
 */
export function headlessAnswer(prompt) {
  // First, because a review prompt also quotes the session's transcript and could otherwise
  // contain another caller's marker inside its own untrusted evidence block.
  if (PERSONA_REVIEW_MARKERS.every((marker) => String(prompt ?? "").includes(marker))) {
    return JSON.stringify(personaVerdict(prompt));
  }
  // `src/server/workflows/context.ts`'s `compactPrompt` - the workflow intent compactor.
  if (prompt.includes("Compact workflow intent without rewriting it.")) {
    return JSON.stringify({ constraints: [], acceptanceCriteria: [], canonicalCriteria: [] });
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
    const scenario = pick(intent);
    return JSON.stringify({ title: scenario.title || "Demo session" });
  }
  return pick(prompt).title || "Demo session";
}

/** How many turns this process has finished, so each one's usage differs a little. */
let turnsFinished = 0;
const cumulativeUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  costUSD: 0,
};

/**
 * A stable 0-10 offset derived from this session's own id, so two CARDS differ too.
 *
 * Without it every session's first turn reports the identical figure - four cards reading exactly
 * $0.48 in a screenshot, which is the tell that the numbers are a constant rather than a fleet.
 * Folded from the id rather than randomized, so a resumed session keeps the scale it had before
 * the restart instead of re-rolling its own history.
 */
const USAGE_OFFSET = [...SESSION_ID].reduce((sum, ch) => sum + ch.charCodeAt(0), 0) % 11;

/**
 * What a finished turn reports it cost, in the `result` frame's own shape.
 *
 * THIS is where a demo card's per-session cost comes from, and it has to be here rather than in
 * the seeder. Claude session spend is written by whichever of two writers owns the note key
 * (`Registry.applyOtelMetrics` -> `sdkOwnedNoteKey`): for a DRIVEN session the driver wins and
 * every OTLP datapoint carrying that session's id is dropped on purpose, so the demo's cards -
 * all of them SDK sessions - can never be given spend through `/v1/metrics`. They can be given
 * it the way a real embedded session gets it: off the `result` frame, which
 * `claudeTurnUsage` -> `recordDriverSessionUsage` reads into the ledger.
 *
 * Field names are the CLI's, read in one place by `claudeEnvelopeModels`: `modelUsage` keyed by
 * model id, with `inputTokens`, `outputTokens`, `cacheReadInputTokens`,
 * `cacheCreationInputTokens` and `costUSD`. The `uuid` is the turn's dedup identity
 * (`claudeEnvelopeTurnId`); a frame without one records nothing at all, which is why it is minted
 * here per turn rather than per process.
 *
 * The figures are invented, and that is the honest part of a demo whose model calls never
 * happened. Each turn's increment is plausible rather than arbitrary, then added to the
 * query-to-date counters the real streaming SDK reports.
 */
export function turnUsage() {
  turnsFinished += 1;
  const n = turnsFinished + USAGE_OFFSET;
  cumulativeUsage.inputTokens += 3_400 + n * 820;
  cumulativeUsage.outputTokens += 900 + n * 240;
  cumulativeUsage.cacheReadInputTokens += 48_000 + n * 5_500;
  cumulativeUsage.cacheCreationInputTokens += 6_200 + n * 400;
  // Priced, not left null: an unpriced row takes the WHOLE fleet figure to "unpriced" rather
  // than to a smaller number (`fleetEstimatedCostSince` returns null when any row is unknown).
  cumulativeUsage.costUSD = Number(
    (cumulativeUsage.costUSD + Number((0.31 + n * 0.17).toFixed(4))).toFixed(4),
  );
  return {
    uuid: randomUUID(),
    total_cost_usd: cumulativeUsage.costUSD,
    num_turns: turnsFinished,
    modelUsage: {
      // The BOUND model, so the ledger charges the card for the model the card says it is
      // running. A real id here would read better in the cost drawer's per-model breakdown and
      // would be the one line of this demo that lied about which model did the work.
      [MODEL]: {
        ...cumulativeUsage,
      },
    },
  };
}

function runSession() {

// --- the transcript file the dashboard actually renders ----------------------------------

const projectDir = join(homedir(), ".claude", "projects", process.cwd().replace(/[/.]/g, "-"));
mkdirSync(projectDir, { recursive: true });
const transcriptPath = join(projectDir, `${SESSION_ID}.jsonl`);
// Created eagerly, but NEVER truncated: `resolveTranscriptPath` returns null for a path
// that does not exist yet, and the `bound` event that carries it fires as soon as the first
// frame lands - so the file has to be there. A resumed session's file already holds the
// conversation the card is about to show, and an unconditional truncate here would erase
// exactly the seeded history this whole mode exists to display.
if (!existsSync(transcriptPath)) writeFileSync(transcriptPath, "");

// Continue the record numbering where the existing transcript left off, rather than
// restarting at 1 and minting `assistant-1` a second time. `parseTranscript` keys each turn
// on `uuid` and `TranscriptPanel` renders those as React keys, so a resumed session that
// reused them would collide with its own history.
let turn = existsSync(transcriptPath)
  ? readFileSync(transcriptPath, "utf8").split("\n").filter((l) => l.trim()).length
  : 0;
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
  clearTimeout(idleAfterResume);
  emit({ type: "result", subtype: "success", session_id: SESSION_ID, ...turnUsage() });
}

/**
 * Say "idle" after a resume that nobody asked anything of.
 *
 * `ClaudeSdkSession.consume` moves a card off `starting` on exactly two frames: `assistant`
 * (working) and `result` (turn_done -> idle). A restored session whose previous turn had
 * already finished gets NEITHER - `SdkSupervisor.resume` launches it with `prompt: ""` and
 * only sends a continuation turn when `turnInProgress` was set - so without this the card
 * would sit at `starting` for the rest of the demo, which is both ugly and untrue.
 *
 * Deliberately on a timer rather than fired straight after `init`: a session that DOES owe a
 * continuation turn receives it immediately after adoption, and that turn should open the
 * card rather than race a result that says the opposite. Whichever happens first wins, and
 * `finishTurn` cancels this if a real turn got there first.
 */
const RESUME_IDLE_GRACE_MS = 750;
const idleAfterResume = RESUMED_SESSION_ID
  ? setTimeout(() => {
      if (!turnOpen) emit({ type: "result", subtype: "success", session_id: SESSION_ID });
    }, RESUME_IDLE_GRACE_MS)
  : null;

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

    // Read BEFORE this turn is appended, or the first user record would be the continuation
    // prompt itself on every restored session after the first restart.
    const original = prompt.includes(CONTINUATION_MARKER)
      ? firstUserPrompt(existsSync(transcriptPath)
        ? readFileSync(transcriptPath, "utf8").split("\n")
        : [])
      : null;

    appendTurn("user", prompt);

    // A message that arrives while a turn is already running (steps still pacing, or an
    // `ask` pending) is absorbed into the transcript for the record, but does not start a
    // second scenario - the one already in flight still owns the only `result` this turn
    // will get. This is also what holds a QUEUED message: `PendingTurnManager` only drains
    // onto a session with no held dialog, so a card parked on an `ask` keeps its outbox.
    if (turnOpen) return;

    turnOpen = true;
    // A continuation is routed by the work it belongs to rather than by its own text, which is
    // identical for every restored session - see `selectContinuation`.
    const scenario = original === null
      ? pick(prompt)
      : selectContinuation(SCENARIOS, original, prompt);
    runSteps(scenario.steps);
  }
});

// Exiting early is what makes a card die: the driver turns any nonzero exit OR an early
// close into `{kind:"exited"}` and evicts the session. Stay alive until the SDK closes
// stdin, then leave cleanly.
rl.on("close", () => process.exit(0));

}
