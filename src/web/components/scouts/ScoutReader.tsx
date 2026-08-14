import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ArchiveArtifactRole,
  ArchiveArtifactView,
  ArchiveDetail,
} from "@shared/archives.ts";
import type { OpenTargetId } from "@shared/open-targets.ts";
import { api } from "../../lib/api.ts";
import { formatBytes } from "../../lib/format.ts";
import {
  HTML_PREVIEW_LINK_MESSAGE,
  HTML_PREVIEW_SANDBOX,
  htmlPreviewSource,
} from "../../lib/htmlPreview.ts";
import { COPY_FEEDBACK_LABEL, useCopyFeedback } from "../../lib/clipboard.ts";
import { Markdown } from "../Markdown.tsx";
import { OpenInMenu } from "../OpenInMenu.tsx";
import { Tooltip } from "../Tooltip.tsx";
import type { ScoutDeleteTarget } from "./ScoutDeleteModal.tsx";
import type { ScoutDetailState } from "./useScoutsCatalog.ts";
import { SCOUT_STATUS_WORD, scoutLabel } from "./scout-labels.ts";

const ROLE_WORD: Record<ArchiveArtifactRole, string> = {
  primary_report: "Primary report",
  report_companion: "Report companion",
  supporting: "Supporting",
};

/** The largest artifact this pane will render inline rather than offer as a download. */
const MAX_INLINE_PREVIEW_BYTES = 2 * 1024 * 1024;

/**
 * The media type WITHOUT its parameters.
 *
 * A manifest records `text/html; charset=utf-8`, not `text/html`, so every equality test
 * against a bare type silently fails and the primary report renders as its own source in a
 * `<pre>` instead of in the sandbox. Caught by opening a real archive; no type says this,
 * because both spellings are a `string`.
 */
function mediaEssence(mediaType: string): string {
  return mediaType.split(";")[0]!.trim().toLowerCase();
}

function isTextual(mediaType: string): boolean {
  const essence = mediaEssence(mediaType);
  return (
    essence.startsWith("text/") ||
    essence === "application/json" ||
    essence === "application/xml"
  );
}

function isMarkdown(artifact: ArchiveArtifactView): boolean {
  return mediaEssence(artifact.mediaType) === "text/markdown"
    || artifact.archivePath.endsWith(".md");
}

/** What an artifact's bytes turned into, once fetched. */
type Loaded =
  | { kind: "html"; text: string }
  | { kind: "markdown"; text: string }
  | { kind: "text"; text: string }
  | { kind: "image"; url: string }
  | { kind: "opaque" }
  | { kind: "error"; error: string }
  | { kind: "loading" };

