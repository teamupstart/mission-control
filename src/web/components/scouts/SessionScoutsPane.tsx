import { useEffect, useRef, useState } from "react";
import type { ArchiveSummary } from "@shared/archives.ts";
import { api } from "../../lib/api.ts";
import { Tooltip } from "../Tooltip.tsx";
import { useScoutsCatalog } from "./useScoutsCatalog.ts";
import { scoutLabel, SCOUT_STATUS_WORD } from "./scout-labels.ts";

/** The ordinary archive catalog, narrowed to this local session's immutable reports. */
export function SessionScoutsPane({ sessionId, revision, onOpenFile, onOpenArchive }: {
  sessionId: string;
  revision: number;
  onOpenFile: (path: string) => void;
  onOpenArchive: (archive: ArchiveSummary) => void;
}): React.JSX.Element {
  const catalog = useScoutsCatalog({ filters: { session: sessionId, kind: "scout" }, archiveKey: null, revision });
  const opening = useRef<AbortController | null>(null);
  const [openingKey, setOpeningKey] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  useEffect(() => () => opening.current?.abort(), [sessionId]);

  async function openReport(archive: ArchiveSummary): Promise<void> {
    opening.current?.abort();
    const request = new AbortController();
    opening.current = request;
    setOpeningKey(archive.key);
    setOpenError(null);
    const result = await api.archiveDetail(archive.key, request.signal);
    if (request.signal.aborted) return;
    setOpeningKey(null);
    if (!result.ok) {
      setOpenError(`Could not open the report in Files: ${result.error}`);
      return;
    }
    const report = result.value.artifacts.find((artifact) => artifact.id === result.value.primaryArtifactId);
    if (!report?.originalPath) {
      setOpenError("This report has no recorded source path. Open its archived copy instead.");
      return;
    }
    onOpenFile(report.originalPath);
  }

  return (
    <section className="session-scouts" aria-label="Session scout reports">
      <h3>Scout reports</h3>
      <p>Each report is a separate archive that remains available after this session ends.</p>
      <p>Select a report to preview its source in Files. Open archive reads the immutable published copy.</p>
      {openError && <p role="alert">{openError}</p>}
      {catalog.listState === "error" ? (
        <div role="alert">
          <p>{catalog.listError}</p>
          <Tooltip label="Retry loading this session's scout reports">
            <button className="btn" onClick={catalog.refresh}>Try again</button>
          </Tooltip>
        </div>
      ) : catalog.listState === "first" ? (
        <p role="status">Reading reports…</p>
      ) : catalog.archives.length === 0 ? (
        <p className="detail-empty">No scout reports from this session yet.</p>
      ) : (
        <ul className="session-scouts-list">
          {catalog.archives.map((archive) => (
            <li key={archive.key}>
              <Tooltip label={`Open ${scoutLabel(archive)} in Files`}>
                <button type="button" className="session-scouts-report" aria-label={scoutLabel(archive)}
                  disabled={openingKey === archive.key} onClick={() => void openReport(archive)}>
                  <strong>{scoutLabel(archive)}</strong>
                  <span>{SCOUT_STATUS_WORD[archive.status]} · {new Date(archive.completedAt ?? archive.createdAt ?? archive.indexedAt).toLocaleString()}</span>
                  {archive.summary && <span>{archive.summary}</span>}
                </button>
              </Tooltip>
              <Tooltip label={`Read the archived copy of ${scoutLabel(archive)}`}>
                <button type="button" className="btn session-scouts-archive" aria-label={`Open archived ${scoutLabel(archive)}`}
                  onClick={() => { opening.current?.abort(); onOpenArchive(archive); }}>Open archive</button>
              </Tooltip>
            </li>
          ))}
        </ul>
      )}
      {catalog.hasMore && (
        <Tooltip label="Read the next page of reports from this session">
          <button className="btn" disabled={catalog.loadingMore} onClick={catalog.loadMore}>Load more</button>
        </Tooltip>
      )}
    </section>
  );
}
