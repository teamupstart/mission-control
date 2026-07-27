import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_WORKFLOW_CONFIG,
  WORKFLOW_CHECK_SLOTS,
  WORKFLOW_EXECUTION_LIMITS,
  WORKFLOW_LIMITS,
  checkBlockedReason,
  checkCommandFor,
  formatCheckCommand,
  parseCheckCommand,
  type WorkflowCheckSlot,
  type WorkflowConfig,
} from "../src/shared/workflow.ts";
import {
  CHECK_RUNTIME_UNAVAILABLE_NOTE,
  DEFAULT_CHECK_CONCURRENCY,
  createCheckScheduler,
  runCheck,
  tailBounded,
  type CheckExecutionRequest,
  type CheckExecutionResult,
} from "../src/server/workflows/checks.ts";
import { WorkflowCheckOutcomeSchema, WorkflowConfigSchema } from "../src/shared/protocol.ts";

// What is at stake: three of a check's four outcomes PASS, and the ones that pass are the
// ones nobody will look at until a shipped workflow carrying check gates lands on a machine
// that configured none of them. If "no command here" ever became a fail, that workflow would
// be broken by default on every repository but the one it was written in - and if a timeout
// ever became a fail, an OOM-killed test suite would be reported to an agent as a defect in
// its change. Both of those are silent: the run looks like it worked, and it says the wrong
// thing about somebody's code.
//
// The other half is the argv. There is no shell anywhere in this path, so the split from a
// typed line to an argv is ours, and an operator can only trust it if the panel shows it
// back. These pin the exact rules that panel is promising.

const REPO = "/repos/thing";
const configWith = (over: Partial<WorkflowConfig> = {}): WorkflowConfig => ({
  ...DEFAULT_WORKFLOW_CONFIG,
  ...over,
});

/** Consent granted and one `test` command configured - the setup most cases start from. */
const READY = configWith({
  checksEnabled: true,
  repoAllowlist: [REPO],
  checkCommands: [{ repoRoot: REPO, slot: "test", command: ["npm", "test"] }],
});

function executorReturning(
  result: CheckExecutionResult,
  seen: CheckExecutionRequest[] = [],
): { execute: (request: CheckExecutionRequest) => Promise<CheckExecutionResult>; seen: CheckExecutionRequest[] } {
  return {
    execute: async (request) => {
      seen.push(request);
      return result;
    },
    seen,
  };
}

const at = (config: WorkflowConfig, slot: WorkflowCheckSlot = "test") => ({
  slot,
  config,
  cwd: `${REPO}-worktree`,
  repoRoot: REPO,
  headSha: "a".repeat(40),
});

test("an unconfigured slot is skipped and PASSES - the contract a shipped workflow rests on", async () => {
  const result = await runCheck(at(configWith({ checksEnabled: true, repoAllowlist: [REPO] })));
  assert.equal(result.kind, "outcome");
  assert.equal(result.kind === "outcome" && result.outcome.status, "skipped");
  assert.equal(result.kind === "outcome" && result.outcome.command, null);
  assert.equal(result.kind === "outcome" && result.outcome.exitCode, null);
  // The note has to say WHICH slot and that nothing ran, or "skipped" reads as a bug.
  assert.match(
    result.kind === "outcome" ? result.outcome.note : "",
    /No test command is configured for this repository/,
  );
});

test("an unconfigured slot never reaches the executor at all", async () => {
  const stub = executorReturning({ kind: "exited", exitCode: 1, output: "boom", truncatedBytes: 0 });
  const result = await runCheck(at(READY, "lint"), { execute: stub.execute });
  assert.deepEqual(stub.seen, [], "nothing may be spawned for a slot nobody configured");
  assert.equal(result.kind === "outcome" && result.outcome.status, "skipped");
});

