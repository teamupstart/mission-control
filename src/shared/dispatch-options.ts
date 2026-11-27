import { afterWorkFor, kindAfterWork } from "./after-work.ts";
import type { HomeDispatchOptionsRequest } from "./home-dispatch.ts";
import {
  HARNESS_LAUNCHED_TASK_KINDS,
  TASK_KIND_INFO,
  hasReviewableDiff,
  type HarnessLaunchedTaskKind,
  type KindWorkflowDefaults,
} from "./task.ts";
import { DEFAULT_TASK_KIND, type TaskKind } from "./types.ts";

/**
 * Dispatch dialog content for headless mode (spec 7.5, 7.6): the kinds a home session offers,
 * their order, the recommendation, the pages and the brief text. The daemon builds the pages
 * with `buildDispatchQuestions` and the dispatch form reads the same after-work rule. This
 * module is browser safe (no `node:` imports) so the mod and `mctl` can import it too, but
 * neither does yet. Nothing here may be copied into a surface by hand.
 */

export { afterWorkFor, kindAfterWork };

/** The kinds a home session may dispatch: the ones Mission Control launches a harness for. */
export const HOME_DISPATCH_KINDS = HARNESS_LAUNCHED_TASK_KINDS;

/**
 * Where each home kind sits in the kind page. A `Record` over the home kinds rather than a
 * second list of them, so a kind added to the registry does not compile until it has a place.
 */
const KIND_RANK: Record<HarnessLaunchedTaskKind, number> = {
  ship: 0,
  bugfix: 1,
  plan: 2,
  scout: 3,
  document: 4,
  chat: 5,
};

/**
 * The order the kind page lists them in, and the order that breaks a recommendation tie:
 * ship, bugfix, plan, scout, document, chat (7.5).
 */
export const HOME_DISPATCH_KIND_ORDER: readonly HarnessLaunchedTaskKind[] =
  [...HOME_DISPATCH_KINDS].sort((a, b) => KIND_RANK[a] - KIND_RANK[b]);

/** Whole words or phrases that point at a kind (7.5). */
export const KIND_HINTS: Readonly<Record<HarnessLaunchedTaskKind, readonly string[]>> = {
  bugfix: ["fix", "repair", "broken", "flaky", "regression", "crash", "bug"],
  ship: ["build", "add", "implement", "change", "refactor", "upgrade"],
  plan: ["design", "architect", "plan", "propose", "spec"],
  scout: ["investigate", "find out", "audit", "research", "which", "why"],
  document: ["document", "explain", "write up", "docs", "readme"],
  chat: ["discuss", "talk through", "brainstorm"],
};

function hintCount(text: string, hints: readonly string[]): number {
  let count = 0;
  for (const hint of hints) {
    const escaped = hint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
    count += text.match(new RegExp(`\\b${escaped}\\b`, "gi"))?.length ?? 0;
  }
  return count;
}

/**
 * The kind whose hint words occur most in `text`, counting whole-word matches. A tie goes to
 * the kind earlier in `HOME_DISPATCH_KIND_ORDER`, and no match returns null.
 */
export function recommendKind(text: string): TaskKind | null {
  let best: TaskKind | null = null;
  let bestCount = 0;
  for (const kind of HOME_DISPATCH_KIND_ORDER) {
    const count = hintCount(text, KIND_HINTS[kind]);
    if (count > bestCount) {
      best = kind;
      bestCount = count;
    }
  }
  return best;
}

/** One option of a dialog page. */
export interface DispatchOption {
  value: string;
  label: string;
  description?: string;
}

/** Claude Code's question dialog holds at most four options. */
export const DISPATCH_PAGE_SIZE = 4;

/** The option that leads to the next page. */
export const MORE_OPTION: DispatchOption = { value: "more", label: "More..." };

/**
 * Splits a list into dialog pages of at most four options. Every page except the last ends
 * with `More...`, so it holds three real options and the last page holds the remaining two to
 * four. A list that fits one page is returned as is.
 */
export function pageOptions<T extends DispatchOption>(options: readonly T[]): Array<Array<T | DispatchOption>> {
  const pages: Array<Array<T | DispatchOption>> = [];
  let rest = options.slice();
  while (rest.length > DISPATCH_PAGE_SIZE) {
    pages.push([...rest.slice(0, DISPATCH_PAGE_SIZE - 1), MORE_OPTION]);
    rest = rest.slice(DISPATCH_PAGE_SIZE - 1);
  }
  pages.push(rest);
  return pages;
}

/** One question of the dialog, as `POST /dispatch/dispatch-options` returns it (7.5). */
export interface DispatchQuestion {
  id: "start" | "kind" | "after-work" | "repo";
  header: string;
  question: string;
  options: DispatchOption[];
}

/** What the daemon knows that the pages depend on. */
export interface DispatchQuestionFacts {
  entry: HomeDispatchOptionsRequest["entry"];
  kind?: TaskKind;
  brief?: string;
  /** Whether `cwd` is inside a repository. */
  inRepository: boolean;
  /** Absolute paths of the workspace repositories. */
  workspaceRepos: readonly string[];
  /** Every active published Workflow. */
  workflows: ReadonlyArray<{ id: string; name: string }>;
  /** The operator's per-kind After work rows (`WorkflowPolicy.kindWorkflowDefaults`). */
  configured: KindWorkflowDefaults;
  /** Where a new plan is stored, for the plan kind's default. */
  planStorage: "repository" | "local";
}

