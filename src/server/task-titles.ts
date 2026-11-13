import type {
  BacklogPlan,
  PlanDecision,
  ReviewItem,
  ServerEvent,
  Session,
  SessionBlocker,
  TranscriptMessage,
} from "@shared/types.ts";
import { taskIdCandidates, withTaskTitles } from "@shared/task-references.ts";
import { getTaskTitles } from "./db.ts";

// What an agent wrote, as the dashboard shows it: every task id it contains replaced by that
// task's quoted title.
//
// A person sees Mission Control tasks only by title, so an id in an agent's words is a
// reference they cannot follow. Every agent is told so (`TASK_REFERENCE_RULE`), and this is
// the enforcement for the agents that ignore it. It runs HERE, in the daemon, because the
// daemon can name every task synchronously - a live one from the registry, a finished one the
// board has let go of from the durable table - so a frame reaches the browser already titled.
// A browser that resolved titles itself would draw the id first and replace it later.
//
// It is a projection of what the BROWSER is sent, never of what is stored. The transcript file,
// the session row, the review row, Foreman's prompts and every agent's tool results keep the
// agent's own words, ids included: those readers act on ids. The seams that call it are the
// dashboard's channels and nothing else - the event stream (`sse.ts`), the conversation's
// stream and history pages (`transcript-stream.ts`, `routes.ts`), and the Sitrep report built
// from the same snapshot (`/api/report`, `/api/report.md`).

/** The part of the registry this reads: the tasks it holds live. */
export interface LiveTaskTitles {
  getTask(id: string): { title: string } | undefined;
}

/**
 * Id-shaped tokens already known to name no task, so a session whose activity line carries an
 * agent session id or a request id does not query the database on every upsert. Bounded, and
 * consulted only after the live registry, so a task created later is still named.
 */
const NOT_A_TASK_LIMIT = 4096;

/** The durable half of a lookup: titles of whichever ids name a saved task, in any status. */
export type SavedTaskTitles = (ids: readonly string[]) => Map<string, string>;

export class TaskTitlePresenter {
  private readonly notATask = new Set<string>();

  constructor(
    private readonly live: LiveTaskTitles,
    private readonly saved: SavedTaskTitles = getTaskTitles,
  ) {}

  /** `text` with every task id in it replaced by that task's quoted title. */
  text(text: string): string {
    const candidates = taskIdCandidates(text);
    if (candidates.length === 0) return text;
    const titles = new Map<string, string>();
    const missing: string[] = [];
    for (const id of candidates) {
      const title = this.live.getTask(id)?.title;
      if (title) titles.set(id, title);
      else if (!this.notATask.has(id)) missing.push(id);
    }
    if (missing.length > 0) {
      const durable = this.savedTitles(missing);
      // A failed read learns nothing, so nothing is remembered as "not a task": the next frame
      // asks again rather than showing the id for as long as the cache holds it.
      if (durable) {
        for (const id of missing) {
          const title = durable.get(id);
          if (title) titles.set(id, title);
          else this.rememberNotATask(id);
        }
      }
    }
    return titles.size === 0 ? text : withTaskTitles(text, titles);
  }

  /** A session's agent-written lines: what it says it is doing, and why it is blocked. */
  session(session: Session): Session {
    const activity = session.activity === null ? null : this.text(session.activity);
    const blocker = session.blocker ? this.blocker(session.blocker) : session.blocker;
    if (activity === session.activity && blocker === session.blocker) return session;
    return { ...session, activity, blocker };
  }

  /**
   * A review's title, its prose, and its questions and options.
   *
   * A diff review's body is a patch: an id in it is code under review, not a reference to a
   * task, so it is left byte for byte. An option keeps its id - the answer is recorded by id -
   * and when titling gives two options of one question the same label, the titled one is
   * numbered (`distinctLabels`) so the card can still tell them apart without showing the id.
   */
  review(review: ReviewItem): ReviewItem {
    const title = this.text(review.title);
    const body = review.kind === "diff" ? review.body : this.text(review.body);
    const decisions = review.decisions ? this.decisions(review.decisions) : review.decisions;
    if (title === review.title && body === review.body && decisions === review.decisions) return review;
    return { ...review, title, body, decisions };
  }

  /** An agent's conversation turns. The human's own turns are shown exactly as typed. */
  transcript(messages: TranscriptMessage[]): TranscriptMessage[] {
    let changed = false;
    const presented = messages.map((message) => {
      if (message.role !== "assistant" || !message.text) return message;
      const text = this.text(message.text);
      if (text === message.text) return message;
      changed = true;
      return { ...message, text };
    });
    return changed ? presented : messages;
  }

