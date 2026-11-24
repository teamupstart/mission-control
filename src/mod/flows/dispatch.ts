import type { DispatchIntent, HomeDispatchDraftSummary, HomeDispatchOptionsRequest } from "@shared/home-dispatch.ts";
import type { TaskKind } from "@shared/types.ts";
import { DAEMON_DOWN_NOTICE, TOKEN_REFUSED_NOTICE } from "../core.ts";
import type { ModHost } from "../host.ts";
import { askPages, askText, pagesOf } from "./dialogs.ts";
import { confirmDraft, createDraft, fetchOptions, updateDraft, type FlowSession, type Outcome } from "./routes.ts";

/**
 * The dispatch dialogs and the draft (spec 7.5, 7.6, 7.11). P11 owns this file.
 *
 * Who owns what. The daemon owns the dispatch pages (Start, Kind, After work, Repo: their questions,
 * options and order), the draft summary text and every refusal sentence; the mod shows those as
 * written and never reorders or rewords a daemon option, asks for a harness, or retries a refusal
 * with changes the person did not ask for. The mod owns its own dialogs: the Confirm dialog (Start now,
 * Save to backlog, Change something, Cancel, with the intent's choice first) and the two free-text
 * prompts it asks under Other (the task description, and a repository the daemon could not resolve).
 * Home-dispatched tasks pass no runtime override anywhere (Focus guard 1): nothing here names one.
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
/** The one line shown when the pane cannot be placed (7.11); `command.ts` re-exports it. */
export const PANE_WIDER_NOTICE = "the pane will open when the window is wider";
export const CANCELLED_NOTICE = "Cancelled. Nothing was created.";
export const NEEDS_REPO_QUESTION = "Which repo is this for? Type a folder name or a path under Other.";

type FlowHost = Pick<ModHost, "ask" | "notice" | "toast" | "fetch" | "fillPrompt" | "paneOpen" | "paneState">;
type Failed = Extract<Outcome<unknown>, { ok: false }>;
type Refused = Extract<Outcome<unknown>, { ok: false; kind: "refused" }>;

