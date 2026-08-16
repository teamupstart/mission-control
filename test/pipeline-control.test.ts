import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// What stops the dashboard reporting that it paused an engine that is still dispatching.
//
// ai-conductor's CLI exits 0 for several malformed invocations - its own reference calls that
// out - and a slug-less `daemon park`, a malformed `decide-grant` and a malformed `reseal` are
// all rejected by an argv detector BEFORE their verb runs, so what prints is a generic refusal
// about the inline pipeline that never mentions what was asked for. Every case below drives
// the real `runConductorControl` against a fake CLI that reproduces one of those shapes, so
// the thing under test is the predicate over stdout rather than a stub of it.
//
// The fake is a shell script and the assertions read the argv it recorded, because the OTHER
// half of being wrong here is spawning the right words in the wrong shape: `daemon park` takes
// a bare positional and `decide-grant` takes exactly three flags, and either mistake produces
// a zero exit and a refusal nobody asked to read.

const home = mkdtempSync(join(tmpdir(), "mission-pipeline-control-"));
process.env.HARNESS_HOME = home;
process.env.MISSION_HOME = home;

const binDir = mkdtempSync(join(tmpdir(), "fake-conduct-"));
const fake = join(binDir, "conduct-ts");
const recorded = join(binDir, "argv.txt");
const scripted = join(binDir, "script.sh");

/**
 * A fake `conduct-ts` that records its argv and then behaves however a case says.
 *
 * The behaviour is a second script the case writes, rather than a table baked in here: every
 * interesting shape is about what conductor PRINTS and with what exit code, and a fake that
 * chose those for the test would be the test asserting against itself.
 */
writeFileSync(
  fake,
  `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(recorded)}
printf '%s\\n' "cwd=$PWD" >> ${JSON.stringify(recorded)}
. ${JSON.stringify(scripted)}
`,
);
chmodSync(fake, 0o755);
process.env.MISSION_CONDUCTOR_BIN = fake;

const { runConductorControl, conductorConsoleArgv, conductorControlArgv } = await import(
  "../src/server/pipelines/conductor/control.ts"
);

