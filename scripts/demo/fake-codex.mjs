#!/usr/bin/env node
/**
 * A stand-in for the `codex` binary that plays scripted, token-free demo sessions.
 *
 * The Codex sibling of `fake-claude.mjs` - same scenario schema and `MISSION_DEMO_SCENARIO_DIR`,
 * played over `codex app-server`'s JSON-RPC control wire instead of Claude's. Derived from
 * `e2e/fixtures/fake-codex.mjs` for the wire mechanics (see that file's header for the full
 * protocol rundown); kept separate for the same reason `fake-claude.mjs` is.
 *
 * DELIBERATE SCOPE CUT (see the phase 1 plan): Codex has no equivalent here of Claude's
 * `AskUserQuestion` - its real "waiting on you" moment is a JSON-RPC *approval* request
 * (`execCommandApproval`/`applyPatchApproval`), a materially different mechanism this phase
 * does not implement. An `"ask"` scenario step still degrades gracefully: it is narrated as
 * an assistant message rather than a blocking card, so a scenario written for Claude does
 * not stall a Codex session. Codex sessions get paced text and tool-call items and real file
 * writes; the waiting-on-you demo runs on Claude.
 *
 * Nothing here reaches a headless `-p`-style one-shot: unlike Claude, Codex is never the
 * daemon's own offline-work runner unless an operator explicitly switches `MISSION_LLM_RUNNER`
 * to it (the shipped default is `claude`), so this file only has to speak the session protocol.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";

const THREAD_ID = process.env.MC_DEMO_CODEX_THREAD_ID ?? randomUUID();
const MODEL = "gpt-5-codex-demo-mock";

if (process.argv[2] !== "app-server") {
  process.stderr.write(`fake-codex: expected "app-server", got ${JSON.stringify(process.argv.slice(2))}\n`);
  process.exit(1);
}

// --- scenario loading (shared schema with fake-claude.mjs) --------------------------------

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

// --- the rollout the dashboard actually renders -------------------------------------------

// HOME is the demo state root (see `launch.mjs`), so this is the real `~/.codex/sessions/...`
// layout scoped to the demo rather than an operator's own.
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
      cli_version: "demo-mock",
    },
  })}\n`,
);

let itemSeq = 0;

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

/** A top-level `function_call` record - the shape `parseCodexMessages` groups under the
 * nearest preceding assistant message and renders as a tool chip. */
function appendFunctionCall(name, args) {
  appendFileSync(
    rolloutPath,
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "function_call",
      call_id: `tool-${++itemSeq}`,
      name: name ?? "tool",
      arguments: args ?? {},
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

// --- the control wire ----------------------------------------------------------------------

function write(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

const respond = (id, result) => write({ jsonrpc: "2.0", id, result });
const notify = (method, params) => write({ jsonrpc: "2.0", method, params });

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
    cliVersion: "demo-mock",
    source: "appServer",
    threadSource: "user",
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    title: null,
    turns: [],
  };
}

let turnSeq = 0;
/** The turn being held open, if any, and every prompt it has absorbed. */
let openTurn = null;

const textOf = (input) =>
  (Array.isArray(input) ? input : [])
    .filter((part) => part?.type === "text")
    .map((part) => part.text)
    .join("\n");

/** Play a scenario's remaining steps, one at a time, each after its own `delayMs`, then
 * complete the turn. Mirrors `fake-claude.mjs`'s runner, minus its `ask` blocking - see the
 * header for why that step degrades to narration here instead. */
function runSteps(turnId, steps, prompts) {
  if (!steps || steps.length === 0) {
    openTurn = null;
    for (const answered of prompts) appendRollout("agent_message", `Mock reply to: ${answered}`);
    notify("turn/completed", { threadId: THREAD_ID, turn: turnOf(turnId, "completed") });
    notify("thread/status/changed", { threadId: THREAD_ID, status: { type: "idle" } });
    return;
  }
  const [step, ...rest] = steps;
  const delayMs = Number(step?.delayMs) || 0;
  setTimeout(() => {
    switch (step?.kind) {
      case "assistant":
        appendRollout("agent_message", String(step.text ?? ""));
        break;
      case "tool":
        appendFunctionCall(step.name, step.input);
        break;
      case "editFile":
        writeScenarioFile(step.path, step.content);
        break;
      case "ask": {
        const questions = Array.isArray(step.questions) ? step.questions : [];
        const asked = questions.map((q) => q?.question).filter(Boolean).join(" / ") || "a question";
        appendRollout(
          "agent_message",
          `I'd ask: ${asked} - but this demo's Codex sessions don't support interactive questions yet, so I'm continuing with a reasonable default.`,
        );
        break;
      }
      case "result":
      default:
        break;
    }
    runSteps(turnId, rest, prompts);
  }, delayMs);
}

function runTurn(turnId, input) {
  const prompt = textOf(input);

  appendRollout("user_message", prompt);
  notify("turn/started", { threadId: THREAD_ID, turn: turnOf(turnId, "inProgress") });
  notify("thread/status/changed", {
    threadId: THREAD_ID,
    status: { type: "active", activeFlags: [] },
  });

  const turnState = { prompts: [prompt] };
  openTurn = turnState;
  runSteps(turnId, selectScenario(prompt).steps, turnState.prompts);
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
      respond(id, { userAgent: "fake-codex/demo" });
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
      respond(id, { turn: turnOf(turnId, "inProgress") });
      setImmediate(() => runTurn(turnId, params?.input));
      return;
    }
    case "turn/steer": {
      if (openTurn) openTurn.prompts.push(textOf(params?.input));
      respond(id, {});
      return;
    }
    case "turn/interrupt":
      respond(id, {});
      return;
    default:
      respond(id, {});
  }
});

process.stdin.on("close", () => process.exit(0));