export interface DispatchInput {
  /**
   * `first-message` asks the Start page first: it is the launcher's entry, and the bare
   * `/mission-dispatch` command uses it too. `command` (a brief, or a kind and its text) skips Start;
   * `conversation` is the wire value for a dispatch made in conversation (the `start_dispatch` tool
   * drafts directly and never asks the options route).
   */
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
function tell(host: FlowHost, session: FlowSession, line: string): void {
  // The daemon's answer is the truth whether or not the session is still there (the result carries
  // it), but its notice and toast would land in whichever session is current now.
  if (gone(session)) return;
  host.notice(line);
  host.toast(line);
}

/**
 * The daemon's own answer for a draft it does not have (expired, replaced, spent). Any other 404
 * (a missing route, a proxy) says nothing about the draft, so it is an error, not an expiry.
 */
export function isNoSuchDraft(outcome: Outcome<unknown>): boolean {
  return !outcome.ok && outcome.kind === "refused" && outcome.status === 404 && outcome.error === "no such draft";
}

/** Shows what went wrong as written and ends the flow. */
export function fail(host: FlowHost, outcome: Failed, session?: FlowSession): FlowResult {
  // The session ended under an open dialog: nothing was filed, and there is no one to tell.
  if (outcome.kind === "ended") return { outcome: "cancelled", line: CANCELLED_LINE };
  const line = isNoSuchDraft(outcome)
    ? EXPIRED_NOTICE
    : unreachableLine(outcome);
  // The line is the truth for the caller (the tool returns it) whether or not the session is still
  // there; only the notice is for the person, and it must not land in whichever session is current now.
  if (!session || !gone(session)) host.notice(line);
  return { outcome: "refused", line };
}

const baseName = (path: string): string => path.split("/").filter(Boolean).at(-1) ?? path;

/** The repository answers 400 with `unknown repository {name}` or `{name} matches {a}, {b}` (7.20). */
export function isRepoSelectorRefusal(outcome: Refused): boolean {
  return outcome.status === 400
    && (outcome.error.startsWith("unknown repository ")
      || outcome.error.startsWith("not a repository: ")
      // The daemon's ambiguity sentence is `{name} matches {path}, {path}`: a name (no slash), then at least
      // two absolute paths (it is only said when more than one repository matches).
      || /^[^/\n]+ matches \/.+, \//.test(outcome.error));
}

/** How many times a repository the daemon cannot resolve is tried in all, wherever it is asked. */
const REPO_ATTEMPTS = 3;

/**
 * The one policy for a repository the daemon refuses to resolve (7.20), shared by creating a draft
 * with a repository named up front and completing a draft that still needs one: `attempt` is tried
 * with the repository (none at first, unless `askFirst`), and each repository refusal is asked about
 * again in the person's words under Other, for `REPO_ATTEMPTS` attempts in all. The last refusal is
 * returned to be shown as written (asking again would only discard the answer), as is any refusal that
 * is not about the repository. `cancelled` means the person gave up at the question.
 */
async function retryRepository<T>(
  host: FlowHost,
  attempt: (repo: string | undefined) => Promise<Outcome<T>>,
  options: { askFirst: boolean },
): Promise<Outcome<T> | { ok: false; kind: "cancelled" }> {
  let repo: string | undefined;
  if (options.askFirst) {
    repo = await askText(host, "Repo", NEEDS_REPO_QUESTION);
    if (repo === undefined) return { ok: false, kind: "cancelled" };
  }
  for (let tries = 1; ; tries += 1) {
    const result = await attempt(repo);
    if (result.ok || result.kind !== "refused" || !isRepoSelectorRefusal(result)) return result;
    if (tries >= REPO_ATTEMPTS) return result;
    repo = await askText(host, "Repo", `${result.error}. ${NEEDS_REPO_QUESTION}`);
    if (repo === undefined) return { ok: false, kind: "cancelled" };
  }
}

/** Creates the draft, asking again about a repository the daemon cannot resolve (see `retryRepository`). */
export async function createDraftAsking(
  host: FlowHost,
  session: FlowSession,
  fields: Parameters<typeof createDraft>[2],
): Promise<Outcome<HomeDispatchDraftSummary> | { ok: false; kind: "cancelled" }> {
  return retryRepository(host, (repo) => createDraft(host, session, repo === undefined ? fields : { ...fields, repo }), { askFirst: false });
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
    // "Waiting" is only true if the next command can find the draft: the write is read back, because
    // the host swallows a refused write and drops a stale session's. Anything else means a typed
    // description would start a new brief, so the description is asked in a dialog instead.
    let saved = false;
    try {
      await host.paneState.set("draftId", summary.draftId);
      // The write may have outlasted the session: say nothing.
      if (session.live && !session.live()) return ended();
      saved = (await host.paneState.get("draftId")) === summary.draftId;
    } catch {
      saved = false;
    }
    // The read-back may have outlasted the session: it is waiting for nobody.
    if (gone(session)) return ended();
    if (saved) {
      host.notice(DESCRIBE_NOTICE);
      return { outcome: "waiting", line: DESCRIBE_NOTICE };
    }
    if (session.live && !session.live()) return ended();
  }
  const words = await askText(host, "Task", "What should this task do? Type it under Other.");
  if (words === undefined) return cancel(host, session, summary.draftId);
  const updated = await updateDraft(host, session, summary.draftId, { words });
  return updated.ok ? confirmLoop(host, session, updated.value, undefined) : fail(host, updated);
}

async function cancel(host: FlowHost, session: FlowSession, draftId: string): Promise<FlowResult> {
  // A cancel the daemon never hears leaves a draft that expires on its own (7.6).
  await confirmDraft(host, session, draftId, "cancel");
  // The draft is cancelled either way; only a session that is still there is told.
  if (session.live && !session.live()) return ended();
  host.notice(CANCELLED_NOTICE);
  return { outcome: "cancelled", line: CANCELLED_LINE };
}

/** Whether the Claude session that started the flow has ended. */
function gone(session: FlowSession): boolean {
  return session.live !== undefined && !session.live();
}

/** The session ended under the flow: there is no one left to tell, so it ends quietly (cf. fail() for `ended`). */
function ended(): FlowResult {
  return { outcome: "cancelled", line: CANCELLED_LINE };
}

/** A dismissed dialog counts as Cancel (7.11); before a draft exists there is nothing to cancel at the daemon. */
function stop(host: FlowHost, session: FlowSession): FlowResult {
  // A session that has ended is not told it was cancelled.
  if (gone(session)) return ended();
  host.notice(CANCELLED_NOTICE);
  return { outcome: "cancelled", line: CANCELLED_LINE };
}

/**
 * A description given while a draft waits for it (7.11): the text, word for word. `null` means
 * the draft is gone (expired, replaced, confirmed), and the caller treats the text as a new brief.
 */
export async function describeDraft(host: FlowHost, session: FlowSession, draftId: string, words: string): Promise<FlowResult | null> {
  const updated = await updateDraft(host, session, draftId, { words });
  // The waiting marker goes only when the draft is spent or gone. A daemon that was briefly down,
  // or any other refusal, leaves the draft (and its kind, after work and repo) waiting, so typing
  // the description again reaches it instead of starting over.
  const spent = updated.ok || isNoSuchDraft(updated);
  if (spent) {
    session.reminded?.delete(draftId);
    // Only this session's own marker is cleared: a replacement session may have its own by now.
    if (!session.live || session.live()) await host.paneState.set("draftId", null);
  }
  if (updated.ok) return confirmLoop(host, session, updated.value, undefined);
  if (isNoSuchDraft(updated)) return null;
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
    // Nothing is shown to a session that has ended.
    if (gone(session)) return ended();
    host.notice(summary.text);
    const options = intent === "backlog"
      ? [CONFIRM_BACKLOG, CONFIRM_START, CONFIRM_CHANGE, CONFIRM_CANCEL]
      : [CONFIRM_START, CONFIRM_BACKLOG, CONFIRM_CHANGE, CONFIRM_CANCEL];
    const answer = await host.ask({ header: "Confirm", question: "Start this task?", options });
    if (answer.kind !== "pick" || answer.label === CONFIRM_CANCEL.label) return cancel(host, session, summary.draftId);
    if (answer.label === CONFIRM_START.label) return file(host, session, summary, "start");
    if (answer.label === CONFIRM_BACKLOG.label) return file(host, session, summary, "backlog");
    // The answer may have arrived after the session ended: no notice or dialog follows it.
    if (gone(session)) return ended();
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
  const kind = await askPages(host, pagesOf(kinds.value.questions, "kind"), session);
  if (kind.kind !== "pick") return cancel(host, session, summary.draftId);
  let updated = await updateDraft(host, session, summary.draftId, { kind: kind.value as TaskKind });
  if (!updated.ok) return fail(host, updated);
  const after = await fetchOptions(host, session, { entry: "command", kind: kind.value as TaskKind });
  if (!after.ok) return fail(host, after);
  const afterPages = pagesOf(after.value.questions, "after-work");
  if (afterPages.length > 0) {
    const pick = await askPages(host, afterPages, session);
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
    tell(host, session, line);
    return { outcome: result.value.started ? "started" : "backlog", line, ...(result.value.taskId ? { taskId: result.value.taskId } : {}) };
  }
  // A start the daemon refused after filing the task: the task exists, shelved.
  const filed = result.kind === "refused" && typeof result.body.taskId === "string" ? result.body.taskId : null;
  if (filed && result.kind === "refused") {
    const line = `Saved ${filed} to the backlog; it did not start: ${result.error}`;
    tell(host, session, line);
    return { outcome: "backlog", line, taskId: filed };
  }
  // A refusal to a confirm can arrive after the session ended (the reply is kept): the result carries it.
  return fail(host, result, session);
}

/** What the Repo question came to: a tagged answer, so a repository named `cancelled` is not a cancel. */
type RepoAnswer = { kind: "none" } | { kind: "cancelled" } | { kind: "repo"; value: string };

/** Asks the Repo page, or the free-text question when the page's own Other is picked. */
async function askRepo(host: FlowHost, session: FlowSession, pages: ReturnType<typeof pagesOf>): Promise<RepoAnswer> {
  if (pages.length === 0) return { kind: "none" };
  const pick = await askPages(host, pages, session);
  if (pick.kind === "dismissed") return { kind: "cancelled" };
  if (pick.kind === "other") return { kind: "repo", value: pick.text };
  if (pick.value !== "other") return { kind: "repo", value: pick.value };
  // No second dialog for a session that ended under the first.
  if (gone(session)) return { kind: "cancelled" };
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
    // The same policy as creating a draft with a repository named up front.
    const draftId = summary.draftId;
    const updated = await retryRepository(host, (repo) => updateDraft(host, session, draftId, { repo: repo ?? "" }), { askFirst: true });
    if (!updated.ok) return updated.kind === "cancelled" ? cancel(host, session, draftId) : fail(host, updated);
    summary = updated.value;
  }
  return summary.needs.includes("description")
    ? requestDescription(host, session, summary)
    : confirmLoop(host, session, summary, intent);
}

