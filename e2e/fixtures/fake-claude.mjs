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
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

function argvValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/**
 * Stable across a restart, distinct across the isolated worktrees concurrent sessions use.
 * A fixed id made unrelated cards share note, Goal and workflow ownership in multi-session
 * browser tests, which no real Claude conversations do. An explicit fixture id or the id on
 * a resume still wins.
 */
function sessionIdForCwd() {
  const hex = createHash("sha256").update(resolve(process.cwd())).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `8${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}
const SESSION_ID = process.env.MC_E2E_SESSION_ID ?? argvValue("--resume") ?? sessionIdForCwd();

// An explicit dispatch model is echoed by the real CLI's init frame. Keep the mock label
// for default launches, but preserve a pinned model so browser specs can exercise the
// production model-metadata resolver rather than a browser-side stub.
const MODEL = argvValue("--model") ?? "claude-e2e-mock";

/**
 * The reasoning effort this session is running at, written onto every assistant record the
 * way the real CLI writes it - a TOP-LEVEL `effort` field on the turn record.
 *
 * An embedded (Agent SDK) session never types `/effort`, so nothing ever echoes a level into
 * its transcript and this field is the only thing that ever says what it is running at. It
 * is seeded from `--effort` (the flag the Agent SDK renders for its `effort` option) and
 * moved by the `apply_flag_settings` control request the daemon sends when a person picks a
 * new level on the card. `medium` is the real CLI's own recorded default.
 */
let effort = argvValue("--effort") ?? "medium";
const HELD_TURN = "hold the current turn open";
const HELD_TURN_MS = 5_000;
// This review scenario has to submit two queued messages before the held turn drains. A
// separate longer window keeps that setup deterministic under the full gate's four workers
// without adding ten seconds to every spec that uses the ordinary held turn.
const REVIEW_HELD_TURN = "hold the current turn open for queued review setup";
const REVIEW_HELD_TURN_MS = 15_000;
/**
 * Keep turn one open for specs that inject a lifecycle event from INSIDE that turn.
 *
 * A real Claude permission prompt blocks the turn that raised it: the Notification hook
 * arrives while that turn is live, and its `result` cannot arrive until the prompt is
 * answered. The ordinary fake answers turn one immediately. Under full-suite contention
 * its result could be emitted before a spec posted the hook but consumed afterwards, which
 * manufactured an impossible `awaiting_input -> idle` transition. This opt-in preserves the
 * real ordering without slowing every dispatch in the suite.
 */
const HOLD_FIRST_TURN = process.env.MC_E2E_HOLD_FIRST_TURN === "1";
const SLOW_STOP = "E2E_SLOW_SESSION_STOP";
const SLOW_STOP_MS = 4_000;
const SLOW_WORKFLOW_CONTEXT = "E2E_SLOW_WORKFLOW_CONTEXT";
const SLOW_WORKFLOW_CONTEXT_MS = 5_000;
/**
 * A reviewer that takes its time before objecting, so a spec can watch one REPORT.
 *
 * Every other verdict here answers instantly, which makes the pending state unobservable from a
 * browser: by the time the run detail is open the reviewer has already spoken. This one holds
 * the fail long enough to select the row while it still reads "No verdict in this round yet"
 * and then watch the worklist carry that selection to the change it raises. Generous rather
 * than tight, because the window has to survive a loaded CI runner opening a page in it, and
 * the spec waits on the outcome rather than on the clock.
 */
const SLOW_FAIL_VERDICT = "E2E_SLOW_FAIL_VERDICT";
const SLOW_FAIL_VERDICT_MS = 15_000;
/**
 * An ensemble comparison that never answers, so a spec can kill the daemon while one is
 * genuinely in flight.
 *
 * The marker rides in the ensemble's INTENT, which the comparison packet quotes verbatim, so
 * it steers that one review and nothing else - the same channel the Persona verdicts below
 * use. The watchdog is what stops a SIGKILLed daemon from orphaning this child: the parent
 * dies without reaping it, and a held review must not outlive the run that asked for it.
 */
const HELD_REVIEW = "E2E_HOLD_ENSEMBLE_REVIEW";
const HELD_REVIEW_MS = 120_000;
/**
 * An ensemble comparison whose provider is DOWN: the child dies without answering.
 *
 * Distinct from a malformed reply on purpose, because the engine charges the two to different
 * budgets. Dying before a single frame is what a spawn failure, a crashed CLI or an unreachable
 * provider looks like from the daemon's side, and it is the only way a browser spec can reach
 * the parked-for-an-operator state without a real outage.
 */
const FAILED_REVIEW = "E2E_FAIL_ENSEMBLE_REVIEW";
/**
 * An ensemble comparison whose provider is down until the review has PARKED, and hangs after.
 *
 * The one shape that reaches "the operator pressed Retry stage and a restart interrupted what it
 * granted". Getting there needs both provider behaviours in one run: enough failures to spend the
 * infrastructure budget, and then a call that stays in flight long enough for a spec to kill the
 * daemon while it is running.
 *
 * Each review call is its own process, so the count cannot live in memory. It lives in a file
 * keyed by the nonce the spec puts in the marker, which is also what keeps parallel workers from
 * sharing a counter. Written under the fixture record directory, never under the agent's
 * disposable Mission Control state home, so separate review invocations share it.
 */
const FAIL_THEN_HOLD_REVIEW = "E2E_FAIL_THEN_HOLD_ENSEMBLE_REVIEW";

/**
 * The intent marker also reaches Goal refinement after an SDK member accepts its launch prompt.
 * Only the anonymous comparison packet is allowed to steer the review fixture; otherwise that
 * unrelated Goal call spends the counter before the first durable review attempt starts.
 */
function isEnsembleReviewPrompt(prompt) {
  return prompt.includes("Rank exactly these submissions, each once:");
}

/** How many calls the marker's nonce has already taken, incremented and returned. */
function failThenHoldCount(prompt) {
  const nonce = new RegExp(`${FAIL_THEN_HOLD_REVIEW}:([A-Za-z0-9-]+)`).exec(prompt)?.[1];
  if (!nonce) return null;
  const root = process.env.MC_E2E_RECORD_DIR ?? homedir();
  const file = join(root, `.e2e-fail-then-hold-${createHash("sha256").update(nonce).digest("hex").slice(0, 16)}`);
  let seen = 0;
  try {
    seen = Number.parseInt(readFileSync(file, "utf8"), 10) || 0;
  } catch {
    seen = 0;
  }
  const next = seen + 1;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, String(next));
  } catch {
    // A counter we cannot persist degrades to "always fail", which is the safe half: the spec
    // then times out waiting for a held call rather than passing on a state it never reached.
  }
  return next;
}
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
/**
 * The prompt that makes this CLI leave deterministic tool activity in its transcript:
 * one assistant turn carrying prose AND a tool call, then a tool-only turn, then the
 * ordinary echoed reply. That pair of shapes is the whole surface the Observed
 * activity browser specs assert against - the mixed turn is the one the main log's
 * tool-run folding does NOT fold, so a rail that derived from the folded rows instead
 * of the messages would silently miss it.
 */
const TOOL_TURN = "E2E_OBSERVED_TOOLS";
/**
 * The prompt that leaves a RUN of tool-only turns: three of them, back to back, with no
 * prose between.
 *
 * Distinct from `TOOL_TURN` because the two shapes prove different things. That one exists
 * so a projection that folded turns would miss a tool call riding prose; this one exists so
 * the terminal rendering has a genuine multi-turn run to fold into one disclosure record -
 * "claude executed 3 commands". A single tool-only turn folds into a record of one, which
 * is a fold that never had to decide anything.
 */
const TOOL_RUN_TURN = "E2E_TERMINAL_RUN";

const recordDir = process.env.MC_E2E_RECORD_DIR;
if (recordDir) {
  const resolvedMissionState =
    process.env.MISSION_HOME ?? process.env.FLEET_HOME ?? process.env.HARNESS_HOME ?? homedir();
  const stateProbe = join(resolvedMissionState, `.agent-state-resolution-${process.pid}.json`);
  mkdirSync(resolvedMissionState, { recursive: true });
  writeFileSync(stateProbe, JSON.stringify({ cwd: process.cwd() }));
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
        missionHome: process.env.MISSION_HOME ?? null,
        fleetHome: process.env.FLEET_HOME ?? null,
        harnessHome: process.env.HARNESS_HOME ?? null,
        resolvedMissionState,
        stateProbe,
        hasMissionApiToken: Boolean(process.env.MISSION_API_TOKEN),
        missionApiTokenFile: process.env.MISSION_API_TOKEN_FILE ?? null,
      },
      null,
      2,
    ),
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

/** Fail the provider boundary unless the native Claude image blocks carry the manifest bytes. */
function verifyClaudeWorkflowImages(prompt, blocks) {
  const manifest = workflowImageManifest(prompt);
  if (manifest.length === 0) return true;
  const images = blocks.filter((block) => block?.type === "image");
  const observed = images.map((block) => {
    const bytes = Buffer.from(block?.source?.data ?? "", "base64");
    return {
      mimeType: block?.source?.media_type ?? null,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });
  const valid = observed.length === manifest.length && observed.every((image, index) =>
    image.sha256 === manifest[index]?.sha256
    && image.bytes === manifest[index]?.bytes
    && image.mimeType === manifest[index]?.mimeType);
  if (recordDir) {
    writeFileSync(
      join(recordDir, "claude", `workflow-image-boundary-${Date.now()}-${process.pid}.json`),
      JSON.stringify({ valid, manifest, observed }, null, 2),
    );
  }
  if (!valid) process.stderr.write("fake-claude: workflow image pixels did not match the manifest\n");
  return valid;
}

// --- headless one-shot modes -----------------------------------------------------------

/**
 * The OTHER protocol this binary has to speak.
 *
 * App-owned work can arrive through either shipped transport. The print escape hatch runs
 * `claude -p --output-format json`: prompt on stdin, one JSON object on stdout, exit. The
 * default Agent SDK also uses a one-shot subprocess, but sends the prompt as a stream-json
 * user frame and expects a stream-json result frame back.
 *
 * Worth stating plainly because it is the more expensive half in practice: a dispatch fires
 * the titler before the session ever starts, so an e2e run that faked only the session would
 * still have spent real tokens on every dispatch. `--setting-sources=` is the deliberate
 * one-shot discriminator: app-owned SDK calls load no filesystem settings, while a live
 * session names the user, project, and local sources it inherits.
 */
if (process.argv.includes("--setting-sources=")) {
  runHeadlessSdk();
} else if (process.argv.includes("-p")) {
  const chunks = [];
  process.stdin.on("data", (c) => chunks.push(c));
  process.stdin.on("end", () => {
    const input = Buffer.concat(chunks).toString("utf8");
    let prompt = input;
    let blocks = [];
    try {
      const frame = JSON.parse(input);
      const content = frame?.message?.content;
      if (Array.isArray(content)) {
        blocks = content;
        prompt = content.filter((block) => block?.type === "text").map((block) => block.text).join("\n");
      }
    } catch {
      // Historical text-only print calls write the prompt directly.
    }
    if (!verifyClaudeWorkflowImages(prompt, blocks)) process.exit(1);
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
  // This marker proves a run-scoped directive reached the Persona prompt in the promised
  // position. The published Persona still carries E2E_FAIL_VERDICT, so only checking this
  // higher-priority prefix first can turn that same reviewer into a pass in a later round.
  if (
    prompt.startsWith("# EXTREMELY CRITICAL OPERATOR DIRECTIVE")
    && prompt.includes("E2E_DIRECTIVE_PASS_VERDICT")
  ) {
    return JSON.stringify({
      verdict: "pass",
      summary: "Deterministic e2e directive approval",
      approvalDetails: { reason: "The run-scoped operator directive was applied", evidence: [] },
      confidence: 0.95,
    });
  }
  /*
   * The same reviewer, still objecting, but in different words.
   *
   * A reviewer that rewords a title it keeps raising retires the old change key and opens a new
   * one, and the worklist has to say what is actually known about the retired half: its reviewer
   * looked again and did not pass, so nothing confirmed the fix. That state is unreachable from
   * a fixture whose fail verdict is a fixed string, which is what this second title is for.
   */
  if (
    prompt.startsWith("# EXTREMELY CRITICAL OPERATOR DIRECTIVE")
    && prompt.includes("E2E_DIRECTIVE_REWORD_VERDICT")
  ) {
    return JSON.stringify({
      verdict: "fail",
      summary: "Deterministic e2e objection, restated",
      requestedChanges: [
        {
          title: "E2E reworded change",
          rationale: "This reviewer is scripted to restate its objection",
          evidence: [{ kind: "goal", quote: "deterministic e2e evidence" }],
        },
      ],
      confidence: 0.9,
    });
  }
  /* The slow reviewer's answer, once its delay has elapsed. Its own title, so a spec can tell
     the change it raises from the instant reviewers' one. */
  if (prompt.includes(SLOW_FAIL_VERDICT)) {
    return JSON.stringify({
      verdict: "fail",
      summary: "Deterministic e2e objection, after a wait",
      requestedChanges: [
        {
          title: "E2E slow requested change",
          rationale: "This reviewer is scripted to object after a delay",
          evidence: [{ kind: "goal", quote: "deterministic e2e evidence" }],
        },
      ],
      confidence: 0.9,
    });
  }
  /*
   * The BUILT-IN Test Evidence Auditor, which cannot be steered the usual way.
   *
   * Every other reviewer in this suite is answered by a marker a spec planted in the Persona
   * it created. That is impossible for this one: it is the shipped built-in, `personas.update`
   * refuses a builtin, and its NAME is what makes the engine treat an attempt as an auditor
   * attempt and append the `test_evidence_audit` telemetry - so a spec measuring that telemetry
   * has to run this exact Persona and no copy of it. It is recognised by a distinctive line of
   * its own published guidance instead, and answered with a fixed, schema-valid refusal that
   * asks for the missing artifact the scout report found most often: rendered pixels.
   */
  if (prompt.includes("Asks whether the submitted work has been shown to do what was asked")) {
    return JSON.stringify({
      verdict: "fail",
      summary: "Deterministic e2e evidence objection",
      requestedChanges: [
        {
          title: "Attach a screenshot of the rendered result",
          rationale: "Nothing in this submission shows the rendered pixels a person would see.",
          evidence: [{ kind: "goal", quote: "deterministic e2e evidence" }],
        },
      ],
      confidence: 0.9,
    });
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

/** Speak the Agent SDK's one-shot stream protocol without becoming a live session. */
function runHeadlessSdk() {
  const schema = argvValue("--json-schema");
  const rl = createInterface({ input: process.stdin });
  let answered = false;

  const emit = (frame) => {
    process.stdout.write(`${JSON.stringify(frame)}\n`);
  };

  const finish = (prompt, blocks) => {
    if (answered) return;
    answered = true;
    if (!verifyClaudeWorkflowImages(prompt, blocks)) process.exit(1);
    const ensembleReview = isEnsembleReviewPrompt(prompt);
    if (ensembleReview && prompt.includes(HELD_REVIEW)) {
      setTimeout(() => process.exit(1), HELD_REVIEW_MS);
      return;
    }
    if (ensembleReview && prompt.includes(FAILED_REVIEW)) process.exit(1);
    if (ensembleReview && prompt.includes(FAIL_THEN_HOLD_REVIEW)) {
      // Down for the whole infrastructure budget, then in flight and staying there.
      if ((failThenHoldCount(prompt) ?? 1) <= 3) process.exit(1);
      setTimeout(() => process.exit(1), HELD_REVIEW_MS);
      return;
    }
    const answer = headlessAnswer(prompt);
    let structuredOutput;
    if (schema !== undefined) {
      try {
        structuredOutput = JSON.parse(answer);
      } catch {
        // Preserve the old fake's invalid-answer behavior for tests that deliberately make
        // an unmarked structured call. The production schema parser must reject this string.
        structuredOutput = answer;
      }
    }
    emit({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: SESSION_ID,
      result: answer,
      ...(schema === undefined ? {} : { structured_output: structuredOutput }),
    });
    process.exit(0);
  };

  rl.on("line", (line) => {
    if (!line.trim()) return;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }

    if (frame.type === "control_request") {
      emit({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: frame.request_id,
          response: frame.request?.subtype === "get_usage"
            ? { rate_limits_available: false }
            : {},
        },
      });
      return;
    }
    if (frame.type !== "user") return;

    const raw = frame.message?.content;
    const prompt =
      typeof raw === "string"
        ? raw
        : Array.isArray(raw)
          ? raw.filter((block) => block?.type === "text").map((block) => block.text).join("\n")
          : "";
    if (
      prompt.includes(SLOW_WORKFLOW_CONTEXT)
      && prompt.includes("Compact workflow intent without rewriting it.")
    ) {
      setTimeout(() => finish(prompt, Array.isArray(raw) ? raw : []), SLOW_WORKFLOW_CONTEXT_MS);
    } else if (prompt.includes(SLOW_FAIL_VERDICT)) {
      setTimeout(() => finish(prompt, Array.isArray(raw) ? raw : []), SLOW_FAIL_VERDICT_MS);
    } else {
      finish(prompt, Array.isArray(raw) ? raw : []);
    }
  });
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
      // Top level, beside the record's own type - not inside `message`, where the model and
      // usage live. That is where the real CLI puts it, and where the daemon reads it.
      ...(role === "assistant" ? { effort } : {}),
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

// ---------------------------------------------------------------------------
// The scout scenario
// ---------------------------------------------------------------------------

/**
 * What a scout does when the daemon tells it to, with no model call anywhere.
 *
 * This fake is a COST DAM everywhere else; here it is also the only way to prove the scout
 * contract end to end. The daemon appends a report requirement to every scout intent and
 * then refuses to complete the task until a verified archive exists, and both halves of that
 * are invisible unless something actually reads the prompt and calls the real MCP route. So
 * this reacts to the marker the daemon composes, writes a static page into its own checkout,
 * and posts to `/mcp/scouts/submit` over loopback with the harness token and the daemon-issued
 * checkout credential - the same request the bundled MCP server makes, without the MCP server.
 *
 * Everything it needs is inherited env: `MISSION_HOME` (the token file) and `MISSION_PORT`
 * (the daemon this dispatch came from). Nothing here reaches a model API, and nothing is
 * scripted by the spec beyond the words in the task's own intent.
 */
const SCOUT_MARKER = "--- Mission Control scout ---";
/**
 * The slug the fake writes under.
 *
 * A plain const, deliberately not exported: `writeFakeAgents` copies this file to an
 * extension-less path and the shebang runs it as a program, and a top-level `export` in that
 * position is a syntax error that shows up as a session which binds and immediately exits.
 * A spec that needs the path spells it out.
 */
const SCOUT_SLUG = "e2e-scout";
/** A phrase that exists ONLY in the report's visible text, so a search for it proves capture. */
const SCOUT_FINDING = "the resume path never replayed the repository grant";
/** An intent word that tells the fake to write a report it knows the daemon will refuse. */
const SCOUT_INVALID = "E2E_SCOUT_INVALID_REPORT";
/** An intent word that tells the fake to write the page but never submit it. */
const SCOUT_NO_SUBMIT = "E2E_SCOUT_NO_SUBMIT";
/** A natural-language intent that stages the report so a spec can deliver later context. */
const SCOUT_DEFER_SUBMISSION = "wait for follow-up context before submitting the report";
/** An attributed fixture turn that tells the staged scout to publish through its real route. */
const SCOUT_SUBMIT_STAGED = "E2E_SCOUT_SUBMIT_STAGED_REPORT";

function scoutReportHtml(valid) {
  const body = valid
    ? `<p>${SCOUT_FINDING}.</p><p><code>src/server/reset.ts:118</code></p>`
    : `<p>built at runtime</p><script>document.write("nope")</script>`;
  return [
    "<!doctype html>",
    '<html lang="en">',
    '<head><meta charset="utf-8"><title>Resume permission loss</title>',
    "<style>body { background: #0a0c0f; color: #e7ebf1; }</style></head>",
    "<body><h1>Resume permission loss</h1>",
    body,
    "</body></html>",
  ].join("\n");
}

function daemonToken() {
  const direct = process.env.MISSION_API_TOKEN;
  if (direct) return direct;
  const suppliedFile = process.env.MISSION_API_TOKEN_FILE;
  if (suppliedFile) {
    try {
      return readFileSync(suppliedFile, "utf8").trim();
    } catch {
      return "";
    }
  }
  const home = process.env.MISSION_HOME ?? process.env.HARNESS_HOME;
  try {
    return readFileSync(join(home, "token"), "utf8").trim();
  } catch {
    return "";
  }
}

/** The opaque credential the daemon provisioned for this exact scout checkout. */
function scoutCredential() {
  const direct = process.env.MISSION_SCOUT_SUBMISSION_CREDENTIAL;
  if (direct) return direct;
  const isolatedFile = process.env.MISSION_SCOUT_SUBMISSION_CREDENTIAL_FILE;
  if (isolatedFile) {
    try {
      return readFileSync(isolatedFile, "utf8").trim();
    } catch {
      return "";
    }
  }
  const home = process.env.MISSION_HOME ?? process.env.HARNESS_HOME;
  try {
    const checkout = resolve(process.cwd());
    const key = createHash("sha256").update(checkout).digest("hex");
    return readFileSync(join(home, "scout-submission-credentials", key), "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * Write the page, then hand it over the way a real scout would.
 *
 * Returns the sentence the turn answers with, so a spec can read the outcome in the
 * conversation as well as in the archive - including the daemon's refusal, which is what an
 * agent correcting an invalid report actually sees.
 */
async function runScout(prompt) {
  const valid = !prompt.includes(SCOUT_INVALID);
  const relative = `docs/reports/${SCOUT_SLUG}/report.html`;
  const target = join(process.cwd(), relative);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, scoutReportHtml(valid));
  // A companion beside the page, captured with the report directory rather than named.
  writeFileSync(join(dirname(target), "evidence.csv"), "when,what\n1,grant missing\n");

  if (prompt.includes(SCOUT_NO_SUBMIT)) {
    return `Report written to ${relative} but deliberately not submitted.`;
  }
  if (prompt.toLowerCase().includes(SCOUT_DEFER_SUBMISSION)) {
    return `Report staged at ${relative}; waiting for follow-up context before submission.`;
  }
  const port = process.env.MISSION_PORT ?? "7317";
  try {
    const res = await fetch(`http://127.0.0.1:${port}/mcp/scouts/submit`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-harness-token": daemonToken(),
        "x-mission-scout-credential": scoutCredential(),
      },
      body: JSON.stringify({
        reportPath: relative,
        summary: "Resume rebuilt the session without replaying the repository grant.",
        tags: ["resume", "permissions"],
        supporting: [],
      }),
    });
    if (!res.ok) {
      return `Mission Control refused the scout submission (${res.status}): ${await res.text()}`;
    }
    return `Submitted the scout report. Report: ${relative}`;
  } catch (error) {
    return `Could not reach Mission Control: ${String(error)}`;
  }
}

