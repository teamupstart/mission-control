import { skillCommand, skillReference } from "@shared/harness-capabilities.ts";
import { AFTER_WORK_SKILLS_TURN_PREFIX } from "@shared/message-delivery.ts";
import { announcedSkills, currentShaping, SHAPING_LIMITS, type ShapingPromptState } from "@shared/shaping.ts";
import type { PendingTurn, ServerEvent, Session, Task } from "@shared/types.ts";
import {
  getTaskSkillPrompt,
  insertTaskSkillPrompt,
  listAnsweredHeldTaskSkillPromptSessions,
  listOpenTaskSkillPrompts,
  listWaitingTaskSkillPromptSessions,
  markHeldTaskSkillPromptsAnswered,
  markTaskSkillPromptWaiting,
  queueTaskSkillPromptTurn,
  settleTaskSkillPrompt,
  taskSkillPromptForTurn,
} from "../db.ts";
import { featureEnabled, onFeatureFlagsChanged } from "../feature-flags/index.ts";
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
  /** Told when the feature flags change, so prompts owed while task shaping was off are recovered when it is on again. */
  onFlagsChanged?: (listener: () => void) => () => void;
  now?: () => number;
  /**
   * Run `fn` after `ms`, returning a cancel. A held prompt whose release failed is tried again
   * this way, so a daemon that keeps running never leaves it held. Defaults to an unref'd timer.
   */
  schedule?: (fn: () => void, ms: number) => () => void;
  /**
   * Sessions whose work a durable signal says is complete, read at start and when task shaping
   * is turned on again: a workflow submission that is running, and when it was submitted. Each
   * is prompted once its session is registered, so a first prompt lost to a database error and
   * a restart is written then - but only for a launch no newer than the submission, so a later
   * launch into the same session is never prompted for an earlier launch's work. The
   * once-per-launch guard makes one already prompted a no-op.
   */
  owedSessions?: () => ReadonlyArray<{ sessionId: string; submittedAt: number }>;
  /** A catalog skill's checked invocation for a live session. */
  catalogCommand?: (session: Session, id: string) => RequiredSkillCommand;
  /** The catalog id behind a routed name, or null for a name Mission Control does not ship. */
  catalogId?: (name: string) => string | null;
}

/** What one call came to, for a caller's log and for tests. */
export type AfterWorkOutcome =
  | { kind: "none"; why: "disabled" | "no_record" | "already" | "no_after_work_skills" | "retrying" }
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

/**
 * Connect the prompter to Foreman's wrap-up answers, as the daemon does. In the answer's own
 * transaction, the session's held prompts are marked answered; after it commits they are
 * released. A daemon that stops between the two still releases them at its next start.
 */
export function wireAfterWorkSkills(
  afterWork: Pick<AfterWorkSkills, "recordAnswered" | "release">,
  queues: {
    onWrapupAnswerRecorded(recorder: (key: string) => void): () => void;
    onWrapupAnswered(listener: (key: string) => void): () => void;
  },
  sessionForKey: (key: string) => string | null,
): () => void {
  const offRecorded = queues.onWrapupAnswerRecorded((key) => {
    const sessionId = sessionForKey(key);
    if (sessionId) afterWork.recordAnswered(sessionId);
  });
  const offAnswered = queues.onWrapupAnswered((key) => {
    const sessionId = sessionForKey(key);
    if (sessionId) afterWork.release(sessionId);
  });
  return () => { offRecorded(); offAnswered(); };
}

/** The first and the longest wait before a failed prompt or held release is tried again. */
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 5 * 60_000;

