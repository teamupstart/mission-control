import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What is at stake here is the CONTRACT, not the call shape. `LlmRunner` exists so the
// app's offline work - Foreman's verdicts, the goal refiner, the titler, the digest, the
// Inspector - can run on a provider other than `claude -p` without any of those callers
// learning about it. Three properties have to survive that indirection, and each one is
// silent when it breaks:
//
//   1. Every run starts from an empty context. The Foreman reviews MANY sessions, so a
//      runner that carried context would grow it across every session it ever looked at
//      and let session A's transcript decide the verdict on session B. Nothing throws; the
//      verdicts just quietly start being about the wrong thing.
//   2. Tools are off unless a caller argued for them, and a grant it cannot fully honour
//      is REFUSED rather than partly applied. Every prompt here embeds untrusted
//      transcript or repo text.
//   3. A run cannot be mistaken for a human's session. A headless run of the agent CLI is
//      that CLI, so it fires the same hooks; inheriting the spawner's pane env once fused
//      two different real cards onto one headless run's uuid.
//
// The fake bin records the argv, the cwd and the env it was handed - which is exactly what
// a provider, and a hook underneath it, would see.
const home = mkdtempSync(join(tmpdir(), "llm-runner-"));
process.env.HARNESS_HOME = join(home, "state");

const RUN_ARGS = join(home, "args");
const RUN_CWD = join(home, "cwd");
const RUN_ENV = join(home, "env");
process.env.RUN_ARGS = RUN_ARGS;
process.env.RUN_CWD = RUN_CWD;
process.env.RUN_ENV = RUN_ENV;

const fakeBin = join(home, "fake-claude.sh");
writeFileSync(
  fakeBin,
  `#!/bin/sh
cat > /dev/null
: > "$RUN_ARGS"
for a in "$@"; do printf '%s\\n' "$a" >> "$RUN_ARGS"; done
pwd > "$RUN_CWD"
printf '%s\\n%s\\n%s\\n' "$TMUX_PANE" "$WEZTERM_PANE" "$MISSION_HEADLESS" > "$RUN_ENV"
printf '{"result":"the model text"}'
`,
);
chmodSync(fakeBin, 0o755);
// Before the import: `claude-cli.ts` resolves the binary at module load.
process.env.MISSION_CLAUDE_BIN = fakeBin;

const { LLM_RUNNERS, DEFAULT_LLM_RUNNER_ID, allLlmRunners, llmRunner } = await import(
  "../src/server/llm/index.ts"
);
const { CLAUDE_GRANTABLE_TOOLS, claudeGrantSettings, claudeRunner } = await import(
  "../src/server/llm/claude.ts"
);
const { HEADLESS_CWD } = await import("../src/server/claude-cli.ts");
const { LLM_RUNNER_IDS, grantRefusal } = await import("../src/shared/llm.ts");
// The one caller that holds tools, and therefore the one that decides whether the grant
// shape fits. Imported for its real constants: an equality asserted against a copy of them
// would prove only that the copy matches itself.
const { DENY_PATHS, DENY_SETTINGS, REVIEW_TOOLS } = await import("../src/server/inspector/worker.ts");

/** Lines a `printf '%s\n'`-per-item file holds, without the trailing empty element. */
function lines(path: string): string[] {
  return readFileSync(path, "utf8").split("\n").slice(0, -1);
}

function argv(): string[] {
  return lines(RUN_ARGS);
}

/** The value `flag` was given, or null when the flag is absent. */
function flag(name: string): string | null {
  const args = argv();
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? null) : null;
}

function clearRecording(): void {
  for (const f of [RUN_ARGS, RUN_CWD, RUN_ENV]) rmSync(f, { force: true });
}

