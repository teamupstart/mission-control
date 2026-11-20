import { randomUUID } from "node:crypto";
import { isAbsolute, resolve as resolvePath } from "node:path";
import type { Handler } from "hono";
import {
  HOME_DISPATCH_KINDS,
  UNAVAILABLE_WORKFLOW_LABEL,
  briefText,
  draftSummaryText,
  kindAfterWork,
} from "@shared/dispatch-options.ts";
import {
  HomeDispatchDraftConfirmSchema,
  HomeDispatchDraftCreateSchema,
  HomeDispatchDraftUpdateSchema,
  type HomeDispatchConfirmResult,
  type HomeDispatchDraftSummary,
} from "@shared/home-dispatch.ts";
import { TASK_KIND_INFO, hasReviewableDiff, taskKindAllowsBacklog, taskKindBacklogRefusal } from "@shared/task.ts";
import type { Task, TaskKind } from "@shared/types.ts";
import { grillFirstDispatchBlock } from "../grill-first.ts";
import { parseBody } from "../http-body.ts";
import { openDb } from "../db.ts";
import { PlanStoreError } from "../plans/store.ts";
import { planDispatchBlock } from "../plans/skills.ts";
import { listRepos, resolveRepoRoot } from "../repos.ts";
import { prepareTaskRepositories } from "../task-repository-preparation.ts";
import { TaskDependencyError, TaskEffortUnsupportedError, TaskPersonaError } from "../tasks.ts";
import { getWorkflowPolicy } from "../workflows/config.ts";
import { defaultPlanStorage, publishedWorkflows } from "./options.ts";
import { requireHomeSession, type HomeSessionRow } from "./sessions.ts";
import type { HomeDispatchDeps, HomeDispatchHandler } from "./stub.ts";

// Owner: P5. Drafts and starting a task (spec 7.6). A draft is the daemon's record of the
// person's picks, so the mod never holds a task half built. Starting files the task through
// the same pieces `create_task` uses (a shelved backlog row), stamps where it came from, and
// starts it through the same path as `dispatch_task`. It passes no runtime anywhere, so the
// task gets the runtime a dashboard task of its kind gets and Focus works on it (plan 4.2).

/** A draft expires this long after its last change (7.6). */
export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

interface Draft {
  id: string;
  sessionId: string;
  /** The repository the task runs in, or null until one is chosen. */
  repoRoot: string | null;
  kind: TaskKind;
  /** `undefined` follows the kind's default after work, `null` is None. */
  workflowId: string | null | undefined;
  words: string;
  context: string | null;
  changedAt: number;
  /** Set while a confirm is filing this draft, so a second confirm or an edit cannot race it. */
  confirming: boolean;
}

/** In memory, one per session, replaced by the next one that session creates. */
const drafts = new Map<string, Draft>();

/** Orders creates by when they started, so a slower earlier create cannot overwrite a newer draft. */
let ticketCounter = 0;

/**
 * The newest create each session has committed. It outlives the draft (a confirm removes the
 * draft, not this), and is swept with the drafts once it is older than the draft lifetime.
 */
const committedCreate = new Map<string, { ticket: number; at: number }>();

/** Forget every draft. For tests, and nothing else. */
export function clearHomeDispatchDrafts(): void {
  drafts.clear();
  committedCreate.clear();
}

function liveDraft(sessionId: string, id: string | undefined): Draft | null {
  const draft = drafts.get(sessionId);
  if (!draft) return null;
  if (Date.now() - draft.changedAt > DRAFT_TTL_MS) {
    drafts.delete(sessionId);
    return null;
  }
  return id === undefined || draft.id === id ? draft : null;
}

function sweepExpired(): void {
  const now = Date.now();
  for (const [sessionId, draft] of drafts) if (now - draft.changedAt > DRAFT_TTL_MS) drafts.delete(sessionId);
  for (const [sessionId, last] of committedCreate) if (now - last.at > DRAFT_TTL_MS) committedCreate.delete(sessionId);
}

type Failure = { ok: false; status: 400 | 403 | 404 | 409 | 503; body: Record<string, unknown> };
const fail = (status: Failure["status"], error: string, extra: Record<string, unknown> = {}): Failure => ({
  ok: false,
  status,
  body: { error, ...extra },
});

/** The wire value of a workflow pick: `none` is an explicit None, absent follows the default. */
function workflowPick(value: string | undefined): string | null | undefined {
  return value === undefined ? undefined : value === "none" ? null : value;
}