test("consent absent is unavailable, passes, and says which of the two gates refused", async () => {
  // Switch off, repository allowed: the operator has to go and flip a switch.
  const offSwitch = await runCheck(at(configWith({
    repoAllowlist: [REPO],
    checkCommands: READY.checkCommands,
  })));
  assert.equal(offSwitch.kind === "outcome" && offSwitch.outcome.status, "unavailable");
  assert.match(
    offSwitch.kind === "outcome" ? offSwitch.outcome.note : "",
    /switched off/,
  );

  // Switch on, repository NOT allowed: the operator has to add a repository. A boolean here
  // would send them to whichever of the two they guessed.
  const offAllowlist = await runCheck(at(configWith({
    checksEnabled: true,
    checkCommands: READY.checkCommands,
  })));
  assert.equal(offAllowlist.kind === "outcome" && offAllowlist.outcome.status, "unavailable");
  assert.match(
    offAllowlist.kind === "outcome" ? offAllowlist.outcome.note : "",
    /not on the workflow allowlist/,
  );
});

test("consent absent never reaches the executor", async () => {
  const stub = executorReturning({ kind: "exited", exitCode: 0, output: "", truncatedBytes: 0 });
  await runCheck(at(configWith({ repoAllowlist: [REPO], checkCommands: READY.checkCommands })), {
    execute: stub.execute,
  });
  assert.deepEqual(stub.seen, [], "an unauthorized gate must not spawn anything");
});

test("a build with no execution runtime is unavailable and passes, rather than failing", async () => {
  const result = await runCheck(at(READY));
  assert.equal(result.kind === "outcome" && result.outcome.status, "unavailable");
  assert.equal(result.kind === "outcome" && result.outcome.note, CHECK_RUNTIME_UNAVAILABLE_NOTE);
  // The resolved command is still reported: an operator has to be able to see that their
  // configuration WAS found, so "not run" reads as a missing runtime and not a typo.
  assert.deepEqual(result.kind === "outcome" ? result.outcome.command : null, ["npm", "test"]);
});

test("exit 0 passes and exit non-zero fails, with the command and code recorded", async () => {
  const passed = await runCheck(at(READY), {
    execute: executorReturning({ kind: "exited", exitCode: 0, output: "ok\n", truncatedBytes: 0 }).execute,
  });
  assert.equal(passed.kind === "outcome" && passed.outcome.status, "passed");
  assert.equal(passed.kind === "outcome" && passed.outcome.exitCode, 0);
  assert.match(passed.kind === "outcome" ? passed.outcome.note : "", /`npm test` passed\./);

  const failed = await runCheck(at(READY), {
    execute: executorReturning({
      kind: "exited",
      exitCode: 2,
      output: "TS2345: nope\n",
      truncatedBytes: 0,
    }).execute,
  });
  assert.equal(failed.kind === "outcome" && failed.outcome.status, "failed");
  assert.equal(failed.kind === "outcome" && failed.outcome.exitCode, 2);
  assert.equal(failed.kind === "outcome" && failed.outcome.output, "TS2345: nope\n");
  assert.match(failed.kind === "outcome" ? failed.outcome.note : "", /exited 2/);
});

test("the executor receives the argv, the repository and the captured commit", async () => {
  const stub = executorReturning({ kind: "exited", exitCode: 0, output: "", truncatedBytes: 0 });
  await runCheck(at(READY), { execute: stub.execute });
  assert.equal(stub.seen.length, 1);
  assert.deepEqual(stub.seen[0]!.command, ["npm", "test"]);
  assert.equal(stub.seen[0]!.slot, "test");
  assert.equal(stub.seen[0]!.repoRoot, REPO);
  // The CAPTURED commit, not a live HEAD: a gate has to judge the tree the submission
  // recorded, or a push landing mid-review changes what was gated.
  assert.equal(stub.seen[0]!.headSha, "a".repeat(40));
});

test("a command with nowhere to run it is unavailable rather than guessed at", async () => {
  // A session that reported no repository. Falling back to the daemon's own cwd here would
  // run the gate against an unrelated checkout and report the answer as if it were this
  // submission's.
  const result = await runCheck({ ...at(READY), cwd: null, repoRoot: null }, {
    execute: executorReturning({ kind: "exited", exitCode: 0, output: "", truncatedBytes: 0 }).execute,
  });
  // With no repoRoot, nothing matches the configured entry, so the honest answer is that
  // no command applies here.
  assert.equal(result.kind === "outcome" && result.outcome.status, "skipped");
});

