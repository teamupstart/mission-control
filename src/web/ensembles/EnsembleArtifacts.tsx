import { useEffect, useRef, useState } from "react";
import type { EnsembleArtifact } from "@shared/ensemble.ts";
import { Tooltip } from "../components/Tooltip.tsx";
import type { EnsembleArtifactPatch, EnsembleRunDetailResponse } from "./types.ts";
import { artifactStatusLabel, fmtBytes, locatorString, shortSha } from "./format.ts";

/**
 * The immutable artifacts a run produced, with their provenance and an on-demand diff. The
 * patch is never in SSE and never on the detail read; it is re-derived and byte-bounded, so it
 * is fetched only when the operator opens one, and rendered in a scrolling `<pre>` that cannot
 * push the page sideways.
 */
export function EnsembleArtifacts({
  detail,
  subjectLabel,
  onLoadPatch,
  onRestore,
  restorePendingId,
  autoOpenId,
}: {
  detail: EnsembleRunDetailResponse;
  subjectLabel: (artifactId: string) => string;
  onLoadPatch: (artifactId: string) => Promise<EnsembleArtifactPatch | { error: string }>;
  onRestore: (artifactId: string) => void;
  restorePendingId: string | null;
  autoOpenId: string | null;
}): React.JSX.Element {
  if (detail.artifacts.length === 0) {
    return <p className="ensemble-empty">No artifacts have been captured yet.</p>;
  }
  return (
    <ul className="ensemble-artifact-list">
      {detail.artifacts.map((artifact) => (
        <ArtifactRow
          key={artifact.id}
          artifact={artifact}
          runBaseSha={detail.run.baseSha}
          label={subjectLabel(artifact.id)}
          onLoadPatch={onLoadPatch}
          onRestore={onRestore}
          restorePending={restorePendingId === artifact.id}
          autoOpen={autoOpenId === artifact.id}
        />
      ))}
    </ul>
  );
}

