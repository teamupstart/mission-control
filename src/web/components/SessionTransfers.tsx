import { useEffect, useState } from "react";
import type { SessionTransferPage, SessionTransferSummary } from "@shared/session-transfer.ts";
import { api } from "../lib/api.ts";
import { Tooltip } from "./Tooltip.tsx";

function TransferRow({ transfer, onChanged }: { transfer: SessionTransferSummary; onChanged: () => void }): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  async function act(end: boolean): Promise<void> {
    setBusy(true);
    try {
      const result = end ? await api.resolveSessionTransfer(transfer.id, transfer.revision) : await api.recheckSessionTransfer(transfer.id);
      setMessage(result.ok ? end ? "Transfer ended." : "Transfer checked." : result.error ?? "Could not check this transfer");
      if (result.ok) onChanged();
    } catch {
      setMessage("Could not reach Mission Control. Check again when it reconnects.");
    } finally { setBusy(false); setConfirmEnd(false); }
  }
  return <div className="report-row report-row-stack report-transfer" role="group" aria-label={`Terminal transfer: ${transfer.sourceName}`}>
    <div className="report-row-main"><strong className="report-name">{transfer.sourceName}</strong></div>
    <p className="report-sub">{transfer.reason}</p>
    {confirmEnd && <p className="report-sub">End this transfer and retain its checkout?</p>}
    <div className="report-row-actions">
      <Tooltip label="Look for the original terminal attempt without launching another agent">
        <button className="btn" disabled={busy} onClick={() => void act(false)}>{busy ? "Checking…" : "Check again"}</button>
      </Tooltip>
      {transfer.canEnd && (confirmEnd ? <>
        <Tooltip label="End this transfer after rechecking absence and retain its checkout">
          <button className="btn btn-danger" disabled={busy} onClick={() => void act(true)}>Confirm end transfer</button>
        </Tooltip>
        <Tooltip label="Leave this transfer available for recovery">
          <button className="btn btn-ghost" onClick={() => setConfirmEnd(false)}>Keep transfer</button>
        </Tooltip>
      </> : <Tooltip label="Review ending this transfer while retaining its checkout">
        <button className="btn" disabled={busy} onClick={() => setConfirmEnd(true)}>End transfer</button>
      </Tooltip>)}
    </div>
    {message && <p className="report-sub" role="status">{message}</p>}
  </div>;
}

/** SSE owns freshness; actions and pagination fetch a bounded page without polling. */
export function SessionTransfers({ page }: { page: SessionTransferPage }): React.JSX.Element | null {
  const [offset, setOffset] = useState(0);
  const [extra, setExtra] = useState<{ offset: number; snapshot: SessionTransferPage; page: SessionTransferPage } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!offset && !refresh) return;
    let current = true;
    void api.sessionTransfers(offset).then((result) => { if (current) { setExtra({ offset, snapshot: page, page: result }); setError(null); } })
      .catch(() => { if (current) setError("Could not load the remaining terminal transfers"); });
    return () => { current = false; };
  }, [offset, page, refresh]);
  // A newer SSE snapshot supersedes any action refresh, including when its fetch fails.
  const shown = extra?.offset === offset && extra.snapshot === page ? extra.page : offset ? null : page;
  if (!shown?.transfers.length && !offset) return null;
  return <section className="report-section" aria-label="Terminal transfers">
    <h3 className="report-section-title">Terminal transfers</h3>
    {shown?.transfers.map((transfer) => <TransferRow key={transfer.id} transfer={transfer} onChanged={() => setRefresh((value) => value + 1)} />)}
    {error && <p role="status">{error}</p>}
    <div className="report-row-actions">
      {offset > 0 && <Tooltip label="Show the previous page of unresolved terminal transfers">
        <button className="btn" onClick={() => { setExtra(null); setOffset(Math.max(0, offset - 100)); }}>Previous transfers</button>
      </Tooltip>}
      {Boolean(shown?.overflow) && <Tooltip label="Show the next page of unresolved terminal transfers">
        <button className="btn" onClick={() => { setExtra(null); setOffset(offset + 100); }}>More transfers ({shown!.overflow})</button>
      </Tooltip>}
    </div>
  </section>;
}
