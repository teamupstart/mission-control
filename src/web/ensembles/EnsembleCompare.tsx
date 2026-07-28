import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { fetchArtifactFilePatch, fetchArtifactFiles } from "../lib/api.ts";
import { fmtUsd } from "../lib/format.ts";
import { Tooltip } from "../components/Tooltip.tsx";
import { fmtBytes } from "./format.ts";
import type {
  EnsembleArtifactPatch,
  EnsembleRunDetailResponse,
} from "./types.ts";
import {
  MAX_COMPARE_ARTIFACTS,
  artifactTouchesPath,
  buildFileMatrix,
  capCompareSelection,
  compareClaim,
  comparePatchKey,
  eligibleCompareArtifacts,
  updateCompareSelection,
  type CompareControl,
} from "./compare.ts";

type CacheEntry<T> =
  | { status: "loading" }
  | { status: "ready"; value: T }
  | { status: "error"; error: string };

export type CompareFilesCache = ReadonlyMap<string, CacheEntry<EnsembleArtifactPatch>>;
export type ComparePatchCache = ReadonlyMap<string, CacheEntry<EnsembleArtifactPatch>>;

/**
 * Fetch controller for the compare workspace. Only the CONTROL state is lifted to detail; these
 * evidence caches belong to this mounted section and do not disturb Artifacts' row-local cache.
 */
export function EnsembleCompare({
  detail,
  subjectLabel,
  compare,
  onCompareChange,
  sectionRef,
}: {
  detail: EnsembleRunDetailResponse;
  subjectLabel: (artifactId: string) => string;
  compare: CompareControl | null;
  onCompareChange: (compare: CompareControl | null) => void;
  sectionRef?: React.Ref<HTMLElement>;
}): React.JSX.Element {
  const [filesCache, setFilesCache] = useState<Map<string, CacheEntry<EnsembleArtifactPatch>>>(
    new Map(),
  );
  const [patchCache, setPatchCache] = useState<Map<string, CacheEntry<EnsembleArtifactPatch>>>(
    new Map(),
  );
  const requestedFiles = useRef(new Set<string>());
  const requestedPatches = useRef(new Set<string>());
  const activeRunId = useRef(detail.run.id);

  useEffect(() => {
    activeRunId.current = detail.run.id;
    requestedFiles.current.clear();
    requestedPatches.current.clear();
    setFilesCache(new Map());
    setPatchCache(new Map());
  }, [detail.run.id]);

  const eligibleIds = useMemo(
    () => eligibleCompareArtifacts(detail).map((artifact) => artifact.id),
    [detail.artifacts],
  );
  const selectedIds = useMemo(
    () => capCompareSelection(compare?.artifactIds ?? [], eligibleIds),
    [compare?.artifactIds, eligibleIds],
  );

  useEffect(() => {
    const runId = detail.run.id;
    for (const artifactId of selectedIds) {
      if (requestedFiles.current.has(artifactId)) continue;
      requestedFiles.current.add(artifactId);
      setFilesCache((current) => new Map(current).set(artifactId, { status: "loading" }));
      void fetchArtifactFiles(runId, artifactId).then((result) => {
        if (activeRunId.current !== runId) return;
        if (!result.ok) requestedFiles.current.delete(artifactId);
        setFilesCache((current) =>
          new Map(current).set(
            artifactId,
            result.ok
              ? { status: "ready", value: result.data }
              : { status: "error", error: result.error },
          ),
        );
      });
    }
  }, [detail.run.id, selectedIds]);

  useEffect(() => {
    if (!compare?.path || selectedIds.length < 2) return;
    const runId = detail.run.id;
    for (const artifactId of selectedIds) {
      const key = comparePatchKey(artifactId, compare.path);
      if (requestedPatches.current.has(key)) continue;
      requestedPatches.current.add(key);
      setPatchCache((current) => new Map(current).set(key, { status: "loading" }));
      void fetchArtifactFilePatch(runId, artifactId, compare.path).then((result) => {
        if (activeRunId.current !== runId) return;
        if (!result.ok) requestedPatches.current.delete(key);
        setPatchCache((current) =>
          new Map(current).set(
            key,
            result.ok
              ? { status: "ready", value: result.data }
              : { status: "error", error: result.error },
          ),
        );
      });
    }
  }, [compare?.path, detail.run.id, selectedIds]);

  return (
    <EnsembleCompareView
      detail={detail}
      subjectLabel={subjectLabel}
      compare={compare}
      onCompareChange={onCompareChange}
      filesCache={filesCache}
      patchCache={patchCache}
      sectionRef={sectionRef}
    />
  );
}

