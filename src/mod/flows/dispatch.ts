import type { DispatchIntent, HomeDispatchDraftSummary, HomeDispatchOptionsRequest } from "@shared/home-dispatch.ts";
import type { TaskKind } from "@shared/types.ts";
import { DAEMON_DOWN_NOTICE, TOKEN_REFUSED_NOTICE } from "../core.ts";
import type { ModHost } from "../host.ts";
import { askPages, askText, pagesOf } from "./dialogs.ts";
import { confirmDraft, createDraft, fetchOptions, updateDraft, type FlowSession, type Outcome } from "./routes.ts";

/**
 * The dispatch dialogs and the draft (spec 7.5, 7.6, 7.11). P11 owns this file.
 *
 * The mod only relays: the daemon builds every page and every sentence about a draft, and the
 * mod shows them as written. It never reorders or rewords an option, never asks for a harness,
 * and never retries a refusal with changes the person did not ask for. Home-dispatched tasks pass
 * no runtime override anywhere (Focus guard 1): nothing here names one.
 */

/** What a flow did, and the one line the person (and, for the tool, the model) is told. */
export interface FlowResult {
  outcome: "started" | "backlog" | "cancelled" | "refused" | "waiting" | "pane";
  line: string;
  taskId?: string;
}

export const FLOW_OFF_NOTICE = "Mission Control headless mode is turned off.";
export const EXPIRED_NOTICE = "That dispatch has expired or is unknown. Run /mission-dispatch again.";
export const DESCRIBE_NOTICE = "Type what this task should do, then press Enter.";
export const DROP_HINT = "Press Enter again with nothing typed to drop this draft and start over.";
export const DROPPED_NOTICE = "Dropped the draft that was waiting for its description.";
export const CANCELLED_LINE = "cancelled";
export const CANCELLED_NOTICE = "Cancelled. Nothing was created.";
export const NEEDS_REPO_QUESTION = "Which repo is this for? Type a folder name or a path under Other.";

type FlowHost = Pick<ModHost, "ask" | "notice" | "toast" | "fetch" | "fillPrompt" | "paneOpen" | "paneState">;
type Failed = Extract<Outcome<unknown>, { ok: false }>;
type Refused = Extract<Outcome<unknown>, { ok: false; kind: "refused" }>;

export interface DispatchInput {
  /** `first-message` is the launcher (Start page first); `command` and `conversation` skip it. */
  entry: HomeDispatchOptionsRequest["entry"];
  kind?: TaskKind;
  words?: string;
  context?: string;
  intent?: DispatchIntent;
  /** A path or a workspace repository name; the daemon resolves it (7.20). */
  repo?: string;
}

/** The line for a call that did not reach a daemon that answers, or the daemon's own refusal. */
export function unreachableLine(outcome: Failed): string {
  if (outcome.kind === "refused") return outcome.error;
  if (outcome.kind === "ended") return CANCELLED_NOTICE;
  if (outcome.kind === "down") return DAEMON_DOWN_NOTICE;
  if (outcome.kind === "off") return FLOW_OFF_NOTICE;
  return TOKEN_REFUSED_NOTICE;
}

/** Shows a closing line to the person, as a notice and a toast (7.11). */
function tell(host: FlowHost, line: string): void {
  host.notice(line);
  host.toast(line);
}

/** Shows what went wrong as written and ends the flow. */
export function fail(host: FlowHost, outcome: Failed): FlowResult {
  // The session ended under an open dialog: nothing was filed, and there is no one to tell.
  if (outcome.kind === "ended") return { outcome: "cancelled", line: CANCELLED_LINE };
  const line = outcome.kind === "refused" && outcome.status === 404 && outcome.error === "no such draft"
    ? EXPIRED_NOTICE
    : unreachableLine(outcome);
  host.notice(line);
  return { outcome: "refused", line };
}

const baseName = (path: string): string => path.split("/").filter(Boolean).at(-1) ?? path;

/** The repository answers 400 with `unknown repository {name}` or `{name} matches {a}, {b}` (7.20). */
export function isRepoSelectorRefusal(outcome: Refused): boolean {
  return outcome.status === 400
    && (outcome.error.startsWith("unknown repository ") || / matches /.test(outcome.error) || outcome.error.startsWith("not a repository: "));
}

/**
 * Creates the draft. A repository the daemon cannot resolve is asked about again, in the
 * person's words under Other, for three attempts in all, and the third refusal is returned to be
 * shown as written; every other refusal is returned the same way. `cancelled` means the person
 * gave up at that question.
 */