/** Why a picked Workflow cannot be filed, or null. Asked when it is picked and again when the task is filed. */
function selectionBlock(deps: HomeDispatchDeps, workflowId: string | null | undefined): Failure | null {
  if (!workflowId) return null;
  if (!deps.workflows) return fail(503, "Workflow manager unavailable");
  const blocked = deps.workflows.workflowSelectionBlock(workflowId);
  return blocked ? fail(409, blocked.message, blocked.fix ? { fix: blocked.fix } : {}) : null;
}

/** The kind checks 7.6 gives a draft: a kind with no backlog (chat) is refused with its own sentence. */
function kindRefusal(kind: TaskKind): Failure | null {
  if (!taskKindAllowsBacklog(kind)) return fail(400, taskKindBacklogRefusal(kind));
  if (!HOME_DISPATCH_KINDS.some((offered) => offered === kind)) {
    return fail(400, `a ${kind} task cannot be dispatched from a session`);
  }
  return null;
}

/**
 * The repository a `repo` selector names (7.20): a path, or the folder name of a workspace
 * repository, matched exactly and case-insensitively. A path that is not a repository is
 * `not a repository: {path}`; a name nothing or several things match is refused with that.
 */
async function resolveRepoSelector(selector: string, session: HomeSessionRow): Promise<{ ok: true; repoRoot: string } | Failure> {
  if (isAbsolute(selector) || selector.includes("/")) {
    const path = isAbsolute(selector) ? selector : resolvePath(session.cwd, selector);
    const root = await resolveRepoRoot(path);
    return root ? { ok: true, repoRoot: root } : fail(400, `not a repository: ${path}`);
  }
  const wanted = selector.toLowerCase();
  const roots = new Set<string>();
  for (const path of await listRepos().catch(() => [] as string[])) {
    if (path.split("/").filter(Boolean).at(-1)?.toLowerCase() !== wanted) continue;
    const root = await resolveRepoRoot(path);
    if (root) roots.add(root);
  }
  const matches = [...roots].sort();
  if (matches.length === 0) return fail(400, `unknown repository ${selector}`);
  if (matches.length > 1) return fail(400, `${selector} matches ${matches.join(", ")}`);
  return { ok: true, repoRoot: matches[0]! };
}

/** The summary the mod shows the person (7.6). Everything on it is derived from the draft. */
function summarize(deps: HomeDispatchDeps, draft: Draft): HomeDispatchDraftSummary {
  const effective = draft.workflowId === undefined
    ? kindAfterWork(draft.kind, getWorkflowPolicy().kindWorkflowDefaults, defaultPlanStorage())
    : draft.workflowId;
  const applies = hasReviewableDiff(draft.kind);
  const named = effective ? publishedWorkflows(deps).find((workflow) => workflow.id === effective)?.name : undefined;
  const afterWork = effective ? (named ?? UNAVAILABLE_WORKFLOW_LABEL) : applies ? "None" : "None (no diff)";
  const kindLabel = TASK_KIND_INFO[draft.kind].label;
  const repoRoot = draft.repoRoot ?? "";
  const needs: string[] = [];
  if (draft.words.trim() === "") needs.push("description");
  if (!draft.repoRoot) needs.push("repo");
  return {
    draftId: draft.id,
    repoRoot,
    kind: draft.kind,
    kindLabel,
    afterWork,
    afterWorkApplies: applies,
    words: draft.words,
    context: draft.context,
    needs,
    brief: briefText({ words: draft.words, context: draft.context }),
    text: draftSummaryText({ repoRoot, kindLabel, afterWork, words: draft.words, context: draft.context }),
  };
}

/** The home session a draft route acts for, or the refusal to answer with. */
function actingSession(deps: HomeDispatchDeps, sessionId: string): { ok: true; session: HomeSessionRow } | Failure {
  const home = requireHomeSession(deps, sessionId);
  return home.ok ? home : fail(home.refusal.status, home.refusal.reason);
}

