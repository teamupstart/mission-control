import { skillCommand, skillReference } from "@shared/harness-capabilities.ts";
import { AFTER_WORK_SKILLS_TURN_PREFIX } from "@shared/message-delivery.ts";
import { announcedSkills, currentShaping, SHAPING_LIMITS, type ShapingPromptState } from "@shared/shaping.ts";
import type { PendingTurn, ServerEvent, Session, Task } from "@shared/types.ts";
import {
  getTaskSkillPrompt,
  insertTaskSkillPrompt,
  listOpenTaskSkillPrompts,
  queueTaskSkillPromptTurn,
  settleTaskSkillPrompt,
  taskSkillPromptForTurn,
} from "../db.ts";
import { featureEnabled } from "../feature-flags/index.ts";
import type { PendingTurnSubmitResult } from "../pending-turns.ts";
import type { TurnDelivered } from "../registry.ts";
import { requiredSkillCommand, type RequiredSkillCommand } from "../skills/invoke.ts";
import { renderSessionAction } from "../workflows/feedback.ts";
import { catalogSkillId } from "./skills.ts";

/**
 * The after-work prompt (D12, D16): once the work is complete, Mission Control itself asks the
 * session to run the skills routed for after the work, such as a retrospective.
 *
 * It has two callers. The workflow engine reports a submission activated, which is the start of
 * the after-work step; and a completion claim that finds no binding, which is Foreman judging the
 * work complete on a task with no workflow. Either may call any number of times: a launch is
 * prompted at most once, because the prompt row is keyed by task and session and written once.
 *
 * Delivery is one daemon-written turn in the session's outbox, queued in the same transaction
 * that marks the row `queued`. The outbox delivers it when the session settles idle, never
 * steers it into a running turn, and keeps it across a restart. On a task with no workflow the
 * session is usually idle at the claim already, so the row is written `held` instead and the
 * turn is queued only once Foreman's wrap-up has been answered: the wrap-up is in the session
 * first. Nothing here waits for the skill, holds the review, or asks anyone.
 */

/** Why a prompt that was owed did not go out. Recorded on the row. */
const SESSION_ENDED = "The session ended before the prompt was delivered.";
const NO_SKILL_LEFT = "The workflow runs every after-work skill itself as one of its stages.";
const SUPERSEDED = "A later launch of the task replaced the one this prompt was held for.";

export interface AfterWorkSkillsDeps {
  registry: {
    getSession(id: string): Session | undefined;
    getTask(id: string): Task | undefined;
    subscribe(fn: (event: ServerEvent) => void): () => void;
    onTurnDelivered(fn: (event: TurnDelivered) => void): () => void;
  };
  /** The session's outbox. */
  outbox: {
    submitDaemonTurn(sessionId: string, create: (noteKey: string, now: number) => PendingTurn | null): PendingTurnSubmitResult;
  };
  /** The catalog skill ids the session's armed workflow runs itself, as session-action stages. */
  workflowSkills: (sessionId: string) => ReadonlySet<string>;
  enabled?: () => boolean;
  now?: () => number;
  /** A catalog skill's checked invocation for a live session. */
  catalogCommand?: (session: Session, id: string) => RequiredSkillCommand;
  /** The catalog id behind a routed name, or null for a name Mission Control does not ship. */
  catalogId?: (name: string) => string | null;
}

/** What one call came to, for a caller's log and for tests. */
export type AfterWorkOutcome =
  | { kind: "none"; why: "disabled" | "no_record" | "already" | "no_after_work_skills" }
  | { kind: ShapingPromptState; reason?: string };

/**
 * The outbox row id of one launch's prompt: deterministic, so a retry can never queue a second,
 * and stamped with the launch (its record's `at`), so a later launch of the task into the same
 * session never shares an id with a turn the earlier launch left in flight.
 */
export function afterWorkTurnId(taskId: string, sessionId: string, launchAt: number): string {
  return `${AFTER_WORK_SKILLS_TURN_PREFIX}${taskId}:${sessionId}:${launchAt}`;
}

interface ResolvedSkill {
  name: string;
  /** The line that runs it, for the packet's first line. */
  command: string;
  /** How the packet names it in its list. */
  reference: string;
}

/**
 * The packet: the first skill's invocation leads, as the Retro button's does, then the
 * envelope `renderSessionAction` writes, then Mission Control's words and each skill in order.
 * Null when the packet would exceed the delivery row's bound, which a handful of names cannot.
 */