export async function createDraftAsking(
  host: FlowHost,
  session: FlowSession,
  fields: Parameters<typeof createDraft>[2],
): Promise<Outcome<HomeDispatchDraftSummary> | { ok: false; kind: "cancelled" }> {
  let attempt = fields;
  for (let tries = 0; tries < 3; tries += 1) {
    const created = await createDraft(host, session, attempt);
    if (created.ok || created.kind !== "refused" || !isRepoSelectorRefusal(created)) return created;
    // The last refusal is shown as written; asking again would only discard the answer.
    if (tries === 2) return created;
    const repo = await askText(host, "Repo", `${created.error}. ${NEEDS_REPO_QUESTION}`);
    if (repo === undefined) return { ok: false, kind: "cancelled" };
    attempt = { ...attempt, repo };
  }
  return { ok: false, kind: "cancelled" };
}

/** Fills the prompt box for the description, or asks for it in a dialog when it cannot be filled (S12). */
async function requestDescription(host: FlowHost, session: FlowSession, summary: HomeDispatchDraftSummary): Promise<FlowResult> {
  // Never touch the prompt of a session other than the one that asked.
  if (session.live && !session.live()) return ended();
  let filled = true;
  try {
    filled = (await host.fillPrompt("/mission-dispatch ", session.live)) !== false;
  } catch {
    filled = false;
  }
  // The fill may have outlasted the session: an ended session must not leave its draft waiting in
  // state the next session reads. (The draft itself expires at the daemon.)
  if (session.live && !session.live()) return ended();
  if (filled) {
    await host.paneState.set("draftId", summary.draftId);
    host.notice(DESCRIBE_NOTICE);
    return { outcome: "waiting", line: DESCRIBE_NOTICE };
  }
  const words = await askText(host, "Task", "What should this task do? Type it under Other.");
  if (words === undefined) return cancel(host, session, summary.draftId);
  const updated = await updateDraft(host, session, summary.draftId, { words });
  return updated.ok ? confirmLoop(host, session, updated.value, undefined) : fail(host, updated);
}

async function cancel(host: FlowHost, session: FlowSession, draftId: string): Promise<FlowResult> {
  // A cancel the daemon never hears leaves a draft that expires on its own (7.6).
  await confirmDraft(host, session, draftId, "cancel");
  host.notice(CANCELLED_NOTICE);
  return { outcome: "cancelled", line: CANCELLED_LINE };
}

/** A dismissed dialog counts as Cancel (7.11); before a draft exists there is nothing to cancel. */
/** The session ended under the flow: there is no one left to tell, so it ends quietly (cf. fail() for `ended`). */
function ended(): FlowResult {
  return { outcome: "cancelled", line: CANCELLED_LINE };
}

function stop(host: FlowHost): FlowResult {
  host.notice(CANCELLED_NOTICE);
  return { outcome: "cancelled", line: CANCELLED_LINE };
}

/**
 * A description given while a draft waits for it (7.11): the text, word for word. `null` means
 * the draft is gone (expired, replaced, confirmed), and the caller treats the text as a new brief.
 */
export async function describeDraft(host: FlowHost, session: FlowSession, draftId: string, words: string): Promise<FlowResult | null> {
  session.reminded?.delete(draftId);
  const updated = await updateDraft(host, session, draftId, { words });
  // Only this session's own marker is cleared: a replacement session may have its own by now.
  if (!session.live || session.live()) await host.paneState.set("draftId", null);
  if (updated.ok) return confirmLoop(host, session, updated.value, undefined);
  if (updated.kind === "refused" && updated.status === 404) return null;
  return fail(host, updated);
}

const CONFIRM_START = { label: "Start now", description: "Create the task and start it" };
const CONFIRM_BACKLOG = { label: "Save to backlog", description: "Create the task and leave it shelved" };
const CONFIRM_CHANGE = { label: "Change something", description: "Go back to the kind and after work" };
const CONFIRM_CANCEL = { label: "Cancel", description: "Create nothing" };

/**
 * Shows the draft's summary and the confirm dialog, the intent's choice first (7.20). Change
 * something goes back to Kind and After work and then asks again. A dismissed dialog is Cancel.
 */
