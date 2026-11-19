import { randomUUID } from "node:crypto";
import { basename, isAbsolute, resolve } from "node:path";
import { afterWorkFor, UNAVAILABLE_WORKFLOW_LABEL } from "@shared/after-work.ts";
import { briefText, kindAfterWork, summaryText } from "@shared/dispatch-options.ts";
import type {
  DraftConfirm,
  DraftConfirmResult,
  DraftCreate,
  DraftIntent,
  DraftSummary,
  DraftUpdate,
  HomeCaller,
  HomeDispatchKind,
} from "@shared/home-dispatch.ts";
import { DRAFT_TTL_MS } from "@shared/home-dispatch.ts";
import { hasReviewableDiff, TASK_KIND_INFO, taskKindAllowsBacklog, taskKindBacklogRefusal } from "@shared/task.ts";
import { resolveTaskAgent } from "../harnesses.ts";
import { listRepos, resolveRepoRoot, resolveTaskRepoRoot } from "../repos.ts";
import { prepareTaskRepositories } from "../task-repository-preparation.ts";
import { PlanStoreError } from "../plans/store.ts";
import type { HomeDispatchDeps } from "./deps.ts";
import { stampTaskOrigin } from "./origin.ts";
import { dispatchSettings } from "./options.ts";
import type { HomeDispatchResult } from "./stub.ts";

/**
 * A draft is the daemon's record of the person's picks (spec 7.6). It lives in memory only:
 * a session has at most one, under a random id, and it expires `DRAFT_TTL_MS` after its last
 * change. A new draft replaces the session's earlier one.
 */
interface Draft {
  id: string;
  sessionId: string;
  /** The session's own repository: what `origin_repo` records, whatever the task targets. */
  sessionRepo: string | null;
  /** The repository the task will run in, or null until one is chosen. */
  repoRoot: string | null;
  kind: HomeDispatchKind;
  /** `undefined` follows the kind's default after work; `null` is an explicit None. */
  workflowId: string | null | undefined;
  words: string;
  context: string;
  intent: DraftIntent;
  touchedAt: number;
}

const bySession = new Map<string, Draft>();
const byId = new Map<string, Draft>();
let clock: () => number = Date.now;

/** Tests only: drop every draft and (optionally) replace the clock. */
export function resetDraftsForTest(now?: () => number): void {
  bySession.clear();
  byId.clear();
  clock = now ?? Date.now;
}

function forget(draft: Draft): void {
  if (bySession.get(draft.sessionId) === draft) bySession.delete(draft.sessionId);
  byId.delete(draft.id);
}

function remember(draft: Draft): void {
  const earlier = bySession.get(draft.sessionId);
  if (earlier) forget(earlier);
  bySession.set(draft.sessionId, draft);
  byId.set(draft.id, draft);
}

/** The caller's live draft, or null: unknown, expired, or someone else's. */
function draftFor(id: string, caller: HomeCaller): Draft | null {
  const draft = byId.get(id);
  if (!draft) return null;
  if (clock() - draft.touchedAt > DRAFT_TTL_MS) {
    forget(draft);
    return null;
  }
  return draft.sessionId === caller.sessionId ? draft : null;
}

const noDraft = (): HomeDispatchResult<never> => ({ status: 404, body: { error: "no such draft" } });
const refuse = (status: 400 | 409, error: string): HomeDispatchResult<never> => ({ status, body: { error } });

type RepoChoice = { ok: true; repoRoot: string } | { ok: false; result: HomeDispatchResult<never> };

/**
 * A repository named by path or by workspace folder name (spec 7.20). A name is matched
 * exactly and case-insensitively against the workspace repositories.
 */
