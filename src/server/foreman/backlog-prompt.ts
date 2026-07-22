import type { Task } from "@shared/types.ts";

// The backlog planner's prompt, handed to a fresh tool-less `claude -p`. Unlike the
// reviewer, which judges one session's transcript, this reads a LIST OF INTENTS a human
// typed and answers one question about it: which of these have to happen before which
// others, and in what order should they be picked up.
//
// It is asked for a graph, not a schedule. Capacity, the repo allowlist and Foreman's
// mode are decided in code (backlog-machine.ts) where they can be tested as a table;
// the model has no business knowing how many agents are free, and a prompt that told it
// would invite it to make the ceiling's decision badly.

/** How much of one task's intent the prompt carries. Enough to see the shape of the work. */
const INTENT_CAP = 1200;

const PLANNER = `You are the BACKLOG PLANNER for "Mission Control", a dashboard that runs a fleet of AI
coding agents. Below is a backlog of tasks a human has queued but not started. Each will be given to
its own coding agent, working in its own git worktree, POSSIBLY AT THE SAME TIME AS THE OTHERS.

Your ONLY job is to say which tasks must WAIT for which other tasks, and in what order they should be
picked up. You are not writing any code and not solving any of these tasks.

Respond with ONLY a single JSON object - no prose, no markdown fences - of this shape:
{
  "tasks": [                    // EVERY task listed below, in the order they should be picked up
    {
      "id": string,             // the task's id, copied exactly from the list
      "dependsOn": [string],    // ids of tasks that must FINISH before this one starts ([] is the norm)
      "reason": string          // one short line: what this touches, or what it is waiting for
    }
  ],
  "note": string                // one line on how you read this backlog overall
}

WHEN ONE TASK DEPENDS ON ANOTHER - only these:
- It builds directly on something the other task creates (a schema, a route, a component, a config
  key that does not exist yet).
- Both would edit the SAME files in ways that would conflict, and one is clearly the foundation.
- One explicitly says it comes after the other ("once X lands...", "follow-up to X").

WHEN IT DOES NOT:
- They merely touch the same area, project, or language. Agents work in separate worktrees and
  separate branches; touching the same repo is not a conflict.
- One is "more important". Priority is ORDER, not a dependency - put it earlier in the array.
- You are not sure. Say nothing. A wrong dependency stalls real work indefinitely and no one is
  watching for it; a missing one costs at worst a merge conflict a human resolves.

ORDERING (the array order):
- Unblocked, foundational work first - the tasks other tasks are waiting on.
- Then unblocked work, roughly by how much else it unblocks.
- Blocked tasks after the things they wait for.

RULES:
- Include EVERY task from the list exactly once. Omitting one is a malformed reply.
- Use ids EXACTLY as given. Never invent an id, and never make a task depend on itself.
- A task's "operator dependencies" are fixed facts. Preserve their direction and NEVER add a
  reverse dependency that would form a cycle with one.
- NEVER create a cycle: if A waits for B, B must not wait for A, directly or through others.
- "dependsOn" defaults to []. Most real backlogs are mostly independent - a reply where everything
  depends on something is almost certainly wrong.`;

/** Assemble the planner prompt for one backlog. */
export function buildBacklogPrompt(tasks: Task[]): string {
  const lines: string[] = [PLANNER, "", "## The backlog", ""];
  for (const t of tasks) {
    lines.push(`### id: ${t.id}`);
    lines.push(`title: ${t.title}`);
    lines.push(`kind: ${t.kind} (${t.kind === "ship" ? "deliver a change" : "investigate and report"})`);
    lines.push(`repo: ${t.repoRoot}`);
    const declared = t.dependencies.filter((dependency) => dependency.satisfiedAt === null);
    if (declared.length > 0) {
      lines.push(
        `operator dependencies: ${declared
          .map((dependency) => dependency.type === "task" ? dependency.taskId : dependency.title)
          .join(", ")}`,
      );
    }
    lines.push("intent:");
    // Fenced, because the intent is text a human typed and may itself contain anything -
    // including something that reads like an instruction to this model. The fence plus
    // the tool-less run is what keeps a task description from steering the planner.
    lines.push("```");
    lines.push(capped(t.intent));
    lines.push("```");
    lines.push("");
  }
  lines.push(
    `Return the JSON object now, with exactly ${tasks.length} entr${tasks.length === 1 ? "y" : "ies"} in "tasks".`,
  );
  return lines.join("\n");
}

function capped(s: string): string {
  const t = s.trim();
  return t.length > INTENT_CAP ? `${t.slice(0, INTENT_CAP)}\n…(truncated)` : t;
}