/** The kinds the kind page offers: every home kind except chat, which `create_task` cannot file. */
export const HOME_DISPATCH_OFFERED_KINDS: readonly TaskKind[] = HOME_DISPATCH_KIND_ORDER.filter((kind) => kind !== "chat");

/** The offered kinds with the recommended one first. */
export function kindsInOrder(brief: string | undefined): TaskKind[] {
  const recommended = brief ? recommendKind(brief) : null;
  const first = recommended && HOME_DISPATCH_OFFERED_KINDS.includes(recommended) ? recommended : DEFAULT_TASK_KIND;
  return [first, ...HOME_DISPATCH_OFFERED_KINDS.filter((kind) => kind !== first)];
}

/** Whether a kind's after-work page is asked at all: a kind with no diff has nothing to review. */
export function asksAfterWork(kind: TaskKind): boolean {
  return hasReviewableDiff(kind);
}

/** The label the After work page and the draft summary give a Workflow that cannot be found. */
export const UNAVAILABLE_WORKFLOW_LABEL = "Unavailable workflow";

function pagesFor(
  id: DispatchQuestion["id"],
  header: string,
  question: string,
  options: readonly DispatchOption[],
): DispatchQuestion[] {
  return pageOptions(options).map((page) => ({ id, header, question, options: page as DispatchOption[] }));
}

/**
 * The dialog pages for a dispatch (7.5), in the order they are asked: Start, Kind, After work,
 * Repo. A question with more than four options is several consecutive pages with the same id.
 *
 * Start is only for the launcher (`first-message`). Kind is absent once a kind is known.
 * After work needs the kind, so it is built only when `kind` is given, and is absent for a kind
 * with no diff and when only None would be offered. Repo is absent inside a repository or when
 * the workspace has none.
 */
export function buildDispatchQuestions(facts: DispatchQuestionFacts): DispatchQuestion[] {
  const questions: DispatchQuestion[] = [];

  if (facts.entry === "first-message") {
    questions.push(...pagesFor("start", "Start", "What do you want to do?", [
      { value: "dispatch", label: "Dispatch a task" },
      { value: "check-in", label: "Check in on my tasks" },
      { value: "work-here", label: "Work in this session" },
    ]));
  }

  if (!facts.kind) {
    questions.push(...pagesFor("kind", "Kind", "What kind of task?", kindsInOrder(facts.brief).map((kind) => ({
      value: kind,
      label: `${TASK_KIND_INFO[kind].label}: ${TASK_KIND_INFO[kind].blurb}`,
    }))));
  }

  if (facts.kind && asksAfterWork(facts.kind)) {
    const afterWork = afterWorkOptions(facts);
    if (afterWork.length > 1) {
      questions.push(...pagesFor("after-work", "After work", "What runs after the work?", afterWork));
    }
  }

  if (!facts.inRepository && facts.workspaceRepos.length > 0) {
    questions.push(...pagesFor("repo", "Repo", "Which repo is this for?", [
      ...facts.workspaceRepos.map((path) => ({
        value: path,
        label: path.split("/").filter(Boolean).at(-1) ?? path,
        description: path,
      })),
      { value: "other", label: "Other" },
    ]));
  }

  return questions;
}

/** The kind's default first, then None, then every other active published Workflow. */
function afterWorkOptions(facts: DispatchQuestionFacts): DispatchOption[] {
  const kind = facts.kind!;
  const defaultId = kindAfterWork(kind, facts.configured, facts.planStorage);
  const none: DispatchOption = { value: "none", label: "None" };
  const known = new Map(facts.workflows.map((workflow) => [workflow.id, afterWorkFor(workflow)]));
  const options: DispatchOption[] = [];
  if (defaultId) {
    const choice = known.get(defaultId);
    options.push({
      value: defaultId,
      label: choice ? choice.label : UNAVAILABLE_WORKFLOW_LABEL,
      description: `Default for ${TASK_KIND_INFO[kind].label}`,
    });
  }
  options.push(none);
  for (const [id, choice] of known) {
    if (id !== defaultId) options.push({ value: id, label: choice.label });
  }
  return options;
}

/**
 * What the worker receives (7.6): the person's words unchanged, and, when Claude added
 * context, a blank line, `## Context Claude added` and the context. There is no template.
 */
export function briefText(input: { words: string; context?: string | null }): string {
  const context = input.context?.trim() ?? "";
  return context ? `${input.words}\n\n## Context Claude added\n${context}` : input.words;
}

/**
 * What a shaper receives from a home-session brief (7.20, D62): the person's own words as
 * `task`, and Claude's added context as its own field. They are never joined, unlike
 * `briefText`, which is what the worker reads. A shaper that must show the person's words
 * back unchanged would otherwise print Claude's paraphrase as if the person had written it.
 */
export function shaperInputFor(input: { words: string; context?: string | null }): { task: string; context: string | null } {
  const context = input.context?.trim() ?? "";
  return { task: input.words, context: context === "" ? null : context };
}

/** The Form 3 message of a draft summary (7.6). The words and the context are never merged. */
export function draftSummaryText(input: {
  repoRoot: string;
  kindLabel: string;
  afterWork: string;
  words: string;
  context: string | null;
}): string {
  const lines = [
    `Repo: ${input.repoRoot}`,
    `Kind: ${input.kindLabel}`,
    `After work: ${input.afterWork}`,
    "",
    "Description:",
    input.words,
  ];
  if (input.context) lines.push("", "Context Claude added:", input.context);
  return lines.join("\n");
}
