import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_WORKFLOW_POLICY,
  WORKFLOW_CHECK_SLOTS,
  WORKFLOW_EXECUTION_LIMITS,
  WORKFLOW_LIMITS,
  checkBlockedReason,
  checkCommandRoot,
  checkCommandSubpath,
  emptyWorkflowCommandView,
  formatCheckCommand,
  parseCheckCommand,
  resolveWorkflowCommand,
  type WorkflowCheckSlot,
  type WorkflowCommandOverride,
  type WorkflowCommandView,
  type WorkflowPolicy,
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
const policyWith = (over: Partial<WorkflowPolicy> = {}): WorkflowPolicy => ({
  ...DEFAULT_WORKFLOW_POLICY,
  ...over,
});

/** One slot's catalog entry, in the grouped shape the daemon projects. */
const commandView = (
  over: Partial<Pick<WorkflowCommandView, "defaultCommand" | "overrides" | "maxRuns">> = {},
  slot: WorkflowCheckSlot = "test",
): WorkflowCommandView => ({ ...emptyWorkflowCommandView(slot), ...over });

/** Consent granted, and one `test` override - the setup most cases start from. */
const ALLOWED = policyWith({ checksEnabled: true, repoAllowlist: [REPO] });
const TEST_COMMAND = commandView({ overrides: [{ repoRoot: REPO, command: ["npm", "test"] }] });

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

const at = (
  policy: WorkflowPolicy,
  command: WorkflowCommandView | null = TEST_COMMAND,
  slot: WorkflowCheckSlot = "test",
  // A run with budget to spare, which is what every case here that is not about the budget
  // means. A granting reservation rather than null: null declines the budget rule entirely,
  // and would make these cases blind to a regression that skipped a gate it should have run.
  reserveRun: (() => { granted: boolean; spent: number }) | null = () => ({
    granted: true,
    spent: 0,
  }),
) => ({
  slot,
  policy,
  command,
  reserveRun,
  cwd: `${REPO}-worktree`,
  repoRoot: REPO,
  headSha: "a".repeat(40),
});

/** The two halves of the ready setup, together, for the cases that just want a gate to run. */
const READY = () => at(ALLOWED);

test("an unconfigured slot is skipped and PASSES - the contract a shipped workflow rests on", async () => {
  const result = await runCheck(at(ALLOWED, commandView()));
  assert.equal(result.kind, "outcome");
  assert.equal(result.kind === "outcome" && result.outcome.status, "skipped");
  assert.equal(result.kind === "outcome" && result.outcome.command, null);
  assert.equal(result.kind === "outcome" && result.outcome.exitCode, null);
  // The note has to say WHICH slot and that nothing ran, or "skipped" reads as a bug.
  assert.match(
    result.kind === "outcome" ? result.outcome.note : "",
    /No test Command is configured for this machine or repository/,
  );
});

test("an unconfigured slot never reaches the executor at all", async () => {
  const stub = executorReturning({ kind: "exited", exitCode: 1, output: "boom", truncatedBytes: 0 });
  const result = await runCheck(at(ALLOWED, commandView({}, "lint"), "lint"), { execute: stub.execute });
  assert.deepEqual(stub.seen, [], "nothing may be spawned for a slot nobody configured");
  assert.equal(result.kind === "outcome" && result.outcome.status, "skipped");
});

test("consent absent is unavailable, passes, and says which of the two gates refused", async () => {
  // Switch off, repository allowed: the operator has to go and flip a switch.
  const offSwitch = await runCheck(at(policyWith({ repoAllowlist: [REPO] })));
  assert.equal(offSwitch.kind === "outcome" && offSwitch.outcome.status, "unavailable");
  assert.match(
    offSwitch.kind === "outcome" ? offSwitch.outcome.note : "",
    /switched off/,
  );

  // Switch on, repository NOT allowed: the operator has to add a repository. A boolean here
  // would send them to whichever of the two they guessed.
  const offAllowlist = await runCheck(at(policyWith({ checksEnabled: true })));
  assert.equal(offAllowlist.kind === "outcome" && offAllowlist.outcome.status, "unavailable");
  assert.match(
    offAllowlist.kind === "outcome" ? offAllowlist.outcome.note : "",
    /not on the workflow allowlist/,
  );
});