/** The turn the CLI is running right now, and every prompt it has absorbed. */
let openTurn = null;
/** The scout turn in flight, if any. Awaited on stdin close so its answer is never lost. */
let scoutTurn = null;
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

/** How many `result` frames this fake has emitted, for UUIDs and cumulative query totals. */
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
 * Costs are round and small so a spec can assert exact rendered strings: $2.50 a turn. The
 * values returned here grow with every result because the real streaming SDK reports totals
 * for the whole `query()` call, not a standalone delta for the turn that just ended.
 */
function turnUsage() {
  results += 1;
  return {
    uuid: `${SESSION_ID}-result-${results}`,
    total_cost_usd: 2.5 * results,
    num_turns: results,
    modelUsage: {
      [MODEL]: {
        inputTokens: 1_000 * results,
        outputTokens: 500 * results,
        cacheReadInputTokens: 20_000 * results,
        cacheCreationInputTokens: 3_000 * results,
        costUSD: 2.5 * results,
      },
    },
    usage: {
      input_tokens: 1_000 * results,
      output_tokens: 500 * results,
      cache_read_input_tokens: 20_000 * results,
      cache_creation_input_tokens: 3_000 * results,
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

/** Run the fake scout's file write and real submission while its SDK turn stays open. */
function beginScoutTurn(prompt) {
  const held = { prompts: [] };
  openTurn = held;
  // Tracked so a stdin close cannot exit the process out from under a submission that is
  // already in flight - the answer would never be written and the card would go from
  // working straight to exited, which reads as a crash rather than as a race.
  scoutTurn = runScout(prompt).then((text) => {
    openTurn = null;
    appendTurn("assistant", [{ type: "text", text }]);
    emit({
      type: "assistant",
      session_id: SESSION_ID,
      message: { role: "assistant", content: [{ type: "text", text }] },
    });
    for (const queued of held.prompts) appendTurn("user", queued);
    emit({ type: "result", subtype: "success", session_id: SESSION_ID, ...turnUsage() });
  });
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
    // `interrupt` is answered by ABORTING, not merely acknowledged. The real CLI stops the
    // running turn and then emits that turn's `result` - which is the frame the driver turns
    // into `turn_done`, and therefore the only thing that takes a card out of "working".
    //
    // Answering it with a bare success (which every other subtype gets, below) would leave
    // the held turn's timer running and the card would return to idle five seconds later on
    // the fake's own schedule. A spec asserting that the interrupt worked would then be
    // green on a build where the request never reached the driver at all - the exact
    // false pass this fake exists to make impossible.
    if (frame.request?.subtype === "interrupt") {
      const running = openTurn;
      ok(frame.request_id, { still_queued: [] });
      if (running) {
        clearTimeout(running.timer);
        openTurn = null;
        // No assistant text: the turn was cut off, so there is nothing it finished saying.
        emit({ type: "result", subtype: "success", session_id: SESSION_ID, ...turnUsage() });
      }
      return;
    }
    // A live effort change. Acknowledging it without MOVING anything would let a spec pass
    // on a build where the level never reached the process: the proof is that the NEXT turn
    // this fake writes records the new level, which is the same evidence the daemon reads
    // off a real transcript.
    if (frame.request?.subtype === "apply_flag_settings") {
      const level = frame.request?.settings?.effortLevel;
      if (typeof level === "string") effort = level;
      ok(frame.request_id, {});
      return;
    }
    // Every other subtype gets a success. `get_usage` arrives repeatedly (once per init and
    // per result) and the driver .catch()es a missing answer, but answering keeps the log
    // clean.
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

    // A fixture-owned permission wait: keep the SAME first turn alive until teardown, so a
    // hook a spec posts for it cannot be followed by a stale result from before the hook.
    // No timer on purpose. A real permission prompt also has no time-based completion; only
    // an answer ends it, and this fixture's test is about the still-unanswered state.
    if (HOLD_FIRST_TURN && results === 0) {
      openTurn = { prompts: [prompt] };
      return;
    }

    // Blocks the turn on a human, which is the whole point: no `result` is emitted until the
    // answer comes back down, so the card stays "waiting on you" for the spec to act on.
    if (prompt === ASK_TURN) {
      ask(prompt);
      return;
    }

    // A scout, recognised by the contract the DAEMON appended rather than by anything the
    // spec wrote - which is what makes the requirement's delivery the thing under test. The
    // turn is held open across the write and the submission because both are real I/O; the
    // card stays "working" until the archive exists, exactly as a real one would.
    if (prompt.includes(SCOUT_MARKER) || prompt === SCOUT_SUBMIT_STAGED) {
      beginScoutTurn(prompt);
      return;
    }

    // Deterministic transcript tool activity, in the two shapes the real CLI writes:
    // a `tool_use` beside prose, and a `tool_use` alone. `answer` then closes the turn
    // with the echoed reply, which is the anchor a spec waits on before asserting.
    if (prompt === TOOL_TURN) {
      appendTurn("assistant", [
        { type: "text", text: "Mock reply with observed tools" },
        { type: "tool_use", id: `obs-${turn}-read`, name: "Read", input: { file_path: "src/web/styles.css" } },
      ]);
      appendTurn("assistant", [
        { type: "tool_use", id: `obs-${turn}-bash`, name: "Bash", input: { command: "ls -la e2e" } },
      ]);
      answer([prompt]);
      return;
    }

    // A run of tool-only turns with prose on either side, which is the shape the terminal
    // rendering folds into one record. The commands are distinguishable on purpose: the
    // record lists the literal input, so a spec can tell the folded list apart from the
    // chip summary the chat log draws.
    if (prompt === TOOL_RUN_TURN) {
      appendTurn("assistant", [{ type: "text", text: "Mock reply before the run" }]);
      appendTurn("assistant", [
        { type: "tool_use", id: `run-${turn}-a`, name: "Bash", input: { command: "rg PersonaDirective src test" } },
      ]);
      appendTurn("assistant", [
        { type: "tool_use", id: `run-${turn}-b`, name: "Bash", input: { command: "git status --short" } },
      ]);
      appendTurn("assistant", [
        { type: "tool_use", id: `run-${turn}-c`, name: "Read", input: { file_path: "src/server/registry.ts" } },
      ]);
      answer([prompt]);
      return;
    }

    // One deterministic busy window for the queued-turn browser specs. Ordinary prompts
    // still answer synchronously, so existing conversation specs keep their fast path. The
    // delay is inside the fake agent, not the dashboard or daemon, and therefore exercises
    // the real SDK busy state and pending-turn route without spending model tokens.
    const heldTurnMs = prompt === HELD_TURN
      ? HELD_TURN_MS
      : prompt === REVIEW_HELD_TURN
      ? REVIEW_HELD_TURN_MS
      : null;
    if (heldTurnMs !== null) {
      const turnState = { prompts: [prompt] };
      turnState.timer = setTimeout(() => {
        openTurn = null;
        answer(turnState.prompts);
      }, heldTurnMs);
      openTurn = turnState;
      return;
    }
    answer([prompt]);
  }
});

// Exiting early is what makes a card die: the driver turns any nonzero exit OR an early
// close into `{kind:"exited"}` and evicts the session. Stay alive until the SDK closes
// stdin, then leave cleanly.
rl.on("close", () => {
  const leave = () => {
    if (slowStop) setTimeout(() => process.exit(0), SLOW_STOP_MS);
    else process.exit(0);
  };
  // A scout's turn is real I/O - a file write and an HTTP submission - so exiting the moment
  // stdin closes would cut it off mid-flight and lose the answer frame the spec reads.
  if (scoutTurn) void scoutTurn.finally(leave);
  else leave();
});

}
