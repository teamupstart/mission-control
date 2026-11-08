import assert from "node:assert/strict";
import test from "node:test";
import {
  commandMisfitSignal,
  defaultCommandFailureNote,
  misfitCommandRepair,
} from "../src/server/workflows/command-fit.ts";

test("recognizes the configured launcher refusing the target, script or recipe it was asked for", () => {
  // Each output is everything the launcher prints when it refuses before starting any work.
  const refusals: Array<[string[], string, RegExp]> = [
    [["make", "test"], "make: *** No rule to make target 'test'.  Stop.", /No rule to make target/],
    // GNU make 3.81, as macOS ships it, quotes with a backtick.
    [["make", "test"], "make: *** No rule to make target `test'.  Stop.", /No rule to make target/],
    [["/usr/bin/make", "-j4", "lint"], "make: *** No rule to make target 'lint'.  Stop.", /'lint'/],
    [["make", "-C", "pkg", "test"],
      "make: Entering directory '/repo/pkg'\nmake: *** No rule to make target 'test'.  Stop.\nmake: Leaving directory '/repo/pkg'", /'test'/],
    [["make"], "make: *** No targets specified and no makefile found.  Stop.", /no makefile found/],
    [["bmake", "lint"], "bmake: don't know how to make lint. Stop", /don't know how to make/],
    [["npm", "run", "lint"],
      "npm error Missing script: \"lint\"\nnpm error\nnpm error To see a list of scripts, run:\nnpm error   npm run\nnpm error A complete log of this run can be found in: /home/u/.npm/_logs/x-debug-0.log",
      /Missing script/],
    [["npm", "test"], "npm ERR! missing script: test\n\nnpm ERR! A complete log of this run can be found in:\nnpm ERR!     /home/u/.npm/_logs/x.log", /missing script/],
    [["pnpm", "typecheck"], " ERR_PNPM_NO_SCRIPT  Missing script: typecheck\n\nCommand \"typecheck\" not found.", /ERR_PNPM_NO_SCRIPT/],
    [["yarn", "test"],
      "yarn run v1.22.19\nerror Command \"test\" not found.\ninfo Visit https://yarnpkg.com/en/docs/cli/run for documentation about this command.",
      /Command "test" not found/],
    [["yarn", "run", "lint"],
      "Usage Error: Couldn't find a script named \"lint\".\n\n$ yarn run [--inspect] [--inspect-brk] [-T,--top-level] [-B,--binaries-only] [--require #0] <scriptName> ...",
      /Couldn't find a script/],
    [["just", "test"], "error: Justfile does not contain recipe `test`.", /does not contain recipe/],
    [["just", "test"], "error: No justfile found", /No justfile found/],
    [["task", "lint"], "task: Task \"lint\" does not exist", /does not exist/],
    [["sh", "-c", "pytest -q"], "sh: 1: pytest: not found", /pytest: not found/],
    [["bash", "-c", "CI=1 tox -e py"], "bash: line 1: tox: command not found", /tox: command not found/],
    [["zsh", "-c", "cargo test"], "zsh: command not found: cargo", /command not found: cargo/],
  ];
  for (const [command, output, shape] of refusals) {
    const signal = commandMisfitSignal(command, `${output}\n`);
    assert.ok(signal, `${command.join(" ")}: ${output}`);
    assert.match(signal, shape);
  }
});

test("make with several goals or --keep-going counts only a refusal that proves nothing ran", () => {
  // make stops at the first goal it cannot make, before building any later one.
  assert.ok(commandMisfitSignal(["make", "test", "lint"], "make: *** No rule to make target 'test'.  Stop."));
  // A refusal of goal two may follow a silent goal one that did run.
  assert.equal(commandMisfitSignal(["make", "test", "lint"], "make: *** No rule to make target 'lint'.  Stop."), null);
  // With -k make keeps building other goals after one fails, so no refusal proves anything.
  for (const flag of ["-k", "-sk", "--keep-going"]) {
    assert.equal(commandMisfitSignal(["make", flag, "test"], "make: *** No rule to make target 'test'.  Stop."), null, flag);
  }
  assert.ok(commandMisfitSignal(["make", "-j4", "test"], "make: *** No rule to make target 'test'.  Stop."));
  // A separate numeric value belongs to -j or -l, never the first goal.
  for (const argv of [["make", "-j", "4", "test"], ["make", "--jobs", "8", "test"], ["make", "-l", "2.5", "test"], ["make", "-j", "test"]]) {
    assert.ok(commandMisfitSignal(argv, "make: *** No rule to make target 'test'.  Stop."), argv.join(" "));
  }
});

test("an option's value is never mistaken for the requested script, task or recipe", () => {
  const cases: Array<[string[], string]> = [
    [["pnpm", "--dir", "packages/app", "test"], " ERR_PNPM_NO_SCRIPT  Missing script: test\n\nCommand \"test\" not found."],
    [["pnpm", "-C", "packages/app", "run", "lint"], " ERR_PNPM_NO_SCRIPT  Missing script: lint"],
    [["pnpm", "--filter", "web", "test"], " ERR_PNPM_NO_SCRIPT  Missing script: test"],
    [["npm", "--prefix", "packages/app", "test"], "npm error Missing script: \"test\""],
    [["npm", "-w", "web", "run", "lint"], "npm error Missing script: \"lint\""],
    [["yarn", "--cwd", "packages/app", "test"], "yarn run v1.22.19\nerror Command \"test\" not found."],
    [["task", "-d", "packages/app", "lint"], "task: Task \"lint\" does not exist"],
    [["task", "--taskfile", "ci/Taskfile.yml", "test"], "task: Task \"test\" does not exist"],
    [["just", "-f", "ci/justfile", "test"], "error: Justfile does not contain recipe `test`."],
    [["just", "--working-directory", "packages/app", "lint"], "error: Justfile does not contain recipe `lint`."],
  ];
  for (const [command, output] of cases) {
    assert.ok(commandMisfitSignal(command, output), `${command.join(" ")}: ${output}`);
  }
  // And the directory itself is not a name the refusal can match.
  assert.equal(commandMisfitSignal(["pnpm", "--dir", "test", "lint"], " ERR_PNPM_NO_SCRIPT  Missing script: test"), null);
  assert.equal(commandMisfitSignal(["task", "-d", "lint", "test"], "task: Task \"lint\" does not exist"), null);
});

test("a nested command failing inside a real target stays an ordinary failure", () => {
  const nested: Array<[string[], string]> = [
    // `make test` exists and its recipe runs a sub-make that cannot find ITS target.
    [["make", "test"], "make -C sub fixtures\nmake[1]: *** No rule to make target 'fixtures'.  Stop.\nmake: *** [Makefile:3: test] Error 2"],
    // Even a sub-make asking for a target of the same name speaks as `make[1]`.
    [["make", "test"], "make[1]: *** No rule to make target 'test'.  Stop."],
    // An INDEPENDENT make process (MAKELEVEL cleared, or run from a script) speaks as `make:`
    // and names `test` - but the outer make echoed the recipe and reported it failing.
    [["make", "test"], "cd fixtures && env -u MAKELEVEL make test\nmake: *** No rule to make target 'test'.  Stop.\nmake: *** [Makefile:2: test] Error 2"],
    // The same with a silent (`@`) recipe: no echo, but the outer make still reports the recipe.
    [["make", "test"], "make: *** No rule to make target 'test'.  Stop.\nmake: *** [Makefile:2: test] Error 2"],
    // GNU make 3.81 reports a failed recipe without the file and line.
    [["make", "test"], "make: *** No rule to make target `test'.  Stop.\nmake: *** [test] Error 2"],
    // A missing prerequisite of the requested target is a real build failure.
    [["make", "test"], "make: *** No rule to make target 'fixtures.json', needed by 'test'.  Stop."],
    // The top-level make refusing a DIFFERENT target than the one configured.
    [["make", "test"], "make: *** No rule to make target 'lint'.  Stop."],
    // `npm test` ran `npm test --prefix fixtures`, whose package has no `test` script: the
    // nested refusal names the SAME script, and the banner shows the outer script started.
    [["npm", "test"], "\n> repo@1.0.0 test\n> npm test --prefix fixtures\n\nnpm error Missing script: \"test\"\nnpm error\nnpm error To see a list of scripts, run:\nnpm error   npm run\nnpm error Lifecycle script `test` failed with error:\nnpm error code 1\nnpm error path /repo\nnpm error command failed\nnpm error command sh -c npm test --prefix fixtures"],
    // The same nested refusal with the outer banner silenced still reports its own lifecycle.
    [["npm", "test"], "npm error Missing script: \"test\"\nnpm error Lifecycle script `test` failed with error:\nnpm error command failed"],
    // `npm test` ran and its script called a missing sibling script.
    [["npm", "test"], "> repo@1.0.0 test\n> npm run unit\nnpm error Missing script: \"unit\""],
    // pnpm and Yarn print a banner or command echo for a script that started.
    [["pnpm", "test"], "> repo@1.0.0 test /repo\n> pnpm --dir fixtures test\n\n ERR_PNPM_NO_SCRIPT  Missing script: test"],
    [["yarn", "test"], "yarn run v1.22.19\n$ yarn --cwd fixtures test\nerror Command \"test\" not found.\nerror Command failed with exit code 1."],
    // go-task announcing a command it ran, and just reporting a recipe that failed.
    [["task", "test"], "task: [test] task -d fixtures test\ntask: Task \"test\" does not exist\ntask: Failed to run task \"test\": exit status 200"],
    [["just", "test"], "just --justfile fixtures/justfile test\nerror: Justfile does not contain recipe `test`.\nerror: Recipe `test` failed on line 2 with exit code 1"],
    // The `test` script ran a nested make that has no Makefile.
    [["npm", "test"], "make: *** No targets specified and no makefile found.  Stop."],
    // The shell started pytest, which then shelled out to a missing helper.
    [["sh", "-c", "pytest -q"], "sh: 1: helper: not found"],
    [["sh", "-c", "pytest -q"], "collected 3 items\nsh: 1: pytest: not found"],
    // Output shaped like a refusal from a launcher this module does not classify.
    [["./scripts/test.sh"], "make: *** No rule to make target 'test'.  Stop."],
  ];
  for (const [command, output] of nested) {
    assert.equal(commandMisfitSignal(command, output), null, `${command.join(" ")}: ${output}`);
  }
});

test("does not mistake a runner that started and reported failures for a missing command", () => {
  const failures = [
    "src/thing.ts(4,1): error TS2345: nope",
    "1 failing\n  AssertionError: expected 2 to equal 3",
    "fixtures/input.json: not found",
    "Error: Cannot find module './missing'",
    "make: *** [Makefile:12: test] Error 1",
    "FAIL test/app.test.ts\n  ● renders",
    "",
  ];
  for (const output of failures) assert.equal(commandMisfitSignal(["make", "test"], output), null, output);
  assert.equal(commandMisfitSignal(null, "make: *** No rule to make target 'test'.  Stop."), null);
});

test("the configuration repair names the default, the signal and every guarded step", () => {
  const repair = misfitCommandRepair({
    slot: "lint",
    command: ["make", "lint"],
    commandSource: "default",
    runId: "run-1",
    signal: "make: *** No rule to make target 'lint'.  Stop.",
  });
  assert.equal(repair.title, "Configure the lint Command for this repository; do not add files to satisfy it");
  assert.match(repair.guidance, /`make lint`, which is Mission Control's machine-wide default for this slot/);
  assert.match(repair.guidance, /Do not create a Makefile/);
  assert.match(repair.guidance, /1\. Inspect the repository/);
  assert.match(repair.guidance, /2\. Call configure_workflow_command\(\{ runId: "run-1", slot: "lint"/);
  assert.match(repair.guidance, /request_input card that Mission Control writes, naming this run, the slot, the repository and the exact argv/);
  assert.match(repair.guidance, /nothing is configured unless they choose Configure this Command/);
  assert.match(repair.guidance, /never the machine-wide default/);
  assert.match(repair.guidance, /3\. .*resubmitUnchanged: true/);

  const override = misfitCommandRepair({
    slot: "test", command: ["make", "test"], commandSource: "override", runId: "run-2", signal: "x",
  });
  assert.match(override.guidance, /which is the Command configured for this repository/);
  // Room for the output tail and retained-output readers inside one 4,000-byte rationale.
  assert.ok(Buffer.byteLength(repair.guidance) < 2_000);
});

test("the default-failure note hands over the same procedure without asserting a misconfiguration", () => {
  const note = defaultCommandFailureNote({
    slot: "test", command: ["make", "test"], commandSource: "default", runId: "run-3",
  });
  assert.match(note, /^Note: `make test` is Mission Control's machine-wide default for the test slot/);
  assert.match(note, /If the output shows the command does not apply here/);
  assert.match(note, /request_input/);
  assert.match(note, /configure_workflow_command\(\{ runId: "run-3", slot: "test"/);
  assert.match(note, /resubmitUnchanged: true/);
});
