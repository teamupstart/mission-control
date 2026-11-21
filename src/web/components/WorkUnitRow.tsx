import { COPY_FEEDBACK_LABEL, useCopyFeedback } from "../lib/clipboard.ts";
import { Tooltip } from "./Tooltip.tsx";

/**
 * The session detail's "work unit" row: the id this session emits, with a copy control.
 *
 * `workUnitId` is `TaskSummary.workUnitId` - the id the session's agent was started with, while
 * its task has that same id - so the row never shows an id the agent's MCP calls do not carry.
 * Not gated on the live preview: the id follows the agent's launch record, so it stays while an
 * agent started under the preview still carries it. Mission Control links to no
 * observability vendor; the id is what an operator pastes into their own query.
 */
export function WorkUnitRow({ workUnitId }: { workUnitId: string }) {
  // Reset when the id changes under a mounted band (another task, another start).
  const copy = useCopyFeedback({ resetOn: workUnitId });
  return (
    <div className="kv work-unit">
      <dt>work unit</dt>
      <dd className="mono">{workUnitId}</dd>
      <Tooltip label={copy.copied ? COPY_FEEDBACK_LABEL : "Copy work unit id"}>
        <button
          type="button"
          className="work-unit-copy"
          aria-label="Copy work unit id"
          onClick={() => void copy.copy(workUnitId)}
        >
          {copy.copied ? COPY_FEEDBACK_LABEL : "Copy"}
        </button>
      </Tooltip>
      {copy.error && <span className="work-unit-copy-error" role="alert">{copy.error}</span>}
    </div>
  );
}
