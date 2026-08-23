import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
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
// bundle, an unwritable state dir - must collapse to an EMPTY argv (keep the built-in,
// status quo), never to a partial one and never to a throw that takes an otherwise-fine
// dispatch down with it.

const home = mkdtempSync(join(tmpdir(), "mission-ask-channel-"));
// Set before importing anything that resolves the state dir.
process.env.HARNESS_HOME = join(home, "state");

// A stand-in for the built bundle: `askChannelArgs` only checks that the path EXISTS, and
// pointing at a real file keeps the test off `npm run build`.
const fakeBundle = join(home, "server.mjs");
writeFileSync(fakeBundle, "// not executed by this test\n");
process.env.HARNESS_MCP_SERVER = fakeBundle;

const {
  askChannelArgs,
  askChannelContribution,
  systemPromptAppendArgs,
  askChannelPaths,
  askChannelPrompt,
  ASK_TOOL,
  DISALLOWED_TOOL,
} = await import("../src/server/ask-channel.ts");

after(() => rmSync(home, { recursive: true, force: true }));

/** The value passed to a flag, so assertions read as pairs rather than by index. */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

test("the disallow never ships without the replacement, the pre-approval and the redirect", async () => {
  const args = await askChannelArgs("claude");

  assert.equal(flag(args, "--disallowed-tools"), DISALLOWED_TOOL);
  // Each of the other three answers a way the disallow alone fails.
  assert.equal(flag(args, "--mcp-config"), askChannelPaths.mcpConfig, "supplies request_input");
  assert.equal(flag(args, "--allowed-tools"), ASK_TOOL, "so calling it is not itself a menu");
  // The redirect travels INLINE, as the flag's own value. This asserts the TEXT and not just
  // the flag on purpose: the predecessor of this line checked that a path had been built and
  // passed while the CLI was rejecting the flag that path was attached to, so the feature was
  // inert and the suite was green. A flag is only evidence of intent; the value is the world.
  const redirect = flag(args, "--append-system-prompt");
  assert.equal(redirect, askChannelPrompt, "tells the agent where to go instead");
  assert.doesNotMatch(String(redirect), /^\S*\/\S*$/, "the prompt itself, never a path to it");
  assert.match(String(redirect), /NEVER ask a question as ordinary prose and end your turn/);
  assert.match(String(redirect), new RegExp(ASK_TOOL), "and names the tool it is redirecting to");
});

test("a missing MCP bundle disarms the whole channel, not half of it", async () => {
  const prior = process.env.HARNESS_MCP_SERVER;
  process.env.HARNESS_MCP_SERVER = join(home, "does-not-exist.mjs");
  try {
    const args = await askChannelArgs("claude");
    // The direction matters: keeping the built-in is the status quo, whereas removing it
    // with nothing behind it is the failure this whole module exists to prevent.
    assert.ok(!args.includes("--disallowed-tools"), "must not gag an agent it cannot equip");
    assert.deepEqual(args, [], "no bundle means no ask channel, never a partial one");
  } finally {
    process.env.HARNESS_MCP_SERVER = prior;
  }
});

test("a filesystem failure skips the channel instead of failing the dispatch", async () => {
  // `askChannelArgs` is called inside `Dispatcher.dispatch`'s try block, so a throw here
  // would not merely skip the ask channel - it would mark a task `failed` that had nothing
  // else wrong with it, and a session that would have launched fine never launches.
  await askChannelArgs("claude"); // create the dir and its file
  // Make the next call actually WANT to write: `writeIfChanged` is a no-op on equal content,
  // so an unwritable directory alone would prove nothing.
  writeFileSync(askChannelPaths.mcpConfig, "stale, forces a rewrite");
  chmodSync(askChannelPaths.dir, 0o500); // readable, not writable: the temp file cannot be made
  try {
    const args = await askChannelArgs("claude");
    assert.deepEqual(args, [], "degrade to no channel rather than throwing into dispatch");
  } finally {
    chmodSync(askChannelPaths.dir, 0o700);
  }
});

