import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Stand-in `claude`, `codex` and `pi` binaries, so this suite spends nothing.
 *
 * This works because of a property of the daemon rather than a trick played on it: NOTHING
 * in `src/` talks to a model API directly. There is no `api.anthropic.com`, no
 * `ANTHROPIC_API_KEY`, and the only `BASE_URL` is the daemon's own loopback address. Every
 * model interaction is a spawned CLI subprocess whose path comes from ONE resolution chain,
 * `resolveBinSpec` in `src/server/harness/bin.ts`:
 *
 *     MISSION_<AGENT>_BIN ?? FLEET_<AGENT>_BIN ?? HARNESS_<AGENT>_BIN ?? <legacy> ?? "<agent>"
 *
 * The Agent SDK runtime goes through the same chain: `claude/sdk-deps.ts` deliberately pins
 * `pathToClaudeCodeExecutable` to the harness's own resolution rather than letting the
 * vendor package find its bundled CLI, precisely so an operator's `MISSION_CLAUDE_BIN`
 * wrapper is honoured. So there is no path - terminal or SDK - that reaches a real model
 * once these three are set.
 *
 * Each fake also RECORDS what it was handed, which turns the mock from a cost dam into an
 * assertion surface: a test can check the argv, the cwd, and the absence of inherited pane
 * env rather than only that the UI moved.
 */
export interface FakeAgents {
  /** Directory the fakes write their invocation records into. */
  recordDir: string;
  bins: { claude: string; codex: string; pi: string; cmux: string; keepAwake: string };
}

/**
 * A fake that only has to exist.
 *
 * `pi` is pointed at this so that nothing can silently fall through to a real binary on
 * PATH, but no spec drives it yet. It fails loudly rather than succeeding quietly: a test
 * that starts exercising it should see this message, not a mysteriously idle card.
 */
function unimplemented(agent: string): string {
  return `#!/bin/sh
echo "fake-${agent}: this agent has no e2e fake yet - see e2e/fixtures/fake-agents.ts" >&2
exit 1
`;
}

/**
 * The stand-in terminal backend, so a spec can watch what a click asks a terminal to run.
 *
 * cmux, not tmux, and the choice is structural. tmux availability is a question about a
 * PAIR - its sessions open detached, so `terminalTargetViews` reports it unavailable unless
 * an emulator exists to raise them, and CI has neither. cmux is the one backend whose
 * sessions need nobody's help to be seen (`attachArgv: null`), whose binary resolves
 * through an env override (`CMUX_BIN`), and whose launch is a single `new-workspace`
 * subprocess call - one fake, and the continue-in-terminal path is drivable end to end on
 * a machine with no terminal at all.
 *
 * The record it writes is the assertion surface: `--command` carries the exact shell
 * command the workspace would run, which is where a resumed conversation's argv - and the
 * permission mode it must carry - either shows up or provably does not.
 *
 * CommonJS `require`, deliberately: the file is extension-less, which Node treats as CJS,
 * and an `import` here would crash the fake at spawn time in a way that reads as a
 * launch failure rather than a broken fixture.
 */
const FAKE_CMUX = `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const dir = process.env.MC_E2E_RECORD_DIR;
if (dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, \`cmux-\${Date.now()}-\${process.pid}.json\`),
    JSON.stringify({ argv: process.argv.slice(2) }, null, 2),
  );
}
`;

/**
 * The stand-in `caffeinate`, so the keep-awake spec can drive the real manager, routes
 * and SSE path without ever touching host power settings - `MISSION_KEEP_AWAKE_BIN`
 * makes this the provider under test on any platform, which is how Linux CI runs it.
 *
 * It records its argv at start (the assertion surface: `-i -w <daemon PID>` either
 * shows up exactly or provably does not) and an exit record when it goes, then behaves
 * like the real thing: it stays alive until SIGTERM, and it honours `-w <pid>` by
 * exiting when the watched process disappears - which is what keeps a SIGKILLed test
 * daemon from leaking an immortal fake into the operator's process table.
 *
 * CommonJS `require` for the reason FAKE_CMUX gives: the file is extension-less, which
 * Node treats as CJS.
 */
const FAKE_KEEP_AWAKE = `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const dir = process.env.MC_E2E_RECORD_DIR;
const record = (kind, body) => {
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, \`keep-awake-\${process.pid}-\${kind}.json\`),
    JSON.stringify(body, null, 2),
  );
};
record("start", { argv: process.argv.slice(2), pid: process.pid });
const leave = (reason) => {
  record("exit", { reason });
  process.exit(0);
};
process.on("SIGTERM", () => leave("SIGTERM"));
const at = process.argv.indexOf("-w");
const watched = at >= 0 ? Number(process.argv[at + 1]) : null;
setInterval(() => {
  if (watched === null) return;
  try {
    process.kill(watched, 0);
  } catch {
    leave("watched-pid-gone");
  }
}, 250);
`;

/**
 * Write the three fakes into `home` and return their paths.
 *
 * The claude fake is COPIED to an extension-less path rather than symlinked or run in
 * place, because the vendored Agent SDK spawns `node <path>` for anything ending in
 * `.js`/`.mjs`/`.ts`/`.jsx`/`.tsx` and executes everything else directly. Extension-less
 * plus the file's own shebang is the combination that survives that branch.
 */
export function writeFakeAgents(home: string): FakeAgents {
  const binDir = join(home, "fake-bin");
  const recordDir = join(home, "agent-records");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(recordDir, { recursive: true });

  const claude = join(binDir, "fake-claude");
  copyFileSync(fileURLToPath(new URL("./fake-claude.mjs", import.meta.url)), claude);
  chmodSync(claude, 0o755);

  // Copied to an extension-less path for the same reason as its sibling above, though only
  // Claude's vendored SDK actually sniffs the extension: `spawnAppServer` execs the resolved
  // path directly, so the shebang is what picks the interpreter either way.
  const codex = join(binDir, "fake-codex");
  copyFileSync(fileURLToPath(new URL("./fake-codex.mjs", import.meta.url)), codex);
  chmodSync(codex, 0o755);

  const pi = join(binDir, "fake-pi");
  writeFileSync(pi, unimplemented("pi"));
  chmodSync(pi, 0o755);

  const cmux = join(binDir, "fake-cmux");
  writeFileSync(cmux, FAKE_CMUX);
  chmodSync(cmux, 0o755);

  const keepAwake = join(binDir, "fake-caffeinate");
  writeFileSync(keepAwake, FAKE_KEEP_AWAKE);
  chmodSync(keepAwake, 0o755);

  return { recordDir, bins: { claude, codex, pi, cmux, keepAwake } };
}
