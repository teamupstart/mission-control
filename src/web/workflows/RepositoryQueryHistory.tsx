import { Tooltip } from "../components/Tooltip.tsx";
import type { WorkflowRunDetail } from "@shared/workflow.ts";
import { useEffect, useState } from "react";
import { repositoryCitationLabel, type RepositoryQueryAuditMetadata } from "@shared/repository-access.ts";
import { workflowRequest } from "./workflowApi.ts";

type Page = { items: { id: number; audit: RepositoryQueryAuditMetadata }[]; nextAfter: number | null };

export function RepositoryQueryHistory({ runId, review }: { runId: string; review: NonNullable<WorkflowRunDetail["repositoryReview"]> }) {
  const { queries: count, snapshot } = review;
  const [after, setAfter] = useState(0);
  const [page, setPage] = useState<Page | null>(null);
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    void workflowRequest<Page>(`/api/workflow-runs/${encodeURIComponent(runId)}/repository-queries?after=${after}&limit=10`, {
      signal: controller.signal,
    }).then(result => { if (!controller.signal.aborted) setPage(result); })
      .catch(() => { if (!controller.signal.aborted) setError("Repository queries could not be loaded."); });
    return () => controller.abort();
  }, [runId, after, count, retry]);
  return <section className="wf-run-section" aria-label="Repository queries">
    <header className="wf-run-section-head"><h4>Repository queries</h4><strong>{count} recorded</strong></header>
    {snapshot && <p>Latest submission snapshot <code>{snapshot.digest.slice(0, 12)}</code> · {snapshot.state} · {snapshot.retainedCommits} retained commits{snapshot.bounded && " · retained history boundary"}</p>}
    <p>{review.bytes} bytes · {count - review.denied - review.failed - review.cancelled} allowed · {review.denied} denied · {review.truncated} truncated · {review.failed} failed · {review.cancelled} cancelled</p>
    {error && <p role="alert">{error} <Tooltip label="Load the requested page of repository queries again">
      <button className="btn" onClick={() => setRetry(n => n + 1)}>Retry loading queries</button>
    </Tooltip></p>}
    {page?.items.map(({ id, audit }) => <details key={id}>
      <Tooltip label="Inspect the snapshot, query timing and returned ranges"><summary>{audit.operation} · {audit.code ?? audit.status} · {audit.items} {audit.items === 1 ? "item" : "items"}{audit.truncated && " · truncated"} · snapshot <code>{audit.snapshotDigest.slice(0, 12)}</code></summary></Tooltip>
      <p>Snapshot <code style={{ overflowWrap: "anywhere" }}>{audit.snapshotDigest}</code></p>
      <p>{audit.bytes} bytes · {audit.durationMs} ms</p>
      <p>Query <code>{audit.inputHash.slice(0, 12)}</code>{audit.hasNextPage && " · next page available"}</p>
      {audit.handles.slice(0, 3).map(handle => <p key={handle.evidenceHandleId}><code>{repositoryCitationLabel(handle)}</code></p>)}
      {audit.handles.length > 3 && <details><Tooltip label="Show the remaining ranges from this query"><summary>{audit.handles.length - 3} more returned ranges</summary></Tooltip>
        {audit.handles.slice(3).map(handle => <p key={handle.evidenceHandleId}><code>{repositoryCitationLabel(handle)}</code></p>)}
      </details>}
    </details>)}
    {after > 0 && <Tooltip label="Return to the earliest recorded queries"><button className="btn" onClick={() => setAfter(0)}>First queries</button></Tooltip>}
    {!error && page?.nextAfter != null && <Tooltip label="Show the next page of recorded queries"><button className="btn" onClick={() => setAfter(page.nextAfter!)}>Next queries</button></Tooltip>}
  </section>;
}