test("exactly ONE --append-system-prompt is ever emitted, carrying every contributor", async () => {
  // Finding 1, and it fails silently in the worst available way. `--append-system-prompt` is
  // declared single-value by the CLI (contrast `--betas <betas...>` two lines below it in the
  // same help output), and the binary carries a guard for the `--append-system-prompt-file`
  // conflict but NONE against the flag repeated against itself - so a second flag is
  // last-wins and the first value is dropped without a word. On Claude the appended text
  // never appears in the transcript either, so a dropped standing instruction is
  // indistinguishable from one that was never set.
  const contribution = await askChannelContribution("claude");
  const args = [
    ...contribution.args,
    ...systemPromptAppendArgs([contribution.redirect, "Never run E2E locally."]),
  ];
  assert.equal(
    args.filter((a) => a === "--append-system-prompt").length,
    1,
    "a second flag would silently discard the first",
  );
  const value = flag(args, "--append-system-prompt");
  assert.match(String(value), new RegExp(ASK_TOOL), "the ask redirect survived");
  assert.match(String(value), /Never run E2E locally\./, "and so did the operator's own words");

  // No contributors renders no flag at all, which is what keeps a launch with neither an ask
  // channel nor a standing instruction byte-identical to what it always was.
  assert.deepEqual(systemPromptAppendArgs([null, null]), []);
  assert.deepEqual(systemPromptAppendArgs([]), []);
});

test("the standing instruction still ships when the ask channel bails entirely", async () => {
  // Finding 2. `askChannelContribution` is all-or-nothing on ANY failure, and that contract
  // is correct for what it guards - an agent with `AskUserQuestion` removed and no
  // replacement is worse than one with the built-in intact. But a standing instruction has
  // nothing to do with the MCP bundle, and folding it inside that function would mean an
  // unbuilt `dist` silently dropped the operator's own words too.
  const prior = process.env.HARNESS_MCP_SERVER;
  process.env.HARNESS_MCP_SERVER = join(home, "does-not-exist.mjs");
  try {
    const contribution = await askChannelContribution("claude");
    assert.deepEqual(contribution, { args: [], redirect: null }, "the channel is fully off");
    assert.deepEqual(
      [...contribution.args, ...systemPromptAppendArgs([contribution.redirect, "Never force-push."])],
      ["--append-system-prompt", "Never force-push."],
      "and the operator's own words ship anyway",
    );
  } finally {
    process.env.HARNESS_MCP_SERVER = prior;
  }
});

test("askChannelArgs is the composition, so the two spellings cannot drift", async () => {
  const contribution = await askChannelContribution("claude");
  assert.deepEqual(await askChannelArgs("claude"), [
    ...contribution.args,
    ...systemPromptAppendArgs([contribution.redirect]),
  ]);
});

test("codex is left alone - these are Claude's flags", async () => {
  assert.deepEqual(await askChannelArgs("codex"), []);
});

test("the mcp config names our server and points at the bundle with an absolute runtime", async () => {
  await askChannelArgs("claude");
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
  const args = await askChannelArgs("claude");
  const text = flag(args, "--append-system-prompt") ?? "";
  assert.match(text, /request_input/, "names the replacement");
  assert.match(text, /options/, "asks for structured choices, not prose alternatives");
  // The measured failure was prose-and-stop, not silence. A prompt that merely names the
  // replacement is arm C; this sentence is the one that made the difference.
  assert.match(text, /NEVER ask a question as ordinary prose and end your turn/);
});

test("the mcp config is rewritten when stale and left alone when current", async () => {
  await askChannelArgs("claude");
  writeFileSync(askChannelPaths.mcpConfig, "clobbered by an older build");
  await askChannelArgs("claude");
  assert.match(
    readFileSync(askChannelPaths.mcpConfig, "utf8"),
    /mcpServers/,
    "a stale file must self-heal - the argv points at it on every dispatch",
  );
  assert.ok(existsSync(askChannelPaths.dir));
});

test("no temp file is left beside the channel file", async () => {
  // The writes are atomic (temp + rename) so a concurrently-starting claude can never read a
  // truncated mcp.json - which would mean no request_input while --disallowed-tools still
  // applies, the exact state this module exists to prevent. The rename must consume the temp.
  await askChannelArgs("claude");
  const { readdirSync } = await import("node:fs");
  const strays = readdirSync(askChannelPaths.dir).filter((f) => f.endsWith(".tmp"));
  assert.deepEqual(strays, []);
});
