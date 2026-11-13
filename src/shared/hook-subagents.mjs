// What a hook bridge lifts off a payload about background sub-agents, bounded before it
// leaves the agent's machine-local process.
//
// `.mjs`, importing nothing, for the reason `hook-bridge.mjs` gives: the installed hook command
// is `node <path> <event>` with no bundler in a developer's checkout. `HookIngestSchema`
// (`protocol.ts`) imports the bounds below, so the bridge and the daemon cannot disagree about
// how long a field may be - a bridge that sent a field the schema refused would cost the
// parent's own state update, not just the sub-agent row.
//
// Field names on the left of every read are Claude Code's hook schema (`agent_type`,
// `tool_input.subagent_type`, `tool_response.status` / `agentId`, `background_tasks`). Codex
// sends `agent_id` / `agent_type` under the same names and nothing else here.

/** The longest text any sub-agent field carries on the wire. */
export const HOOK_SUBAGENT_TEXT_MAX = 200;

/** The most in-flight background tasks one hook forwards. */
export const HOOK_BACKGROUND_TASKS_MAX = 50;

/** The tool names Claude Code has used for launching a sub-agent. */
const AGENT_TOOLS = new Set(["Agent", "Task"]);

/** A non-empty string clipped to the wire bound, else undefined so it drops out of the JSON. */
export function hookText(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > HOOK_SUBAGENT_TEXT_MAX ? `${trimmed.slice(0, HOOK_SUBAGENT_TEXT_MAX - 1)}…` : trimmed;
}

const record = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : null);

/**
 * The Agent tool call this `PostToolUse` reports, reduced to what places a sub-agent: who it is,
 * what it was asked to do, and whether it went to the background (`async_launched`). Undefined
 * for every other event and tool, which is nearly every hook.
 *
 * Never the prompt and never the result text: only the short description the model wrote for
 * the launch, which is what a board row shows.
 */
export function agentToolDescriptor(payload, event) {
  if (event !== "PostToolUse" || !AGENT_TOOLS.has(payload?.tool_name)) return undefined;
  const input = record(payload.tool_input) ?? {};
  const response = record(payload.tool_response) ?? {};
  const descriptor = {
    agentId: hookText(response.agentId),
    status: hookText(response.status),
    subagentType: hookText(input.subagent_type),
    description: hookText(input.description) ?? hookText(response.description),
  };
  return Object.values(descriptor).some((v) => v !== undefined) ? descriptor : undefined;
}

/** Every well-formed `background_tasks` entry, unbounded; undefined when the payload has no list. */
function backgroundTaskEntries(payload) {
  if (!Array.isArray(payload?.background_tasks)) return undefined;
  const tasks = [];
  for (const raw of payload.background_tasks) {
    const task = record(raw);
    const id = hookText(task?.id);
    if (!task || !id) continue;
    tasks.push({
      id,
      type: hookText(task.type),
      description: hookText(task.description),
      agentType: hookText(task.agent_type),
    });
  }
  return tasks;
}

/**
 * Claude's `background_tasks` - the session's in-flight background work at this event - bounded.
 *
 * Undefined when the payload has no such list (most events, and every Claude Code that predates
 * it), and an EMPTY array when it has one with nothing in it: "nothing is running" is a reading
 * the daemon acts on, while "this event does not say" leaves what it knew alone.
 *
 * Past the bound the list is cut, and a cut list is no longer the whole in-flight set: an agent
 * past the cut is still running. `backgroundTasksTruncated` says so on the wire, so the daemon
 * reads the list as additions only and stops nothing on its account.
 */
export function backgroundTaskList(payload) {
  return backgroundTaskEntries(payload)?.slice(0, HOOK_BACKGROUND_TASKS_MAX);
}

/** True when `backgroundTaskList` had to cut the list; undefined otherwise, so it drops off the wire. */
export function backgroundTasksTruncated(payload) {
  const all = backgroundTaskEntries(payload);
  return all && all.length > HOOK_BACKGROUND_TASKS_MAX ? true : undefined;
}
