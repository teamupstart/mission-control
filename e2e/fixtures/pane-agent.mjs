/**
 * A stand-in agent that lives in a REAL tmux pane and behaves enough like a Claude TUI for
 * a handover to complete against it.
 *
 * Why this exists at all: `runtime: "terminal"` is stamped in exactly one place
 * (`registry.ts:mergeDiscovered`), so passive discovery is the only door to a terminal-runtime
 * session - and a terminal-runtime session is the only kind `TaskManager.assign` can ever
 * accept, because `controlFor` gives an Agent SDK session `stream-json` control and
 * `paneAcceptsPrompt` admits `keystroke` only. A dispatched SDK agent therefore cannot be
 * handed a task by this gesture no matter how the fixture is arranged.
 *
 * What the assign path actually requires of the far side is three things, and this file is
 * exactly those three and nothing more:
 *
 *   1. A COMPOSER THAT ECHOES. `awaitClearProcessed` waits for the screen to CHANGE and for
 *      the clear command to leave the composer. A pane that renders nothing satisfies the
 *      first half by accident and the second half never, so every reset reported
 *      `cleared: false` and the task was correctly never typed.
 *   2. A HISTORY LINE THAT IS NOT THE COMMAND. `hasPendingCommand` scans the trailing lines
 *      for one ENDING with the command, so echoing `ran /clear` into the transcript would
 *      read as a `/clear` still sitting in the composer, forever. The transcript records a
 *      length, never the text.
 *   3. THE REBIND HOOK. A `/clear` mints a new agent session, and `resetSession` will not
 *      report `workIdentityReady` until it sees one announced (`waitForWorkEpisodeReady`,
 *      5s). Real Claude announces it through the hook bridge; so does this, with a new uuid
 *      and a new transcript path, which is the same evidence `resolvePendingWorkEpisode`
 *      weighs. Without it the handover stops one step short with the checkout already reset.
 *
 * It spends NO model tokens: it is `node` under a symlink named `claude`, which is not a
 * trick played on the detector but the shape `harnessOf` is built to recognise - it matches
 * argv0's basename against each harness's declared `detect.commands`.
 *
 * Raw mode, because the claim being tested is about the exact bytes that arrive: a cooked
 * pty's line discipline would eat or transform them before this saw them.
 *
 * `PANE_AGENT_TURNS=<file>` opts into whole turns, for a spec that reads what the agent was
 * sent rather than how long it was. A newline inside a bracketed paste then stays in the
 * composer, as a real composer keeps it, and only the Enter after the paste submits. Each
 * submission's full text is appended to `<file>` as one JSON line, never drawn on the screen,
 * so (2) above still holds. And each submission other than the clear is reported through the
 * hook bridge as Claude reports a turn: `UserPromptSubmit` when it is taken, then `Stop`, which
 * is the evidence the outbox waits for before it counts a delivery and goes on to the next row.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";

const [baseURL, token, paneId, cwd, transcriptDir] = process.argv.slice(2);
const TURNS = process.env.PANE_AGENT_TURNS || null;

/** Claude's own clear command, as `harness/claude` declares it. */
const CLEAR = "/clear";
/**
 * The bracketed-paste framing `PaneWrite.paste` wraps a body in, spelled the way
 * `terminal/cmux.ts` spells it. Built from a char code rather than written into a regex so
 * this strips them by split/join: a control character inside a pattern is a lint warning
 * everywhere else in this repo, and there is nothing here a regex does better.
 */
const ESC = String.fromCharCode(27);
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;
/** How many transcript lines the screen keeps. Enough to read, small enough to stay one screen. */
const SCROLLBACK = 20;

let composer = "";
/** A trailing marker prefix held until the next stdin chunk (at most five characters). */
let pendingMarker = "";
const history = [];
/** Inside a bracketed paste, which only whole-turn mode distinguishes. */
let pasting = false;
/** The agent session the last clear announced, which the turn hooks name. */
let agentSession = null;
let agentTranscript = null;

