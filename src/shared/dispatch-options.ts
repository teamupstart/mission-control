/**
 * Guided dispatch choices (headless mode, spec 7.5, 7.6). Pure and browser-safe: the daemon
 * gathers the facts (repositories, workflows, settings), and everything below turns them into
 * the two shapes of the same choices (`forms` and `questions`), so their values cannot differ.
 *
 * Every list comes from a registry: kinds from `TASK_KIND_INFO` and `HOME_DISPATCH_KIND_ORDER`,
 * defaults from `taskDefaultWorkflowId`. Nothing here spells a kind out by hand except the
 * hint words, which are the one place the spec fixes them.
 */
import { AFTER_WORK_NONE, afterWorkFor, UNAVAILABLE_WORKFLOW_LABEL } from "./after-work.ts";
import type {
  DispatchChoice,
  DispatchForm,
  DispatchOptionsRequest,
  DispatchOptionsResponse,
  DispatchQuestion,
  HomeDispatchKind,
} from "./home-dispatch.ts";
import { DISPATCH_QUESTION_MAX_OPTIONS, HOME_DISPATCH_KIND_ORDER } from "./home-dispatch.ts";
import {
  hasReviewableDiff,
  TASK_KIND_INFO,
  taskDefaultWorkflowId,
  type KindWorkflowDefaults,
} from "./task.ts";
import { DEFAULT_TASK_KIND, type TaskKind } from "./types.ts";

// ---- after work ------------------------------------------------------------------------

/**
 * The after-work workflow a new task of this kind arms when its creator named none (spec 7.5).
 * The dashboard's dispatch modal and the home-session forms both ask this, so a parity test can
 * fail when they disagree. It is `taskDefaultWorkflowId` under the name the spec gives it.
 */
export function kindAfterWork(
  kind: TaskKind,
  configured: KindWorkflowDefaults,
  storage: "repository" | "local" = "repository",
): string | null {
  return taskDefaultWorkflowId(kind, configured, storage);
}

// ---- recommendation --------------------------------------------------------------------

/** Hint words per kind (spec 7.5). Matched as whole words, so `fixture` never counts as `fix`. */
export const KIND_HINTS: Readonly<Record<HomeDispatchKind, readonly string[]>> = {
  ship: ["build", "add", "implement", "change", "refactor", "upgrade"],
  bugfix: ["fix", "repair", "broken", "flaky", "regression", "crash", "bug"],
  plan: ["design", "architect", "plan", "propose", "spec"],
  scout: ["investigate", "find out", "audit", "research", "which", "why"],
  document: ["document", "explain", "write up", "docs", "readme"],
  chat: ["discuss", "talk through", "brainstorm"],
};

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countHint(text: string, hint: string): number {
  const phrase = hint.split(/\s+/).map(escapeRegExp).join("\\s+");
  return text.match(new RegExp(`(?<![a-z0-9])${phrase}(?![a-z0-9])`, "g"))?.length ?? 0;
}

/**
 * The kind a piece of text most suggests, or null for no match. Counts whole-word hint
 * matches; a tie goes to the kind earlier in `HOME_DISPATCH_KIND_ORDER`.
 */
export function recommendKind(text: string | undefined | null): HomeDispatchKind | null {
  const lower = (text ?? "").toLowerCase();
  if (lower.trim() === "") return null;
  let best: HomeDispatchKind | null = null;
  let bestCount = 0;
  for (const kind of HOME_DISPATCH_KIND_ORDER) {
    const count = KIND_HINTS[kind].reduce((sum, hint) => sum + countHint(lower, hint), 0);
    if (count > bestCount) {
      best = kind;
      bestCount = count;
    }
  }
  return best;
}

// ---- paging and schemas ----------------------------------------------------------------

export const MORE_OPTION: DispatchChoice = { value: "more", label: "More..." };

/**
 * Pages of at most four options for `AskUserQuestion`. Every page except the last ends with
 * `{ value: "more", label: "More..." }`, which takes one of its four places.
 */
export function pageOptions(options: readonly DispatchChoice[]): DispatchChoice[][] {
  const max = DISPATCH_QUESTION_MAX_OPTIONS;
  const pages: DispatchChoice[][] = [];
  let rest = [...options];
  while (rest.length > max) {
    pages.push([...rest.slice(0, max - 1), MORE_OPTION]);
    rest = rest.slice(max - 1);
  }
  if (rest.length > 0) pages.push(rest);
  return pages;
}