export async function confirmLoop(
  host: FlowHost,
  session: FlowSession,
  first: HomeDispatchDraftSummary,
  intent: DispatchIntent | undefined,
): Promise<FlowResult> {
  let summary = first;
  for (;;) {
    host.notice(summary.text);
    const options = intent === "backlog"
      ? [CONFIRM_BACKLOG, CONFIRM_START, CONFIRM_CHANGE, CONFIRM_CANCEL]
      : [CONFIRM_START, CONFIRM_BACKLOG, CONFIRM_CHANGE, CONFIRM_CANCEL];
    const answer = await host.ask({ header: "Confirm", question: "Start this task?", options });
    if (answer.kind !== "pick" || answer.label === CONFIRM_CANCEL.label) return cancel(host, session, summary.draftId);
    if (answer.label === CONFIRM_START.label) return file(host, session, summary, "start");
    if (answer.label === CONFIRM_BACKLOG.label) return file(host, session, summary, "backlog");
    const changed = await changeSomething(host, session, summary);
    if ("outcome" in changed) return changed;
    summary = changed;
  }
}

/** Kind, then After work for that kind, as the daemon built the pages; returns the changed draft or the flow's end. */
async function changeSomething(host: FlowHost, session: FlowSession, summary: HomeDispatchDraftSummary): Promise<HomeDispatchDraftSummary | FlowResult> {
  host.notice(`Current kind: ${summary.kindLabel}.`);
  const kinds = await fetchOptions(host, session, { entry: "command", brief: summary.words });
  if (!kinds.ok) return fail(host, kinds);
  const kind = await askPages(host, pagesOf(kinds.value.questions, "kind"));
  if (kind.kind !== "pick") return cancel(host, session, summary.draftId);
  let updated = await updateDraft(host, session, summary.draftId, { kind: kind.value as TaskKind });
  if (!updated.ok) return fail(host, updated);
  const after = await fetchOptions(host, session, { entry: "command", kind: kind.value as TaskKind });
  if (!after.ok) return fail(host, after);
  const afterPages = pagesOf(after.value.questions, "after-work");
  if (afterPages.length > 0) {
    const pick = await askPages(host, afterPages);
    if (pick.kind !== "pick") return cancel(host, session, summary.draftId);
    updated = await updateDraft(host, session, summary.draftId, { workflowId: pick.value });
    if (!updated.ok) return fail(host, updated);
  }
  return updated.value;
}

/** Files the draft and tells the person the outcome (7.11). */
async function file(host: FlowHost, session: FlowSession, summary: HomeDispatchDraftSummary, choice: "start" | "backlog"): Promise<FlowResult> {
  const result = await confirmDraft(host, session, summary.draftId, choice);
  const where = `${summary.kindLabel}, after work ${summary.afterWork}, in ${baseName(summary.repoRoot)}`;
  if (result.ok) {
    const taskId = result.value.taskId ?? "the task";
    const line = result.value.started ? `Started ${taskId}: ${where}.` : `Saved ${taskId} to the backlog: ${where}.`;
    tell(host, line);
    return { outcome: result.value.started ? "started" : "backlog", line, ...(result.value.taskId ? { taskId: result.value.taskId } : {}) };
  }
  // A start the daemon refused after filing the task: the task exists, shelved.
  const filed = result.kind === "refused" && typeof result.body.taskId === "string" ? result.body.taskId : null;
  if (filed && result.kind === "refused") {
    const line = `Saved ${filed} to the backlog; it did not start: ${result.error}`;
    tell(host, line);
    return { outcome: "backlog", line, taskId: filed };
  }
  return fail(host, result);
}

/** What the Repo question came to: a tagged answer, so a repository named `cancelled` is not a cancel. */
type RepoAnswer = { kind: "none" } | { kind: "cancelled" } | { kind: "repo"; value: string };

/** Asks the Repo page, or the free-text question when the page's own Other is picked. */
async function askRepo(host: FlowHost, pages: ReturnType<typeof pagesOf>): Promise<RepoAnswer> {
  if (pages.length === 0) return { kind: "none" };
  const pick = await askPages(host, pages);
  if (pick.kind === "dismissed") return { kind: "cancelled" };
  if (pick.kind === "other") return { kind: "repo", value: pick.text };
  if (pick.value !== "other") return { kind: "repo", value: pick.value };
  const typed = await askText(host, "Repo", NEEDS_REPO_QUESTION);
  return typed === undefined ? { kind: "cancelled" } : { kind: "repo", value: typed };
}

/**
 * Takes a fresh draft to its confirm: a repository the draft still needs is asked for first, and
 * a description it still needs is requested in the prompt box.
 */
