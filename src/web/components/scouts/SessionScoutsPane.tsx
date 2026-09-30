import type { ArchiveSummary } from "@shared/archives.ts";
import { Tooltip } from "../Tooltip.tsx";
import { useScoutsCatalog } from "./useScoutsCatalog.ts";
import { scoutLabel, SCOUT_STATUS_WORD } from "./scout-labels.ts";

/** The ordinary archive catalog, narrowed to this local session's immutable reports. */
export function SessionScoutsPane({ sessionId, revision, onOpen }: {
  sessionId: string;
  revision: number;
  onOpen: (archive: ArchiveSummary) => void;
}): React.JSX.Element {
  const catalog = useScoutsCatalog({ filters: { session: sessionId, kind: "scout" }, archiveKey: null, revision });
  return (
    <section className="session-scouts" aria-label="Session scout reports">
      <h3>Scout reports</h3>
      <p>Each report is a separate archive that remains available after this session ends.</p>
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
              <Tooltip label={`Open ${scoutLabel(archive)}`}>
                <button type="button" className="session-scouts-report" aria-label={scoutLabel(archive)} onClick={() => onOpen(archive)}>
                  <strong>{scoutLabel(archive)}</strong>
                  <span>{SCOUT_STATUS_WORD[archive.status]} · {new Date(archive.completedAt ?? archive.createdAt ?? archive.indexedAt).toLocaleString()}</span>
                  {archive.summary && <span>{archive.summary}</span>}
                </button>
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
