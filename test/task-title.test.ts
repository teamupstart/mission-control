import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
