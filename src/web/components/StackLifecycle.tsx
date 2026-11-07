import { useEffect, useState } from "react";
import {
  STACK_SEND_LABEL,
  stackActionLabel,
  type StackActionKind,
  type StackStanding,
} from "@shared/stacking.ts";
import { api } from "../lib/api.ts";
import { Tooltip } from "./Tooltip.tsx";

// Stacked pull requests: what a held child's lifecycle says, and the buttons that move it.
//
// One component for the two places it is drawn - the merge queue row and the child's board
// tile - so the label and the actions cannot disagree between them. The label is the row's
// stack STANDING, never its merge gate: the gate stays `stacked-base` or `stack-hold`, and this
// is the detail beneath it that says why and what to do.

const ACTION_HINT: Record<StackActionKind, string> = {
  "move-onto-main":
    "Ask the session to cherry-pick only this task's own commits onto a new branch from the default branch, open a replacement pull request and close this one. No force-push.",
  "reopen-against-main":
    "Ask the session to open a new pull request from the same branch against the default branch, then merge the default branch in and push.",
  "reopen-on-parent":
    "Ask the session to open a new pull request from the same branch against the still-open parent's branch. It inherits this one's stack lineage.",
  "await-replacement":
    "Keep this pull request open. When the parent task opens a replacement pull request, it becomes this one's parent and this one is retargeted onto it.",
  "reschedule-parent":
    "Put the stopped parent task back in the backlog, so its pull request can be finished and merged. Or close that pull request on GitHub to move this one onto main.",
  "start-parent":
    "Start the parent task again in a fresh worktree, so it can finish and merge its pull request.",
};

export function StackLifecycle({
  prKey,
  standing,
  onChanged,
}: {
  prKey: string;
  standing: StackStanding | null | undefined;
  /** Called after an action the daemon accepted, so the caller can re-read. */
  onChanged?: () => void;
}): React.JSX.Element | null {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // A confirmation belongs to the state it was given in: once the stack moves on, the label
  // says what is true now, and an old "Sent" or "Waiting for a replacement" would contradict it.
  const label = standing?.label ?? null;
  useEffect(() => setMessage(null), [label]);
  if (!standing?.label) return null;
  const prompt = standing.prompt;
  // The manual send: offered when Foreman will not deliver it (off, not live, not invited) and
  // as the explicit re-arm of a delivery whose outcome is uncertain. Never for no session: the
  // way out of that one is the task's existing Resume control.
  const send = prompt && (prompt.status === "foreman-off" || prompt.status === "uncertain") ? prompt : null;
  const noSession = !standing.sessionId;

  async function run(what: () => Promise<{ ok: boolean; error?: string }>, done: string): Promise<void> {
    setBusy(true);
    setMessage(null);
    const r = await what();
    setBusy(false);
    setMessage(r.ok ? done : r.error ?? "could not send it");
    if (r.ok) onChanged?.();
  }

  return (
    <span className="stack-lifecycle" role="group" aria-label="Stacked pull request">
      <span className={`stack-label${standing.state === "broken" || standing.retargetError ? " is-broken" : ""}`}>
        {standing.label}
      </span>
      {send && (
        <Tooltip label={noSession ? "No live session owns this pull request - resume its task first" : "Type the prompt into the child's session now, through the same guards Foreman uses"}>
          <button
            type="button"
            className="stack-action"
            disabled={busy || noSession}
            onClick={(e) => {
              e.stopPropagation();
              void run(
                () => api.sendStackPrompt(standing.sessionId!, { prKey, kind: send.kind, tip: send.tip }),
                "Sent",
              );
            }}
          >
            {STACK_SEND_LABEL[send.kind]}
          </button>
        </Tooltip>
      )}
      {standing.actions.map((action) => {
        // Restarting the parent goes through the task's own reschedule and dispatch controls;
        // every other action is typed into the child's session and needs that session live.
        const restart = action === "reschedule-parent" || action === "start-parent";
        const needsSession = action !== "await-replacement" && !restart;
        const unavailable = (needsSession && noSession) || (restart && !standing.parentTaskId);
        const hint = needsSession && noSession
          ? "No live session owns this pull request - resume its task first"
          : restart && !standing.parentTaskId ? "The parent task is not known on this board" : ACTION_HINT[action];
        const send = (): Promise<{ ok: boolean; error?: string }> => {
          if (action === "await-replacement") return api.stackAwaitReplacement(prKey, true);
          if (action === "reschedule-parent") return api.rescheduleTask(standing.parentTaskId!);
          if (action === "start-parent") return api.dispatchBacklog(standing.parentTaskId!, true);
          return api.sendStackPrompt(standing.sessionId!, { prKey, kind: action, tip: null });
        };
        return (
          <Tooltip key={action} label={hint}>
            <button
              type="button"
              className="stack-action"
              disabled={busy || unavailable}
              onClick={(e) => {
                e.stopPropagation();
                void run(send, action === "await-replacement" ? "Waiting for a replacement" : restart ? "Done" : "Sent");
              }}
            >
              {stackActionLabel(action, standing.parentNumber)}
            </button>
          </Tooltip>
        );
      })}
      {message && <span className="stack-message" role="status">{message}</span>}
    </span>
  );
}
