import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What is at stake: an agent that has been gagged and given nothing to say instead.
//
// Taking Claude's built-in `AskUserQuestion` away is only safe because the same spawn hands
// the agent `request_input` and tells it to use that. Measured on a live session, the flag
// ALONE does not redirect anything - the agent asked its question in prose and ended its
// turn, into a terminal nobody is watching. That is strictly worse than the menu it
// replaced, which at least sits on screen where pane-dialog reads it and Foreman can answer.
//
// So the property under test is not "the flags are right", it is that the DANGEROUS flag
// cannot ship without the three that make it survivable. Every way this can go wrong - no
// bundle, a CLI without the redirect flag, an unwritable state dir - must collapse to an
// EMPTY argv (keep the built-in, status quo), never to a partial one and never to a throw
// that takes an otherwise-fine dispatch down with it.

const home = mkdtempSync(join(tmpdir(), "mission-ask-channel-"));
// Set before importing anything that resolves the state dir.
process.env.HARNESS_HOME = join(home, "state");

// A stand-in for the built bundle: `askChannelArgs` only checks that the path EXISTS, and
// pointing at a real file keeps the test off `npm run build`.
const fakeBundle = join(home, "server.mjs");
writeFileSync(fakeBundle, "// not executed by this test\n");
process.env.HARNESS_MCP_SERVER = fakeBundle;

/**
 * A fake `claude` whose `--help` either lists the redirect flag or does not.
 *
 * The probe shells out to the real binary, so the only honest way to test both sides is to
 * hand it a binary that answers each way. Distinct paths per stub because the probe result is
 * cached per binary for the daemon's lifetime.
 */
function stubClaude(name: string, listsFlag: boolean): string {
  const path = join(home, name);
  writeFileSync(
    path,
    `#!/bin/sh\necho "  --append-system-prompt <prompt>  Append a system prompt"\n` +
      (listsFlag ? `echo "  --append-system-prompt-file <path>  Append from a file"\n` : ""),
  );
  chmodSync(path, 0o755);
  return path;
}

const CLAUDE = stubClaude("claude-ok", true);

const { askChannelArgs, askChannelPaths, ASK_TOOL, DISALLOWED_TOOL } = await import(
  "../src/server/ask-channel.ts"
);

after(() => rmSync(home, { recursive: true, force: true }));

/** The value passed to a flag, so assertions read as pairs rather than by index. */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

test("the disallow never ships without the replacement, the pre-approval and the redirect", async () => {
  const args = await askChannelArgs("claude", CLAUDE);

  assert.equal(flag(args, "--disallowed-tools"), DISALLOWED_TOOL);
  // Each of the other three answers a way the disallow alone fails.
  assert.equal(flag(args, "--mcp-config"), askChannelPaths.mcpConfig, "supplies request_input");
  assert.equal(flag(args, "--allowed-tools"), ASK_TOOL, "so calling it is not itself a menu");
  assert.equal(
    flag(args, "--append-system-prompt-file"),
    askChannelPaths.redirect,
    "tells the agent where to go instead",
  );
});

test("a missing MCP bundle disarms the whole channel, not half of it", async () => {
  const prior = process.env.HARNESS_MCP_SERVER;
  process.env.HARNESS_MCP_SERVER = join(home, "does-not-exist.mjs");
  try {
    const args = await askChannelArgs("claude", CLAUDE);
    // The direction matters: keeping the built-in is the status quo, whereas removing it
    // with nothing behind it is the failure this whole module exists to prevent.
    assert.ok(!args.includes("--disallowed-tools"), "must not gag an agent it cannot equip");
    assert.deepEqual(args, [], "no bundle means no ask channel, never a partial one");
  } finally {
    process.env.HARNESS_MCP_SERVER = prior;
  }
});

test("a claude without --append-system-prompt-file keeps its built-in menu", async () => {
  // The flag is undocumented in `claude --help`, and Claude Code hard-errors on an unknown
  // option: passing it to a CLI that lacks it kills the child at spawn, and the dispatch
  // fails READY_TIMEOUT_MS later as "agent session never appeared" - on EVERY dispatch, with
  // nothing pointing at the real cause. Without the redirect there is no ask channel at all.
  const args = await askChannelArgs("claude", stubClaude("claude-old", false));
  assert.deepEqual(args, []);
});