test("consent absent never reaches the executor", async () => {
  const stub = executorReturning({ kind: "exited", exitCode: 0, output: "", truncatedBytes: 0 });
  await runCheck(at(policyWith({ repoAllowlist: [REPO] })), {
    execute: stub.execute,
  });
  assert.deepEqual(stub.seen, [], "an unauthorized gate must not spawn anything");
});

test("a build with no execution runtime is unavailable and passes, rather than failing", async () => {
  const result = await runCheck(READY());
  assert.equal(result.kind === "outcome" && result.outcome.status, "unavailable");
  assert.equal(result.kind === "outcome" && result.outcome.note, CHECK_RUNTIME_UNAVAILABLE_NOTE);
  // The resolved command is still reported: an operator has to be able to see that their
  // configuration WAS found, so "not run" reads as a missing runtime and not a typo.
  assert.deepEqual(result.kind === "outcome" ? result.outcome.command : null, ["npm", "test"]);
});

test("exit 0 passes and exit non-zero fails, with the command and code recorded", async () => {
  const passed = await runCheck(READY(), {
    execute: executorReturning({ kind: "exited", exitCode: 0, output: "ok\n", truncatedBytes: 0 }).execute,
  });
  assert.equal(passed.kind === "outcome" && passed.outcome.status, "passed");
  assert.equal(passed.kind === "outcome" && passed.outcome.exitCode, 0);
  assert.match(passed.kind === "outcome" ? passed.outcome.note : "", /`npm test` passed\./);

  const failed = await runCheck(READY(), {
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
  await runCheck(READY(), { execute: stub.execute });
  assert.equal(stub.seen.length, 1);
  assert.deepEqual(stub.seen[0]!.command, ["npm", "test"]);
  assert.equal(stub.seen[0]!.slot, "test");
  assert.equal(stub.seen[0]!.repoRoot, REPO);
  // The CAPTURED commit, not a live HEAD: a gate has to judge the tree the submission
  // recorded, or a push landing mid-review changes what was gated.
  assert.equal(stub.seen[0]!.headSha, "a".repeat(40));
  // A repository-wide entry runs at the checkout root.
  assert.equal(stub.seen[0]!.workingSubpath, "");
});

test("a nested command reaches the executor with the directory it was configured in", async () => {
  // The monorepo case, end to end. Resolution already preferred the nested entry, but the
  // executor was handed only the repository - so the package's command would have run at the
  // top of the tree, which most build tools do not refuse: they succeed against the wrong
  // target and the gate reports that as this submission's answer.
  const stub = executorReturning({ kind: "exited", exitCode: 0, output: "", truncatedBytes: 0 });
  await runCheck({
    slot: "test",
    policy: ALLOWED,
    reserveRun: () => ({ granted: true, spent: 0 }),
    command: commandView({
      overrides: [
        { repoRoot: REPO, command: ["npm", "test"] },
        { repoRoot: `${REPO}/packages/web`, command: ["pnpm", "-C", ".", "test"] },
      ],
    }),
    // The session stands in the package, which is how the nested entry is selected at all.
    cwd: `${REPO}/packages/web`,
    repoRoot: REPO,
    headSha: "b".repeat(40),
  }, {
    execute: stub.execute,
    // Stubbed rather than shelling out to git: this asserts which package was selected and
    // where it will run, not how the daemon asks where a session is.
    checkoutSubpath: async () => "packages/web",
  });

  assert.equal(stub.seen.length, 1);
  assert.deepEqual(stub.seen[0]!.command, ["pnpm", "-C", ".", "test"], "the nested argv won");
  // The repository is still what gets leased and pinned...
  assert.equal(stub.seen[0]!.repoRoot, REPO);
  // ...and this is where inside it the command runs. Relative, so the runtime joins it onto
  // the pooled worktree it provisioned rather than onto the operator's live checkout.
  assert.equal(stub.seen[0]!.workingSubpath, "packages/web");
});

test("a command with nowhere to run it is unavailable rather than guessed at", async () => {
  // A session that reported no repository. Falling back to the daemon's own cwd here would
  // run the gate against an unrelated checkout and report the answer as if it were this
  // submission's.
  const result = await runCheck({ ...READY(), cwd: null, repoRoot: null }, {
    execute: executorReturning({ kind: "exited", exitCode: 0, output: "", truncatedBytes: 0 }).execute,
  });
  // With no repoRoot, nothing matches the configured entry, so the honest answer is that
  // no command applies here.
  assert.equal(result.kind === "outcome" && result.outcome.status, "skipped");
});

test("a missing executable is unavailable, which is a configuration problem and not a defect", async () => {
  const result = await runCheck(READY(), {
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
    const result = await runCheck(READY(), {
      execute: executorReturning({ kind: "infrastructure", reason }).execute,
    });
    assert.equal(result.kind, "infrastructure", `${reason} must not become an outcome`);
    assert.equal(result.kind === "infrastructure" && result.reason, reason);
  }
});

test("output is kept tail-first, and the omitted count sums every truncation", async () => {
  const head = "é".repeat(WORKFLOW_EXECUTION_LIMITS.checkOutput / 2);
  const failure = "THE ACTUAL FAILURE";
  const result = await runCheck(READY(), {
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
  assert.equal(command.join(" ").length, WORKFLOW_LIMITS.checkCommandLength - 1);
  const result = await runCheck(at(ALLOWED, commandView({ overrides: [{ repoRoot: REPO, command }] })), {
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
  const testSlot = commandView({
    overrides: [
      { repoRoot: "/repos", command: ["broad"] },
      { repoRoot: "/repos/thing", command: ["narrow"] },
    ],
  });
  const lintSlot = commandView({
    overrides: [{ repoRoot: "/repos/thing", command: ["lint-it"] }],
  }, "lint");
  const argv = (cwd: string | null, root: string | null, view: WorkflowCommandView | null) =>
    resolveWorkflowCommand(view, { cwd, repoRoot: root, checkoutSubpath: null })?.command ?? null;
  // The MOST SPECIFIC entry wins, so a monorepo subdirectory can override the tree-wide one.
  assert.deepEqual(argv(null, "/repos/thing", testSlot), ["narrow"]);
  assert.deepEqual(argv(null, "/repos/other", testSlot), ["broad"]);
  assert.deepEqual(argv(null, "/repos/thing", lintSlot), ["lint-it"]);
  // An unconfigured slot, and a slot the daemon did not project at all.
  assert.equal(argv(null, "/repos/thing", commandView({}, "build")), null);
  assert.equal(argv(null, "/repos/thing", null), null);
  assert.equal(argv(null, "/elsewhere", testSlot), null);
  // A session standing in a pooled worktree outside the repo is the NORMAL dispatch shape,
  // and its cwd is the only clue when repoRoot is absent. Matching on either is what stops
  // every dispatched session from silently skipping every gate.
  assert.deepEqual(argv("/repos/thing/src", null, testSlot), ["narrow"]);
  // A boundary match, not a prefix: `/repos-backup` is a different repository.
  assert.equal(argv(null, "/repos-backup", testSlot), null);
  // The working subpath comes back too, because when a nested entry wins it is also the
  // directory that command has to run in. Returning only the argv is what let a package's
  // command be handed to the runtime with nothing but the parent repository.
  const at_ = (root: string) => ({ cwd: null, repoRoot: root, checkoutSubpath: null });
  assert.equal(resolveWorkflowCommand(testSlot, at_("/repos/thing"))?.workingSubpath, "");
  assert.equal(resolveWorkflowCommand(testSlot, at_("/repos/thing/pkg"))?.workingSubpath, "");
  const nested = commandView({ overrides: [{ repoRoot: "/repos/thing/pkg", command: ["p"] }] });
  assert.equal(resolveWorkflowCommand(nested, at_("/repos/thing"))?.workingSubpath, undefined);
  assert.equal(
    resolveWorkflowCommand(nested, at_("/repos/thing/pkg"))?.workingSubpath,
    "",
    "matched through its own root, the nested entry IS the checkout",
  );
});

test("a global default answers only after every override has failed to match", () => {
  // The whole point of the catalog: a machine-wide command that needs no repository, and an
  // override that remains the exception. Precedence is asserted in one place because getting
  // it backwards would silently run the wrong command everywhere the exception exists.
  const view = commandView({
    defaultCommand: ["npm", "test"],
    overrides: [
      { repoRoot: "/repos/thing", command: ["narrow"] },
      { repoRoot: "/repos/thing/packages/web", command: ["package"] },
    ],
  });
  const pick = (root: string | null, checkoutSubpath: string | null = null) =>
    resolveWorkflowCommand(view, { cwd: null, repoRoot: root, checkoutSubpath });

  // Nested override beats the repository override...
  assert.deepEqual(pick("/repos/thing", "packages/web")?.command, ["package"]);
  assert.equal(pick("/repos/thing", "packages/web")?.workingSubpath, "packages/web");
  assert.equal(pick("/repos/thing", "packages/web")?.source, "override");
  // ...the repository override beats the global default...
  assert.deepEqual(pick("/repos/thing")?.command, ["narrow"]);
  assert.equal(pick("/repos/thing")?.source, "override");
  // ...and the default answers for every repository nobody wrote an exception for.
  assert.deepEqual(pick("/somewhere/else")?.command, ["npm", "test"]);
  assert.deepEqual(pick(null)?.command, ["npm", "test"]);
  assert.equal(pick("/somewhere/else")?.source, "default");

  // A default names NO repository, so it runs at the checkout root. Inheriting a losing
  // override's subdirectory would run a machine-wide command somewhere it was never meant to.
  assert.equal(pick("/somewhere/else")?.workingSubpath, "");

  // And with no default, an unmatched repository still skips - the shipped-workflow contract.
  assert.equal(
    resolveWorkflowCommand(
      commandView({ overrides: view.overrides }),
      { cwd: null, repoRoot: "/somewhere/else", checkoutSubpath: null },
    ),
    null,
  );
});

test("a resolved default is a copy, so a caller cannot edit the stored catalog", () => {
  const view = commandView({ defaultCommand: ["npm", "test"] });
  const resolved = resolveWorkflowCommand(view, { cwd: null, repoRoot: REPO, checkoutSubpath: null });
  resolved!.command.push("--bail");
  assert.deepEqual(view.defaultCommand, ["npm", "test"]);
});

test("a nested command is chosen by the session's EXACT position in its checkout", () => {
  // The case that carries the feature, and the one place resolution can pick the wrong
  // package. A dispatched session's cwd is under `~/.treehouse/`, outside the repository
  // entirely, while its repoRoot names the main checkout - so absolute containment selects
  // only the repository-wide entry. The nested entry is reached by comparing where the
  // session sits INSIDE its own checkout, component by component.
  const view = commandView({
    overrides: [
      { repoRoot: "/repo", command: ["repo-wide"] },
      { repoRoot: "/repo/packages/web", command: ["package"] },
    ],
  });
  const pick = (checkoutSubpath: string | null, cwd = "/home/u/.treehouse/r/1/repo") =>
    resolveWorkflowCommand(view, { cwd, repoRoot: "/repo", checkoutSubpath })?.command ?? null;

  // In the package, and deeper inside it.
  assert.deepEqual(pick("packages/web"), ["package"]);
  assert.deepEqual(pick("packages/web/src"), ["package"]);
  // At the top of the checkout, and in a different package.
  assert.deepEqual(pick(""), ["repo-wide"]);
  assert.deepEqual(pick("packages/api"), ["repo-wide"]);

  // THE COUNTER-EXAMPLE. A trailing-substring match read `examples/packages/web` as
  // `packages/web` and would then have run the command in the leased checkout's
  // `packages/web` - silently testing a different package from the one the submission was
  // written in. A repository containing both directories is ordinary.
  assert.deepEqual(pick("examples/packages/web"), ["repo-wide"]);
  // Nor does a partial component match: `web-legacy` is not `web`.
  assert.deepEqual(pick("packages/web-legacy"), ["repo-wide"]);

  // An unknown position declines nested matching rather than falling back to something
  // looser - not knowing where a session is is not evidence that it is in the package.
  assert.deepEqual(pick(null), ["repo-wide"]);

  // The plain-checkout case still resolves through ordinary containment, with no subpath.
  assert.deepEqual(
    resolveWorkflowCommand(view, { cwd: "/repo/packages/web", repoRoot: "/repo", checkoutSubpath: null })?.command,
    ["package"],
  );
});

test("a nested command's execution directory is relative to the checkout, not absolute", () => {
  // Relative because the runtime does not run in the operator's directory: it leases a
  // pooled worktree of the repository and pins it to the captured commit, so an absolute
  // path would run the check against the live checkout instead of the reviewed commit.
  assert.equal(checkCommandSubpath("/repo", "/repo/packages/web"), "packages/web");
  assert.equal(checkCommandSubpath("/repo/", "/repo/packages/web"), "packages/web");
  assert.equal(checkCommandSubpath("/repo", "/repo/packages/web/"), "packages/web");
  // The root itself, and the two shapes that are not a subdirectory of it at all: an entry
  // ABOVE the repository is a broad rule that names no subdirectory, and one outside the
  // tree was matched through cwd. Both run at the checkout root, which is where a
  // repository-wide command expects to be.
  assert.equal(checkCommandSubpath("/repo", "/repo"), "");
  assert.equal(checkCommandSubpath("/repo", "/"), "");
  assert.equal(checkCommandSubpath("/repo/packages/web", "/repo"), "");
  assert.equal(checkCommandSubpath("/repo", "/elsewhere/pkg"), "");
  // A boundary match, like the allowlist's: `/repo-backup` is not inside `/repo`.
  assert.equal(checkCommandSubpath("/repo", "/repo-backup/pkg"), "");
  assert.equal(checkCommandSubpath(null, "/repo/pkg"), "");
});

test("a typed subdirectory survives being resolved to its repository", () => {
  // Resolving a path to its repository is lossy in exactly the direction that matters:
  // /repo/packages/web resolves to /repo. Storing the root alone made the subdirectory
  // override - documented, and wired all the way to the executor - impossible to configure
  // from Settings, which is a capability that exists only for whoever calls the API by hand.
  assert.equal(checkCommandRoot("/repo", "/repo/packages/web"), "/repo/packages/web");
  assert.equal(checkCommandRoot("/repo", "/repo"), "/repo");
  assert.equal(checkCommandRoot("/repo/", "/repo/packages/web/"), "/repo/packages/web");
  // Outside the repository it resolved to - a symlinked or relocated checkout. Storing that
  // would be an entry the matcher can never match, so it falls back to the repository.
  assert.equal(checkCommandRoot("/repo", "/elsewhere/pkg"), "/repo");
  assert.equal(checkCommandRoot("/repo", "/repo-backup/pkg"), "/repo");
  // And it round-trips with the reader: what Settings stores is what resolution takes apart.
  const stored = checkCommandRoot("/repo", "/repo/packages/web");
  assert.equal(checkCommandSubpath("/repo", stored), "packages/web");
});

test("the resolved argv is a copy, so a caller cannot edit the stored catalog", () => {
  const view = commandView({ overrides: [{ repoRoot: REPO, command: ["npm", "test"] }] });
  const resolved = resolveWorkflowCommand(view, { cwd: null, repoRoot: REPO, checkoutSubpath: null });
  resolved!.command.push("--bail");
  assert.deepEqual(view.overrides[0]!.command, ["npm", "test"]);
});

test("checkBlockedReason answers with a sentence, and null when both gates are open", () => {
  assert.equal(checkBlockedReason(ALLOWED, null, REPO), null);
  assert.equal(typeof checkBlockedReason(DEFAULT_WORKFLOW_POLICY, null, REPO), "string");
  // Never a boolean: the two refusals need different things done about them.
  assert.notEqual(
    checkBlockedReason(policyWith({ repoAllowlist: [REPO] }), null, REPO),
    checkBlockedReason(policyWith({ checksEnabled: true }), null, REPO),
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
  // `(repoRoot, slot)` is the key resolution picks by, and it keeps the first of a
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