/** An MCP elicitation `requestedSchema`: one required string field, a `oneOf` in option order. */
export function elicitationSchemaFor(
  form: Pick<DispatchForm, "title" | "options" | "default">,
  field: string,
): {
  type: "object";
  properties: Record<string, {
    type: "string";
    title: string;
    oneOf: { const: string; title: string }[];
    default: string;
  }>;
  required: string[];
} {
  return {
    type: "object",
    properties: {
      [field]: {
        type: "string",
        title: form.title,
        oneOf: form.options.map((option) => ({ const: option.value, title: option.label })),
        default: form.default,
      },
    },
    required: [field],
  };
}

// ---- the choices -----------------------------------------------------------------------

export const START_WORK_HERE = "work-here" as const;
export const START_CHECK_IN = "check-in" as const;
export const START_DISPATCH = "dispatch" as const;
export const REPO_OTHER = "other" as const;

export const START_FORM_TITLE = "What do you want to do?";
export const AFTER_WORK_FORM_TITLE = "What runs after the work?";
export const REPO_FORM_TITLE = "Which repo is this for?";

export interface DispatchWorkflowFact {
  id: string;
  name: string;
}

export interface DispatchOptionsFacts {
  /** The request, as the route validated it. */
  request: Pick<DispatchOptionsRequest, "kind" | "brief" | "entry">;
  /** True when `cwd` is inside a repository: the repository question is then never asked. */
  cwdInRepo: boolean;
  /** Workspace repositories, as absolute paths. */
  repos: readonly string[];
  /** Active, published workflows, in the order the dashboard lists them. */
  workflows: readonly DispatchWorkflowFact[];
  configured: KindWorkflowDefaults;
  storage: "repository" | "local";
  /** The dashboard's guided dispatch setting. Off removes Form 2, never the launcher form. */
  guidedDispatch: boolean;
}

function folderName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed;
}

/** The kinds Form 1 offers: every home-dispatch kind except chat, in order. */
export function startFormKinds(): HomeDispatchKind[] {
  return HOME_DISPATCH_KIND_ORDER.filter((kind) => kind !== "chat");
}

function kindChoice(kind: HomeDispatchKind): DispatchChoice {
  const info = TASK_KIND_INFO[kind];
  return { value: kind, label: `${info.label}: ${info.blurb}` };
}

function startForm(facts: DispatchOptionsFacts): DispatchForm | null {
  if (facts.request.kind !== undefined) return null;
  const options: DispatchChoice[] = [
    ...startFormKinds().map(kindChoice),
    { value: START_WORK_HERE, label: "Work in this session" },
    { value: START_CHECK_IN, label: "Check in on my tasks" },
  ];
  const recommended = recommendKind(facts.request.brief);
  const offered = recommended !== null && options.some((option) => option.value === recommended);
  const fallbackDefault = facts.request.entry === "first-message" ? START_WORK_HERE : DEFAULT_TASK_KIND;
  return {
    id: "start",
    title: START_FORM_TITLE,
    options,
    default: offered ? recommended : fallbackDefault,
  };
}

/**
 * The after-work choices for a kind, the kind's default first. The default stays in the list
 * when its workflow is archived or unpublished, labelled `Unavailable workflow`, as the
 * dashboard does.
 */
export function afterWorkChoices(
  kind: TaskKind,
  facts: Pick<DispatchOptionsFacts, "workflows" | "configured" | "storage">,
): { options: DispatchChoice[]; default: string } {
  const defaultId = kindAfterWork(kind, facts.configured, facts.storage);
  const labelOf = (workflow: DispatchWorkflowFact): string => afterWorkFor(workflow).label;
  const none: DispatchChoice = { value: AFTER_WORK_NONE, label: "None" };
  const others = facts.workflows.filter((workflow) => workflow.id !== defaultId);
  const options: DispatchChoice[] = [];
  if (defaultId === null) {
    options.push(none);
  } else {
    const known = facts.workflows.find((workflow) => workflow.id === defaultId);
    options.push({ value: defaultId, label: known ? labelOf(known) : UNAVAILABLE_WORKFLOW_LABEL });
    options.push(none);
  }
  for (const workflow of others) options.push({ value: workflow.id, label: labelOf(workflow) });
  return { options, default: defaultId ?? AFTER_WORK_NONE };
}

