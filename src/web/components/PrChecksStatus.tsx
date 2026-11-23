import { useState } from "react";
import { createPortal } from "react-dom";
import type { PrCheckDetails } from "@shared/pr-check-details.ts";
import { prCheckSummary } from "@shared/pr-check-details.ts";
import { Overlay, OVERLAY_IDS } from "./Overlay.tsx";
import { Tooltip } from "./Tooltip.tsx";

/**
 * Warning glyph for the CI results button: an outlined triangle with an exclamation. An SVG
 * rather than the `⚠` character, so it sizes like the neighbouring chip icons instead of
 * taking whatever height the platform font gives that glyph.
 */
export function ChecksFailedIcon(): React.JSX.Element {
  return (
    <svg className="pr-icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden focusable="false">
      <path
        fill="currentColor"
        d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"
      />
    </svg>
  );
}

/** Reporting only: the caller keeps its existing CI warning policy. */
export function PrChecksStatus({ details, url }: { details?: PrCheckDetails | null; url: string }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const summary = prCheckSummary(details);
  return <>
    <Tooltip label={`${summary} - view check results`}>
      <button type="button" className="pr-checks-alert" aria-label={`${summary} - view check results`}
        onClick={event => { event.stopPropagation(); setOpen(true); }}><ChecksFailedIcon /></button>
    </Tooltip>
    {/* The board tile's hover transform must not contain or clip this fixed dialog. */}
    {open && createPortal(<Overlay id={OVERLAY_IDS.prChecks} onClose={() => setOpen(false)}
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
    </Overlay>, document.body)}
  </>;
}