async function resolveRepoSelector(selector: string, cwd: string): Promise<RepoChoice> {
  const trimmed = selector.trim();
  if (isAbsolute(trimmed) || trimmed.includes("/") || trimmed.startsWith("~")) {
    const path = resolve(cwd, trimmed);
    const resolved = await resolveTaskRepoRoot(path);
    return resolved.ok ? resolved : { ok: false, result: refuse(400, `not a repository: ${path}`) };
  }
  let repos: string[];
  try {
    repos = await listRepos();
  } catch {
    repos = [];
  }
  const wanted = trimmed.toLowerCase();
  const roots = new Set<string>();
  for (const repo of repos) {
    if (basename(repo).toLowerCase() !== wanted) continue;
    const resolved = await resolveTaskRepoRoot(repo);
    if (resolved.ok) roots.add(resolved.repoRoot);
  }
  const matches = [...roots].sort();
  if (matches.length === 0) return { ok: false, result: refuse(400, `unknown repository ${trimmed}`) };
  if (matches.length > 1) return { ok: false, result: refuse(400, `${trimmed} matches ${matches.join(", ")}`) };
  return { ok: true, repoRoot: matches[0]! };
}

function workflowLabel(draft: Draft, deps: HomeDispatchDeps): string | null {
  const settings = dispatchSettings(deps);
  const id = draft.workflowId === undefined
    ? kindAfterWork(draft.kind, settings.configured, settings.storage)
    : draft.workflowId;
  if (id === null) return null;
  const known = settings.workflows.find((workflow) => workflow.id === id);
  return known ? afterWorkFor(known).label : UNAVAILABLE_WORKFLOW_LABEL;
}

function summaryOf(draft: Draft, deps: HomeDispatchDeps): DraftSummary {
  const afterWork = workflowLabel(draft, deps);
  const afterWorkApplies = hasReviewableDiff(draft.kind);
  const needs: DraftSummary["needs"] = [];
  if (draft.words.trim() === "") needs.push("words");
  if (draft.repoRoot === null) needs.push("repo");
  return {
    draftId: draft.id,
    repoRoot: draft.repoRoot,
    kind: draft.kind,
    kindLabel: TASK_KIND_INFO[draft.kind].label,
    afterWork,
    afterWorkApplies,
    words: draft.words,
    context: draft.context,
    needs,
    brief: briefText({ words: draft.words, context: draft.context }),
    text: summaryText({
      repoLabel: draft.repoRoot ?? "(not chosen)",
      kindLabel: TASK_KIND_INFO[draft.kind].label,
      afterWork,
      afterWorkApplies,
      words: draft.words,
      context: draft.context,
    }),
  };
}

/** `POST /mcp/dispatch/drafts` (spec 7.6, 7.20). */
export async function handleCreateDraft(
  input: DraftCreate,
  deps: HomeDispatchDeps = {},
): Promise<HomeDispatchResult<DraftSummary>> {
  if (!taskKindAllowsBacklog(input.kind)) return refuse(400, taskKindBacklogRefusal(input.kind));
  const sessionRepo = await resolveRepoRoot(input.cwd);
  let repoRoot = sessionRepo;
  if (input.repo !== undefined && input.repo.trim() !== "") {
    const chosen = await resolveRepoSelector(input.repo, input.cwd);
    if (!chosen.ok) return chosen.result;
    repoRoot = chosen.repoRoot;
  }
  const draft: Draft = {
    id: randomUUID(),
    sessionId: input.sessionId,
    sessionRepo,
    repoRoot,
    kind: input.kind,
    workflowId: input.workflowId,
    words: input.words ?? "",
    context: input.context ?? "",
    intent: input.intent ?? "now",
    touchedAt: clock(),
  };
  remember(draft);
  return { status: 200, body: summaryOf(draft, deps) };
}