/** Redraw the whole screen: the transcript, then the composer, exactly like a TUI. */
function draw() {
  process.stdout.write(`${ESC}[2J${ESC}[H`);
  for (const line of history.slice(-SCROLLBACK)) process.stdout.write(`${line}\r\n`);
  process.stdout.write(`\r\n> ${composer}`);
}

/** Report to the daemon the way the installed Claude hook bridge does. */
async function hook(event, extra) {
  await fetch(`${baseURL}/hooks/${event}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-harness-token": token },
    body: JSON.stringify({ agent: "claude", cwd, env: { tmuxPane: paneId }, ...extra }),
  }).catch(() => {});
}

/**
 * Take one submission.
 *
 * The transcript records a LENGTH rather than the text - see (2) in the header. The
 * `/clear` branch is the rebind announcement, and it is sent AFTER the redraw so the
 * screen the daemon reads has already lost the command.
 */
async function submit(text) {
  const body = text.trim();
  history.push(`[took ${body.length} chars]`);
  composer = "";
  draw();
  if (TURNS) appendFileSync(TURNS, `${JSON.stringify({ text: body })}\n`);
  if (body !== CLEAR) {
    if (!TURNS) return;
    await hook("UserPromptSubmit", { sessionId: agentSession, transcriptPath: agentTranscript, prompt: body });
    await new Promise((done) => setTimeout(done, 300));
    await hook("Stop", { sessionId: agentSession, transcriptPath: agentTranscript });
    return;
  }
  const id = randomUUID();
  agentSession = id;
  agentTranscript = `${transcriptDir}/${id}.jsonl`;
  await hook("SessionStart", {
    sessionId: id,
    transcriptPath: agentTranscript,
    source: "clear",
  });
}

process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  chunk = pendingMarker + chunk;
  pendingMarker = "";
  // A read can end anywhere inside either marker. Keep the longest possible prefix out
  // of the composer until the next read completes it or proves it is ordinary input.
  for (let length = Math.min(chunk.length, PASTE_START.length - 1); length > 0; length--) {
    const suffix = chunk.slice(-length);
    if (PASTE_START.startsWith(suffix) || PASTE_END.startsWith(suffix)) {
      pendingMarker = suffix;
      chunk = chunk.slice(0, -length);
      break;
    }
  }
  // Bracketed-paste markers are stripped rather than rendered: `PaneWrite.paste` wraps the
  // body in them, and a real composer treats them as framing, not as content.
  if (TURNS) {
    // Whole turns: the paste's own newlines are content, and the Enter after it submits.
    // Both markers are six characters long.
    let rest = chunk;
    while (rest.length > 0) {
      const marks = [rest.indexOf(PASTE_START), rest.indexOf(PASTE_END)].filter((at) => at >= 0);
      const next = marks.length > 0 ? Math.min(...marks) : -1;
      for (const ch of next === -1 ? rest : rest.slice(0, next)) {
        if ((ch === "\r" || ch === "\n") && pasting) composer += "\n";
        else if (ch === "\r" || ch === "\n") void submit(composer);
        else if (ch === "\x7f") composer = composer.slice(0, -1);
        else if (ch >= " " || ch === "\t") composer += ch;
      }
      if (next === -1) break;
      pasting = rest.startsWith(PASTE_START, next);
      rest = rest.slice(next + PASTE_START.length);
    }
    draw();
    return;
  }
  const body = chunk.split(PASTE_START).join("").split(PASTE_END).join("");
  for (const ch of body) {
    if (ch === "\r" || ch === "\n") void submit(composer);
    else if (ch === "\x7f") composer = composer.slice(0, -1);
    else if (ch >= " ") composer += ch;
  }
  draw();
});

// Whole turns need the paste framed, and tmux frames a paste only for an application that asked
// for bracketed paste, as a real composer does.
if (TURNS) process.stdout.write(`${ESC}[?2004h`);
draw();
// Announce idleness at once, so the card is instrumented without waiting for a sweep to
// infer it. `instrumented` is a fresh hook overlay and nothing else - `assignReserved`
// refuses a session without one, in those words.
void hook("Stop", {});
setInterval(() => {}, 1 << 30);