export function ScoutReader({
  detail,
  state,
  error,
  libraryPath,
  onDelete,
  onBack,
}: {
  detail: ArchiveDetail | null;
  state: ScoutDetailState;
  error: string | null;
  libraryPath: string | null;
  onDelete: (target: ScoutDeleteTarget, from: HTMLElement) => void;
  onBack: () => void;
}): React.JSX.Element {
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const copyBundle = useCopyFeedback({ resetOn: detail?.key ?? null });
  const [opening, setOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  /** The object URL currently on screen, revoked whenever it is replaced or unmounted. */
  const objectUrl = useRef<string | null>(null);

  const artifacts = useMemo(() => detail?.artifacts ?? [], [detail]);
  // The primary report opens by default; a scout's answer is the point of the page.
  const activeId = selectedArtifactId ?? detail?.primaryArtifactId ?? artifacts[0]?.id ?? null;
  const active = artifacts.find((artifact) => artifact.id === activeId) ?? null;

  useEffect(() => setSelectedArtifactId(null), [detail?.key]);

  const releaseUrl = useCallback((): void => {
    if (objectUrl.current) {
      URL.revokeObjectURL(objectUrl.current);
      objectUrl.current = null;
    }
  }, []);

  useEffect(() => releaseUrl, [releaseUrl]);

  useEffect(() => {
    if (!detail || !active) {
      setLoaded({ kind: "opaque" });
      return;
    }
    const controller = new AbortController();
    releaseUrl();
    setLoaded({ kind: "loading" });
    const isImage = mediaEssence(active.mediaType).startsWith("image/");
    const textual = isTextual(active.mediaType);
    if (!isImage && !textual) {
      // Unknown or binary stays downloadable and openable, but is never rendered as text -
      // dumping a PNG's bytes into a <pre> is not a preview, it is a hang.
      setLoaded({ kind: "opaque" });
      return;
    }
    if (active.bytes > MAX_INLINE_PREVIEW_BYTES) {
      setLoaded({ kind: "opaque" });
      return;
    }
    void api.archiveArtifact(detail.key, active.id, controller.signal).then(async (result) => {
      if (controller.signal.aborted) return;
      if (!result.ok) {
        setLoaded({ kind: "error", error: result.error });
        return;
      }
      if (isImage) {
        const url = URL.createObjectURL(result.value.blob);
        objectUrl.current = url;
        setLoaded({ kind: "image", url });
        return;
      }
      const text = await result.value.blob.text();
      if (controller.signal.aborted) return;
      if (mediaEssence(active.mediaType) === "text/html") setLoaded({ kind: "html", text });
      else if (isMarkdown(active)) setLoaded({ kind: "markdown", text });
      else setLoaded({ kind: "text", text });
    });
    return () => controller.abort();
  }, [detail, active, releaseUrl]);

  /*
   * The receiving half of the shared preview's link bridge.
   *
   * A relative link inside an archived report resolves to a VERIFIED companion artifact or
   * to nothing at all. There is no path arithmetic and no fallback that hands the href to
   * the browser: the iframe has already cancelled the navigation, and every unclaimed link
   * staying inert is the designed outcome, not a gap. External URLs, schemes and escaping
   * paths never reach here - capture refused them - but an unclaimed link is still the
   * ordinary case for a citation the report deliberately left as text.
   */
  useEffect(() => {
    if (!detail) return;
    const onMessage = (event: MessageEvent): void => {
      const data = event.data as { type?: string; href?: string } | null;
      if (data?.type !== HTML_PREVIEW_LINK_MESSAGE || typeof data.href !== "string") return;
      const primary = artifacts.find((a) => a.id === detail.primaryArtifactId);
      if (!primary) return;
      const base = primary.archivePath.slice(0, primary.archivePath.lastIndexOf("/") + 1);
      // Normalized against the report directory, then matched against a captured artifact's
      // own archive path. A miss is simply not claimed.
      let resolved: string;
      try {
        resolved = new URL(data.href, `mission:/${base}`).pathname.replace(/^\//, "");
      } catch {
        return;
      }
      const match = artifacts.find((a) => a.archivePath === resolved);
      if (match) setSelectedArtifactId(match.id);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [detail, artifacts]);

  async function openArtifact(target: OpenTargetId): Promise<void> {
    if (!detail || !active) return;
    setOpening(true);
    setOpenError(null);
    const result = await api.openArchiveArtifact(detail.key, active.id, target);
    setOpening(false);
    if (!result.ok) setOpenError(result.error ?? "That artifact could not be opened.");
  }

  if (state === "error") {
    return (
      <section className="scouts-reader" aria-label="Scout report">
        <div className="scouts-empty" role="alert">
          <p className="empty-title">This scout could not be read</p>
          <p className="empty-sub">{error}</p>
          <Tooltip label="Return to the archive list">
            <button type="button" className="btn" onClick={onBack}>Back to all scouts</button>
          </Tooltip>
        </div>
      </section>
    );
  }

  if (!detail) {
    return (
      <section className="scouts-reader" aria-label="Scout report">
        <div className="scouts-empty">
          <p className="empty-title">
            {state === "loading" ? "Opening the archive…" : "No scout selected"}
          </p>
          <p className="empty-sub">
            {state === "loading" ? "" : "Choose an archive to read its report."}
          </p>
        </div>
      </section>
    );
  }

  const repos = detail.repositories.map((repo) => repo.label).filter(Boolean).join(", ");

  return (
    <>
      <section className="scouts-reader" aria-label="Scout report">
        <header className="scouts-head">
          <Tooltip label="Return to the archive list">
            <button type="button" className="btn btn-ghost scouts-back" onClick={onBack}>
              <span aria-hidden>←</span> All scouts
            </button>
          </Tooltip>
          <p className="scouts-eyebrow">{scoutLabel(detail)}</p>
          <h1 className="scouts-question">{detail.question ?? scoutLabel(detail)}</h1>
          <div className="scouts-provenance">
            <span className={`badge badge-${detail.status === "ready"
              ? "idle"
              : detail.status === "partial" ? "attention" : "exited"}`}
            >
              <span className="badge-dot" />
              {SCOUT_STATUS_WORD[detail.status]}
            </span>
            {detail.agent ? <span className="chip mono">{detail.agent}</span> : null}
            {detail.model ? <span className="chip mono">{detail.model}</span> : null}
            {repos ? <span className="chip mono">{repos}</span> : null}
            {detail.source ? <span className="chip mono">source {detail.source}</span> : null}
            <span className="chip mono">{formatBytes(detail.bytes)}</span>
            {detail.producerLabel ? (
              // A producer label is an UNVERIFIED claim out of a manifest that may have been
              // copied here from another machine. It is shown because it is useful and
              // labelled because it is not an identity.
              <Tooltip label="A claim from this bundle's manifest. Mission Control does not verify producer identity.">
                <span className="chip mono scouts-foreign">
                  {detail.producerLabel} (unverified)
                </span>
              </Tooltip>
            ) : null}
            <span className="spacer" />
            <Tooltip label="Delete this archive from the library on this machine">
            <button
              type="button"
              className="btn btn-danger-ghost"
              onClick={(event) =>
                onDelete(
                  {
                    key: detail.key,
                    title: scoutLabel(detail),
                    producerLabel: detail.producerLabel,
                    bytes: detail.bytes,
                  },
                  event.currentTarget,
                )
              }
            >
              Delete scout
            </button>
            </Tooltip>
          </div>
          {/*
            The daemon's own diagnostic for a bundle it could not read.

            This is the ONLY thing this pane can honestly say about an unreadable archive,
            and leaving it out was a real defect caught by looking at the running page: the
            body below promises "its manifest says why above" while the reason sat only in
            the rail row, so the reader asserted an explanation it was not showing.
          */}
          {detail.error ? (
            <p className="scouts-unreadable" role="alert">
              <strong>This bundle could not be read.</strong> {detail.error}
            </p>
          ) : null}
          {detail.missing.length > 0 ? (
            <ul className="scouts-missing" aria-label="Missing evidence">
              {detail.missing.map((missing, index) => (
                <li key={index}>
                  <strong>{missing.kind.replace(/_/g, " ")}</strong>
                  {missing.expectedSource ? (
                    <> · <span className="mono">{missing.expectedSource}</span></>
                  ) : null}
                  {" · "}{missing.reason}
                </li>
              ))}
            </ul>
          ) : null}
        </header>

        <div className="scouts-doc">
          {active ? (
            <>
              <p className="scouts-sandbox-note mono">
                sandboxed {active.archivePath} · scripts and network blocked
              </p>
              {loaded.kind === "loading" ? (
                <p className="scouts-loading" role="status">Loading…</p>
              ) : loaded.kind === "error" ? (
                <p className="scouts-doc-error" role="alert">{loaded.error}</p>
              ) : loaded.kind === "html" ? (
                <iframe
                  className="scouts-preview"
                  title={`Report ${active.archivePath}`}
                  sandbox={HTML_PREVIEW_SANDBOX}
                  srcDoc={htmlPreviewSource(loaded.text)}
                />
              ) : loaded.kind === "markdown" ? (
                <div className="scouts-markdown"><Markdown>{loaded.text}</Markdown></div>
              ) : loaded.kind === "image" ? (
                <img className="scouts-image" src={loaded.url} alt={active.archivePath} />
              ) : loaded.kind === "text" ? (
                <pre className="scouts-text">{loaded.text}</pre>
              ) : (
                <p className="scouts-opaque">
                  {active.bytes > MAX_INLINE_PREVIEW_BYTES
                    ? `This file is ${formatBytes(active.bytes)}, too large to preview here.`
                    : `Mission Control does not preview ${active.mediaType} files.`}
                  {" "}Download it or open it in another application.
                </p>
              )}
            </>
          ) : (
            <p className="scouts-opaque">
              {detail.error
                ? "There is nothing to read in this bundle. The diagnostic above is all Mission Control could recover; the files are still on disk and can be deleted from here."
                : "This archive has no readable primary report. Any missing evidence is listed above."}
            </p>
          )}
        </div>
      </section>

      <aside className="scouts-spine" aria-label="Evidence">
        <h2 className="scouts-spine-head">
          Evidence
          <span className="mono scouts-spine-count">
            {artifacts.length} file{artifacts.length === 1 ? "" : "s"}
          </span>
        </h2>
        <ul className="scouts-stops">
          {artifacts.map((artifact) => (
            <li
              key={artifact.id}
              className={`scouts-stop${artifact.id === activeId ? " is-selected" : ""}`}
            >
              <Tooltip label={`Read ${artifact.archivePath} (${ROLE_WORD[artifact.role]})`}>
              <button
                type="button"
                className="scouts-stop-open"
                aria-current={artifact.id === activeId ? "true" : undefined}
                onClick={() => setSelectedArtifactId(artifact.id)}
              >
                <span className="scouts-stop-node" aria-hidden />
                <span className="scouts-stop-name mono">{artifact.archivePath}</span>
                <span className="scouts-stop-role">{ROLE_WORD[artifact.role]}</span>
                <span className="scouts-stop-meta mono">
                  {artifact.mediaType} · {formatBytes(artifact.bytes)}
                </span>
                {artifact.originalPath ? (
                  <span className="scouts-stop-origin mono">from {artifact.originalPath}</span>
                ) : null}
                <span className="scouts-stop-digest mono">{artifact.sha256.slice(0, 19)}…</span>
              </button>
              </Tooltip>
              {artifact.id === activeId ? (
                <div className="scouts-stop-actions">
                  <Tooltip label={`Save ${artifact.archivePath} out of the archive`}>
                    <a
                      className="btn btn-ghost"
                      href={`/api/archives/${encodeURIComponent(detail.key)}/artifacts/${
                        encodeURIComponent(artifact.id)
                      }`}
                      download
                    >
                      Download
                    </a>
                  </Tooltip>
                  <OpenInMenu
                    disabled={false}
                    busy={opening}
                    onChoose={(target) => { void openArtifact(target); }}
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
        {openError ? <p className="scouts-open-error" role="alert">{openError}</p> : null}

        <div className="scouts-bundle">
          <h3 className="scouts-eyebrow">Bundle</h3>
          <p className="scouts-bundle-path mono">{detail.bundlePath}</p>
          <Tooltip label="Copy this bundle's absolute directory to the clipboard">
            <button
              className="btn"
              type="button"
              onClick={() => { void copyBundle.copy(() => detail.bundlePath); }}
            >
              {copyBundle.copied ? COPY_FEEDBACK_LABEL : "Copy path"}
            </button>
          </Tooltip>
          {libraryPath ? (
            <p className="scouts-library mono">Library: {libraryPath}</p>
          ) : null}
        </div>
      </aside>
    </>
  );
}