test("a missing executable is unavailable, which is a configuration problem and not a defect", async () => {
  const result = await runCheck(at(READY), {
    execute: executorReturning({
      kind: "unavailable",
      note: "The configured executable `npm` is not on PATH.",
    }).execute,
  });
  assert.equal(result.kind === "outcome" && result.outcome.status, "unavailable");
  assert.match(result.kind === "outcome" ? result.outcome.note : "", /not on PATH/);
});

test("a command that died without answering is infrastructure, NEVER a fail verdict", async () => {
  // Timeout, OOM kill, container stop: all indistinguishable from the caller's side, and
  // none of them is a statement about the change under review. A fail here would return a
  // repair packet accusing an agent of breaking a build that never finished running.
  for (const reason of ["timed out after 600000ms", "killed by SIGKILL", "the pool lease could not be taken"]) {
    const result = await runCheck(at(READY), {
      execute: executorReturning({ kind: "infrastructure", reason }).execute,
    });
    assert.equal(result.kind, "infrastructure", `${reason} must not become an outcome`);
    assert.equal(result.kind === "infrastructure" && result.reason, reason);
  }
});

test("output is kept tail-first, and the omitted count sums every truncation", async () => {
  const head = "é".repeat(WORKFLOW_EXECUTION_LIMITS.checkOutput / 2);
  const failure = "THE ACTUAL FAILURE";
  const result = await runCheck(at(READY), {
    execute: executorReturning({
      kind: "exited",
      exitCode: 1,
      output: `${head}${failure}`,
      // The runner already dropped this much while streaming; the final clip adds to it
      // rather than replacing it, or a doubly-truncated log under-reports what was lost.
      truncatedBytes: 5_000,
    }).execute,
  });
  assert.equal(result.kind, "outcome");
  const outcome = result.kind === "outcome" ? result.outcome : null;
  assert.ok(outcome);
  assert.equal(Buffer.byteLength(outcome.output), WORKFLOW_EXECUTION_LIMITS.checkOutput);
  assert.ok(
    outcome.output.endsWith(failure),
    "a build prints its failure last, so the tail is the part worth keeping",
  );
  assert.equal(outcome.truncatedBytes, 5_000 + Buffer.byteLength(failure));
});

test("tailBounded keeps the end and reports exactly what it dropped", () => {
  assert.deepEqual(tailBounded("abc", 10), { text: "abc", droppedBytes: 0 });
  assert.deepEqual(tailBounded("abcdef", 3), { text: "def", droppedBytes: 3 });
  assert.deepEqual(tailBounded("abc", 3), { text: "abc", droppedBytes: 0 });
  assert.deepEqual(tailBounded("ééabc", 5), { text: "éabc", droppedBytes: 2 });
});