/** `POST /dispatch/drafts` (7.6). `intent` only sets which confirm choice the mod preselects, so it is not stored. */
export const createDraftHandler: HomeDispatchHandler = (deps): Handler => async (c) => {
  const parsed = await parseBody(c, HomeDispatchDraftCreateSchema);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;
  const acting = actingSession(deps, body.sessionId);
  if (!acting.ok) return c.json(acting.body, acting.status);
  const refused = kindRefusal(body.kind);
  if (refused) return c.json(refused.body, refused.status);
  const ticket = ++ticketCounter;
  const workflowId = workflowPick(body.workflowId);
  const blocked = selectionBlock(deps, workflowId);
  if (blocked) return c.json(blocked.body, blocked.status);
  let repoRoot = acting.session.repoRoot;
  if (body.repo !== undefined) {
    const resolved = await resolveRepoSelector(body.repo, acting.session);
    if (!resolved.ok) return c.json(resolved.body, resolved.status);
    repoRoot = resolved.repoRoot;
  }
  if ((committedCreate.get(body.sessionId)?.ticket ?? 0) > ticket) {
    return c.json({ error: "a newer draft was started for this session" }, 409);
  }
  sweepExpired();
  const draft: Draft = {
    id: randomUUID(),
    sessionId: body.sessionId,
    repoRoot,
    kind: body.kind,
    workflowId,
    words: body.words ?? "",
    context: body.context?.trim() || null,
    changedAt: Date.now(),
    confirming: false,
  };
  drafts.set(body.sessionId, draft);
  committedCreate.set(body.sessionId, { ticket, at: draft.changedAt });
  return c.json(summarize(deps, draft));
};

/** `POST /dispatch/drafts/{id}` (7.6). A kind change without a workflow returns after work to the new kind's default. */
export const updateDraftHandler: HomeDispatchHandler = (deps): Handler => async (c) => {
  const parsed = await parseBody(c, HomeDispatchDraftUpdateSchema);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;
  const acting = actingSession(deps, body.sessionId);
  if (!acting.ok) return c.json(acting.body, acting.status);
  const draft = liveDraft(body.sessionId, c.req.param("id"));
  if (!draft) return c.json({ error: "no such draft" }, 404);
  if (draft.confirming) return c.json({ error: "this draft is being confirmed" }, 409);
  if (body.kind !== undefined) {
    const refused = kindRefusal(body.kind);
    if (refused) return c.json(refused.body, refused.status);
  }
  const workflowId = workflowPick(body.workflowId);
  const blocked = selectionBlock(deps, workflowId);
  if (blocked) return c.json(blocked.body, blocked.status);
  let repoRoot = draft.repoRoot;
  if (body.repo !== undefined) {
    const resolved = await resolveRepoSelector(body.repo, acting.session);
    if (!resolved.ok) return c.json(resolved.body, resolved.status);
    repoRoot = resolved.repoRoot;
  }
  if (draft.confirming || drafts.get(body.sessionId) !== draft) {
    return c.json({ error: "this draft is being confirmed" }, 409);
  }
  if (body.kind !== undefined && body.kind !== draft.kind) {
    draft.kind = body.kind;
    draft.workflowId = undefined;
  }
  if (workflowId !== undefined) draft.workflowId = workflowId;
  draft.repoRoot = repoRoot;
  if (body.words !== undefined) draft.words = body.words;
  if (body.context !== undefined) draft.context = body.context.trim() || null;
  draft.changedAt = Date.now();
  return c.json(summarize(deps, draft));
};

/**
 * Files the draft as a shelved backlog task, the way `create_task` does: the same repository
 * preparation, creation policy and Workflow checks. No runtime is chosen anywhere here, and
 * the origin is stamped in the same tick as the row, before anything else can read it.
 */