after(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

// Through `realpathSync`, because the temp dir is a symlink on macOS and the child reports
// the resolved path in `$PWD` - the same reason `resolveRepoRoot` hands the daemon a real one.
const REPO = realpathSync(mkdtempSync(join(tmpdir(), "mission-pipeline-repo-")));
after(() => rmSync(REPO, { recursive: true, force: true }));

/** What the engine will print and exit with, for the next invocation. */
function scripts(body: string): void {
  writeFileSync(scripted, body);
  rmSync(recorded, { force: true });
}

/** Every argv the fake was called with, one line per invocation. */
function invocations(): string[] {
  if (!existsSync(recorded)) return [];
  return readFileSync(recorded, "utf8").trim().split("\n").filter((line) => line !== "");
}

const target = (over: Partial<{ slug: string | null; step: string | null; reason: string | null }> = {}) => ({
  repoRoot: REPO,
  slug: null,
  step: null,
  reason: null,
  ...over,
});

/** The feature worktree every reseal path has to resolve inside, as the provider computes it. */
const WORKTREE = join(REPO, ".worktrees", "fix-the-thing");
mkdirSync(join(WORKTREE, ".docs", "decisions"), { recursive: true });

/** The composed reseal argv, for a case that is only about the paths in it. */
function reseal(paths: readonly string[], worktree = WORKTREE): string[] {
  const composed = conductorConsoleArgv(
    "reseal",
    { ...target({ slug: "fix-the-thing", reason: "r" }), paths, clearHalt: false },
    worktree,
  );
  assert.ok(!("refused" in composed), `expected argv, got ${JSON.stringify(composed)}`);
  return composed.argv;
}

/** Just the `--path` values out of a composed argv, in order. */
function pathsIn(argv: readonly string[]): string[] {
  return argv.filter((_, at) => argv[at - 1] === "--path");
}

/** Why the composer refused these paths, or `null` if it did not. */
function resealRefusal(paths: readonly string[], worktree = WORKTREE): string | null {
  const composed = conductorConsoleArgv(
    "reseal",
    { ...target({ slug: "fix-the-thing", reason: "r" }), paths, clearHalt: false },
    worktree,
  );
  return "refused" in composed ? composed.refused : null;
}

test("a verb that printed its confirmation is a success, whatever else it printed", async () => {
  // `daemon start` runs the engine's own installation check first with INHERITED stdio, so
  // the confirmation is preceded by however many lines that felt like printing. A predicate
  // anchored to the start of the output rather than to a line would fail on every real start.
  scripts(`printf 'checking install…\\nskills: 41 ok\\ndaemon started (session conductor-demo)\\n'\n`);
  const started = await runConductorControl("daemon-start", target());
  assert.equal(started.ok, true);
  assert.match(started.detail, /daemon is running/);
  // Nothing on a success: the sentence above already says what happened, and printing both
  // invites a reader to hunt for the difference between them.
  assert.equal(started.output, "");
  assert.match(started.command, /daemon start -D$/);
  // Detached, and from the consented repository root.
  assert.equal(invocations()[0], "daemon start -D");
  assert.equal(invocations()[1], `cwd=${REPO}`);
});

test("a clean exit with no confirmation is a FAILURE, and says so in those words", async () => {
  // The shape this whole module exists for: conductor's argv detector rejected the verb
  // before it ran, printed a refusal about a different subcommand, and exited 0.
  scripts(`printf 'the inline SDLC pipeline now runs under the \`inline\` subcommand\\n'\n`);
  const parked = await runConductorControl("park", target({ slug: "fix-the-thing" }));
  assert.equal(parked.ok, false);
  assert.match(parked.detail, /exited cleanly without confirming/);
  // The engine's own words travel back, because the operator's next move is to read them.
  assert.match(parked.output, /inline SDLC pipeline/);
});

test("a binary that is not there is an answer, not an exception", async () => {
  const missing = join(binDir, "not-installed");
  process.env.MISSION_CONDUCTOR_BIN = missing;
  const result = await runConductorControl("daemon-pause", target());
  process.env.MISSION_CONDUCTOR_BIN = fake;
  assert.equal(result.ok, false);
  assert.ok(result.detail.length > 0, "a control surface needs a sentence for every outcome");
  assert.match(result.command, /not-installed daemon pause$/);
});

test("silence is how a stop succeeds, and any output means it did not", async () => {
  // `daemon stop` prints nothing when it works - killing the session is idempotent - and
  // prints its FAILURES to stdout rather than stderr. So output at all is the engine saying
  // something went wrong, even behind a zero exit.
  scripts("exit 0\n");
  const quiet = await runConductorControl("daemon-stop", target());
  assert.equal(quiet.ok, true);
  assert.match(quiet.detail, /stopped/);

  scripts(`printf 'no daemon session found for this repository\\n'\n`);
  const noisy = await runConductorControl("daemon-stop", target());
  assert.equal(noisy.ok, false);
  assert.match(noisy.output, /no daemon session/);
});

test("pause and resume accept the engine's idempotent answers as successes", async () => {
  // An operator who pauses an already-paused daemon got what they asked for. A red flash on
  // a correct state teaches them to distrust the control.
  for (const [line, action] of [
    ["daemon paused", "daemon-pause"],
    ["already paused", "daemon-pause"],
    ["daemon resumed", "daemon-resume"],
    ["not paused", "daemon-resume"],
  ] as const) {
    scripts(`printf '%s\\n' ${JSON.stringify(line)}\n`);
    const result = await runConductorControl(action, target());
    assert.equal(result.ok, true, line);
  }
  // A sentence about some other state is not a confirmation.
  scripts(`printf 'daemon is not running\\n'\n`);
  assert.equal((await runConductorControl("daemon-pause", target())).ok, false);
});

test("park and unpark confirm for THIS feature, not for whichever one the engine mentioned", async () => {
  scripts(`printf "Parked 'fix-the-thing' - no dispatch until unparked\\n"\n`);
  const parked = await runConductorControl("park", target({ slug: "fix-the-thing" }));
  assert.equal(parked.ok, true);
  // A bare positional. There is no `--slug` on this verb, and passing one falls through to a
  // refusal that never mentions parking.
  assert.equal(invocations()[0], "daemon park fix-the-thing");

  // The same output, asked about a different feature. A predicate that matched the verb's
  // sentence without binding the slug would report a park that never happened.
  scripts(`printf "Parked 'other-thing' - no dispatch until unparked\\n"\n`);
  assert.equal((await runConductorControl("park", target({ slug: "fix-the-thing" }))).ok, false);

  scripts(`printf "'fix-the-thing' is already parked\\n"\n`);
  assert.equal((await runConductorControl("park", target({ slug: "fix-the-thing" }))).ok, true);

  scripts(`printf "Unparked 'fix-the-thing'\\n"\n`);
  assert.equal((await runConductorControl("unpark", target({ slug: "fix-the-thing" }))).ok, true);
  assert.equal(invocations()[0], "daemon unpark fix-the-thing");

  scripts(`printf "'fix-the-thing' was not operator-parked\\n"\n`);
  assert.equal((await runConductorControl("unpark", target({ slug: "fix-the-thing" }))).ok, true);
});

test("a grant is spawned as three flags and confirmed for the exact step", async () => {
  scripts(`printf "DECIDE grant recorded for 'prd' in 'fix-the-thing'.\\n"\n`);
  const granted = await runConductorControl(
    "grant",
    target({ slug: "fix-the-thing", step: "prd", reason: "the assumption changed" }),
  );
  assert.equal(granted.ok, true);
  assert.match(granted.detail, /may enter prd once/);
  // conductor's detector wants exactly these three flags, each once, each with a value.
  assert.equal(invocations()[0], "decide-grant --slug fix-the-thing --step prd --reason the assumption changed");

  // A grant recorded for a DIFFERENT step is not this grant.
  scripts(`printf "DECIDE grant recorded for 'plan' in 'fix-the-thing'.\\n"\n`);
  const wrong = await runConductorControl(
    "grant",
    target({ slug: "fix-the-thing", step: "prd", reason: "why" }),
  );
  assert.equal(wrong.ok, false);
});

test("a plan grant is refused here, before anything is spawned", async () => {
  // conductor refuses this in four independent places of its own, so nothing below is the
  // enforcement - it is the EXPLANATION, which a relayed exit code cannot give. The absence
  // of an invocation is the assertion: no subprocess ran to learn something already known.
  scripts(`printf "DECIDE grant recorded for 'plan' in 'fix-the-thing'.\\n"\n`);
  const refused = await runConductorControl(
    "grant",
    target({ slug: "fix-the-thing", step: "plan", reason: "I would like to re-plan" }),
  );
  assert.equal(refused.ok, false);
  assert.match(refused.detail, /never grants re-entry to 'plan'/);
  assert.equal(refused.output, "");
  assert.deepEqual(invocations(), [], "nothing was spawned");

  // A step that is not a DECIDE step at all is refused the same way.
  const notDecide = await runConductorControl(
    "grant",
    target({ slug: "fix-the-thing", step: "build", reason: "why" }),
  );
  assert.equal(notDecide.ok, false);
  assert.match(notDecide.detail, /not a DECIDE step/);
  assert.deepEqual(invocations(), []);
});

test("the console argv is what conductor's own CLI takes, and no more", () => {
  // Plain `daemon connect`, not `--attach-into <tmux target>`. That flag sends an attach into
  // a tmux pane that already exists; Mission Control hosts the terminal itself, so there is
  // no target to mint - and it is the only form that works on the emulator backends.
  assert.deepEqual(
    conductorConsoleArgv("daemon", { ...target(), paths: [], clearHalt: false }, WORKTREE),
    { argv: [fake, "daemon", "connect"] },
  );
  assert.deepEqual(
    conductorConsoleArgv(
      "reseal",
      {
        ...target({ slug: "fix-the-thing", reason: "the decision moved" }),
        paths: [".docs/decisions/a.md", ".docs/decisions/b.md"],
        clearHalt: true,
      },
      WORKTREE,
    ),
    {
      argv: [
        fake,
        "reseal",
        "--slug",
        "fix-the-thing",
        "--path",
        ".docs/decisions/a.md",
        "--path",
        ".docs/decisions/b.md",
        "--reason",
        "the decision moved",
        "--clear-halt",
      ],
    },
  );
  // One `--path` per artifact, repeated. A comma-joined list is one path with commas in it.
  assert.equal(
    reseal(["a", "b"]).filter((part) => part === "--path").length,
    2,
  );
  // And the verb table itself, for the two verbs whose shape is easiest to get wrong.
  assert.deepEqual(conductorControlArgv("park", target({ slug: "s" })), [fake, "daemon", "park", "s"]);
  assert.deepEqual(conductorControlArgv("daemon-start", target()), [fake, "daemon", "start", "-D"]);
});

test("a reseal path that leaves the feature's worktree is refused before argv is composed", () => {
  // The paths arrive in a request body and leave as arguments to a command that breaks a
  // cryptographic seal and can clear the halt that seal raised. Length-bounding them says
  // nothing about WHERE they point, and the engine will not check: from its side, an
  // operator typed them.
  const inside = ".docs/decisions/a.md";
  assert.deepEqual(pathsIn(reseal([inside])), [inside]);

  // Traversal, in the two spellings that reach a different feature's artifacts.
  assert.match(
    String(resealRefusal(["../other-feature/.docs/decisions/a.md"])),
    /points outside this feature's worktree/,
  );
  assert.match(String(resealRefusal(["a/../../b.md"])), /points outside/);
  // An absolute path is refused rather than rebased: the caller meant a different root, and
  // silently reinterpreting it would re-seal a file nobody named.
  assert.match(String(resealRefusal([join(REPO, "sealed.md")])), /absolute path/);
  assert.match(String(resealRefusal(["/etc/passwd"])), /absolute path/);
  assert.equal(resealRefusal(["   "]), "an artifact path cannot be blank");

  // The one a string comparison misses. `linked` is a symlink out of the worktree, so a path
  // under it carries no `..`, is not absolute, and still lands somewhere else on disk.
  const escapee = join(WORKTREE, "linked");
  mkdirSync(join(REPO, "outside"), { recursive: true });
  if (!existsSync(escapee)) symlinkSync(join(REPO, "outside"), escapee);
  assert.match(String(resealRefusal(["linked/a.md"])), /points outside/);

  // A file that does not exist is still resealable - deletion is one of the ways a seal
  // breaks - as long as the directory that would hold it is inside.
  assert.deepEqual(pathsIn(reseal([".docs/decisions/never-written.md"])), [
    ".docs/decisions/never-written.md",
  ]);

  // What reaches argv is the form this check verified, not the string that arrived: the two
  // can name one file, and passing the original through would leave the command carrying a
  // spelling nothing validated.
  assert.deepEqual(pathsIn(reseal(["./.docs/decisions/../decisions/a.md"])), [
    ".docs/decisions/a.md",
  ]);
});