export async function completeDraft(
  host: FlowHost,
  session: FlowSession,
  first: HomeDispatchDraftSummary,
  intent: DispatchIntent | undefined,
): Promise<FlowResult> {
  let summary = first;
  if (summary.needs.includes("repo")) {
    // The same three attempts createDraftAsking gives: a refused name is asked about again, and
    // the last refusal is shown as written.
    let question = NEEDS_REPO_QUESTION;
    for (let tries = 0; ; tries += 1) {
      const named = await askText(host, "Repo", question);
      if (named === undefined) return cancel(host, session, summary.draftId);
      const updated = await updateDraft(host, session, summary.draftId, { repo: named });
      if (updated.ok) {
        summary = updated.value;
        break;
      }
      if (updated.kind !== "refused" || !isRepoSelectorRefusal(updated) || tries === 2) return fail(host, updated);
      question = `${updated.error}. ${NEEDS_REPO_QUESTION}`;
    }
  }
  return summary.needs.includes("description")
    ? requestDescription(host, session, summary)
    : confirmLoop(host, session, summary, intent);
}

/**
 * The whole dispatch flow (7.11): Start (launcher entry only), Kind, After work, Repo, the draft,
 * the description, the confirm. Every step that needs the person is a dialog the daemon built.
 */
export async function runDispatchFlow(host: FlowHost, session: FlowSession, input: DispatchInput): Promise<FlowResult> {
  const first = await fetchOptions(host, session, {
    entry: input.entry,
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.words ? { brief: input.words } : {}),
  });
  if (!first.ok) return fail(host, first);

  const start = pagesOf(first.value.questions, "start");
  if (start.length > 0) {
    const pick = await askPages(host, start);
    if (pick.kind !== "pick") return stop(host);
    if (pick.value === "check-in") {
      if (session.live && !session.live()) return ended();
      await host.paneOpen({ tab: "needs-you", focus: true, ...(session.live ? { guard: session.live } : {}) });
      return { outcome: "pane", line: "" };
    }
    // Work in this session: the person goes on with their own work.
    if (pick.value === "work-here") return stop(host);
  }

  let kind = input.kind;
  if (!kind) {
    const pick = await askPages(host, pagesOf(first.value.questions, "kind"));
    if (pick.kind !== "pick") return stop(host);
    kind = pick.value as TaskKind;
  }

  // Everything that depends on the kind: After work, and Repo outside a repository.
  const next = input.kind && input.entry !== "first-message"
    ? first
    : await fetchOptions(host, session, { entry: "command", kind });
  if (!next.ok) return fail(host, next);
  let workflowId: string | undefined;
  const afterPages = pagesOf(next.value.questions, "after-work");
  if (afterPages.length > 0) {
    const pick = await askPages(host, afterPages);
    if (pick.kind !== "pick") return stop(host);
    workflowId = pick.value;
  }
  let repo = input.repo;
  if (repo === undefined) {
    const picked = await askRepo(host, pagesOf(next.value.questions, "repo"));
    if (picked.kind === "cancelled") return stop(host);
    if (picked.kind === "repo") repo = picked.value;
  }

  const created = await createDraftAsking(host, session, {
    kind,
    ...(workflowId === undefined ? {} : { workflowId }),
    ...(repo === undefined ? {} : { repo }),
    ...(input.words === undefined ? {} : { words: input.words }),
    ...(input.context === undefined ? {} : { context: input.context }),
    ...(input.intent === undefined ? {} : { intent: input.intent }),
  });
  if (!created.ok) return created.kind === "cancelled" ? stop(host) : fail(host, created);

  return completeDraft(host, session, created.value, input.intent);
}

/**
 * A blank `/mission-dispatch` while a draft waits for its description. The first time it asks
 * again for the description (and fills the prompt box again); the second drops the draft, so a
 * person who changed their mind is not stuck. Returns null when the flow should start over.
 */
export async function remindOrDropWaitingDraft(host: FlowHost, session: FlowSession, draftId: string): Promise<FlowResult | null> {
  // The waiting-draft read that led here may have outlasted the session.
  if (session.live && !session.live()) return { outcome: "cancelled", line: CANCELLED_LINE };
  const reminded = session.reminded ?? new Set<string>();
  if (!reminded.has(draftId)) {
    reminded.add(draftId);
    try {
      await host.fillPrompt("/mission-dispatch ", session.live);
    } catch {
      // The notice below says what to type.
    }
    if (session.live && !session.live()) return { outcome: "cancelled", line: CANCELLED_LINE };
    host.notice(`${DESCRIBE_NOTICE} ${DROP_HINT}`);
    return { outcome: "waiting", line: DESCRIBE_NOTICE };
  }
  reminded.delete(draftId);
  await confirmDraft(host, session, draftId, "cancel");
  if (session.live && !session.live()) return { outcome: "cancelled", line: CANCELLED_LINE };
  await host.paneState.set("draftId", null);
  host.notice(DROPPED_NOTICE);
  return null;
}
