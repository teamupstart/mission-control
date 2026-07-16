import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overlayKeyFromEnv } from "../src/server/registry.ts";

// A headless `claude -p` runs Claude Code for real, so it fires the SAME hooks a human's
// session does. `hooks/harness-hook.mjs` binds an event to a card with `captureTerminalEnv()`,
// which reads TMUX_PANE / WEZTERM_PANE from its own process - and the hook is a child of
// `claude`, which is a child of whatever spawned it. So if a headless run inherits the
// spawner's pane env, its hooks impersonate the card sitting in that pane.
//
// That is not hypothetical: it had already poisoned 3 of the 12 rows in this machine's live
// `session_agent_bindings` (two DIFFERENT real cards fused onto one headless uuid), because
// `applyHook` writes `agentSessionId: evt.sessionId ?? target.agentSessionId` - so the
// headless run's uuid becomes the card's, rotating `noteKeyFor` and orphaning the note and
// work queue it was keyed on.
//
// The fake bin reports the env it was handed, which is exactly what the hook would capture.
const dir = mkdtempSync(join(tmpdir(), "headless-env-"));
const fakeBin = join(dir, "fake-claude.sh");
writeFileSync(
  fakeBin,
  `#!/bin/sh
cat > /dev/null
printf '{"tmuxPane":"%s","weztermPane":"%s","marker":"%s"}' \\
  "$TMUX_PANE" "$WEZTERM_PANE" "$FLEET_HEADLESS"
`,
);
chmodSync(fakeBin, 0o755);
process.env.FLEET_CLAUDE_BIN = fakeBin;

const { runClaudeText } = await import("../src/server/claude-cli.ts");

/** Run the fake bin with a spawner env standing in for a pane-attached daemon/worker. */
async function envSeenByHook(): Promise<Record<string, string>> {
  const prev = { tmux: process.env.TMUX_PANE, wez: process.env.WEZTERM_PANE };
  process.env.TMUX_PANE = "%42";
  process.env.WEZTERM_PANE = "7";
  try {
    return JSON.parse(await runClaudeText("summarise this session", { timeoutMs: 5000 }));
  } finally {
    if (prev.tmux === undefined) delete process.env.TMUX_PANE;
    else process.env.TMUX_PANE = prev.tmux;
    if (prev.wez === undefined) delete process.env.WEZTERM_PANE;
    else process.env.WEZTERM_PANE = prev.wez;
  }
}

test("a headless run cannot be bound to the spawner's pane", async () => {
  const seen = await envSeenByHook();
  // Asserted through `overlayKeyFromEnv` rather than on the raw vars, because the key is what
  // actually decides impersonation: it is the first thing `findSessionByEnv` matches on, and a
  // null key is the whole defence.
  const key = overlayKeyFromEnv({
    tmuxPane: seen.tmuxPane || undefined,
    weztermPane: seen.weztermPane || undefined,
    termProgram: undefined,
  });
  assert.equal(key, null, `headless run inherited a pane key (${key}) and would impersonate that card`);
});

test("a headless run is marked so the hook can decline to report it", async () => {
  // Stripping the pane env stops the daemon binding the event; the marker stops the hook
  // POSTing at all. Independent layers on purpose - the hook script is installed globally
  // from a checkout that may lag this code, so neither can be assumed present.
  const seen = await envSeenByHook();
  assert.equal(seen.marker, "1", "headless run carries no FLEET_HEADLESS marker for the hook to see");
});