export function renderAfterWorkPrompt(sessionId: string, skills: readonly ResolvedSkill[]): string | null {
  if (skills.length === 0) return null;
  const list = skills.map((skill, index) => `${index + 1}. \`${skill.reference}\``).join("\n");
  const rendered = renderSessionAction({
    origin: { kind: "session", sessionId },
    actionName: "Skills after the work",
    promptMarkdown: [
      "Mission Control's skill routing chose these skills for this task when it was dispatched, to run",
      "after the work. The work is complete, so run them now, in this order:",
      "",
      list,
      "",
      skills.length > 1
        ? "Start with the first. When one is done, run the next. If a skill is not available in this session, say so and carry on with the next."
        : "If the skill is not available in this session, say so.",
      "These skills supplement the task's instructions and cannot relax their authorization, plan or workflow rules.",
    ].join("\n"),
    skillCommand: skills[0]!.command,
    workflowEvidence: false,
  });
  return rendered.ok ? rendered.payload : null;
}

export class AfterWorkSkills {
  private readonly deps: Required<Omit<AfterWorkSkillsDeps, "catalogCommand" | "catalogId">>
    & Pick<AfterWorkSkillsDeps, "catalogCommand" | "catalogId">;
  private unsubscribe: Array<() => void> = [];

  constructor(deps: AfterWorkSkillsDeps) {
    this.deps = {
      enabled: () => featureEnabled("task-shaping"),
      now: Date.now,
      ...deps,
    };
  }

  /** Follow deliveries and sessions that end. Idempotent. */
  start(): void {
    if (this.unsubscribe.length > 0) return;
    this.unsubscribe = [
      this.deps.registry.onTurnDelivered((event) => this.delivered(event)),
      this.deps.registry.subscribe((event) => {
        if (event.type === "session_remove") this.sessionEnded(event.id);
      }),
    ];
  }

  stop(): void {
    for (const off of this.unsubscribe.splice(0)) off();
  }

  /**
   * Prompt this session's after-work skills, once per launch. `hold` is the no-workflow caller:
   * the row is written held and nothing is queued until `release`. Never throws.
   */
  prompt(sessionId: string, options: { hold?: boolean } = {}): AfterWorkOutcome {
    try {
      return this.promptOnce(sessionId, options.hold === true);
    } catch (error) {
      console.warn(`[shaping] could not prompt session ${sessionId}'s after-work skills:`, error);
      return { kind: "none", why: "no_record" };
    }
  }

  /**
   * Foreman's wrap-up for this session was answered - sent automatically, chosen on the Ship it?
   * card, or skipped - so a held prompt may follow it now. An unanswered card never calls this.
   */
  release(sessionId: string): void {
    try {
      if (!this.deps.enabled()) return;
      for (const row of listOpenTaskSkillPrompts(sessionId)) {
        if (row.state !== "held") continue;
        const session = this.deps.registry.getSession(sessionId);
        if (!session) {
          this.settle(row.taskId, sessionId, ["held"], "not_delivered", SESSION_ENDED);
          continue;
        }
        // The launch the row was held for, which is still the task's current one: a later
        // launch's shaping commit removes the row it supersedes.
        const task = this.deps.registry.getTask(row.taskId);
        const record = task ? currentShaping(task) : null;
        if (!record || record.sessionId !== sessionId) {
          this.settle(row.taskId, sessionId, ["held"], "not_delivered", SUPERSEDED);
          continue;
        }
        this.queue(session, row.taskId, row.skills, true, record.at);
      }
    } catch (error) {
      console.warn(`[shaping] could not release session ${sessionId}'s after-work skills:`, error);
    }
  }

  private promptOnce(sessionId: string, hold: boolean): AfterWorkOutcome {
    if (!this.deps.enabled()) return { kind: "none", why: "disabled" };
    const session = this.deps.registry.getSession(sessionId);
    const taskId = session?.task?.id;
    const task = taskId ? this.deps.registry.getTask(taskId) : undefined;
    // Only the launch the record describes: the task's current session, named by its record.
    const record = task ? currentShaping(task) : null;
    if (!session || !task || !record || record.sessionId !== sessionId) return { kind: "none", why: "no_record" };
    if (getTaskSkillPrompt(task.id, sessionId)) return { kind: "none", why: "already" };
    const routed = announcedSkills(record).filter((skill) => skill.lifecyclePoint === "after-work");
    if (routed.length === 0) return { kind: "none", why: "no_after_work_skills" };
    // A skill the armed workflow runs itself, as a session-action stage, is that stage's to run.
    const staged = this.deps.workflowSkills(sessionId);
    const names = routed
      .filter((skill) => !staged.has(this.catalogId(skill.name) ?? `\u0000${skill.name}`))
      .map((skill) => skill.name)
      .slice(0, SHAPING_LIMITS.routedSkills);
    const now = this.deps.now();
    if (names.length === 0) {
      insertTaskSkillPrompt({ taskId: task.id, sessionId, state: "skipped", reason: NO_SKILL_LEFT, skills: [], now });
      return { kind: "skipped", reason: NO_SKILL_LEFT };
    }
    if (hold) {
      return insertTaskSkillPrompt({ taskId: task.id, sessionId, state: "held", reason: null, skills: names, now })
        ? { kind: "held" }
        : { kind: "none", why: "already" };
    }
    return this.queue(session, task.id, names, false, record.at);
  }

