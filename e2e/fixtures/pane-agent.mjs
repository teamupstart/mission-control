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
 */
import { randomUUID } from "node:crypto";

const [baseURL, token, paneId, cwd, transcriptDir] = process.argv.slice(2);

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
const history = [];

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
  if (body !== CLEAR) return;
  const id = randomUUID();
  await hook("SessionStart", {
    sessionId: id,
    transcriptPath: `${transcriptDir}/${id}.jsonl`,
    source: "clear",
  });
}

process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  // Bracketed-paste markers are stripped rather than rendered: `PaneWrite.paste` wraps the
  // body in them, and a real composer treats them as framing, not as content.
  const body = chunk.split(PASTE_START).join("").split(PASTE_END).join("");
  for (const ch of body) {
    if (ch === "\r" || ch === "\n") void submit(composer);
    else if (ch === "\x7f") composer = composer.slice(0, -1);
    else if (ch >= " ") composer += ch;
  }
  draw();
});

draw();
// Announce idleness at once, so the card is instrumented without waiting for a sweep to
// infer it. `instrumented` is a fresh hook overlay and nothing else - `assignReserved`
// refuses a session without one, in those words.
void hook("Stop", {});
setInterval(() => {}, 1 << 30);