/** `POST /mcp/dispatch/drafts/{id}`: update any of kind, workflow, repo, words and context. */
export async function handleUpdateDraft(
  id: string,
  input: DraftUpdate,
  deps: HomeDispatchDeps = {},
): Promise<HomeDispatchResult<DraftSummary>> {
  const draft = draftFor(id, input);
  if (!draft) return noDraft();
  if (input.kind !== undefined && !taskKindAllowsBacklog(input.kind)) {
    return refuse(400, taskKindBacklogRefusal(input.kind));
  }
  let repoRoot = draft.repoRoot;
  if (input.repo !== undefined && input.repo.trim() !== "") {
    const chosen = await resolveRepoSelector(input.repo, input.cwd);
    if (!chosen.ok) return chosen.result;
    repoRoot = chosen.repoRoot;
  }
  // The draft may have been confirmed or replaced while the repository was resolved.
  if (draftFor(id, input) !== draft) return noDraft();
  draft.repoRoot = repoRoot;
  if (input.kind !== undefined) {
    // Changing the kind without naming a workflow resets after work to the new kind's default.
    if (input.kind !== draft.kind && input.workflowId === undefined) draft.workflowId = undefined;
    draft.kind = input.kind;
  }
  if (input.workflowId !== undefined) draft.workflowId = input.workflowId;
  if (input.words !== undefined) draft.words = input.words;
  if (input.context !== undefined) draft.context = input.context;
  draft.touchedAt = clock();
  return { status: 200, body: summaryOf(draft, deps) };
}

function titleOf(words: string): string {
  const line = words.trim().split(/\r?\n/, 1)[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
}

/** `POST /mcp/dispatch/drafts/{id}/confirm`: start the task, shelve it, or cancel. */
export async function handleConfirmDraft(
  id: string,
  input: DraftConfirm,
  deps: HomeDispatchDeps = {},
): Promise<HomeDispatchResult<DraftConfirmResult>> {
  const draft = draftFor(id, input);
  if (!draft) return noDraft();
  if (input.choice === "cancel") {
    forget(draft);
    return { status: 200, body: { outcome: "cancelled", taskId: null, refusal: null } };
  }
  if (draft.words.trim() === "") return refuse(400, "the task needs a description");
  if (draft.repoRoot === null) return refuse(400, "the task needs a repo");
  const tasks = deps.tasks;
  if (!tasks) return { status: 409, body: { error: "the task manager is not available" } };

  // One draft makes at most one task: take it before any await, so a second confirm is a 404.
  forget(draft);
  let created = false;
  try {
    const kind = draft.kind;
    const prepared = await prepareTaskRepositories({
      primary: draft.repoRoot,
      extras: [],
      kind,
      agent: resolveTaskAgent(kind),
      shortNameSelectors: "none",
    });
    if (!prepared.ok) throw new DraftRefusal(prepared.status, prepared.error);
    const creationPolicy = tasks.prepareCreationPolicy({ kind, workflowId: draft.workflowId });
    const blocked = creationPolicy.workflowId ? await deps.workflows?.workflowSelectionBlock(creationPolicy.workflowId) : null;
    if (blocked) throw new DraftRefusal(409, blocked.message);
    const brief = briefText({ words: draft.words, context: draft.context });
    const task = tasks.create(
      {
        repoRoot: prepared.repoRoot,
        extraRepoRoots: prepared.extraRepoRoots,
        title: titleOf(draft.words),
        intent: brief,
        kind,
        agent: prepared.agent,
        workflowId: creationPolicy.workflowId,
        enabled: false,
        backlog: true,
      },
      undefined,
      undefined,
      creationPolicy,
    );
    created = true;
    stampTaskOrigin(task.id, { surface: "home-session", repo: draft.sessionRepo, sessionId: draft.sessionId });
    if (input.choice === "backlog") return { status: 200, body: { outcome: "saved", taskId: task.id, refusal: null } };
    const started = await tasks.dispatch(task.id, { overrideDisabled: true });
    if (!started.ok) {
      return { status: 200, body: { outcome: "saved", taskId: task.id, refusal: started.error } };
    }
    return { status: 200, body: { outcome: "started", taskId: task.id, refusal: null } };
  } catch (error) {
    // Nothing was created: keep the draft so the person can fix the problem and confirm again.
    // Put it back only if the session has not started a newer draft while this one was out.
    if (!created && !bySession.has(draft.sessionId)) remember(draft);
    if (error instanceof DraftRefusal) return refuse(error.status, error.message);
    if (error instanceof PlanStoreError) return refuse(409, error.message);
    throw error;
  }
}

class DraftRefusal extends Error {
  constructor(readonly status: 400 | 409, message: string) {
    super(message);
  }
}
