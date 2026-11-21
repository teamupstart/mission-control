import { useState } from "react";
import type { PrCheckDetails } from "@shared/pr-check-details.ts";
import { prCheckSummary } from "@shared/pr-check-details.ts";
import { Overlay, OVERLAY_IDS } from "./Overlay.tsx";
import { Tooltip } from "./Tooltip.tsx";

/** Reporting only: the caller keeps its existing CI warning policy. */
export function PrChecksStatus({ details, url }: { details?: PrCheckDetails | null; url: string }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const summary = prCheckSummary(details);
  return <>
    <Tooltip label={`${summary} - view check results`}>
      <button type="button" className="pr-checks-alert" aria-label={`${summary} - view check results`}
        onClick={event => { event.stopPropagation(); setOpen(true); }}>⚠</button>
    </Tooltip>
    {open && <Overlay id={OVERLAY_IDS.prChecks} onClose={() => setOpen(false)}
      className="modal pr-checks-modal" role="dialog" ariaModal ariaLabel="Pull request checks">
      <header className="modal-head"><h2>Pull request checks</h2>
        <Tooltip label="Close pull request checks">
          <button type="button" className="btn" onClick={() => setOpen(false)}>Close</button>
        </Tooltip></header>
      <div className="modal-body">
        <p>{summary}</p>
        <p>Reported check results, including earlier runs.
          Workflow wait reasons are shown separately in the workflow run.</p>
        {!details?.complete && <p role="status">The check list may be incomplete. Missing results cannot be classified.</p>}
        <ul className="pr-check-results">
          {details?.results.map((result, index) => <li key={index}>
            {result.url
              ? <Tooltip label={`Open ${result.name}: ${result.conclusion} on the check provider`}>
                  <a href={result.url} target="_blank" rel="noreferrer">{result.name}: {result.conclusion}</a>
                </Tooltip>
              : <span>{result.name}: {result.conclusion}</span>}
          </li>)}
        </ul>
      </div>
      <footer className="modal-foot">
        <Tooltip label="Open the pull request overview on GitHub">
          <a href={url} target="_blank" rel="noreferrer">Open pull request on GitHub</a>
        </Tooltip>
      </footer>
    </Overlay>}
  </>;
}
