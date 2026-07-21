import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Drives the REAL create path against a fake `claude`: a real spawn, a real envelope, the
// real parse ladder, the real registry write. Everything is pinned before importing the
// modules that read it at load time.
const home = mkdtempSync(join(tmpdir(), "mission-title-"));
process.env.HARNESS_HOME = home;
process.env.MISSION_HOME = home;

// ONE fake bin whose behaviour is data, not code - `claude-cli.ts` resolves CLAUDE_BIN at
// module load, so a test cannot swap binaries afterwards (see goal-refiner.test.ts for the
// bug that taught us this). It also records every invocation, which is how the
// "an explicit title costs nothing" case below is proved rather than assumed.
const bin = mkdtempSync(join(tmpdir(), "fake-claude-"));
const modeFile = join(bin, "mode");
const callsFile = join(bin, "calls");
const fake = join(bin, "claude.sh");
writeFileSync(
  fake,
  `#!/bin/sh
cat > /dev/null
echo x >> ${callsFile}
# Printed as a %s ARGUMENT, never as the printf format: a format string processes escapes and
# POSIX leaves \\" undefined, so a formatted reply is valid JSON on one CI runner and garbage
# on the other. As an argument the payload reaches stdout byte for byte.
case "$(cat ${modeFile} 2>/dev/null)" in
  crash) echo "boom" >&2; exit 1 ;;
  # Well-formed JSON carrying nothing: the shape the schema must reject rather than stamp
  # onto the card, which would leave it blank.
  blank) printf %s '{"result":"{\\"title\\":\\"   \\"}"}' ;;
  # The model fences its JSON even when told not to (observed on a real probe), so the fake
  # does too - that keeps the parse ladder inside what this test covers rather than mocked.
  *) printf %s '{"result":"\`\`\`json\\n{\\"title\\":\\"Fix flaky worktree cleanup\\"}\\n\`\`\`"}' ;;
esac
`,
);
chmodSync(fake, 0o755);
const setMode = (m: "good" | "crash" | "blank"): void => writeFileSync(modeFile, m);
const callCount = (): number =>
  existsSync(callsFile) ? readFileSync(callsFile, "utf8").split("\n").filter(Boolean).length : 0;
setMode("good");

process.env.MISSION_CLAUDE_BIN = fake;
process.env.MISSION_TASK_TITLE_TIMEOUT_MS = "5000";

const { openDb } = await import("../src/server/db.ts");
const { Registry } = await import("../src/server/registry.ts");
const { TaskManager } = await import("../src/server/tasks.ts");

openDb();
after(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(bin, { recursive: true, force: true });
});

/** Poll until `fn` is true, or fail. Beats a fixed sleep: the titling is async by nature. */
async function until(fn: () => boolean, what: string, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`timed out waiting for: ${what}`);
}

/** Every case backlogs the task: titling is what's under test, not worktrees and tmux. */
function create(tasks: InstanceType<typeof TaskManager>, intent: string, title?: string) {
  return tasks.create({ repoRoot: "/repo", intent, title, kind: "ship", agent: "claude", backlog: true });
}

test("an untitled dispatch is named by the model, not by its first line", async () => {
  const tasks = new TaskManager(new Registry());
  const intent = "hey, can you take a look at the thing where Reset sometimes leaves a worktree behind?";
  const t = create(tasks, intent);

  // Returns immediately under the heuristic title - the card must appear now, not after a
  // subprocess - and that title is exactly the first-line-verbatim one we're replacing.
  assert.match(t.title, /^Hey, Can You Take/);

  await until(() => tasks.get(t.id)?.title === "Fix flaky worktree cleanup", "the model's title");
});

test("an explicit title is used verbatim and never spawns a model", async () => {
  const tasks = new TaskManager(new Registry());
  const before = callCount();
  const t = create(tasks, "some long rambling intent that would otherwise be summarized", "  My Title  ");
  assert.equal(t.title, "My Title");
  // Give a stray call time to land, so this asserts "never" rather than "not yet".
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(callCount(), before, "no headless run for an explicitly titled task");
  assert.equal(tasks.get(t.id)?.title, "My Title");
});

test("a crashing claude leaves the heuristic title standing", async () => {
  setMode("crash");
  const tasks = new TaskManager(new Registry());
  const before = callCount();
  const t = create(tasks, "fix the login bug\nmore detail here");
  assert.equal(t.title, "Fix the Login Bug");
  // A non-zero exit is NOT retried inside runStructured (only a parse miss is), so exactly
  // one run happens - the retry would just re-hit the same broken binary.
  await until(() => callCount() >= before + 1, "the run to fail");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(tasks.get(t.id)?.title, "Fix the Login Bug", "a failure must not blank the card");
});

test("a whitespace-only title is rejected rather than stamped onto the card", async () => {
  setMode("blank");
  const tasks = new TaskManager(new Registry());
  const before = callCount();
  const t = create(tasks, "add a dark mode toggle");
  await until(() => callCount() >= before + 2, "both attempts to be rejected");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(tasks.get(t.id)?.title, "Add a Dark Mode Toggle");
  // EXACTLY two, not "at least two": TITLE_TIMEOUT_MS is a per-attempt budget, so the
  // number of attempts is what sets the ceiling a dispatch can wait behind. A third
  // attempt would silently make that ceiling 3x its documented value.
  assert.equal(callCount(), before + 2, "a parse miss is retried exactly once");
});

