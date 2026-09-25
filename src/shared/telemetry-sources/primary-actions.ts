/** Phase 5 operation manifest. Paths select owners and are never exported. */
import { EnsembleActionSchema } from "../protocol.ts";
import { PIPELINE_ACTIONS, PipelineActionRequestSchema } from "../pipeline.ts";

// The domain registries own these verbs. A new generic primitive is automatically named,
// rather than disappearing into an undifferentiated actions endpoint.
const ensembleActions = EnsembleActionSchema.options.map((s) => `ensemble.${s.shape.kind.value}` as const);
const pipelineActions = PIPELINE_ACTIONS.map((verb) => `pipeline.control.${verb}` as const);
export const PRIMARY_ACTION_ROUTES = [
  ["PUT", "/api/setup/checks", "setup.dismiss", "setup"],
  ["POST", "/api/setup/install", "setup.installer_launch", "setup"],
  ["POST", "/api/setup/service", "setup.service_start", "setup"],
  ["PUT", "/api/extensions/pi/config", "setup.pi_configure", "setup"],
  ["PUT", "/api/terminals/config", "setup.terminals_configure", "setup"],
  ["PUT", "/api/repo-index", "setup.repositories_configure", "setup"],
  ["POST", "/api/repo-index/rescan", "setup.repositories_scan", "setup"],
  ["POST", "/api/repos/resolve", "setup.repository_resolve", "setup"],
  ["POST", "/api/pipelines/register", "setup.pipeline_register", "setup"],
  ["POST", "/api/pipelines/install", "setup.pipeline_installer_launch", "setup"],
  ["POST", "/api/tasks", "task.create", "tasks"],
  ["POST", "/mcp/tasks", "task.create", "tasks"],
  ["POST", "/mcp/v2/tasks", "task.create", "tasks"],
  ["POST", "/api/tasks/:id/update", "task.edit", "tasks"],
  ["POST", "/api/tasks/:id/push", "task.publish", "tasks"],
  ["POST", "/api/tasks/:id/reorder", "task.reorder", "tasks"],
  ["POST", "/api/tasks/:id/reschedule", "task.reschedule", "tasks"],
  ["DELETE", "/api/tasks/:id", "task.delete", "tasks"],
  ["PUT", "/api/task-sources/config", "task.sources_configure", "tasks"],
  ["POST", "/api/task-sources/:id/sweep", "task.import", "tasks"],
  ["POST", "/api/task-sources/:id/preflight", "task.source_check", "tasks"],
  ["DELETE", "/api/task-sources/:id/seen", "task.source_reset", "tasks"],
  ["POST", "/api/task-sources/:id/writeback/retry", "task.writeback_retry", "tasks"],
  ["DELETE", "/api/task-sources/:id/writeback", "task.writeback_cancel", "tasks"],
  ["POST", "/api/product-issues/preview", "task.issue_preview", "tasks"],
  ["POST", "/mcp/product-issues/preview", "task.issue_preview", "tasks"],
  ["POST", "/api/product-issues/confirm", "task.issue_confirm", "tasks"],
  ["POST", "/api/product-issues", "task.issue_submit", "tasks"],
  ["POST", "/mcp/product-issues", "task.issue_submit", "tasks"],
  ["POST", "/mcp/reviews", "attention.request", "permissions"],
  ["POST", "/mcp/reviews/:id/detach", "attention.detach", "permissions"],
  ["POST", "/api/reviews/:id/resolve", "attention.resolve", "permissions"],
  ["POST", "/api/sessions/:id/mode/cycle", "permission.mode_cycle", "permissions"],
  ["POST", "/api/sessions/:id/mode", "permission.mode_set", "permissions"],
  ["POST", "/api/sessions/:id/rename", "session.rename", "sessions"],
  ["POST", "/api/sessions/:id/model", "session.model_set", "sessions"],
  ["POST", "/api/sessions/:id/focus", "session.focus", "sessions"],
  ["POST", "/api/sessions/:id/launch", "session.terminal_launch", "sessions"],
  ["POST", "/api/sessions/:id/retro", "session.retro", "sessions"],
  ["POST", "/mcp/retros/no-change", "session.retro_no_change", "sessions"],
  ["POST", "/api/sessions/:id/pending-turns/:turnId/retry", "conversation.retry", "sessions"],
  ["POST", "/api/sessions/:id/pending-turns/:turnId/resolve", "conversation.resolve", "sessions"],
  ["POST", "/api/uploads", "conversation.attach", "sessions"],
  ["POST", "/api/sessions/:id/standards", "session.standards", "sessions"],
  ["PUT", "/api/sessions/:id/file", "file.save", "files"],
  ["POST", "/api/sessions/:id/file-comments", "file.comment", "files"],
  ["POST", "/api/sessions/:id/file-comments/reorder", "file.comments_reorder", "files"],
  ["POST", "/api/file-comments/:id/queue", "file.comment_queue", "files"],
  ["POST", "/api/file-comments/:id/messages", "file.comment_reply", "files"],
  ["POST", "/mcp/file-comments/replies", "file.comment_reply", "files"],
  ["POST", "/api/file-comment-messages/:id", "file.comment_edit", "files"],
  ["POST", "/api/file-comments/:id/read", "file.comment_read", "files"],
  ["POST", "/api/file-comments/:id/status", "file.comment_status", "files"],
  ["DELETE", "/api/file-comments/:id", "file.comment_delete", "files"],
  ["POST", "/api/sessions/:id/file-comment-review", "file.review", "files"],
  ["POST", "/api/sessions/:id/file/open", "file.external_open", "files"],
  ["POST", "/api/session-actions", "library.action_create", "library"],
  ["PATCH", "/api/session-actions/:id", "library.action_edit", "library"],
  ["DELETE", "/api/session-actions/:id", "library.action_archive", "library"],
  ["POST", "/api/workflows/:id/validate", "library.workflow_validate", "library"],
  ["POST", "/api/workflow-bindings/:id/evidence/coverage", "runs.coverage_register", "runs"],
  ["DELETE", "/api/workflow-bindings/:id/evidence/coverage/:clientCriterionId", "runs.coverage_remove", "runs"],
  ["DELETE", "/api/workflow-bindings/:id/evidence/:clientItemId", "runs.evidence_remove", "runs"],
  ["POST", "/api/sessions/:id/workflow-evidence/coverage", "runs.coverage_register", "runs"],
  ["DELETE", "/api/sessions/:id/workflow-evidence/coverage/:clientCriterionId", "runs.coverage_remove", "runs"],
  ["DELETE", "/api/sessions/:id/workflow-evidence/:clientItemId", "runs.evidence_remove", "runs"],
  ["POST", "/api/workflow-bindings/:id/evidence/reattach", "runs.evidence_reattach", "runs"],
  ["POST", "/mcp/workflow-evidence", "runs.evidence_register", "runs"],
  ["POST", "/api/sessions/:id/queue", "queue.enqueue", "queues"],
  ["PATCH", "/api/sessions/:id/queue/:itemId", "queue.edit", "queues"],
  ["DELETE", "/api/sessions/:id/queue/:itemId", "queue.dequeue", "queues"],
  ["PUT", "/api/sessions/:id/queue/order", "queue.reorder", "queues"],
  ["POST", "/api/sessions/:id/queue/:itemId/approve", "queue.approve", "queues"],
  ["PUT", "/api/sessions/:id/queue/:itemId/state", "queue.state", "queues"],
  ["POST", "/api/sessions/:id/queue/:itemId/sent", "queue.sent", "queues"],
  ["POST", "/api/sessions/:id/queue/:itemId/recover", "queue.recover", "queues"],
  ["PUT", "/api/sessions/:id/queue/wrapup", "queue.wrapup_configure", "queues"],
  ["POST", "/api/sessions/:id/queue/reattach", "queue.reattach", "queues"],
  ["PUT", "/api/queues/:key/items/:itemId/state", "queue.state", "queues"],
  ["PUT", "/api/backlog/plan", "queue.plan", "queues"],
  ["POST", "/api/schedules/preview", "schedule.preview", "schedules"],
  ["POST", "/api/schedules", "schedule.create", "schedules"],
  ["POST", "/api/schedules/:id/update", "schedule.edit", "schedules"],
  ["POST", "/api/schedules/:id/set-enabled", "schedule.enable", "schedules"],
  ["POST", "/api/schedules/:id/run-now", "schedule.run_now", "schedules"],
  ["POST", "/api/schedules/:id/archive", "schedule.archive", "schedules"],
  ["POST", "/api/ensembles/preview", "ensemble.preview", "ensembles"],
  ["POST", "/api/ensembles", "ensemble.create", "ensembles"],
  ["POST", "/api/ensembles/:id/actions", "ensemble.action", "ensembles"],
  ["DELETE", "/api/ensembles/:id", "ensemble.delete", "ensembles"],
  ["POST", "/api/ensembles/:id/members/:memberId/submit", "ensemble.submit", "ensembles"],
  ["POST", "/mcp/ensembles/submit", "ensemble.submit", "ensembles"],
  ["POST", "/mcp/pipelines/adopt", "pipeline.adopt", "pipelines"],
  ["POST", "/mcp/pipelines/workspace", "pipeline.workspace", "pipelines"],
  ["PUT", "/api/pipelines/config", "pipeline.configure", "pipelines"],
  ["POST", "/api/pipelines/action", "pipeline.action", "pipelines"],
  ["POST", "/api/pipelines/console", "pipeline.console", "pipelines"],
  ["POST", "/api/tasks/:id/pipeline/readiness", "pipeline.readiness", "pipelines"],
  ["POST", "/api/tasks/:id/pipeline/start", "pipeline.start", "pipelines"],
  ["POST", "/api/tasks/:id/pipeline/retry", "pipeline.retry", "pipelines"],
  ["POST", "/api/tasks/:id/pipeline/successor/refresh", "pipeline.refresh", "pipelines"],
  ["POST", "/api/tasks/:id/pipeline/successor/adopt", "pipeline.successor_adopt", "pipelines"],
  ["POST", "/api/tasks/:id/pipeline/abandon", "pipeline.abandon", "pipelines"],
  ["POST", "/api/tasks/:id/pipeline/cancel", "pipeline.cancel", "pipelines"],
  ["POST", "/api/sessions/:id/foreman-invite", "foreman.invite", "foreman"],
  ["DELETE", "/api/sessions/:id/foreman-invite", "foreman.withdraw", "foreman"],
  ["POST", "/api/sessions/:id/foreman-episode", "foreman.episode", "foreman"],
  ["POST", "/api/sessions/:id/foreman-episode/resolve", "foreman.episode_resolve", "foreman"],
  ["POST", "/api/sessions/:id/queue/wrapup/asked", "foreman.wrapup_asked", "foreman"],
  ["POST", "/api/sessions/:id/queue/wrapup/prompted", "foreman.completion_claim", "foreman"],
  ["POST", "/api/sessions/:id/queue/wrapup/prompted/undelivered", "foreman.completion_undelivered", "foreman"],
  ["POST", "/api/sessions/:id/queue/ship-recovery/claim", "foreman.recovery_claim", "foreman"],
  ["POST", "/api/sessions/:id/queue/ship-recovery/delivery", "foreman.recovery_delivery", "foreman"],
  ["POST", "/api/sessions/:id/workflow-completion", "foreman.workflow_claim", "foreman"],
  ["PUT", "/api/foreman/config", "foreman.configure", "foreman"],
  ["PUT", "/api/foreman/instructions", "foreman.instructions", "foreman"],
  ["POST", "/api/foreman/planner/retry", "foreman.planner_retry", "foreman"],
  ["POST", "/api/pipelines/foreman-episode", "foreman.pipeline_episode", "foreman"],
  ["PUT", "/api/away", "away.configure", "foreman"],
  ["PUT", "/api/sessions/:id/note", "foreman.note", "foreman"],
  ["PUT", "/api/inspector/config", "inspector.configure", "inspector"],
  ["POST", "/api/inspector/resolve-findings", "inspector.resolve", "inspector"],
  ["PUT", "/api/shipping/config", "shipping.configure", "inspector"],
  ["PATCH", "/api/archives/:archiveKey", "archive.edit", "archives"],
  ["POST", "/api/archives/:archiveKey/artifacts/:artifactId/open", "archive.external_open", "archives"],
  ["DELETE", "/api/archives/:archiveKey", "archive.delete", "archives"],
  ["POST", "/mcp/scouts/submit", "archive.scout_submit", "archives"],
  ["POST", "/api/tasks/:id/reclaim", "archive.reclaim", "archives"],
  ["PUT", "/api/keep-awake", "settings.keep_awake", "settings"],
  ["PUT", "/api/ui/config", "settings.appearance", "settings"],
  ["PUT", "/api/cost/config", "settings.cost", "settings"],
  ["PUT", "/api/skills/config", "settings.skills", "settings"],
  ["PUT", "/api/instructions", "settings.instructions", "settings"],
  ["PUT", "/api/llm/config", "settings.automation_models", "settings"],
  ["PUT", "/api/harnesses/config", "settings.harnesses", "settings"],
  ["POST", "/api/settings-backups/:id/restore", "settings.restore", "settings"],
  ["PUT", "/api/worktrees/config", "settings.worktrees", "settings"],
  ["POST", "/api/worktrees/manual/acquire", "worktree.acquire", "settings"],
  ["POST", "/api/worktrees/manual/return", "worktree.return", "settings"],
  ["POST", "/api/worktrees/actions/preview", "worktree.preview", "settings"],
  ["POST", "/api/worktrees/actions/execute", "worktree.execute", "settings"],
  ["POST", "/api/worktrees/:slotId/open", "worktree.open", "settings"],
  ["POST", "/api/tours/:tourId/dispatch", "help.tour_dispatch", "help"],
  ["POST", "/api/tours/:tourId/preview", "help.tour_preview", "help"],
  ["POST", "/api/tours/:tourId/seed-run", "help.tour_seed_run", "help"],
  ["POST", "/api/tours/:tourId/tasks/:id/complete", "help.tour_complete", "help"],
  ["POST", "/api/sessions/:id/pending-turns/:turnId/deliver", "conversation.expedite", "sessions"],
] as const;
export type PrimaryAction = typeof PRIMARY_ACTION_ROUTES[number][2] | typeof ensembleActions[number] | typeof pipelineActions[number];
export type PrimaryFeature = typeof PRIMARY_ACTION_ROUTES[number][3];
export const PRIMARY_FEATURES = [...new Set(PRIMARY_ACTION_ROUTES.map((r) => r[3]))] as [PrimaryFeature, ...PrimaryFeature[]];
export const PRIMARY_ACTION_IDS = [...new Set([...PRIMARY_ACTION_ROUTES.map((r) => r[2]), ...ensembleActions, ...pipelineActions])];
/** Configuration/preview outcomes are still actions; they are not evidence of operating a feature. */
export const PRIMARY_NON_USE_ACTIONS: ReadonlySet<PrimaryAction> = new Set([
  "task.sources_configure", "task.source_check", "task.issue_preview", "file.comment_read",
  "queue.wrapup_configure", "schedule.preview", "schedule.create", "schedule.edit", "schedule.enable", "schedule.archive",
  "ensemble.preview", "pipeline.configure", "pipeline.readiness", "foreman.configure", "foreman.instructions",
  "away.configure", "inspector.configure", "shipping.configure", "help.tour_preview",
]);
export function isPrimaryUseAction(feature: string, action: string): boolean {
  return feature !== "settings" && feature !== "setup" && PRIMARY_ACTION_IDS.includes(action as PrimaryAction)
    && !PRIMARY_NON_USE_ACTIONS.has(action as PrimaryAction);
}
export function primaryActionVariant(action: PrimaryAction, body: unknown): PrimaryAction {
  if (action === "ensemble.action") {
    const parsed = EnsembleActionSchema.safeParse(body);
    if (parsed.success) return `ensemble.${parsed.data.kind}`;
  }
  if (action === "pipeline.action") {
    const parsed = PipelineActionRequestSchema.safeParse(body);
    if (parsed.success) return `pipeline.control.${parsed.data.action}`;
  }
  // Invalid requests retain the endpoint action and a refusal, without reflecting input.
  return action;
}
const matchers = PRIMARY_ACTION_ROUTES.map(([method, path, action, feature]) => ({
  method, path, action, feature, pattern: new RegExp(`^${path.replace(/:[A-Za-z]+/g, "([^/]+)")}$`),
}));
export function matchPrimaryAction(method: string, path: string) {
  for (const entry of matchers) {
    if (entry.method !== method) continue;
    const match = entry.pattern.exec(path);
    if (match) return { action: entry.action, feature: entry.feature, subject: match.slice(1).join(":") };
  }
  return null;
}