function afterWorkForm(facts: DispatchOptionsFacts): DispatchForm | null {
  const kind = facts.request.kind;
  if (kind === undefined || !facts.guidedDispatch || !hasReviewableDiff(kind)) return null;
  const choices = afterWorkChoices(kind, facts);
  if (choices.options.length === 1 && choices.options[0]!.value === AFTER_WORK_NONE) return null;
  return { id: "afterWork", title: AFTER_WORK_FORM_TITLE, ...choices };
}

function repoChoices(facts: DispatchOptionsFacts): DispatchChoice[] {
  return [
    ...facts.repos.map((path) => ({ value: path, label: folderName(path), description: path })),
    { value: REPO_OTHER, label: "Another repository" },
  ];
}

function repoForm(facts: DispatchOptionsFacts): DispatchForm | null {
  if (facts.cwdInRepo || facts.repos.length === 0) return null;
  const options = repoChoices(facts);
  return { id: "repo", title: REPO_FORM_TITLE, options, default: options[0]!.value };
}

function questionsFor(header: string, question: string, options: readonly DispatchChoice[]): DispatchQuestion[] {
  const pages = pageOptions(options);
  return pages.map((page, index) => ({
    header,
    question: pages.length > 1 ? `${question} (${index + 1} of ${pages.length})` : question,
    options: page,
  }));
}

function fallbackQuestions(facts: DispatchOptionsFacts): DispatchQuestion[] {
  const questions: DispatchQuestion[] = [];
  const { kind } = facts.request;
  if (kind === undefined) {
    questions.push(
      ...questionsFor("Start", START_FORM_TITLE, [
        { value: START_WORK_HERE, label: "Work in this session" },
        { value: START_DISPATCH, label: "Dispatch a task to Mission Control" },
        { value: START_CHECK_IN, label: "Check in on my tasks" },
      ]),
    );
  }
  if (!facts.cwdInRepo && facts.repos.length > 0) {
    questions.push(...questionsFor("Repo", REPO_FORM_TITLE, repoChoices(facts)));
  }
  if (kind === undefined) {
    // The fallback keeps chat: it is a plain conversation choice, not a created task.
    questions.push(...questionsFor("Kind", "What kind of task is this?", HOME_DISPATCH_KIND_ORDER.map(kindChoice)));
  } else if (facts.guidedDispatch && hasReviewableDiff(kind)) {
    const choices = afterWorkChoices(kind, facts);
    if (!(choices.options.length === 1 && choices.options[0]!.value === AFTER_WORK_NONE)) {
      questions.push(...questionsFor("After work", AFTER_WORK_FORM_TITLE, choices.options));
    }
  }
  return questions;
}

function fallbackTextFor(questions: readonly DispatchQuestion[]): string {
  return questions
    .map((question) => {
      const lines = question.options.map((option, index) => `  ${index + 1}. ${option.label} [${option.value}]`);
      return [`${question.header}: ${question.question}`, ...lines].join("\n");
    })
    .join("\n\n");
}

/** Both shapes of the same choices, built from one set of facts. */
export function buildDispatchOptions(facts: DispatchOptionsFacts): DispatchOptionsResponse {
  const questions = fallbackQuestions(facts);
  return {
    forms: { start: startForm(facts), afterWork: afterWorkForm(facts), repo: repoForm(facts) },
    questions,
    fallbackText: fallbackTextFor(questions),
  };
}

// ---- briefs and the summary ------------------------------------------------------------

/**
 * Exactly what the worker will receive. The person's words are unchanged. When Claude added
 * context, it follows under its own heading, so the two are never merged. There is no template.
 */
export function briefText(input: { words: string; context?: string | null }): string {
  const context = (input.context ?? "").trim();
  if (context === "") return input.words;
  return `${input.words}\n\n## Context Claude added\n${context}`;
}

/** The Form 3 message (spec 7.6). */
export function summaryText(input: {
  repoLabel: string;
  kindLabel: string;
  afterWork: string | null;
  afterWorkApplies: boolean;
  words: string;
  context: string;
}): string {
  const after = input.afterWork ?? (input.afterWorkApplies ? "None" : "None (no diff)");
  const lines = [
    `Repo: ${input.repoLabel}`,
    `Kind: ${input.kindLabel}`,
    `After work: ${after}`,
    "",
    "Description:",
    input.words,
  ];
  if (input.context.trim() !== "") lines.push("", "Context Claude added:", input.context.trim());
  return lines.join("\n");
}
