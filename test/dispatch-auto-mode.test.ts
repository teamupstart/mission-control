import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { Session } from "@shared/types.ts";
import type { TerminalHandle } from "@shared/terminal.ts";
import { mkMuxHandle } from "./helpers/session-fixture.ts";

// The dispatcher's `applyAutoMode` decision - the heart of the "auto mode on dispatch"
// harness setting. It is exercised against the REAL harnesses config (a round-trip
// through the app_config KV) and the REAL `setPermissionMode`, so what is tested is the
// exact wiring a dispatch runs, not a mock of it.
//
// The contract under test, spelled out in the intent:
//   - it drives a session to `auto` ONLY when the setting is on AND the agent is claude;
//   - codex has no permission mode, so it is skipped entirely;
//   - it is best-effort - a session it can't drive logs a warning and is left alone,
//     never throwing and sinking the dispatch.
//
// `applyAutoMode` is private; it is called directly (rather than through the full
// `dispatch()`, which needs a worktree + a real agent spawn) because the decision is the
// only new behavior here and this is the smallest faithful way to observe it.

const home = mkdtempSync(join(tmpdir(), "mission-dispatch-auto-"));
// Set before importing anything that resolves the state dir / opens the db.
process.env.HARNESS_HOME = join(home, "state");

const { Dispatcher } = await import("../src/server/dispatcher.ts");
const { setHarnessesConfig } = await import("../src/server/harnesses.ts");
const { openDb } = await import("../src/server/db.ts");

after(() => rmSync(home, { recursive: true, force: true }));

beforeEach(() => {
  openDb().exec("DELETE FROM app_config");
});

// `applyAutoMode` never touches the registry, so a bare Dispatcher is enough.
const dispatcher = new Dispatcher({} as never);
const applyAutoMode = (session: Session, agent: Session["agent"]): Promise<void> =>
  (dispatcher as unknown as { applyAutoMode(s: Session, a: Session["agent"]): Promise<void> })
    .applyAutoMode(session, agent);

/** A session with no pane handle - the cleanest way to make `setPermissionMode` fail fast. */
function noHandleSession(agent: Session["agent"]): Session {
  return { id: `s-${agent}`, agent, terminals: [] as TerminalHandle[] } as Session;
}

/** Run `fn`, returning every `console.warn` message it emitted. */
async function warningsFrom(fn: () => Promise<void>): Promise<string[]> {
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.warn = orig;
  }
  return warnings;
}

test("setting ON + claude: it drives the dispatched session toward auto (best-effort, no throw)", async () => {
  setHarnessesConfig({ autoModeOnDispatch: true });
  // A no-handle session can't be driven, so the real `setPermissionMode` fails - which is
  // exactly how we know it was CALLED. The dispatcher must swallow that into a warning,
  // not an exception: a dispatch that otherwise launched cleanly is not sunk by this step.
  const warnings = await warningsFrom(() => applyAutoMode(noHandleSession("claude"), "claude"));
  assert.equal(warnings.length, 1, "the one un-drivable session should have warned exactly once");
  assert.match(warnings[0] ?? "", /auto mode/i);
  assert.match(warnings[0] ?? "", /s-claude/, "the warning should name the session it couldn't drive");
});

test("setting ON + codex: skipped entirely - codex has no permission mode", async () => {
  setHarnessesConfig({ autoModeOnDispatch: true });
  // A no-handle CLAUDE warns (previous test), so the ABSENCE of a warning here proves
  // codex never reached `setPermissionMode` at all - it wasn't driven-and-failed, it was
  // skipped by the `agent !== "claude"` guard before any pane work.
  const warnings = await warningsFrom(() => applyAutoMode(noHandleSession("codex"), "codex"));
  assert.deepEqual(warnings, [], "codex must not be driven, so it must not warn");
});

test("setting OFF: claude is left in its default mode, untouched", async () => {
  setHarnessesConfig({ autoModeOnDispatch: false });
  // Ships off. With the setting off, even a claude dispatch must not reach
  // `setPermissionMode` - so, again, no warning from an un-drivable session.
  const warnings = await warningsFrom(() => applyAutoMode(noHandleSession("claude"), "claude"));
  assert.deepEqual(warnings, [], "with the setting off, nothing should be driven");
});

test("default config (nothing stored): claude is untouched - the setting is off until opted in", async () => {
  // No setHarnessesConfig call: the KV is empty, so the schema default (off) governs.
  const warnings = await warningsFrom(() => applyAutoMode(noHandleSession("claude"), "claude"));
  assert.deepEqual(warnings, [], "an un-configured harness must behave as off");
});

// ---- the happy path, against a real pane ----

function tmuxAvailable(): boolean {
  try {
    execFileSync("tmux", ["-V"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("setting ON + claude, real pane already in auto: the session ends in auto, no warning", { skip: tmuxAvailable() ? false : "tmux not available" }, async () => {
  setHarnessesConfig({ autoModeOnDispatch: true });

  // A real detached tmux pane made to render exactly the footer line Claude prints when it
  // is already in auto mode. `setPermissionMode` reads that off the live pane, sees it is
  // already the target, and reports success - so a claude dispatch confirms auto and the
  // dispatcher stays quiet. This exercises the true capture-pane path end to end.
  const sessName = `mc-auto-${process.pid}`;
  const tmux = (paneId: string) => mkMuxHandle({ session: sessName, windowName: "0", paneId });
  try {
    execFileSync("tmux", ["new-session", "-d", "-s", sessName, "-x", "200", "-y", "50"]);
    // clear wipes the command echo; the printed glyph+wording is then the only footer line;
    // `read` holds the shell open so the line stays put for the capture.
    execFileSync("tmux", ["send-keys", "-t", sessName, "-l", 'clear; printf "\\n\\342\\217\\265\\342\\217\\265 auto mode on\\n"; read x']);
    execFileSync("tmux", ["send-keys", "-t", sessName, "Enter"]);

    const paneId = execFileSync("tmux", ["list-panes", "-t", sessName, "-F", "#{pane_id}"]).toString().trim();

    // Wait for the pane to actually RENDER the footer before driving it. Match the real
    // glyph (⏵⏵), which only the printf output carries - the shell's echo of the command
    // shows the literal `\342\217\265` octal, not the glyph - so we don't mistake the
    // command echo (still on screen before `clear` runs) for the rendered mode line.
    let painted = false;
    for (let i = 0; i < 40 && !painted; i++) {
      const text = execFileSync("tmux", ["capture-pane", "-p", "-t", paneId]).toString();
      painted = /⏵⏵ auto mode on/.test(text);
      if (!painted) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(painted, "the fake pane should render the auto-mode footer before we drive it");

    const session = { id: "s-real", agent: "claude", terminals: [tmux(paneId)] } as Session;
    const warnings = await warningsFrom(() => applyAutoMode(session, "claude"));
    assert.deepEqual(warnings, [], "a session already in auto should be confirmed silently, not warned about");
  } finally {
    try {
      execFileSync("tmux", ["kill-session", "-t", sessName], { stdio: "ignore" });
    } catch {
      /* session may already be gone */
    }
  }
});
