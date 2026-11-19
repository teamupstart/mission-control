/**
 * The six dispatch MCP tools (spec 2.3, 7.10): names, input schemas and the result shape.
 * Browser-safe. `src/mcp/home-dispatch/index.ts` registers them; later packages fill them in.
 */
import { z } from "zod";
import { ANSWER_ACTIONS, AnswerRequestSchema, DispatchEntrySchema, DraftIntentSchema, HomeDispatchKindSchema } from "./home-dispatch.ts";

/** Registered in the `mission-control` server, outside workers, only while the flag is on. */
export const HOME_DISPATCH_MCP_TOOLS = [
  "start_dispatch",
  "submit_brief",
  "checkin",
  "read_inbox",
  "answer_task",
  "read_dispatch_options",
] as const;
export type HomeDispatchMcpTool = (typeof HOME_DISPATCH_MCP_TOOLS)[number];

export const StartDispatchInputSchema = z.object({
  entry: DispatchEntrySchema.optional(),
  brief: z.string().optional(),
  kind: HomeDispatchKindSchema.optional(),
  intent: DraftIntentSchema.optional(),
  context: z.string().optional(),
  repo: z.string().optional(),
});

export const SubmitBriefInputSchema = z.object({
  draftId: z.string().min(1),
  words: z.string().optional(),
  context: z.string().optional(),
  repo: z.string().optional(),
});

export const CheckinInputSchema = z.object({});
export const ReadInboxInputSchema = z.object({});

/** `answer_task` mirrors the answers route without the caller fields. */
export const AnswerTaskInputSchema = z.object({
  action: z.enum(ANSWER_ACTIONS),
  reviewId: z.string().min(1),
  option: z.string().optional(),
  text: z.string().optional(),
  revisionHash: z.string().optional(),
});

/**
 * Why an `answer_task` input would be refused, or null when it fits its action. The answers
 * route's `AnswerRequestSchema` is the one owner of the per-action rules: this adds only the
 * caller fields the tool does not carry (the daemon fills in the real ones) and asks that
 * schema, so the tool and the route can never accept different requests. The tool's own input
 * schema stays one flat object because MCP publishes a plain object.
 */
export function answerTaskProblem(input: z.infer<typeof AnswerTaskInputSchema>): string | null {
  const parsed = AnswerRequestSchema.safeParse({ ...input, sessionId: "answer-task", cwd: "answer-task" });
  if (parsed.success) return null;
  const issue = parsed.error.issues[0];
  const field = issue?.path.join(".");
  return field && field !== "action" ? field + ": " + issue?.message : (issue?.message ?? "invalid input");
}

export const ReadDispatchOptionsInputSchema = z.object({
  kind: HomeDispatchKindSchema.optional(),
  brief: z.string().optional(),
  entry: DispatchEntrySchema.optional(),
});

/** Every tool result carries one of these outcomes in `structuredContent`. */
export const HOME_DISPATCH_TOOL_OUTCOMES = [
  "draft", "started", "saved", "cancelled", "expired", "work-here", "open",
  "fallback", "off", "not-implemented",
] as const;

export const HomeDispatchToolResultSchema = z.object({
  outcome: z.enum(HOME_DISPATCH_TOOL_OUTCOMES),
  draftId: z.string().optional(),
  needs: z.array(z.string()).optional(),
  receipt: z.string().optional(),
});
export type HomeDispatchToolResult = z.infer<typeof HomeDispatchToolResultSchema>;

/** What a tool says when the daemon answers 404 `This feature is disabled.` (7.1). */
export const HEADLESS_MODE_OFF_TEXT = "headless mode is off";

// `answer_task` must stay assignable to the route body it mirrors.
export type AnswerTaskInput = z.infer<typeof AnswerTaskInputSchema>;
export type AnswerRouteAction = z.infer<typeof AnswerRequestSchema>["action"];