async function fileTask(
  deps: HomeDispatchDeps,
  draft: Draft,
  session: HomeSessionRow,
  start: boolean,
): Promise<{ ok: true; task: Task } | Failure> {
  const prepared = await prepareTaskRepositories({
    primary: draft.repoRoot!,
    extras: [],
    kind: draft.kind,
    shortNameSelectors: "none",
  });
  if (!prepared.ok) return fail(prepared.status, prepared.error);
  let policy;
  try {
    policy = deps.tasks.prepareCreationPolicy({ kind: draft.kind, workflowId: draft.workflowId });
  } catch (error) {
    if (error instanceof PlanStoreError) return fail(409, error.message);
    throw error;
  }
  if (policy.workflowId) {
    if (!deps.workflows) return fail(503, "Workflow manager unavailable");
    const blocked = start
      ? deps.workflows.dispatchWorkflowBlock(policy.workflowId, prepared.agent, prepared.repoRoot)
      : deps.workflows.workflowSelectionBlock(policy.workflowId);
    if (blocked) return fail(409, blocked.message, blocked.fix ? { fix: blocked.fix } : {});
  }
  if (start) {
    const block = planDispatchBlock({ kind: draft.kind, agent: prepared.agent })
      ?? grillFirstDispatchBlock({ kind: draft.kind, agent: prepared.agent, grillFirst: policy.grillFirst });
    if (block) return fail(409, block);
  }
  try {
    const task = deps.tasks.create({
      repoRoot: prepared.repoRoot,
      extraRepoRoots: prepared.extraRepoRoots,
      intent: briefText({ words: draft.words, context: draft.context }),
      kind: draft.kind,
      agent: prepared.agent,
      workflowId: policy.workflowId,
      enabled: false,
      backlog: true,
    }, undefined, undefined, policy);
    stampTaskOrigin(task.id, "home-session", session.repoRoot, session.sessionId);
    return { ok: true, task };
  } catch (error) {
    if (error instanceof TaskDependencyError || error instanceof PlanStoreError) return fail(409, error.message);
    if (error instanceof TaskEffortUnsupportedError || error instanceof TaskPersonaError) return fail(400, error.message);
    throw error;
  }
}

/**
 * Records where a task came from (spec 2.4). `origin_repo` is the caller's own repository even
 * when the task targets another, so the task shows in that session's pane (7.6).
 */
export function stampTaskOrigin(
  taskId: string,
  surface: "home-session" | "mctl",
  originRepo: string | null,
  originSessionId: string | null,
): void {
  openDb()
    .prepare(`UPDATE tasks SET origin_surface = ?, origin_repo = ?, origin_session_id = ? WHERE id = ?`)
    .run(surface, originRepo, originSessionId, taskId);
}

/**
 * `POST /dispatch/drafts/{id}/confirm` (7.6). Cancel, and any confirm that files a task (even if
 * the start then fails), delete the draft. A refusal before the task exists (a missing field, or
 * a refusal from filing) keeps the draft and releases its claim, so the same draft can be retried.
 */
export const confirmDraftHandler: HomeDispatchHandler = (deps): Handler => async (c) => {
  const parsed = await parseBody(c, HomeDispatchDraftConfirmSchema);
  if (!parsed.ok) return parsed.res;
  const body = parsed.data;
  const acting = actingSession(deps, body.sessionId);
  if (!acting.ok) return c.json(acting.body, acting.status);
  const draft = liveDraft(body.sessionId, c.req.param("id"));
  if (!draft) return c.json({ error: "no such draft" }, 404);
  if (draft.confirming) return c.json({ error: "this draft is being confirmed" }, 409);

  /** Removes this draft only, never a newer one the session has created since. */
  const spend = () => { if (drafts.get(body.sessionId) === draft) drafts.delete(body.sessionId); };
  const result = (taskId: string | null, started: boolean): HomeDispatchConfirmResult =>
    ({ choice: body.choice, taskId, started });
  if (body.choice === "cancel") {
    spend();
    return c.json(result(null, false));
  }
  if (draft.words.trim() === "") return c.json({ error: "the task needs a description" }, 400);
  if (!draft.repoRoot) return c.json({ error: "the task needs a repo" }, 400);

  // Claimed before the first await, so a second confirm cannot file the same draft again. A
  // refusal before the task exists releases the claim, so the person can fix it and retry.
  draft.confirming = true;
  let filed: Awaited<ReturnType<typeof fileTask>>;
  try {
    filed = await fileTask(deps, draft, acting.session, body.choice === "start");
  } catch (error) {
    draft.confirming = false;
    throw error;
  }
  if (!filed.ok) {
    draft.confirming = false;
    return c.json(filed.body, filed.status);
  }
  // The task exists from here on, so the draft is spent whatever the start does.
  spend();
  if (body.choice === "backlog") return c.json(result(filed.task.id, false));

  // The same call `dispatch_task` makes. Not the operator's, so a launch hold still stands.
  // An exception from the launch must not hide the task id: the task is already filed.
  const started = await deps.tasks.dispatch(filed.task.id, { overrideDisabled: true })
    .catch((error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }));
  if (!started.ok) {
    return c.json({ error: started.error, taskId: filed.task.id, started: false }, 409);
  }
  return c.json(result(filed.task.id, true));
};
