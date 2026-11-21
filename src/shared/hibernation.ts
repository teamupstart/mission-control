/**
 * Hibernating a task (issue #1547): stop its agent's process to free its memory, keep the
 * task, conversation, worktree and blocker, and reopen the same conversation on Resume.
 *
 * Browser-safe and shared because the daemon refuses with these sentences and the dashboard
 * disables its control with the same ones, so a click is never offered that the route would
 * reject, and both read a hibernated task's record the same way.
 *
 * BOTH RUNTIMES, TWO MECHANISMS. An Agent SDK session's process is the daemon's own child, and
 * the daemon already reopens one under the SAME session id on every restart (`SdkSupervisor`'s
 * restore), so hibernation is that restart for one session on the operator's word. A terminal
 * session is stopped the way Kill stops it, and Resume reopens its conversation through the
 * managed terminal resume (`prepareTerminalResume`) in a new terminal home: a new process with a
 * new session id, which the task and any armed workflow binding then follow.
 */
import { z } from "zod";
import { AGENT_IDENTITY } from "./agent.ts";
import type { FeatureFlagId } from "./feature-flags.ts";
import { capabilitiesFor } from "./harness-capabilities.ts";
import { questionsAwaitingOperator } from "./async-input.ts";
import { taskKindLaunchesHarness } from "./task.ts";
import {
  PERMISSION_MODES,
  SESSION_BLOCKER_KINDS,
  SESSION_RUNTIMES,
  type PermissionMode,
  type Session,
  type Task,
} from "./types.ts";

/** The preview flag that gates the Hibernate action. Resume is never gated: see the docs. */
export const TASK_HIBERNATION_FLAG: FeatureFlagId = "task-hibernation";

/** The blocker a task carried when it was hibernated, for the Backlog card to say. */
export const TaskHibernationBlockerSchema = z.object({
  kind: z.enum(SESSION_BLOCKER_KINDS),
  reason: z.string(),
  waitingOn: z.string(),
  startedAt: z.number().int().nonnegative(),
});

/**
 * A terminal Resume's launch that could not be closed after it failed: its agent may still be
 * running. Recorded so the next Resume closes it (or finds it gone) BEFORE launching another
 * process onto the same conversation and worktree, and refuses while it cannot.
 *
 * The home is null when the launcher failed without saying which home it opened, yet a guard
 * had already claimed the lease. There is then nothing safe to close - a guessed name could be
 * another task's terminal - so the next Resume refuses until the lease says the agent ended.
 */
export const TaskHibernationLaunchSchema = z.object({
  homeName: z.string().min(1).nullable(),
  homeBackend: z.string().min(1).nullable(),
  terminalResourceId: z.string().nullable(),
  /** The managed resume lease that launch ran under, which says whether it is still live. */
  leaseRoot: z.string().min(1),
  leaseId: z.string().min(1),
});

/**
 * The checkout the conversation ran in: its path, and the directory's device and inode when it
 * was hibernated, so Resume can tell the same worktree from another one created at that path.
 */
export const TaskHibernationCheckoutSchema = z.object({
  path: z.string().min(1),
  dev: z.string().min(1),
  ino: z.string().min(1),
});
export type TaskHibernationCheckout = z.infer<typeof TaskHibernationCheckoutSchema>;

/** Why the last Resume did not reopen the conversation. Cleared by the next attempt. */
export const TaskHibernationFailureSchema = z.object({
  reason: z.string().min(1),
  at: z.number().int().nonnegative(),
  launch: TaskHibernationLaunchSchema.nullable().default(null),
});
export type TaskHibernationLaunch = z.infer<typeof TaskHibernationLaunchSchema>;

/**
 * The persisted record, in `tasks.hibernation` as JSON, present exactly while the task is
 * `hibernated`.
 *
 * `sessionId` is the session that was stopped. For `runtime: "sdk"` it is also the one that
 * resumes: its `sdk_sessions` row is kept, status `hibernated`, and Resume relaunches it under
 * that same id. For `runtime: "terminal"` Resume starts a new process, and this id is what the
 * task's workflow binding still names until the new session takes it over.
 * `agentSessionId` is the conversation Resume reopens, `checkout` the directory it ran in
 * (which Resume verifies is still the same one before starting anything), `permissionMode` the
 * mode a terminal resume starts in, and `noteKey` what the blocker and notes are keyed on, so the
 * blocker is kept alive while nobody holds it (`Registry.pruneBlockers`).
 *
 * `runtime` defaults to `sdk` and `permissionMode` to null, the shape before terminal sessions
 * could hibernate. `permissionMode` is a plain string: a mode a newer build wrote is not a
 * reason to lose the record, and the resume reads it back through `PERMISSION_MODES`.
 */
