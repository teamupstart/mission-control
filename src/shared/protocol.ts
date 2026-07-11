import { z } from "zod";

/**
 * Payload a Claude Code hook posts to the daemon. The hook script forwards the
 * raw event JSON plus the terminal env it captured (pane ids), which the daemon
 * uses to bind the event to a discovered session.
 */
export const HookIngestSchema = z.object({
  event: z.string(),
  sessionId: z.string().nullable().optional().default(null),
  cwd: z.string().nullable().optional().default(null),
  ts: z.number().optional(),
  env: z
    .object({
      tmuxPane: z.string().optional(),
      weztermPane: z.string().optional(),
      termProgram: z.string().optional(),
    })
    .default({}),
  // Selected fields lifted from the raw hook JSON; everything is optional.
  toolName: z.string().optional(),
  prompt: z.string().optional(),
  message: z.string().optional(),
  source: z.string().optional(),
  reason: z.string().optional(),
});

export type HookIngest = z.infer<typeof HookIngestSchema>;

/** A message the user sends into a session from the dashboard. */
export const SendTextSchema = z.object({
  text: z.string().min(1),
  /** Whether to submit (press Enter) after typing. Default true. */
  submit: z.boolean().optional().default(true),
});
export type SendText = z.infer<typeof SendTextSchema>;

const EnvSchema = z
  .object({
    tmuxPane: z.string().optional(),
    weztermPane: z.string().optional(),
    termProgram: z.string().optional(),
  })
  .default({});

/** An MCP-driven agent creating a review item bound to its session's pane. */
export const CreateReviewSchema = z.object({
  env: EnvSchema,
  sessionId: z.string().nullable().optional().default(null),
  cwd: z.string().nullable().optional().default(null),
  kind: z.enum(["plan", "diff", "input"]),
  title: z.string().min(1),
  body: z.string(),
});
export type CreateReview = z.infer<typeof CreateReviewSchema>;

/** The human's decision on a review, from the dashboard. */
export const ResolveReviewSchema = z.object({
  action: z.enum(["approve", "reject", "answer"]),
  response: z.string().nullable().optional().default(null),
});
export type ResolveReview = z.infer<typeof ResolveReviewSchema>;

/** A decision on a no-mistakes gate, from the dashboard. */
export const NomistakesRespondSchema = z.object({
  action: z.enum(["approve", "fix", "skip"]),
  /** Finding ids to fix (with action=fix); empty means all shown findings. */
  findings: z.array(z.string()).optional().default([]),
  instructions: z.string().optional(),
  step: z.string().optional(),
});
export type NomistakesRespond = z.infer<typeof NomistakesRespondSchema>;

/** MCP `report_status`: update the session's activity line. */
export const StatusSchema = z.object({
  env: EnvSchema,
  sessionId: z.string().nullable().optional().default(null),
  activity: z.string().min(1),
});
export type StatusReport = z.infer<typeof StatusSchema>;

/**
 * Dispatch (or queue) a new crewmate: launch an agent in an isolated worktree of
 * `repoRoot` with `intent` as its first prompt. `queue: true` only adds it to the
 * backlog (no worktree/session yet); dispatch it later.
 */
export const DispatchSchema = z.object({
  repoRoot: z.string().min(1),
  intent: z.string().min(1),
  title: z.string().optional(),
  kind: z.enum(["ship", "scout"]).default("ship"),
  agent: z.enum(["claude", "codex"]).default("claude"),
  queue: z.boolean().optional().default(false),
});
export type Dispatch = z.infer<typeof DispatchSchema>;

/** Close a task with a human-recorded outcome (the `/stow` intent -> result loop). */
export const CompleteTaskSchema = z.object({
  outcome: z.string().min(1),
  outcomeUrl: z.string().url().optional(),
});
export type CompleteTask = z.infer<typeof CompleteTaskSchema>;