export class AfterWorkSkills {
  private readonly deps: Required<Omit<AfterWorkSkillsDeps, "catalogCommand" | "catalogId">>
    & Pick<AfterWorkSkillsDeps, "catalogCommand" | "catalogId">;
  private unsubscribe: Array<() => void> = [];
  /** Sessions with a prompt the outbox refused for a reason that can clear, tried again as they change. */
  private readonly waiting = new Set<string>();
  /** Sessions with an answered held prompt a restart releases once the session is back. */
  private readonly heldCheck = new Set<string>();
  /** The session each task's shaping record last named, so a resume's move is seen once. */
  private readonly shapingSessions = new Map<string, string>();
  /**
   * Work that failed and is tried again on a timer, keyed `held:<session>` (a release) or
   * `prompt:<session>` (a first prompt): the next try's cancel and how many tries have failed.
   */
  private readonly retries = new Map<string, { cancel: () => void; failures: number }>();
  /**
   * Sessions whose first prompt failed before it wrote a row, with whether it was to be held.
   * A wrap-up answered meanwhile clears `hold`: the wrap-up has reached the session, which is
   * all holding was for, and a row held after the answer would never be released.
   */
  private readonly owedPrompts = new Map<string, { hold: boolean; notAfter: number }>();
  /** Sessions `owedSessions` named that were not registered yet, with their submission time. */
  private readonly owedAtStart = new Map<string, number>();
  private retrying = false;

