import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentType, Task } from "../src/shared/types.ts";
import type { RequiredSkillCommand } from "../src/server/skills/invoke.ts";
import type { CreateTaskInput, TaskManager } from "../src/server/tasks.ts";
import { runRetro, type RetroDeps } from "../src/server/retro.ts";
import { mkSession } from "./helpers/session-fixture.ts";

// Which harness a DISPATCHED retro is filed against, and what happens when none of them can run
// it. The route test proves the two arms over HTTP; this proves the selection underneath, which
// needs harnesses a real machine may not have installed.

function deps(over: Partial<RetroDeps> = {}): RetroDeps & { filed: CreateTaskInput[] } {
  const filed: CreateTaskInput[] = [];
  return {
    filed,
    tasks: {
      create(input: CreateTaskInput): Task {
        filed.push(input);
        return { id: `task-${filed.length}`, ...input } as unknown as Task;
      },
    } as unknown as TaskManager,
    promptBlocker: () => null,
    resolveRepoRoot: async () => ({ ok: true as const, repoRoot: "/repo" }),
    skillForAgent: () => ({ ok: true as const, command: "/retro" }),
    ...over,
  };
}

/** A session nothing can be typed into - the fallback's ordinary input. */
function dead(agent: AgentType) {
  return mkSession({
    agent,
    runtime: "terminal",
    terminals: [],
    cwd: "/repo/wt",
    repoRoot: "/repo",
    gitBranch: "feature/x",
  });
}

/**
 * Every shipped harness declares a skills directory - Pi included, which is easy to get wrong
 * because Pi is the one that loads no repository FILES. So the selection asks whether a
 * harness can actually invoke the skill, and the session's own is asked first and once.
 */
test("the session's own harness is asked first, and asked about the right skill", async () => {
  const asked: Array<[AgentType, string]> = [];
  const d = deps({
    skillForAgent: (agent, id): RequiredSkillCommand => {
      asked.push([agent, id]);
      return { ok: true, command: "/retro" };
    },
  });
  const result = await runRetro(dead("pi"), d);

  assert.equal(result.kind, "dispatched");
  assert.deepEqual(asked, [["pi", "retro"]], "the shipped action's own required skill, once");
  assert.equal(d.filed[0]!.agent, "pi");
});

test("a session's own harness is preferred when it can run the skill", async () => {
  const d = deps();
  const result = await runRetro(dead("claude"), d);

  assert.equal(result.kind, "dispatched");
  assert.equal(d.filed[0]!.agent, "claude");
  assert.equal(d.filed[0]!.backlog, true, "a retro never jumps the queue it was filed behind");
  assert.equal(d.filed[0]!.repoRoot, "/repo");
});

test("a harness that cannot run the skill hands the retro to one that can", async () => {
  const d = deps({
    skillForAgent: (agent): RequiredSkillCommand =>
      agent === "codex"
        ? { ok: false, message: "codex's link drifted" }
        : { ok: true, command: "/retro" },
  });
  const result = await runRetro(dead("codex"), d);

  assert.equal(result.kind, "dispatched");
  assert.equal(d.filed[0]!.agent, "claude");
});

/**
 * The Inspector's finding, pinned: the dispatch arm types nothing, so it looks like it has
 * nothing to gate - but the skill is where the human-approval ceremony lives, and a task filed
 * without it names a procedure the agent it reaches cannot load.
 */
test("no harness can run the skill, so nothing is filed at all", async () => {
  const d = deps({
    skillForAgent: (): RequiredSkillCommand => ({
      ok: false,
      message: "Enable Skills and the retro skill before sending this instruction.",
    }),
  });
  const result = await runRetro(dead("claude"), d);

  assert.equal(result.kind, "refused");
  if (result.kind !== "refused") return;
  assert.equal(result.status, 409);
  assert.match(result.error, /Enable Skills and the retro skill/);
  assert.match(result.error, /cannot load the procedure/);
  assert.equal(d.filed.length, 0, "a retro with no procedure is not a retro");
});

/** Every candidate is tried before giving up, so one drifted link does not sink the retro. */
test("a refusal is reported only after every harness has been asked", async () => {
  const asked: AgentType[] = [];
  const d = deps({
    skillForAgent: (agent): RequiredSkillCommand => {
      asked.push(agent);
      return { ok: false, message: `${agent} link drifted` };
    },
  });
  const result = await runRetro(dead("claude"), d);

  assert.equal(result.kind, "refused");
  assert.deepEqual(asked, ["claude", "codex", "pi"], "the session's own harness first");
  assert.equal(d.filed.length, 0);
});

test("the repository is resolved to a main checkout, and a refusal files nothing", async () => {
  const d = deps({
    resolveRepoRoot: async () => ({ ok: false as const, error: "not a git repository: /repo/wt" }),
  });
  const result = await runRetro(dead("claude"), d);

  assert.equal(result.kind, "refused");
  if (result.kind !== "refused") return;
  assert.equal(result.status, 409);
  assert.match(result.error, /not a git repository/);
  assert.equal(d.filed.length, 0);
});