function ArtifactRow({
  artifact,
  runBaseSha,
  label,
  onLoadPatch,
  onRestore,
  restorePending,
  autoOpen,
}: {
  artifact: EnsembleArtifact;
  runBaseSha: string | null;
  label: string;
  onLoadPatch: (artifactId: string) => Promise<EnsembleArtifactPatch | { error: string }>;
  onRestore: (artifactId: string) => void;
  restorePending: boolean;
  autoOpen: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [patch, setPatch] = useState<EnsembleArtifactPatch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const ref = useRef<HTMLLIElement>(null);
  const ready = artifact.status === "ready" && artifact.kind !== null;

  const ref_ = locatorString(artifact.locator, "ref");
  const snapshotSha = locatorString(artifact.locator, "snapshotSha");
  const baseSha = locatorString(artifact.locator, "baseSha");
  const baseMatchesRun = baseSha !== null && runBaseSha !== null && baseSha === runBaseSha;

  const load = async (): Promise<void> => {
    if (patch || loading) return;
    setLoading(true);
    setError(null);
    const result = await onLoadPatch(artifact.id);
    setLoading(false);
    if ("error" in result) setError(result.error);
    else setPatch(result);
  };

  const toggle = (): void => {
    const next = !open;
    setOpen(next);
    if (next) void load();
  };

  useEffect(() => {
    if (autoOpen && !open) {
      setOpen(true);
      void load();
      ref.current?.scrollIntoView({ block: "nearest" });
    }
    // Only react to an external open request, not to internal open toggles.
  }, [autoOpen]);

  return (
    <li className="ensemble-artifact" ref={ref}>
      <div className="ensemble-artifact-head">
        <span className="ensemble-artifact-label">{label}</span>
        <span className={`ensemble-pill ensemble-pill-${artifact.status ?? "unknown"}`}>
          {artifactStatusLabel(artifact.status)}
        </span>
        {artifact.kind && <span className="ensemble-artifact-kind">{artifact.kind}</span>}
        <span className="ensemble-artifact-spacer" />
        {ready && (
          <>
            <Tooltip label="Fetch and show this artifact's bounded diff">
              <button className="btn btn-ghost" onClick={toggle} aria-expanded={open}>
                {open ? "Hide diff" : "Show diff"}
              </button>
            </Tooltip>
            {!confirmRestore && (
              <Tooltip label="Hard-reset this member's existing checkout to the submitted snapshot">
                <button
                  className="btn btn-ghost"
                  disabled={restorePending}
                  onClick={() => setConfirmRestore(true)}
                >
                  {restorePending ? "Resetting…" : "Reset checkout…"}
                </button>
              </Tooltip>
            )}
          </>
        )}
      </div>
      {confirmRestore && (
        <div className="ensemble-inline-confirm" role="group" aria-label="Confirm checkout reset">
          <p>
            Hard-reset this member&apos;s existing checkout to its submitted snapshot. Edits made
            in that checkout after submission will be discarded.
          </p>
          <div className="ensemble-action-row">
            <Tooltip label="Confirm: discard later edits and reset the existing checkout">
              <button
                className="btn btn-primary danger"
                disabled={restorePending}
                onClick={() => {
                  setConfirmRestore(false);
                  onRestore(artifact.id);
                }}
              >
                {restorePending ? "Resetting…" : "Reset checkout"}
              </button>
            </Tooltip>
            <Tooltip label="Keep the member's existing checkout unchanged">
              <button
                className="btn btn-ghost"
                disabled={restorePending}
                onClick={() => setConfirmRestore(false)}
              >
                Keep checkout
              </button>
            </Tooltip>
          </div>
        </div>
      )}
      <dl className="ensemble-artifact-facts">
        <div>
          <dt>Fingerprint</dt>
          <dd>
            <code>{shortSha(artifact.digest) || "-"}</code>
          </dd>
        </div>
        {ref_ && (
          <div>
            <dt>Ref</dt>
            <dd>
              <code className="ensemble-ref">{ref_}</code>
            </dd>
          </div>
        )}
        {snapshotSha && (
          <div>
            <dt>Snapshot</dt>
            <dd>
              <code>{shortSha(snapshotSha)}</code>
            </dd>
          </div>
        )}
        {baseSha && (
          <div>
            <dt>Base</dt>
            <dd>
              <code>{shortSha(baseSha)}</code>
              {!baseMatchesRun && <span className="ensemble-warn-inline"> (differs from run base)</span>}
            </dd>
          </div>
        )}
      </dl>
      {artifact.error && (
        <p className="ensemble-error" role="alert">
          {artifact.error}
        </p>
      )}
      {open && (
        <div className="ensemble-diff">
          {loading && <p className="ensemble-muted">Loading diff…</p>}
          {error && (
            <p className="ensemble-error" role="alert">
              {error}
            </p>
          )}
          {patch && <ArtifactDiff patch={patch} />}
        </div>
      )}
    </li>
  );
}

function ArtifactDiff({ patch }: { patch: EnsembleArtifactPatch }): React.JSX.Element {
  return (
    <>
      <p className="ensemble-diff-stats">
        {patch.filesChanged} file{patch.filesChanged === 1 ? "" : "s"} · +{patch.insertions} / -
        {patch.deletions}
        {patch.truncated && (
          <span className="ensemble-warn-inline">
            {" "}
            · truncated, {fmtBytes(patch.omittedBytes)} omitted
          </span>
        )}
      </p>
      {patch.files.length > 0 && (
        <ul className="ensemble-diff-files">
          {patch.files.map((file) => (
            <li key={file.path}>
              {file.oldPath && file.oldPath !== file.path ? (
                <code>
                  {file.oldPath} → {file.path}
                </code>
              ) : (
                <code>{file.path}</code>
              )}
              {file.binary ? (
                <span className="ensemble-muted"> binary</span>
              ) : (
                <span className="ensemble-muted">
                  {" "}
                  +{file.insertions} / -{file.deletions}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {patch.patch && <pre className="ensemble-patch">{patch.patch}</pre>}
    </>
  );
}