/** Presentational half, exported so honest loaded/error/truncated states can be render-tested. */
export function EnsembleCompareView({
  detail,
  subjectLabel,
  compare,
  onCompareChange,
  filesCache,
  patchCache,
  sectionRef,
}: {
  detail: EnsembleRunDetailResponse;
  subjectLabel: (artifactId: string) => string;
  compare: CompareControl | null;
  onCompareChange: (compare: CompareControl | null) => void;
  filesCache: CompareFilesCache;
  patchCache: ComparePatchCache;
  sectionRef?: React.Ref<HTMLElement>;
}): React.JSX.Element {
  const eligible = eligibleCompareArtifacts(detail);
  const eligibleIds = eligible.map((artifact) => artifact.id);
  const selectedIds = capCompareSelection(compare?.artifactIds ?? [], eligibleIds);
  const selectedSet = new Set(selectedIds);
  const path = compare?.path ?? null;

  const filesByArtifact = new Map<string, EnsembleArtifactPatch["files"]>();
  for (const artifactId of selectedIds) {
    const entry = filesCache.get(artifactId);
    if (entry?.status === "ready") filesByArtifact.set(artifactId, entry.value.files);
  }
  const filesComplete =
    selectedIds.length >= 2 &&
    selectedIds.every((artifactId) => filesCache.get(artifactId)?.status === "ready");
  // A partial union would briefly invent "only #N" marks before the slower columns arrive.
  // Keep the matrix empty until every selected artifact's complete stats are present.
  const matrix = filesComplete ? buildFileMatrix(filesByArtifact) : [];
  const pathTouchedByArtifact = new Map(
    path === null
      ? []
      : selectedIds.map((artifactId) => [
          artifactId,
          artifactTouchesPath(filesByArtifact.get(artifactId) ?? [], path),
        ]),
  );
  const untouchedPath =
    path !== null &&
    filesComplete &&
    selectedIds.every((artifactId) => pathTouchedByArtifact.get(artifactId) === false);
  const columnsStyle = {
    "--ensemble-compare-columns": String(Math.max(2, selectedIds.length)),
  } as CSSProperties;

  const setSelection = (artifactId: string, checked: boolean): void => {
    const artifactIds = updateCompareSelection(
      selectedIds,
      artifactId,
      checked,
      eligibleIds,
    );
    onCompareChange(
      artifactIds.length === 0
        ? null
        : {
            artifactIds,
            path: artifactIds.length >= 2 ? path : null,
          },
    );
  };

  const openPath = (nextPath: string): void => {
    if (selectedIds.length < 2) return;
    onCompareChange({ artifactIds: selectedIds, path: nextPath });
  };

  return (
    <section
      className="ensemble-section ensemble-compare"
      aria-label="Compare"
      ref={sectionRef}
    >
      <div className="ensemble-compare-heading">
        <div>
          <h4>Compare</h4>
          <p>Line up two or three snapshots, then open one file across every column.</p>
        </div>
        {selectedIds.length > 0 && (
          <span className="ensemble-compare-count">
            {selectedIds.length}/{MAX_COMPARE_ARTIFACTS} selected
          </span>
        )}
      </div>

      {eligible.length < 2 ? (
        <p className="ensemble-empty">Comparison opens when two snapshots are ready.</p>
      ) : (
        <>
          <fieldset className="ensemble-compare-picker">
            <legend>Snapshots</legend>
            {eligible.map((artifact) => {
              const checked = selectedSet.has(artifact.id);
              return (
                <Tooltip
                  key={artifact.id}
                  label={`${checked ? "Remove" : "Add"} ${subjectLabel(artifact.id)} ${checked ? "from" : "to"} Compare`}
                >
                  <label>
                    <input
                      id={`ensemble-compare-${artifact.id}`}
                      type="checkbox"
                      name="ensemble-compare-artifacts"
                      value={artifact.id}
                      checked={checked}
                      disabled={!checked && selectedIds.length >= MAX_COMPARE_ARTIFACTS}
                      onChange={(event) => setSelection(artifact.id, event.currentTarget.checked)}
                    />
                    <span>{subjectLabel(artifact.id)}</span>
                  </label>
                </Tooltip>
              );
            })}
          </fieldset>

          {selectedIds.length < 2 ? (
            <p className="ensemble-muted">Select at least two snapshots to build the file matrix.</p>
          ) : (
            <>
              <CompareClaims
                detail={detail}
                artifactIds={selectedIds}
                subjectLabel={subjectLabel}
                style={columnsStyle}
              />
              <div className="ensemble-compare-matrix-scroll">
                <table className="ensemble-compare-matrix">
                  <thead>
                    <tr>
                      <th scope="col">Changed file</th>
                      {selectedIds.map((artifactId) => (
                        <th scope="col" key={artifactId}>
                          {subjectLabel(artifactId)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {untouchedPath && (
                      <tr className="is-untouched" aria-current="true">
                        <th scope="row">
                          <Tooltip label={`Open ${path} across the selected snapshots`}>
                            <button type="button" onClick={() => openPath(path!)}>
                              <code>{path}</code>
                            </button>
                          </Tooltip>
                        </th>
                        <td colSpan={selectedIds.length}>
                          Not touched by the selected candidates.
                        </td>
                      </tr>
                    )}
                    {matrix.map((row) => (
                      <tr
                        key={row.path}
                        className={path === row.path ? "is-open" : undefined}
                        aria-current={path === row.path ? "true" : undefined}
                      >
                        <th scope="row">
                          <Tooltip label={`Open ${row.path} across the selected snapshots`}>
                            <button type="button" onClick={() => openPath(row.path)}>
                              <code>{row.path}</code>
                            </button>
                          </Tooltip>
                        </th>
                        {selectedIds.map((artifactId) => {
                          const cell = row.cells[artifactId];
                          return (
                            <td key={artifactId}>
                              {cell ? (
                                <>
                                  <span className="ensemble-compare-churn">
                                    {cell.binary ? "binary" : `+${cell.ins} / -${cell.del}`}
                                  </span>
                                  {cell.renamedFrom && (
                                    <Tooltip label={`Renamed from ${cell.renamedFrom}`}>
                                      <small>
                                        from <code>{cell.renamedFrom}</code>
                                      </small>
                                    </Tooltip>
                                  )}
                                  {row.onlyIn === artifactId && (
                                    <span className="ensemble-compare-only">
                                      only #{artifactOrdinal(detail, artifactId) ?? selectedIds.indexOf(artifactId) + 1}
                                    </span>
                                  )}
                                </>
                              ) : (
                                <span className="ensemble-compare-absent" aria-label="Not touched">
                                  —
                                </span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                    {matrix.length === 0 && !untouchedPath && filesComplete && (
                      <tr>
                        <td colSpan={selectedIds.length + 1} className="ensemble-muted">
                          These snapshots contain no changed files.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {!filesComplete && (
                <CompareLoadStatus artifactIds={selectedIds} cache={filesCache} />
              )}

              {path && (
                <ComparePanes
                  artifactIds={selectedIds}
                  path={path}
                  subjectLabel={subjectLabel}
                  patchCache={patchCache}
                  pathTouchedByArtifact={pathTouchedByArtifact}
                  untouchedPath={untouchedPath}
                  style={columnsStyle}
                />
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

function CompareClaims({
  detail,
  artifactIds,
  subjectLabel,
  style,
}: {
  detail: EnsembleRunDetailResponse;
  artifactIds: string[];
  subjectLabel: (artifactId: string) => string;
  style: CSSProperties;
}): React.JSX.Element {
  return (
    <div className="ensemble-compare-claims-grid" style={style} aria-label="Candidate claims">
      {artifactIds.map((artifactId) => {
        const claim = compareClaim(detail, artifactId);
        const scoreParts = [
          claim.rank === null ? null : `rank #${claim.rank}`,
          claim.score === null ? null : `score ${claim.score}/100`,
          claim.confidence === null
            ? null
            : `${Math.round(claim.confidence * 100)}% confidence`,
        ].filter((part): part is string => part !== null);
        return (
          <article key={artifactId} className="ensemble-compare-claim">
            <h5>{subjectLabel(artifactId)}</h5>
            <p>{claim.summary ?? <span className="ensemble-muted">No reported summary.</span>}</p>
            <dl>
              <div>
                <dt>Checks claimed</dt>
                <dd>{claim.checksCount}</dd>
              </div>
              <div>
                <dt>Frozen cost</dt>
                <dd>
                  {claim.costUsd === null ? (
                    <span className="ensemble-muted">not reported</span>
                  ) : (
                    fmtUsd(claim.costUsd)
                  )}
                </dd>
              </div>
            </dl>
            {scoreParts.length > 0 && <p className="ensemble-compare-score">{scoreParts.join(" · ")}</p>}
          </article>
        );
      })}
    </div>
  );
}

function CompareLoadStatus({
  artifactIds,
  cache,
}: {
  artifactIds: string[];
  cache: CompareFilesCache;
}): React.JSX.Element {
  const errors = artifactIds
    .map((artifactId) => cache.get(artifactId))
    .filter((entry): entry is Extract<CacheEntry<EnsembleArtifactPatch>, { status: "error" }> =>
      entry?.status === "error",
    );
  return errors.length > 0 ? (
    <p className="ensemble-error" role="alert">
      Could not load {errors.length === 1 ? "one file list" : `${errors.length} file lists`}:{" "}
      {errors.map((entry) => entry.error).join("; ")}
    </p>
  ) : (
    <p className="ensemble-muted">Loading complete file lists…</p>
  );
}

function ComparePanes({
  artifactIds,
  path,
  subjectLabel,
  patchCache,
  pathTouchedByArtifact,
  untouchedPath,
  style,
}: {
  artifactIds: string[];
  path: string;
  subjectLabel: (artifactId: string) => string;
  patchCache: ComparePatchCache;
  pathTouchedByArtifact: ReadonlyMap<string, boolean>;
  untouchedPath: boolean;
  style: CSSProperties;
}): React.JSX.Element {
  return (
    <div className="ensemble-compare-file">
      <header className="ensemble-compare-file-head">
        <span>Open in every snapshot</span>
        <code>{path}</code>
        {untouchedPath && <strong>Not touched by the selected candidates</strong>}
      </header>
      <div className="ensemble-compare-panes" style={style}>
        {artifactIds.map((artifactId) => {
          const entry = patchCache.get(comparePatchKey(artifactId, path));
          const pathTouched = pathTouchedByArtifact.get(artifactId);
          return (
            <article className="ensemble-compare-pane" key={artifactId}>
              <h5>{subjectLabel(artifactId)}</h5>
              {!entry || entry.status === "loading" ? (
                <p className="ensemble-muted">Loading this file…</p>
              ) : entry.status === "error" ? (
                <p className="ensemble-error" role="alert">
                  {entry.error}
                </p>
              ) : (
                <>
                  {entry.value.truncated && (
                    <p className="ensemble-warn" role="note">
                      Patch truncated · {fmtBytes(entry.value.omittedBytes)} omitted
                    </p>
                  )}
                  {entry.value.patch ? (
                    <pre>{entry.value.patch}</pre>
                  ) : (
                    <p className="ensemble-muted">
                      {pathTouched === false
                        ? "Not touched by this candidate."
                        : "No text patch for this file."}
                    </p>
                  )}
                </>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}

function artifactOrdinal(detail: EnsembleRunDetailResponse, artifactId: string): number | null {
  const artifact = detail.artifacts.find((candidate) => candidate.id === artifactId);
  if (!artifact?.attemptId) return null;
  const attempt = detail.attempts.find((candidate) => candidate.id === artifact.attemptId);
  const member = attempt
    ? detail.members.find((candidate) => candidate.id === attempt.memberId)
    : detail.members.find((candidate) => candidate.selectedAttemptId === artifact.attemptId);
  return member?.ordinal ?? null;
}