  constructor(deps: AfterWorkSkillsDeps) {
    this.deps = {
      enabled: () => featureEnabled("task-shaping"),
      onFlagsChanged: (listener) => onFeatureFlagsChanged(() => listener()),
      now: Date.now,
      owedSessions: () => [],
      schedule: (fn, ms) => {
        const timer = setTimeout(fn, ms);
        timer.unref?.();
        return () => clearTimeout(timer);
      },
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
        // A session that changes may be able to take its waiting prompt now: the outbox has
        // started, or it can receive messages again.
        else if (event.type === "session_upsert") {
          const submittedAt = this.owedAtStart.get(event.session.id);
          if (submittedAt !== undefined) {
            this.owedAtStart.delete(event.session.id);
            this.promptOwed(event.session.id, submittedAt);
          }
          this.pendingChanged(event.session.id);
        }
        else if (event.type === "task_upsert") this.follow(event.task);
        else if (event.type === "task_remove") this.shapingSessions.delete(event.id);
      }),
      // Prompts owed while task shaping was off - answered held ones, waiting ones - are
      // recovered when it is turned on again, without waiting for a restart.
      this.deps.onFlagsChanged(() => { if (this.deps.enabled()) this.recover(); }),
    ];
    this.recover();
  }

  /** Release or retry what a session that changed is owed. Memory only until it names one. */
  private pendingChanged(sessionId: string): void {
    if (this.heldCheck.has(sessionId)) this.checkHeld(sessionId);
    if (this.waiting.has(sessionId)) this.retry(sessionId);
  }

  /**
   * A resume moves a task's shaping record, and its durable prompt row with it, to a successor
   * session these sets have never seen, and publishes the task with the record's new session.
   * Only that move re-reads them from the database, and only while a row is pending: a session
   * update, or a task update that leaves its record where it was, costs nothing, however long a
   * row stays pending. A task this prompter has not seen yet counts as moved, once.
   */
  private follow(task: Task): void {
    const to = task.shaping?.sessionId;
    const from = this.shapingSessions.get(task.id);
    if (!to) {
      this.shapingSessions.delete(task.id);
      return;
    }
    this.shapingSessions.set(task.id, to);
    if (from === to || this.waiting.has(to) || this.heldCheck.has(to)) return;
    if (this.waiting.size === 0 && this.heldCheck.size === 0) return;
    try {
      if (this.waiting.size > 0) {
        this.waiting.clear();
        for (const id of listWaitingTaskSkillPromptSessions()) this.waiting.add(id);
      }
      if (this.heldCheck.size > 0) {
        this.heldCheck.clear();
        for (const id of listAnsweredHeldTaskSkillPromptSessions()) this.heldCheck.add(id);
      }
    } catch (error) {
      console.warn("[shaping] could not re-read the after-work prompts still owed:", error);
      return;
    }
    this.pendingChanged(to);
  }

  /**
   * Find and send what is owed: held prompts whose wrap-up was answered (the answer marked them
   * in its own transaction, so a daemon that stopped, or a flag that was off, before the release
   * still releases them, whatever the answer said), and prompts waiting on the outbox.
   */
  private recover(): void {
    // A first prompt a durable signal says is owed, which a restart may have lost before it
    // wrote its row. Prompting is once per launch, so one already written stays as it is.
    try {
      for (const { sessionId, submittedAt } of this.deps.owedSessions()) {
        if (this.deps.registry.getSession(sessionId)) this.promptOwed(sessionId, submittedAt);
        else this.owedAtStart.set(sessionId, submittedAt);
      }
    } catch (error) {
      console.warn("[shaping] could not read the sessions owed an after-work prompt:", error);
    }
    try {
      for (const sessionId of listAnsweredHeldTaskSkillPromptSessions()) this.heldCheck.add(sessionId);
    } catch (error) {
      console.warn("[shaping] could not read the after-work prompts that are held:", error);
    }
    for (const sessionId of [...this.heldCheck]) this.checkHeld(sessionId);
    // Waiting rows a restart left behind are tried again once the outbox is up.
    try {
      for (const sessionId of listWaitingTaskSkillPromptSessions()) this.waiting.add(sessionId);
    } catch (error) {
      console.warn("[shaping] could not read the after-work prompts that are waiting:", error);
    }
    for (const sessionId of [...this.waiting]) this.retry(sessionId);
  }

  /** Prompt a session a durable signal says is owed, when its current launch predates the signal. */
  private promptOwed(sessionId: string, submittedAt: number): void {
    try {
      const taskId = this.deps.registry.getSession(sessionId)?.task?.id;
      const task = taskId ? this.deps.registry.getTask(taskId) : undefined;
      const record = task ? currentShaping(task) : null;
      if (!record || record.sessionId !== sessionId || record.at > submittedAt) return;
    } catch (error) {
      // Unread, it is neither prompted (it might be a later launch) nor given up: the session's
      // next update checks it again.
      console.warn(`[shaping] could not check session ${sessionId}'s owed after-work prompt:`, error);
      this.owedAtStart.set(sessionId, submittedAt);
      return;
    }
    this.prompt(sessionId, { notAfter: submittedAt });
  }

  stop(): void {
    for (const off of this.unsubscribe.splice(0)) off();
    for (const retry of this.retries.values()) retry.cancel();
    this.retries.clear();
    this.owedPrompts.clear();
    this.owedAtStart.clear();
  }

  /**
   * Prompt this session's after-work skills, once per launch. `hold` is the no-workflow caller:
   * the row is written held and nothing is queued until `release`. Never throws.
   */
  prompt(sessionId: string, options: { hold?: boolean; notAfter?: number } = {}): AfterWorkOutcome {
    // A fresh call - an activation, a claim, a recovery - is decided by its own hold and bound,
    // never by an earlier call's owed entry: a newer launch's own prompt must not be refused
    // under an older launch's bound. It settles that entry either way, since the record it
    // reads is the current one.
    return this.attemptPrompt(sessionId, options.hold === true, options.notAfter ?? null);
  }

  /** One attempt to write and queue the prompt. A failure keeps it owed, with its hold and bound. */
  private attemptPrompt(sessionId: string, hold: boolean, notAfter: number | null): AfterWorkOutcome {
    try {
      const outcome = this.promptOnce(sessionId, hold, notAfter);
      this.owedPrompts.delete(sessionId);
      this.clearRetry(`prompt:${sessionId}`);
      return outcome;
    } catch (error) {
      // Nothing was written, and the caller - a submission's activation, a claim - may not
      // come again: the prompt stays owed and is tried again until it writes its row. It is
      // owed to the launch current now, so a retry never prompts a launch written after this
      // call (or, recovered at start, after the submission it was owed for).
      console.warn(`[shaping] could not prompt session ${sessionId}'s after-work skills:`, error);
      this.owedPrompts.set(sessionId, { hold, notAfter: notAfter ?? this.deps.now() });
      // The timer's retry is the one caller that keeps the owed entry's hold - which an answered
      // wrap-up may have cleared since - and its bound.
      this.retryLater(`prompt:${sessionId}`, () => {
        const owed = this.owedPrompts.get(sessionId);
        if (owed) this.attemptPrompt(sessionId, owed.hold, owed.notAfter);
      });
      return { kind: "none", why: "retrying" };
    }
  }

  /**
   * Foreman's wrap-up for this session was answered - sent automatically, chosen on the Ship it?
   * card, or skipped - so a held prompt may follow it now. An unanswered card never calls this.
   */
  release(sessionId: string): void {
    const owed = this.owedPrompts.get(sessionId);
    if (owed) owed.hold = false;
    try {
      this.resume(sessionId, "held");
      this.clearRetry(`held:${sessionId}`);
    } catch (error) {
      console.warn(`[shaping] could not release session ${sessionId}'s after-work skills:`, error);
      this.retryHeldLater(sessionId);
    }
  }

  /**
   * A release that failed stays owed: the answer's marker is durable, so the session is kept for
   * the held check - its next update, or a flag turned on again - and tried again on the retry
   * timer, so a session that stays quiet is still released.
   */
  private retryHeldLater(sessionId: string): void {
    if (!this.unsubscribe.length) return;
    this.heldCheck.add(sessionId);
    this.retryLater(`held:${sessionId}`, () => {
      if (this.heldCheck.has(sessionId)) this.checkHeld(sessionId);
    });
  }

  /**
   * Run `run` again after a wait that backs off from 1 second to 5 minutes with each failure of
   * `key`. Only the latest timer for a key runs. A stopped prompter schedules nothing.
   */
  private retryLater(key: string, run: () => void): void {
    if (!this.unsubscribe.length) return;
    const prior = this.retries.get(key);
    prior?.cancel();
    const failures = (prior?.failures ?? 0) + 1;
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (failures - 1));
    const cancel = this.deps.schedule(() => {
      if (this.retries.get(key)?.cancel !== cancel) return;
      run();
    }, delay);
    this.retries.set(key, { cancel, failures });
  }

  private clearRetry(key: string): void {
    this.retries.get(key)?.cancel();
    this.retries.delete(key);
  }

  /**
   * Inside the transaction that records a session's wrap-up answer: mark its held prompts
   * answered, so the release survives a daemon that stops before `release` runs. Throws with the
   * transaction, which then keeps neither.
   */
  recordAnswered(sessionId: string): void {
    markHeldTaskSkillPromptsAnswered(sessionId);
  }

  /**
   * Release a session's held prompts that an answer marked, once the session is registered and
   * task shaping is on. One whose session is still being restored is released when it arrives,
   * and one found while the flag is off when the flag is on again. Never throws.
   */
  private checkHeld(sessionId: string): void {
    try {
      // Kept for later, never dropped: a session not registered yet is checked when it is, and
      // with task shaping off nothing is released until it is on again.
      if (!this.deps.registry.getSession(sessionId) || !this.deps.enabled()) return;
      this.heldCheck.delete(sessionId);
      this.release(sessionId);
    } catch (error) {
      console.warn(`[shaping] could not check session ${sessionId}'s held after-work skills:`, error);
      this.retryHeldLater(sessionId);
    }
  }

  /** Try a session's waiting prompts again, once at a time. Never throws. */
  private retry(sessionId: string): void {
    if (this.retrying) return;
    this.retrying = true;
    try {
      this.resume(sessionId, "waiting");
      if (!listOpenTaskSkillPrompts(sessionId).some((row) => row.state === "waiting")) this.waiting.delete(sessionId);
    } catch (error) {
      console.warn(`[shaping] could not retry session ${sessionId}'s after-work skills:`, error);
    } finally {
      this.retrying = false;
    }
  }

  /** Queue the session's rows that are still `from`: held behind a wrap-up, or waiting on the outbox. */
  private resume(sessionId: string, from: "held" | "waiting"): void {
    if (!this.deps.enabled()) return;
    for (const row of listOpenTaskSkillPrompts(sessionId)) {
      if (row.state !== from) continue;
      const session = this.deps.registry.getSession(sessionId);
      if (!session) {
        // A waiting row stays owed while its session is not registered: at startup sessions are
        // still being restored, and its arrival tries again. A session that ends settles it then.
        if (from === "waiting") continue;
        this.settle(row.taskId, sessionId, [from], "not_delivered", SESSION_ENDED);
        continue;
      }
      // The launch the row was written for, which is still the task's current one: a later
      // launch's shaping commit removes the row it supersedes.
      const task = this.deps.registry.getTask(row.taskId);
      const record = task ? currentShaping(task) : null;
      if (!record || record.sessionId !== sessionId) {
        this.settle(row.taskId, sessionId, [from], "not_delivered", SUPERSEDED);
        continue;
      }
      this.queue(session, row.taskId, row.skills, from, record.at);
    }
  }

  /**
   * `notAfter`, when set, bounds the launch: a current record written after it belongs to a
   * later launch, which is not prompted for this one's work.
   */
  private promptOnce(sessionId: string, hold: boolean, notAfter: number | null = null): AfterWorkOutcome {
    if (!this.deps.enabled()) return { kind: "none", why: "disabled" };
    const session = this.deps.registry.getSession(sessionId);
    const taskId = session?.task?.id;
    const task = taskId ? this.deps.registry.getTask(taskId) : undefined;
    // Only the launch the record describes: the task's current session, named by its record.
    const record = task ? currentShaping(task) : null;
    if (!session || !task || !record || record.sessionId !== sessionId) return { kind: "none", why: "no_record" };
    if (notAfter !== null && record.at > notAfter) return { kind: "none", why: "no_record" };
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
    return this.queue(session, task.id, names, null, record.at);
  }

  /** Resolve, render and queue. A row that cannot be queued ends `not_delivered`, with why. */
  private queue(
    session: Session,
    taskId: string,
    names: readonly string[],
    from: "held" | "waiting" | null,
    launchAt: number,
  ): AfterWorkOutcome {
    const resolved: ResolvedSkill[] = [];
    const problems: string[] = [];
    for (const name of names) {
      const result = this.resolve(session, name);
      if (result.ok) resolved.push(result.skill);
      else problems.push(`${name}: ${result.reason}`);
    }
    const write = (reason: string): AfterWorkOutcome => {
      const bounded = reason.slice(0, SHAPING_LIMITS.reasonChars);
      if (from !== null) this.settle(taskId, session.id, [from], "not_delivered", bounded);
      else insertTaskSkillPrompt({ taskId, sessionId: session.id, state: "not_delivered", reason: bounded, skills: names, now: this.deps.now() });
      return { kind: "not_delivered", reason: bounded };
    };
    const text = renderAfterWorkPrompt(session.id, resolved);
    if (!text) return write(`No skill resolved. ${problems.join(" ")}`.trim());
    const turnId = afterWorkTurnId(taskId, session.id, launchAt);
    const submitted = this.deps.outbox.submitDaemonTurn(session.id, (noteKey, now) => queueTaskSkillPromptTurn({
      taskId, sessionId: session.id, noteKey, turnId, text, skills: resolved.map((skill) => skill.name), from, now,
    }));
    if (!submitted.ok && submitted.retryable) {
      // A refusal that can clear, such as the outbox still starting: kept owed, and tried again
      // when the session next changes or the daemon next starts, never given up on.
      const reason = `Waiting for the session to take the prompt: ${submitted.error ?? "unknown error"}.`.slice(0, SHAPING_LIMITS.reasonChars);
      markTaskSkillPromptWaiting({ taskId, sessionId: session.id, from, skills: names, reason, now: this.deps.now() });
      this.waiting.add(session.id);
      return { kind: "waiting", reason };
    }
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
    this.clearRetry(`held:${sessionId}`);
    this.clearRetry(`prompt:${sessionId}`);
    this.owedPrompts.delete(sessionId);
    this.owedAtStart.delete(sessionId);
    this.heldCheck.delete(sessionId);
    try {
      for (const row of listOpenTaskSkillPrompts(sessionId)) {
        this.settle(row.taskId, sessionId, [row.state], "not_delivered", SESSION_ENDED);
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