/**
 * The whole dispatch flow (7.11): Start (the launcher and a bare `/mission-dispatch`), Kind, After
 * work, Repo, the draft, the description, the confirm. The pages come from the daemon; the description and repository
 * prompts and the Confirm dialog are the mod's own (see the file header).
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
    const pick = await askPages(host, start, session);
    if (pick.kind !== "pick") return stop(host, session);
    if (pick.value === "check-in") {
      if (session.live && !session.live()) return ended();
      const placed = await host.paneOpen({ tab: "needs-you", focus: true, ...(session.live ? { guard: session.live } : {}) });
      // A session that ended mid-open is also reported as not placed; it is told nothing.
      if (session.live && !session.live()) return ended();
      // The same line the pane commands give: a narrow window must not look like the pick was ignored.
      if (!placed.isPlaced) host.notice(PANE_WIDER_NOTICE);
      return { outcome: "pane", line: "" };
    }
    // Work in this session: the person goes on with their own work.
    if (pick.value === "work-here") return stop(host, session);
    // The Start answer may have arrived after the session ended: no Kind dialog for a session that is gone.
    if (gone(session)) return ended();
  }

  let kind = input.kind;
  if (!kind) {
    const pick = await askPages(host, pagesOf(first.value.questions, "kind"), session);
    if (pick.kind !== "pick") return stop(host, session);
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
    const pick = await askPages(host, afterPages, session);
    if (pick.kind !== "pick") return stop(host, session);
    workflowId = pick.value;
    // Likewise before the Repo dialog.
    if (gone(session)) return ended();
  }
  let repo = input.repo;
  if (repo === undefined) {
    const picked = await askRepo(host, session, pagesOf(next.value.questions, "repo"));
    if (picked.kind === "cancelled") return stop(host, session);
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
  if (!created.ok) return created.kind === "cancelled" ? stop(host, session) : fail(host, created);

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
  // Clearing the marker may have outlasted the session: nothing is said and nothing starts over.
  if (gone(session)) return ended();
  host.notice(DROPPED_NOTICE);
  return null;
}