  /**
   * Foreman's backlog plan: each task's reason and the plan's note, which the board prints
   * verbatim. The planner is shown every backlog task's id, and a task's intent can cite any
   * other saved task, so this names whatever task the prose mentions - not only the backlog.
   */
  plan(plan: BacklogPlan | null): BacklogPlan | null {
    if (!plan) return plan;
    let changed = false;
    const entries = plan.entries.map((entry) => {
      const reason = entry.reason === null ? null : this.text(entry.reason);
      if (reason === entry.reason) return entry;
      changed = true;
      return { ...entry, reason };
    });
    const note = plan.note === null ? null : this.text(plan.note);
    if (!changed && note === plan.note) return plan;
    return { ...plan, entries, note };
  }

  /** A registry snapshot as the browser reads it: its sessions and reviews titled. */
  snapshot<T extends { sessions: Session[]; reviews: ReviewItem[] }>(snapshot: T): T {
    return {
      ...snapshot,
      sessions: snapshot.sessions.map((session) => this.session(session)),
      reviews: snapshot.reviews.map((review) => this.review(review)),
    };
  }

  /** One event on its way to the browser. Events carrying no agent prose pass by reference. */
  event(event: ServerEvent): ServerEvent {
    switch (event.type) {
      case "session_upsert": {
        const session = this.session(event.session);
        return session === event.session ? event : { ...event, session };
      }
      case "review_upsert": {
        const review = this.review(event.review);
        return review === event.review ? event : { ...event, review };
      }
      default:
        return event;
    }
  }

  private blocker(blocker: SessionBlocker): SessionBlocker {
    const reason = this.text(blocker.reason);
    const waitingOn = this.text(blocker.waitingOn);
    const resumeWhen = this.text(blocker.resumeWhen);
    const details = blocker.details === null ? null : this.text(blocker.details);
    if (
      reason === blocker.reason && waitingOn === blocker.waitingOn
      && resumeWhen === blocker.resumeWhen && details === blocker.details
    ) return blocker;
    return { ...blocker, reason, waitingOn, resumeWhen, details };
  }

  private decisions(decisions: PlanDecision[]): PlanDecision[] {
    let changed = false;
    const presented = decisions.map((decision) => {
      const question = this.text(decision.question);
      const labels = distinctLabels(
        decision.options.map((option) => option.label),
        decision.options.map((option) => this.text(option.label)),
      );
      const options = decision.options.map((option, index) => {
        const label = labels[index]!;
        const detail = option.detail === undefined ? undefined : this.text(option.detail);
        if (label === option.label && detail === option.detail) return option;
        return { ...option, label, ...(detail === undefined ? {} : { detail }) };
      });
      const optionsChanged = options.some((option, index) => option !== decision.options[index]);
      if (question === decision.question && !optionsChanged) return decision;
      changed = true;
      return { ...decision, question, options };
    });
    return changed ? presented : decisions;
  }

  /**
   * The saved table's answer, or null when it cannot be read.
   *
   * This runs on the write path of every dashboard event frame, every transcript frame and the
   * Sitrep report, and titling is a projection of text that is already correct. A busy or closed
   * database must cost the titles of finished tasks for that frame, never the frame itself: an
   * exception here would end the dashboard's live feed. Live tasks are still named from the
   * registry, and every other id is left as written.
   */
  private savedTitles(ids: string[]): Map<string, string> | null {
    try {
      return this.saved(ids);
    } catch (error) {
      console.warn(`[task-titles] could not read saved task titles: ${String(error)}`);
      return null;
    }
  }

  private rememberNotATask(id: string): void {
    if (this.notATask.size >= NOT_A_TASK_LIMIT) this.notATask.clear();
    this.notATask.add(id);
  }
}

/**
 * One question's option labels, titled, and still distinct the way the card compares them.
 *
 * `request_input` refuses two options whose labels match ignoring case and surrounding space,
 * because the card could not tell them apart (`inputQuestionProblem`). Titling can create such
 * a pair - an option naming a task by id beside one already naming it by title - and showing
 * the id to avoid it would defeat the point. So every label the agent wrote without a task id
 * keeps its exact text, and a titled label that would match one already taken is numbered,
 * ` (2)`, ` (3)` and on, in option order, until it is unique.
 */
export function distinctLabels(original: readonly string[], titled: readonly string[]): string[] {
  const key = (label: string): string => label.trim().toLowerCase();
  const taken = new Set(original.flatMap((label, index) => (titled[index] === label ? [key(label)] : [])));
  return titled.map((label, index) => {
    if (label === original[index]) return label;
    let candidate = label;
    for (let n = 2; taken.has(key(candidate)); n++) candidate = `${label} (${n})`;
    taken.add(key(candidate));
    return candidate;
  });
}

const presenters = new WeakMap<LiveTaskTitles, TaskTitlePresenter>();

/** The one presenter for a registry, so every dashboard channel shares its cache. */
export function taskTitlePresenter(live: LiveTaskTitles): TaskTitlePresenter {
  let presenter = presenters.get(live);
  if (!presenter) {
    presenter = new TaskTitlePresenter(live);
    presenters.set(live, presenter);
  }
  return presenter;
}