test("a maximum-length argv still produces a schema-valid outcome note", async () => {
  const command = Array.from({ length: 4 }, () => "x".repeat(999));
  const config = configWith({
    checksEnabled: true,
    repoAllowlist: [REPO],
    checkCommands: [{ repoRoot: REPO, slot: "test", command }],
  });
  assert.equal(command.join(" ").length, WORKFLOW_LIMITS.checkCommandLength - 1);
  const result = await runCheck(at(config), {
    execute: executorReturning({
      kind: "exited",
      exitCode: 1,
      output: "failed\n",
      truncatedBytes: 0,
    }).execute,
  });
  assert.equal(result.kind, "outcome");
  const outcome = result.kind === "outcome" ? result.outcome : null;
  assert.ok(outcome);
  assert.equal(WorkflowCheckOutcomeSchema.safeParse(outcome).success, true);
  assert.ok(outcome.note.length <= WORKFLOW_EXECUTION_LIMITS.verdictSummary);
  assert.match(outcome.note, /…` exited 1\.$/);
});

test("command resolution matches a worktree of a configured repository, longest root first", () => {
  const config = configWith({
    checkCommands: [
      { repoRoot: "/repos", slot: "test", command: ["broad"] },
      { repoRoot: "/repos/thing", slot: "test", command: ["narrow"] },
      { repoRoot: "/repos/thing", slot: "lint", command: ["lint-it"] },
    ],
  });
  // The MOST SPECIFIC entry wins, so a monorepo subdirectory can override the tree-wide one.
  assert.deepEqual(checkCommandFor(config, null, "/repos/thing", "test"), ["narrow"]);
  assert.deepEqual(checkCommandFor(config, null, "/repos/other", "test"), ["broad"]);
  assert.deepEqual(checkCommandFor(config, null, "/repos/thing", "lint"), ["lint-it"]);
  assert.equal(checkCommandFor(config, null, "/repos/thing", "build"), null);
  assert.equal(checkCommandFor(config, null, "/elsewhere", "test"), null);
  // A session standing in a pooled worktree outside the repo is the NORMAL dispatch shape,
  // and its cwd is the only clue when repoRoot is absent. Matching on either is what stops
  // every dispatched session from silently skipping every gate.
  assert.deepEqual(checkCommandFor(config, "/repos/thing/src", null, "test"), ["narrow"]);
  // A boundary match, not a prefix: `/repos-backup` is a different repository.
  assert.equal(checkCommandFor(config, null, "/repos-backup", "test"), null);
});

test("the resolved argv is a copy, so a caller cannot edit the stored config", () => {
  const config = configWith({
    checkCommands: [{ repoRoot: REPO, slot: "test", command: ["npm", "test"] }],
  });
  const resolved = checkCommandFor(config, null, REPO, "test");
  resolved!.push("--bail");
  assert.deepEqual(config.checkCommands[0]!.command, ["npm", "test"]);
});

test("checkBlockedReason answers with a sentence, and null when both gates are open", () => {
  assert.equal(checkBlockedReason(READY, null, REPO), null);
  assert.equal(typeof checkBlockedReason(DEFAULT_WORKFLOW_CONFIG, null, REPO), "string");
  // Never a boolean: the two refusals need different things done about them.
  assert.notEqual(
    checkBlockedReason(configWith({ repoAllowlist: [REPO] }), null, REPO),
    checkBlockedReason(configWith({ checksEnabled: true }), null, REPO),
  );
});

test("the argv split is quote-aware, and every ambiguity is an error rather than a guess", () => {
  const argv = (line: string): string[] => {
    const parsed = parseCheckCommand(line);
    assert.ok(parsed.ok, `expected ${line} to parse`);
    return parsed.ok ? parsed.argv : [];
  };
  // Plain words, with runs of whitespace collapsing.
  assert.deepEqual(argv("npm test"), ["npm", "test"]);
  assert.deepEqual(argv("  npm\t\trun   build \n"), ["npm", "run", "build"]);
  // Single quotes are literal all the way to the closing quote - the sh rule, so a regex or
  // a Windows path can be pasted without doubling anything.
  assert.deepEqual(argv("grep 'a b' ./x"), ["grep", "a b", "./x"]);
  assert.deepEqual(argv(`echo 'it\\'`), ["echo", "it\\"]);
  // Double quotes honour \" and \\ and nothing else, so "C:\tmp" is not given a tab.
  assert.deepEqual(argv('echo "a \\"b\\" c"'), ["echo", 'a "b" c']);
  assert.deepEqual(argv('echo "C:\\tmp"'), ["echo", "C:\\tmp"]);
  assert.deepEqual(argv('echo "a\\\\b"'), ["echo", "a\\b"]);
  // Outside quotes a backslash escapes exactly the next character, whitespace included.
  assert.deepEqual(argv("ls a\\ b"), ["ls", "a b"]);
  assert.deepEqual(argv('ls \\"x'), ["ls", '"x']);
  // Adjacent runs concatenate into ONE token, which is what makes --flag="a b" work.
  assert.deepEqual(argv('npm test --filter="a b"'), ["npm", "test", "--filter=a b"]);
  assert.deepEqual(argv("a'b'c"), ["abc"]);

  // Every refusal, each of which would otherwise resolve to something that would run.
  assert.equal(parseCheckCommand("").ok, false);
  assert.equal(parseCheckCommand("   ").ok, false);
  assert.equal(parseCheckCommand("npm 'test").ok, false);
  assert.equal(parseCheckCommand('npm "test').ok, false);
  assert.equal(parseCheckCommand("npm test\\").ok, false);
  // An empty argument is legal sh and illegal here: the schema bounds every element
  // non-empty, so accepting it would show a parse the daemon then refuses.
  assert.equal(parseCheckCommand("npm '' test").ok, false);

  // There is no shell, so shell operators are ORDINARY WORDS. Pinned so nobody later
  // "fixes" the split into something that pretends to understand them.
  assert.deepEqual(argv("a && b"), ["a", "&&", "b"]);
  assert.deepEqual(argv("a | b > c"), ["a", "|", "b", ">", "c"]);
  assert.deepEqual(argv("echo $HOME"), ["echo", "$HOME"]);
});

test("formatCheckCommand round-trips through the parser", () => {
  // The panel's promise is that what it prints back is what will run, so every printed argv
  // has to re-parse to the argv it came from. The control-character cases are the ones that
  // caught a real defect: the formatter used JSON.stringify, which escapes a tab as the two
  // characters \t, and this parser reads those literally (its double-quote rule honours \"
  // and \\ and nothing else, deliberately, so "C:\tmp" stays a path). A configured argument
  // containing a tab was therefore DISPLAYED as a different command from the one stored.
  for (const argv of [
    ["npm", "test"],
    ["npm", "test", "--filter=a b"],
    ["grep", 'a "quoted" thing'],
    ["x", "back\\slash"],
    ["x", "a\tb"],
    ["x", "a\nb"],
    ["x", "a\rb"],
    ["x", "tab\tand\\slash\"and quote"],
    ["x", "'single'"],
    ["x", "\u00e9\u4e2d\u6587 spaced"],
  ]) {
    const printed = formatCheckCommand(argv);
    const parsed = parseCheckCommand(printed);
    assert.ok(parsed.ok, `${JSON.stringify(printed)} should re-parse`);
    assert.deepEqual(
      parsed.ok ? parsed.argv : null,
      argv,
      `${JSON.stringify(printed)} re-parsed to something else`,
    );
  }
});

test("a repository may configure a slot only once, refused at the write boundary", () => {
  // `(repoRoot, slot)` is the key `checkCommandFor` resolves by, and it keeps the first of a
  // tie - so two entries sharing one are two commands the operator can see and one that can
  // ever run, chosen by array order that no surface displays. Refused rather than silently
  // deduplicated, because a caller who sent two is otherwise never told which survived.
  const base = { liveEnabled: false, repoAllowlist: [] };
  const duplicate = WorkflowConfigSchema.safeParse({
    ...base,
    checkCommands: [
      { repoRoot: "/repo", slot: "test", command: ["a"] },
      { repoRoot: "/repo", slot: "test", command: ["b"] },
    ],
  });
  assert.equal(duplicate.success, false);

  // The pair is what is unique, not either half: the same root with a different slot, and
  // the same slot in a different root, are both ordinary configurations.
  assert.equal(
    WorkflowConfigSchema.safeParse({
      ...base,
      checkCommands: [
        { repoRoot: "/repo", slot: "test", command: ["a"] },
        { repoRoot: "/repo", slot: "lint", command: ["b"] },
        { repoRoot: "/other", slot: "test", command: ["c"] },
      ],
    }).success,
    true,
  );
});

test("the check budget is its own, small, and not the review scheduler's three", async () => {
  // A check runs a build; the review scheduler's own comment defines its membership as
  // tool-less MODEL calls. Sharing would let one slow test suite hold a review slot.
  assert.ok(DEFAULT_CHECK_CONCURRENCY >= 1 && DEFAULT_CHECK_CONCURRENCY <= 2);
  const limit = createCheckScheduler(1);
  let running = 0;
  let peak = 0;
  await Promise.all([1, 2, 3].map(() => limit(async () => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running -= 1;
  })));
  assert.equal(peak, 1);
});

test("the slot list is append-only and every slot is reachable", () => {
  // Renaming one orphans every published graph naming the old spelling: the node stops
  // matching a configured command and skips forever, which looks exactly like a repository
  // nobody configured.
  assert.deepEqual([...WORKFLOW_CHECK_SLOTS], ["test", "lint", "typecheck", "build"]);
});