test("the registry answers for every declared runner", () => {
  // The whole enforcement mechanism: a new id that is not implemented must not compile,
  // and this catches the other half - an entry filed under the wrong key, which typecheck
  // cannot see because both sides are the same union.
  assert.deepEqual(Object.keys(LLM_RUNNERS).sort(), [...LLM_RUNNER_IDS].sort());
  for (const id of LLM_RUNNER_IDS) {
    assert.equal(LLM_RUNNERS[id].id, id, `${id} is filed under someone else's key`);
    assert.ok(LLM_RUNNERS[id].label.trim().length > 0, `${id} has no label to display`);
  }
  assert.equal(allLlmRunners().length, LLM_RUNNER_IDS.length);
  assert.equal(llmRunner().id, DEFAULT_LLM_RUNNER_ID, "the no-argument runner is the default");
});

test("a run carries no way to see a previous one", async () => {
  await claudeRunner.run("summarise this session", { model: "claude-haiku-4-5", timeoutMs: 5000 });
  const args = argv();
  // Absence is the guarantee, so absence is what is asserted. Without one of these three
  // flags every `claude -p` mints a new session with an empty context; WITH one, Foreman's
  // context would grow across every session it ever reviewed and one session's transcript
  // could decide another's verdict. A "hold the process open to skip the spawn"
  // optimisation reintroduces exactly this, and is worth ~2s of a 4-6s call.
  for (const forbidden of ["--resume", "--continue", "--session-id"]) {
    assert.equal(args.includes(forbidden), false, `a run passed ${forbidden}: context is no longer fresh`);
  }
  assert.ok(args.includes("-p"), "not a one-shot run");
  assert.equal(flag("--model"), "claude-haiku-4-5", "the caller's model did not reach the provider");
});

test("a run without a grant has every tool disabled, in a directory of no consequence", async () => {
  await claudeRunner.run("summarise this session", { timeoutMs: 5000 });
  assert.equal(flag("--tools"), "", "tools were not disabled for an ungranted run");
  assert.equal(flag("--settings"), null, "an ungranted run should carry no permission payload");
  // Not the daemon's cwd and not a repo: with no tools a working directory is meaningless
  // to the run, and a real one only risks it noticing a checkout it has no business in.
  assert.equal(lines(RUN_CWD)[0], realpathSync(HEADLESS_CWD));
});

test("the provider's envelope never reaches the caller", async () => {
  // `--output-format json` is this runner's own flag, so unwrapping `{ result: "…" }` is
  // its own job. A caller that did it would be undoing its runner's choice, and would
  // break outright against a provider whose envelope looks different.
  const text = await claudeRunner.run("summarise this session", { timeoutMs: 5000 });
  assert.equal(text, "the model text");
});

test("a run cannot be attributed to the card the daemon was launched from", async () => {
  const prev = { tmux: process.env.TMUX_PANE, wez: process.env.WEZTERM_PANE };
  process.env.TMUX_PANE = "%42";
  process.env.WEZTERM_PANE = "7";
  try {
    await claudeRunner.run("summarise this session", { timeoutMs: 5000 });
  } finally {
    if (prev.tmux === undefined) delete process.env.TMUX_PANE;
    else process.env.TMUX_PANE = prev.tmux;
    if (prev.wez === undefined) delete process.env.WEZTERM_PANE;
    else process.env.WEZTERM_PANE = prev.wez;
  }
  const [tmuxPane, weztermPane, marker] = lines(RUN_ENV);
  // The pane ids are what `overlayKeyFromEnv` binds a hook event on; the marker is the
  // independent second layer, letting a hook decline to report the run at all. Both,
  // because the hook script is installed globally from a checkout that may lag this code.
  assert.equal(tmuxPane, "", "the run inherited a tmux pane and would impersonate that card");
  assert.equal(weztermPane, "", "the run inherited a wezterm pane and would impersonate that card");
  assert.equal(marker, "1", "the run is not marked headless for the hook to see");
});