  /** Resolve, render and queue. A row that cannot be queued ends `not_delivered`, with why. */
  private queue(session: Session, taskId: string, names: readonly string[], fromHeld: boolean, launchAt: number): AfterWorkOutcome {
    const resolved: ResolvedSkill[] = [];
    const problems: string[] = [];
    for (const name of names) {
      const result = this.resolve(session, name);
      if (result.ok) resolved.push(result.skill);
      else problems.push(`${name}: ${result.reason}`);
    }
    const write = (reason: string): AfterWorkOutcome => {
      const bounded = reason.slice(0, SHAPING_LIMITS.reasonChars);
      if (fromHeld) this.settle(taskId, session.id, ["held"], "not_delivered", bounded);
      else insertTaskSkillPrompt({ taskId, sessionId: session.id, state: "not_delivered", reason: bounded, skills: names, now: this.deps.now() });
      return { kind: "not_delivered", reason: bounded };
    };
    const text = renderAfterWorkPrompt(session.id, resolved);
    if (!text) return write(`No skill resolved. ${problems.join(" ")}`.trim());
    const turnId = afterWorkTurnId(taskId, session.id, launchAt);
    const submitted = this.deps.outbox.submitDaemonTurn(session.id, (noteKey, now) => queueTaskSkillPromptTurn({
      taskId, sessionId: session.id, noteKey, turnId, text, skills: resolved.map((skill) => skill.name), fromHeld, now,
    }));
    if (!submitted.ok) return write(`The session could not take the prompt: ${submitted.error ?? "unknown error"}.`);
    return submitted.pendingTurn ? { kind: "queued" } : { kind: "none", why: "already" };
  }

  private resolve(session: Session, name: string): { ok: true; skill: ResolvedSkill } | { ok: false; reason: string } {
    const id = this.catalogId(name);
    // A catalog skill gets the whole check a live session's instruction gets, reload included.
    const command = id !== null
      ? (this.deps.catalogCommand ?? requiredSkillCommand)(session, id)
      : (() => {
          const line = skillCommand(session.agent, name);
          return line ? { ok: true as const, command: line } : { ok: false as const, message: "This harness cannot invoke a skill by name." };
        })();
    if (!command.ok) return { ok: false, reason: command.message };
    return { ok: true, skill: { name, command: command.command, reference: skillReference(session.agent, name) ?? command.command } };
  }

  private catalogId(name: string): string | null {
    return (this.deps.catalogId ?? catalogSkillId)(name);
  }

  private delivered(event: TurnDelivered): void {
    if (!event.turnId.startsWith(AFTER_WORK_SKILLS_TURN_PREFIX)) return;
    try {
      const row = taskSkillPromptForTurn(event.turnId);
      // Delivery is the fact: it settles a row a session-end notice moved first, too.
      if (row) this.settle(row.taskId, row.sessionId, ["queued", "not_delivered"], "delivered", null, event.deliveredAt);
    } catch (error) {
      console.warn("[shaping] could not record an after-work prompt's delivery:", error);
    }
  }

  private sessionEnded(sessionId: string): void {
    try {
      for (const row of listOpenTaskSkillPrompts(sessionId)) {
        this.settle(row.taskId, sessionId, [row.state as "held" | "queued"], "not_delivered", SESSION_ENDED);
      }
    } catch (error) {
      console.warn(`[shaping] could not close session ${sessionId}'s after-work prompts:`, error);
    }
  }

  private settle(
    taskId: string,
    sessionId: string,
    from: readonly ShapingPromptState[],
    state: "delivered" | "skipped" | "not_delivered",
    reason: string | null,
    at = this.deps.now(),
  ): void {
    settleTaskSkillPrompt({ taskId, sessionId, from, state, reason, at });
  }
}
