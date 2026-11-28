import { HOME_DISPATCH_OFFERED_KINDS, recommendKind } from "@shared/dispatch-options.ts";
import type { DispatchIntent } from "@shared/home-dispatch.ts";
import { DEFAULT_TASK_KIND, type TaskKind } from "@shared/types.ts";
import type { ModHost } from "../host.ts";
import { CANCELLED_LINE, completeDraft, createDraftAsking, fail } from "./dispatch.ts";
import type { FlowSession } from "./routes.ts";

/**
 * The `start_dispatch` tool, the quick path (spec 7.20). P11 owns this file.
 *
 * Claude splits the person's request into `brief` (their words, unchanged) and `context` (what
 * those words point to). The mod makes the draft, shows the summary and the confirm dialog at
 * once with the intent's choice first, and returns only the receipt line, `cancelled`, or the
 * refusal text. Nothing the person picked reaches the model beyond that line.
 */

export interface StartDispatchInput {
  brief?: unknown;
  context?: unknown;
  intent?: unknown;
  kind?: unknown;
  repo?: unknown;
}

type ToolHost = Pick<ModHost, "ask" | "notice" | "toast" | "fetch" | "fillPrompt" | "paneOpen" | "paneState">;

/** What the model is told the tool is for (7.20). Kept here so a test can pin its promises. */
export const START_DISPATCH_DESCRIPTION = [
  "Start or save a task in Mission Control, after the person confirms it in a dialog.",
  "Call it when the person asks, at any point, to run, start, send, dispatch or delegate something in Mission Control, or to schedule, queue or save it to Mission Control's backlog.",
  "Pass the person's words about the task unchanged as `brief`, and what they point to in the conversation (what \"this\" means, files, errors, decisions so far) as `context`. Never put secrets in `context`.",
  "Set `intent` to `now` or `backlog`. Pass `repo` only when the person named one, as a folder name or a path.",
  "If neither the words nor the conversation say what the task should do, ask the person one question first.",
  "If Claude Code reports that this tool has no handler, tell the person to use /mission-dispatch. Never submit the command for them.",
  "Afterwards, go straight back to the work in progress with no further questions, and never change the session's files, branch or working folder for the dispatch.",
].join(" ");

export const START_DISPATCH_SCHEMA = {
  type: "object",
  properties: {
    brief: { type: "string", description: "The person's words about the task, exactly as they typed them." },
    context: { type: "string", description: "What the person's words point to in the conversation." },
    intent: { type: "string", enum: ["now", "backlog"] },
    kind: { type: "string", description: "Only when the person named a kind." },
    repo: { type: "string", description: "Only when the person named a repository: a folder name or a path." },
  },
  required: ["brief"],
} as const;

/** The one line the intent nudge attaches to a matching prompt (7.20). */
export function intentNudge(intent: DispatchIntent): string {
  const what = intent === "now" ? "run this now" : "save this to the backlog";
  return `The person asked to ${what} in Mission Control. Call start_dispatch with intent ${intent}. Then return to what you were doing.`;
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value : undefined);

/** The kind the quick path drafts with: the one named, else the recommendation, else the default (a recommendation of chat counts as none). */
function kindFor(input: StartDispatchInput, brief: string, context: string | undefined): TaskKind {
  const named = typeof input.kind === "string" ? HOME_DISPATCH_OFFERED_KINDS.find((kind) => kind === input.kind) : undefined;
  if (named) return named;
  const recommended = recommendKind(context ? `${brief} ${context}` : brief);
  return recommended && HOME_DISPATCH_OFFERED_KINDS.includes(recommended) ? recommended : DEFAULT_TASK_KIND;
}

/** Runs one dispatch from the model's call and answers with the line the model sees. */
export async function runStartDispatchTool(host: ToolHost, session: FlowSession, input: StartDispatchInput): Promise<string> {
  const brief = text(input.brief);
  if (brief === undefined) return "start_dispatch needs a brief: the person's words about the task.";
  const context = text(input.context);
  const intent: DispatchIntent = input.intent === "backlog" ? "backlog" : "now";
  const repo = text(input.repo);

  const created = await createDraftAsking(host, session, {
    kind: kindFor(input, brief, context),
    words: brief,
    ...(context === undefined ? {} : { context }),
    intent,
    ...(repo === undefined ? {} : { repo }),
  });
  if (!created.ok) return created.kind === "cancelled" ? CANCELLED_LINE : fail(host, created).line;
  const result = await completeDraft(host, session, created.value, intent);
  return result.line;
}