test("a tool grant renders exactly the deny rules the Inspector ships today", () => {
  const rendered = claudeGrantSettings({
    tools: REVIEW_TOOLS.split(","),
    cwd: "/tmp/checkout",
    denyPaths: DENY_PATHS,
  });
  // Byte-for-byte, against the Inspector's own constant. This is what makes migrating that
  // call site onto the runner a provable no-op: the reviewer keeps the identical sandbox,
  // not a similar one. If this ever has to change, the deny list on a live PR review is
  // what changed with it.
  assert.equal(rendered, DENY_SETTINGS);
  // The generalisation that produces it: every path denied for every tool held, because
  // `Grep` on an absolute path prints the lines a `Read(...)`-only rule pretended to
  // protect, and `Glob` confirms the file is there.
  assert.equal(
    claudeGrantSettings({ tools: ["Read", "Grep"], cwd: "/tmp/checkout", denyPaths: ["**/.env"] }),
    JSON.stringify({ permissions: { deny: ["Read(**/.env)", "Grep(**/.env)"] } }),
  );
});

test("a granted run is scoped to the grant's directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "llm-grant-"));
  await claudeRunner.run("review this diff", {
    timeoutMs: 5000,
    grant: { tools: [...CLAUDE_GRANTABLE_TOOLS], cwd: dir, denyPaths: DENY_PATHS },
  });
  assert.equal(flag("--tools"), "Read,Grep,Glob");
  assert.equal(flag("--settings"), DENY_SETTINGS);
  // The cwd is not a convenience here: under a one-shot run there is nobody to approve a
  // read outside it, so the directory IS the read scope that pays for the tools.
  assert.equal(lines(RUN_CWD)[0], realpathSync(dir));
});

test("a grant this runner cannot honour is refused before anything is spawned", async () => {
  const cases: Array<[string, { tools: string[]; cwd: string; denyPaths: string[] }]> = [
    ["a tool outside the read-only set", { tools: ["Read", "Bash"], cwd: "/tmp", denyPaths: [] }],
    ["a relative cwd", { tools: ["Read"], cwd: "checkout", denyPaths: [] }],
    ["no tools at all", { tools: [], cwd: "/tmp", denyPaths: [] }],
  ];
  for (const [what, grant] of cases) {
    clearRecording();
    await assert.rejects(
      claudeRunner.run("review this diff", { timeoutMs: 5000, grant }),
      /refused the tool grant/,
      `${what} was accepted`,
    );
    // Refused, not partly applied: a caller that asked for a deny list and silently did not
    // get one cannot tell until something it named turns up in a prompt.
    assert.equal(existsSync(RUN_ARGS), false, `${what} still spawned a run`);
  }
});

test("a runner with no sandbox refuses every grant", () => {
  // `null` is a real answer rather than a stub - a provider with no way to bound a tool
  // grant must decline one. Asserted on the shared predicate because that is what a future
  // runner inherits; nothing about this is Claude-specific.
  assert.match(
    grantRefusal(null, { tools: ["Read"], cwd: "/tmp", denyPaths: [] }) ?? "",
    /cannot sandbox/,
  );
  assert.equal(grantRefusal(claudeRunner.sandbox, { tools: ["Read"], cwd: "/tmp", denyPaths: [] }), null);
});

test("the runner declares the litter its runs leave behind", () => {
  // Every run writes a real transcript that nothing reads and nothing used to delete - 153
  // of 250 transcripts sampled on one machine were this app's. A provider that litters has
  // to say where, or the sweeper learns about it when someone's disk fills.
  assert.ok(claudeRunner.litter, "the claude runner leaves transcripts and must declare them");
  assert.equal(claudeRunner.litter.ext, ".jsonl");
  assert.ok(claudeRunner.litter.dir().startsWith("/"), "the litter directory must be absolute");
  assert.equal(typeof claudeRunner.killLiveRuns, "function");
  // Null rather than a throwing stub, so a caller can branch on the absence. If it is ever
  // implemented the key must be one supervised session, never a shared thread.
  assert.equal(claudeRunner.runInThread, null);
});
