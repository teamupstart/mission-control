import { useState } from "react";
import type { TaskSourceInstance } from "@shared/task-source.ts";
import type { SourceContent, SourceSyncReview } from "@shared/task-source-sync.ts";
import type { TaskSourcesState } from "../useTaskSources.ts";
import { Tooltip } from "./Tooltip.tsx";

function Content({ value, review }: { value: SourceContent; review: SourceSyncReview }) {
  return <>
    {review.conflicts.includes("brief") && <><strong>{value.title}</strong><pre>{value.intent}</pre></>}
    {review.conflicts.includes("priority") && <p>Priority: {value.priority ?? "none"}</p>}
    {review.conflicts.includes("labels") && <p>Labels: {value.labels.join(", ") || "none"}</p>}
  </>;
}

export function TaskSourceSync({ src, state, onChange }: {
  src: TaskSourceInstance; state: TaskSourcesState; onChange: (source: TaskSourceInstance) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const reviews = (state.view?.sync ?? []).filter((review) => review.sourceId === src.id);
  const pending = reviews.filter((review) => review.remote || review.error);
  const unchecked = reviews.filter((review) => review.adoption && !review.remote && !review.error).length;
  async function resolve(review: SourceSyncReview, choice: "source" | "local") {
    setBusy(review.taskId);
    try { await state.resolveSync(src.id, review.taskId, review.version, choice); }
    finally { setBusy(null); }
  }
  return <section className="ts-sync" aria-label="Imported task updates">
    <label className={`settings-toggle${src.keepUpdated ? " is-on" : ""}`}>
      <Tooltip label="Refresh imported details on each sweep while tasks have not started">
        <input type="checkbox" checked={src.keepUpdated === true} aria-label="Keep imported backlog tasks updated"
          onChange={(event) => onChange({ ...src, keepUpdated: event.target.checked })} />
      </Tooltip>
      <span className="settings-toggle-text">
        <span className="settings-toggle-label">Keep imported backlog tasks updated</span>
        <span className="settings-toggle-desc">On each sweep, refresh imported details for tasks that have not started.
          Local edits are preserved and conflicting updates are shown here for review. This does not change task status or write upstream.</span>
      </span>
    </label>
    {src.keepUpdated && <p className="settings-hint">{reviews.length} linked backlog {reviews.length === 1 ? "item" : "items"}.
      {unchecked > 0 && ` ${unchecked} older ${unchecked === 1 ? "item needs" : "items need"} a sweep before adoption review.`}</p>}
    {pending.map((review) => <article key={review.taskId} className="ts-sync-review" aria-label={`Source update for ${review.externalId}`}>
      <h4>{review.title}</h4>
      <p className="settings-hint">{review.externalId}{review.checkedAt ? ` · Checked ${new Date(review.checkedAt).toLocaleString()}` : ""}</p>
      {review.error && <p className="settings-error">{review.error}</p>}
      {review.remote && <>
        <p>{review.adoption ? "Review this older task before enabling updates for it." : "Local edits overlap with source changes."}</p>
        <div className="ts-sync-comparison">
          <div><h5>Local task</h5><Content value={review.local} review={review} /></div>
          <div><h5>Source item</h5><Content value={review.remote} review={review} /></div>
        </div>
        <div className="ts-sync-actions">
          <Tooltip label="Apply the source values shown here and accept this source revision">
            <button className="btn" disabled={!src.keepUpdated || !!review.error || busy !== null}
              onClick={() => void resolve(review, "source")}>Use source</button>
          </Tooltip>
          <Tooltip label="Keep local values and accept this source revision">
            <button className="btn" disabled={!src.keepUpdated || !!review.error || busy !== null}
              onClick={() => void resolve(review, "local")}>Keep local</button>
          </Tooltip>
        </div>
      </>}
    </article>)}
  </section>;
}