export const TaskHibernationSchema = z.object({
  sessionId: z.string().min(1),
  runtime: z.enum(SESSION_RUNTIMES).default("sdk"),
  agentSessionId: z.string().min(1),
  noteKey: z.string().min(1),
  permissionMode: z.string().nullable().default(null),
  /** Where Resume reopens it, verified first. Null only on a record that predates it. */
  checkout: TaskHibernationCheckoutSchema.nullable().default(null),
  hibernatedAt: z.number().int().nonnegative(),
  blocker: TaskHibernationBlockerSchema.nullable(),
  failure: TaskHibernationFailureSchema.nullable(),
});
export type TaskHibernation = z.infer<typeof TaskHibernationSchema>;
export type TaskHibernationBlocker = z.infer<typeof TaskHibernationBlockerSchema>;

/** A persisted value read back, or null when it is absent or unreadable. */
export function parseTaskHibernation(raw: string | null | undefined): TaskHibernation | null {
  if (!raw) return null;
  try {
    const parsed = TaskHibernationSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The session fields `hibernateRefusal` reads. */
export type HibernationCandidate = Pick<
  Session,
  "agent" | "runtime" | "state" | "agentSessionId" | "pendingReviews" | "openQuestions" | "pendingTurns" | "task"
>;

/** A persisted permission mode read back, or null when this build does not know it. */
export function hibernationPermissionMode(record: Pick<TaskHibernation, "permissionMode">): PermissionMode | null {
  const mode = record.permissionMode;
  return mode !== null && (PERMISSION_MODES as readonly string[]).includes(mode) ? (mode as PermissionMode) : null;
}

/**
 * Why Hibernate is refused while a workflow run is open on the session. A run is a JOIN the
 * session itself does not carry (see `heldSessionIds` in the web), so `hibernateRefusal` cannot
 * see it: the route answers with this, and the Pause menu shows it before anyone clicks.
 */
export const HIBERNATE_OPEN_RUN_REFUSAL = "A workflow run is in progress for it. Let the run finish first.";

/**
 * Why this session cannot be hibernated right now, or null when it can.
 *
 * Every refusal names what to do instead, because the dashboard shows it on a disabled menu
 * row and the route answers with it. Only an idle session is taken: one mid-turn, starting, or
 * waiting on an answer would lose the work in flight, and the issue's promise is that nothing
 * is lost.
 */
export function hibernateRefusal(session: HibernationCandidate): string | null {
  const capabilities = capabilitiesFor(session.agent);
  // A terminal agent is always a process of its own. An embedded one is only when its harness's
  // driver is (`sdkDriverStoppable`); Pi's runs inside the daemon, so there is nothing to free.
  if (session.runtime === "sdk" && !capabilities?.sdkDriverStoppable) {
    return `${AGENT_IDENTITY[session.agent].label} runs inside Mission Control, so stopping it would free no memory.`;
  }
  if (!capabilities?.resumes) return `${AGENT_IDENTITY[session.agent].label} cannot reopen a conversation.`;
  const task = session.task;
  if (!task) return "Only a task's session can be hibernated.";
  if (task.status !== "running") return "Its task is not running.";
  // Only a kind whose harness Mission Control launches itself: a Pipeline's provider and a
  // resident's profile own their launches, so neither could be reopened by Resume.
  if (!taskKindLaunchesHarness(task.kind)) {
    return `A ${task.kind} task keeps its own lifecycle and cannot be hibernated.`;
  }
  if (task.ensemble) return "An ensemble member cannot be hibernated.";
  switch (session.state) {
    case "exited":
    case "stopping":
      return "This session is already ending.";
    case "starting":
      return "Wait until it has started.";
    case "working":
      return "It is in the middle of a turn. Wait for the turn to end, or pause it.";
    case "awaiting_input":
    case "awaiting_review":
      return "It is waiting for an answer. Answer it first.";
    case "idle":
      break;
  }
  if (!session.agentSessionId) {
    return "Mission Control has not seen this conversation's id yet, so it could not reopen it.";
  }
  // A question filed without stopping (`async-input`) counts too: hibernating would evict the
  // session and orphan it, so its answer would never reach the resumed conversation.
  if (questionsAwaitingOperator(session) > 0) return "It has a question waiting for you. Answer it first.";
  if (session.pendingTurns.length > 0) return "Messages are still waiting to be delivered to it.";
  return null;
}

/** The hibernated tasks, longest asleep last: the order the Backlog's section draws them in. */
export function hibernatedTasks(tasks: readonly Task[]): Task[] {
  return tasks
    .filter((task) => task.status === "hibernated")
    .sort((a, b) => (b.hibernation?.hibernatedAt ?? b.updatedAt) - (a.hibernation?.hibernatedAt ?? a.updatedAt));
}

/**
 * Whether a hibernated task holds this conversation of this stopped session: the session id it
 * was hibernated from AND its conversation's note key. Resume reopens only that conversation, so
 * anything else the session held is not waiting for it.
 */
export function hibernationHoldsConversation(tasks: Iterable<Task>, sessionId: string | null, noteKey: string): boolean {
  if (!sessionId) return false;
  for (const task of tasks) {
    const held = task.status === "hibernated" ? task.hibernation : null;
    if (held?.sessionId === sessionId && held.noteKey === noteKey) return true;
  }
  return false;
}
