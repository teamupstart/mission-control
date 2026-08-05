#!/usr/bin/env node
/**
 * A stand-in for the `pi` binary that genuinely plays a demo scenario, the same schema
 * `fake-claude.mjs` and `fake-codex.mjs` do - not a stub.
 *
 * pi's real launch shape, taken from `src/server/harness/pi/launch.ts`'s `preparePiLaunch`
 * and `src/server/harness/index.ts`'s `pi.resume`: `pi --session-id <uuid> <initial message>`
 * on dispatch, `pi --session <uuid>` on resume (no message - pi keeps history itself). pi has
 * no control wire at all: `hooks: null` (no push channel) and `sdk: null` (no RPC driver), so
 * there is nothing to speak on stdio. The daemon's ENTIRE view of a pi session - its
 * conversation and its idle/working state - comes from one file it reads passively:
 * `src/server/harness/pi/transcript.ts` (`locatePiTranscript`, `piToMessage`) and
 * `src/server/harness/pi/meta.ts` (`computePiSessionActivity`). This file writes exactly that
 * file, in pi's own path encoding and record shape, and plays a scenario into it for real:
 * paced `assistant`/`tool`/`editFile`/`result` steps, with `ask` narrated rather than
 * blocking (see below).
 *
 * WHAT THIS DOES AND DOES NOT CLOSE: this binary is a genuine scenario player - invoked with
 * a real `--session-id` and prompt, it writes a real pi-shaped transcript with real file
 * edits, exactly like its Claude and Codex siblings. What it cannot do anything about is
 * getting the resulting session ADOPTED into the dashboard: pi's only real runtime is a
 * terminal pane, and pane discovery is the passive sweep this demo turns off as a
 * non-negotiable isolation guard (see `launch.mjs`'s `installPlayers` and README.md's Demo
 * mode section for the full, separately-documented reasoning). That is a fact about this
 * demo's daemon configuration, not about whether this player executes a scenario - it does.
 */
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

function argvValue(...flags) {
  for (const flag of flags) {
    const index = process.argv.indexOf(flag);
    if (index >= 0) return process.argv[index + 1];
  }
  return undefined;
}

const SESSION_ID = argvValue("--session-id", "--session") ?? randomUUID();
const MODEL = "pi-demo-mock";

/** The dispatch shape's trailing positional prompt; resume has none. */
function initialPrompt() {
  const argv = process.argv.slice(2);
  let prompt = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--session-id" || a === "--session") {
      i += 1; // skip the flag's value too - it is not a positional
      continue;
    }
    if (a.startsWith("-")) continue;
    prompt = a;
  }
  return prompt;
}

// --- scenario loading (shared schema with fake-claude.mjs / fake-codex.mjs) --------------

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

// --- pi's transcript, in pi's own path encoding and record shape --------------------------

/**
 * pi's cwd -> project-dir encoding, taken verbatim from `src/server/harness/pi/transcript.ts`'s
 * `piProjectDir`: strip a leading slash, replace `/ \ :` with `-`, wrap in `--`.
 */
function piProjectDir(cwd) {
  const safe = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(homedir(), ".pi", "agent", "sessions", safe);
}

const projectDir = piProjectDir(process.cwd());
mkdirSync(projectDir, { recursive: true });
// pi's own filename shape: `<filename-safe-ISO-ts>_<uuid>.jsonl`.
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const transcriptPath = join(projectDir, `${stamp}_${SESSION_ID}.jsonl`);
writeFileSync(transcriptPath, "");

/** One pi `message` record. `stopReason: "stop"` is what `computePiSessionActivity` reads as
 * idle - everything else is read as working, the safe bias pi's own driver applies. */
function appendMessage(role, content, stopReason) {
  appendFileSync(
    transcriptPath,
    `${JSON.stringify({
      type: "message",
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      message: {
        role,
        content,
        ...(role === "assistant" ? { model: MODEL, ...(stopReason ? { stopReason } : {}) } : {}),
      },
    })}\n`,
  );
}

/** Write a scenario's file into the session's cwd, refusing anything outside it. */
function writeScenarioFile(relPath, content) {
  const cwd = process.cwd();
  const target = resolve(cwd, String(relPath ?? ""));
  if (target !== cwd && !target.startsWith(cwd + sep)) return;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, String(content ?? ""));
}

/** Play a scenario's steps in order, each after its own `delayMs`, writing pi's transcript
 * as it goes. Resolves once the scenario has ended and idle has been recorded. */
function playScenario(steps) {
  return new Promise((resolvePlay) => {
    const run = (remaining) => {
      if (!remaining || remaining.length === 0) {
        // The idle backstop: whatever the last step was, one final clean-stop record is what
        // flips the session to idle, exactly as a real pi turn ending cleanly would.
        appendMessage("assistant", [], "stop");
        resolvePlay();
        return;
      }
      const [step, ...rest] = remaining;
      const delayMs = Number(step?.delayMs) || 0;
      setTimeout(() => {
        switch (step?.kind) {
          case "assistant":
            appendMessage("assistant", [{ type: "text", text: String(step.text ?? "") }]);
            break;
          case "tool":
            appendMessage("assistant", [
              { type: "tool_call", name: step.name ?? "tool", input: step.input ?? {} },
            ]);
            break;
          case "editFile":
            writeScenarioFile(step.path, step.content);
            break;
          case "ask": {
            // pi has no AskUserQuestion-equivalent control channel to block a turn on - the
            // same documented degradation `fake-codex.mjs` applies for its approval gap.
            const questions = Array.isArray(step.questions) ? step.questions : [];
            const asked = questions.map((q) => q?.question).filter(Boolean).join(" / ") || "a question";
            appendMessage("assistant", [
              {
                type: "text",
                text: `I'd ask: ${asked} - but this demo's pi sessions have no channel to ask through, so I'm continuing with a reasonable default.`,
              },
            ]);
            break;
          }
          case "result":
          default:
            break;
        }
        run(rest);
      }, delayMs);
    };
    run(steps);
  });
}

const prompt = initialPrompt();
appendMessage("user", prompt);
await playScenario(selectScenario(prompt).steps);
process.exit(0);