test("the shipped per-attempt budget is above real model latency", () => {
  // MEASURED, not guessed - do not lower this without re-measuring. Against the real
  // `claude -p` (Haiku, tools off) a single call answered in 6908/7258/7422/7830/8459 ms.
  // Six untitled intents through the real `summariseTaskTitle` at an 8s budget produced
  // 2/6 model titles - the other four paid the full 8s and still fell back to the
  // first-line heuristic this feature exists to replace. The identical six at 15s
  // produced 6/6. 8s was tried, shipped, and reverted for exactly this reason.
  //
  // Nothing ABOVE this line can catch that class of bug: every other test in this file
  // drives a fake `claude` that answers instantly, so the budget is never the binding
  // constraint and any value at all would pass. Only a run against the real CLI
  // exercises the latency, hence a measurement pinned in a comment.
  //
  // Read from a CHILD process that never saw the override this file pins above. Read in-process
  // it would only prove the env var is wired, and would still pass if the shipped default
  // regressed - which is the regression it guards.
  const env = { ...process.env };
  delete env.MISSION_TASK_TITLE_TIMEOUT_MS;
  delete env.TASK_TITLE_TIMEOUT_MS;
  const out = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      // `String(...)`, not the number itself. `console.log` routes a non-string through
      // util.inspect, which colorizes whenever FORCE_COLOR is set - and it is, in any
      // terminal that exports it, because the child inherits the env we hand it. The
      // number then arrives wrapped in ANSI and `Number()` reads NaN, so this test failed
      // only on a developer's machine and passed on CI. A string is never inspected.
      'const m = await import("./src/server/task-title.ts"); console.log(String(m.TITLE_TIMEOUT_MS));',
    ],
    { cwd: fileURLToPath(new URL("..", import.meta.url)), env, encoding: "utf8" },
  );
  const shipped = Number(out.trim().split("\n").filter(Boolean).at(-1));
  assert.equal(shipped, 15000, "8s sat below measured model latency and lost 4 titles in 6");
});

test("dispatching while titling is in flight uses the model's title, not the heuristic one", async () => {
  setMode("good");
  const registry = new Registry();
  const tasks = new TaskManager(registry);

  // The title `Dispatcher.dispatch` reads - once, at the top - to cut the branch and name the
  // tmux session, captured at the moment TaskManager delegates to it. Standing in for the real
  // dispatch so the assertion is about that read and nothing else: a real one shells out to git
  // against a repo that does not exist, on a timeline this test cannot await and `after` can
  // outrun. The titling under test is untouched - real spawn, real parse ladder, real registry.
  let titleAtDispatch: string | undefined;
  const inner = tasks as unknown as { dispatcher: { dispatch(id: string): Promise<void> } };
  inner.dispatcher.dispatch = async (id) => {
    titleAtDispatch = registry.getTask(id)?.title;
  };

  const t = create(tasks, "hey, could you please look at the flaky worktree cleanup on Reset?");
  // The heuristic title is on the card right now, and the operator can click Dispatch on it
  // immediately - this is that click, landing inside the titling window.
  assert.match(t.title, /^Hey, Could You Please/);

  const dispatched = await tasks.dispatch(t.id);

  assert.equal(titleAtDispatch, "Fix flaky worktree cleanup", "the branch/tmux name is cut from this");
  assert.equal(dispatched?.title, "Fix flaky worktree cleanup");
});

test("dispatching a task removed during titling is refused rather than resurrecting it", async () => {
  setMode("good");
  const tasks = new TaskManager(new Registry());
  const t = create(tasks, "add a dark mode toggle to the settings pane");
  const gone = tasks.dispatch(t.id);
  await tasks.remove(t.id);
  assert.equal(await gone, null, "the post-wait re-read must see the removal");
});

test("a Foreman backlog launch pins its default only when the task has no model of its own", async () => {
  const registry = new Registry();
  const tasks = new TaskManager(registry);
  const inner = tasks as unknown as { dispatcher: { dispatch(id: string): Promise<void> } };
  inner.dispatcher.dispatch = async () => {};

  const unpinned = tasks.create({
    repoRoot: "/repo", intent: "do the first task", title: "First", kind: "ship", agent: "claude", backlog: true,
  });
  await tasks.dispatch(unpinned.id, { defaultModel: "claude-sonnet-5" });
  assert.equal(registry.getTask(unpinned.id)?.model, "claude-sonnet-5");

  const explicit = tasks.create({
    repoRoot: "/repo", intent: "do the second task", title: "Second", kind: "ship", agent: "claude",
    model: "claude-opus-4-8", backlog: true,
  });
  await tasks.dispatch(explicit.id, { defaultModel: "claude-haiku-4-5" });
  assert.equal(registry.getTask(explicit.id)?.model, "claude-opus-4-8");
});

test("a long model title is clamped at a word boundary, not rejected", async () => {
  const { TitleSchema } = await import("../src/server/task-title.ts");
  const long = "Fix the flaky worktree cleanup that Reset leaves behind whenever the lease expires";
  const r = TitleSchema.safeParse({ title: long });
  assert.ok(r.success);
  assert.ok(r.data.title.length <= 60);
  assert.ok(r.data.title.endsWith("…"));
  // Cut on a word, not mid-syllable.
  assert.ok(!/\S…$/.test(r.data.title.replace(/\s\S+…$/, "")));
});
