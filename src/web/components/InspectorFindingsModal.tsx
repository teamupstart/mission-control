import { useCallback, useEffect, useRef, useState } from "react";
import type { InspectorComment, InspectorInspection } from "@shared/types.ts";
import type { InspectorFindingsResponse } from "@shared/protocol.ts";
import { findingPublication } from "@shared/inspector-findings.ts";
import { fetchInspectorFindings } from "../lib/api.ts";
import { containTourTab } from "../tour/focus-containment.ts";
import { inspectorPrClosedAs } from "../lib/pr-standing.ts";
import { InspectorFindingsTable } from "./InspectorFindingsTable.tsx";
import { Overlay, OVERLAY_IDS } from "./Overlay.tsx";
import { Tooltip } from "./Tooltip.tsx";

/** "open", "merged" or "closed", the words the Inspections table uses for a pull request. */
export function inspectorPrStateWord(pr: InspectorInspection): string {
  return inspectorPrClosedAs(pr) ?? "open";
}

/** The line that says a closed pull request's unresolved findings are a record, or null. */
export function closedRecordLine(pr: InspectorInspection): string | null {
  const closedAs = inspectorPrClosedAs(pr);
  const n = pr.openFindings;
  if (closedAs === null || n === 0) return null;
  const kept = n === 1 ? "It is" : "They are";
  return (
    `This pull request ${closedAs} with ${n} finding${n === 1 ? "" : "s"} unresolved. ` +
    `${kept} kept as a record and will not be reviewed again.`
  );
}

export function inspectorRoundsLabel(round: number): string {
  if (round === 0) return "not reviewed yet";
  return `${round} review round${round === 1 ? "" : "s"}`;
}

/**
 * The line that says nothing on this pull request reached GitHub, or null.
 *
 * `reviewPosture` describes only the LAST review, so it is not enough on its own: a pull
 * request reviewed live and then again in dry run has comments on GitHub from the first round.
 * The line is shown only when no finding reads as posted, being posted, or posted earlier. A
 * null posture (a row from an older build, or one never reviewed) proves nothing, so no line.
 */
export function nothingPostedLine(
  pr: Pick<InspectorInspection, "reviewPosture">,
  findings: readonly InspectorComment[],
): string | null {
  if (pr.reviewPosture === null || pr.reviewPosture === "live") return null;
  const anyPosted = findings.some((finding) => {
    const publication = findingPublication(finding);
    if (publication.earlierPost) return true;
    switch (publication.state) {
      case "not-posted":
      case "refused":
        return false;
      case "posted":
      case "posting":
      case "unknown":
        return true;
      default: {
        const exhaustive: never = publication.state;
        return exhaustive;
      }
    }
  });
  if (anyPosted) return null;
  return pr.reviewPosture === "not-allowlisted"
    ? "Not on the allowlist: nothing on this pull request was posted"
    : "Dry run: nothing on this pull request was posted";
}

/**
 * Every finding GitHub Inspector generated for one pull request, and whether each was posted.
 * Read-only: Resolve stays on the Inspections row.
 *
 * `refreshSignal` is the Inspections list. `useInspector` replaces that array on every poll,
 * so each tick re-reads the findings while the modal is open.
 */
export function InspectorFindingsModal({
  prKey,
  refreshSignal,
  onClose,
}: {
  prKey: string;
  refreshSignal: unknown;
  onClose: () => void;
}): React.JSX.Element {
  const [data, setData] = useState<InspectorFindingsResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const panelRef = useRef<HTMLElement | null>(null);
  const setPanel = useCallback((element: HTMLElement | null) => {
    panelRef.current = element;
  }, []);
  const containTab = useCallback((event: KeyboardEvent) => {
    if (panelRef.current) containTourTab(event, panelRef.current);
  }, []);

  // The Findings control that opened this stays behind the backdrop, so focus moves in and
  // returns to it on close, unless it is gone by then. The panel takes it rather than a
  // control, because a focused control opens its tooltip.
  useEffect(() => {
    const previous = document.activeElement;
    const panel = panelRef.current;
    panel?.setAttribute("tabindex", "-1");
    panel?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  const shownKey = useRef(prKey);
  const inFlightKey = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // A poll that lands while a read for this pull request is still out reuses that read rather
  // than discarding it, so a read slower than the poll interval still reaches the screen.
  useEffect(() => {
    shownKey.current = prKey;
    if (inFlightKey.current === prKey) return;
    inFlightKey.current = prKey;
    void fetchInspectorFindings(prKey).then((response) => {
      if (inFlightKey.current === prKey) inFlightKey.current = null;
      if (!mounted.current || shownKey.current !== prKey) return;
      // A failed read keeps the last answer on screen and says so, rather than blanking it.
      if (response) setData(response);
      setFailed(response === null);
    });
  }, [prKey, refreshSignal]);

  const pr = data?.pr ?? null;
  const findings = data?.findings ?? [];
  const nothingPosted = pr ? nothingPostedLine(pr, findings) : null;
  const closedRecord = pr ? closedRecordLine(pr) : null;

  return (
    <Overlay
      id={OVERLAY_IDS.inspectorFindings}
      onClose={onClose}
      className="modal inspector-findings-modal"
      role="dialog"
      ariaLabel={`GitHub Inspector findings on ${prKey}`}
      ariaModal
      onKeyDown={containTab}
      surfaceRef={setPanel}
    >
      <header className="modal-head">
        <h2>GitHub Inspector findings</h2>
      </header>

      <div className="inspector-findings-summary">
        <p className="inspector-findings-pr">
          {pr ? (
            <Tooltip label={`Open ${pr.key} on GitHub`}>
              <a href={pr.url} target="_blank" rel="noreferrer">{pr.key}</a>
            </Tooltip>
          ) : (
            <span>{prKey}</span>
          )}
          {pr && (
            <>
              <span className="inspector-findings-sep" aria-hidden="true">·</span>
              <span>{inspectorPrStateWord(pr)}</span>
              <span className="inspector-findings-sep" aria-hidden="true">·</span>
              <span>{inspectorRoundsLabel(pr.round)}</span>
            </>
          )}
        </p>
        {closedRecord && <p className="inspector-findings-record">{closedRecord}</p>}
        {nothingPosted && <p className="inspector-findings-mode">{nothingPosted}</p>}
        {failed && (
          <p className="settings-error">
            Couldn't read this pull request's findings. Trying again on the next refresh.
          </p>
        )}
      </div>

      <div className="modal-bleed inspector-findings-body">
        {data === null ? (
          !failed && <p className="wf-run-empty">Loading findings…</p>
        ) : findings.length === 0 ? (
          <p className="wf-run-empty">GitHub Inspector has recorded no findings on this pull request.</p>
        ) : (
          <InspectorFindingsTable
            findings={findings}
            caption={`GitHub Inspector findings on ${prKey}`}
          />
        )}
      </div>

      <footer className="modal-foot">
        <span className="actions-spacer" />
        <Tooltip label="Close the findings (Escape)">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Close
          </button>
        </Tooltip>
      </footer>
    </Overlay>
  );
}