test("an unprobeable claude counts as unsupported, not as supported", async () => {
  // A binary that does not exist, hangs, or crashes is not evidence the flag is there, and
  // the safe direction is unambiguous - keep the menu.
  const args = await askChannelArgs("claude", join(home, "no-such-binary"));
  assert.deepEqual(args, []);
});

test("a filesystem failure skips the channel instead of failing the dispatch", async () => {
  // `askChannelArgs` is called inside `Dispatcher.dispatch`'s try block, so a throw here
  // would not merely skip the ask channel - it would mark a task `failed` that had nothing
  // else wrong with it, and a session that would have launched fine never launches.
  await askChannelArgs("claude", CLAUDE); // create the dir and its files
  // Make the next call actually WANT to write: `writeIfChanged` is a no-op on equal content,
  // so an unwritable directory alone would prove nothing.
  writeFileSync(askChannelPaths.redirect, "stale, forces a rewrite");
  chmodSync(askChannelPaths.dir, 0o500); // readable, not writable: the temp file cannot be made
  try {
    const args = await askChannelArgs("claude", CLAUDE);
    assert.deepEqual(args, [], "degrade to no channel rather than throwing into dispatch");
  } finally {
    chmodSync(askChannelPaths.dir, 0o700);
  }
});

test("codex is left alone - these are Claude's flags", async () => {
  assert.deepEqual(await askChannelArgs("codex", CLAUDE), []);
});

test("the mcp config names our server and points at the bundle with an absolute runtime", async () => {
  await askChannelArgs("claude", CLAUDE);
  const cfg = JSON.parse(readFileSync(askChannelPaths.mcpConfig, "utf8")) as {
    mcpServers: Record<string, { command: string; args: string[] }>;
  };
  const server = cfg.mcpServers["mission-control"];
  assert.ok(server, "the server name is what namespaces the tool the redirect prompt names");
  assert.equal(server.args[0], fakeBundle);
  // Claude Code launches this as an external process, so a bare `node` off the spawned
  // shell's PATH is not good enough.
  assert.ok(server.command.startsWith("/"), `runtime should be absolute, got ${server.command}`);
  // The tool name in the argv has to match what this server registration produces, or the
  // pre-approval silently covers nothing and the agent stops on a permission prompt.
  assert.equal(ASK_TOOL, "mcp__mission-control__request_input");
});

test("the redirect prompt closes the escape hatch the agent actually took", async () => {
  await askChannelArgs("claude", CLAUDE);
  const text = readFileSync(askChannelPaths.redirect, "utf8");
  assert.match(text, /request_input/, "names the replacement");
  assert.match(text, /options/, "asks for structured choices, not prose alternatives");
  // The measured failure was prose-and-stop, not silence. A prompt that merely names the
  // replacement is arm C; this sentence is the one that made the difference.
  assert.match(text, /NEVER ask a question as ordinary prose and end your turn/);
});

test("the files are rewritten when stale and left alone when current", async () => {
  await askChannelArgs("claude", CLAUDE);
  writeFileSync(askChannelPaths.redirect, "clobbered by an older build");
  await askChannelArgs("claude", CLAUDE);
  assert.match(
    readFileSync(askChannelPaths.redirect, "utf8"),
    /request_input/,
    "a stale file must self-heal - the argv points at it on every dispatch",
  );
  assert.ok(existsSync(askChannelPaths.dir));
});

test("no temp file is left beside the channel files", async () => {
  // The writes are atomic (temp + rename) so a concurrently-starting claude can never read a
  // truncated mcp.json - which would mean no request_input while --disallowed-tools still
  // applies, the exact state this module exists to prevent. The rename must consume the temp.
  await askChannelArgs("claude", CLAUDE);
  const { readdirSync } = await import("node:fs");
  const strays = readdirSync(askChannelPaths.dir).filter((f) => f.endsWith(".tmp"));
  assert.deepEqual(strays, []);
});
