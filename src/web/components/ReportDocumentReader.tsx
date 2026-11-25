import { spokenNameLabel } from "@shared/voice-names.ts";
import { useReportAuthorIdentity } from "../lib/sessionReports.ts";
import { useEffect, useRef, useState } from "react";
import type { ReportItem } from "@shared/reports.ts";
import { api } from "../lib/api.ts";
import { HTML_PREVIEW_LINK_MESSAGE, HTML_PREVIEW_SANDBOX, htmlPreviewSource } from "../lib/htmlPreview.ts";
import { Markdown } from "./Markdown.tsx";
import { OVERLAY_IDS, Overlay } from "./Overlay.tsx";
import { Tooltip } from "./Tooltip.tsx";

/** What the reader has read so far. */
type Loaded = { state: "loading" } | { state: "ready"; text: string } | { state: "failed"; error: string };

/**
 * An agent report's attached document (`inbox` flag), read from the copy Mission Control stored
 * when the report was posted (`GET /api/reports/:id/document`), so it opens after the session's
 * worktree is gone.
 *
 * An HTML document is drawn in the dashboard's one sandboxed preview frame (`htmlPreview.ts`),
 * which runs none of the document's scripts and reaches nothing; a link it holds opens in the
 * browser only when it is an ordinary web address. A Markdown document goes through the
 * dashboard's Markdown renderer. Reading a document never marks its report read.
 */
export function ReportDocumentReader({
  report,
  onClose,
}: {
  report: ReportItem;
  onClose: () => void;
}): React.JSX.Element {
  const authorName = spokenNameLabel(useReportAuthorIdentity(report.author));
  const document = report.document;
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoaded({ state: "loading" });
    void fetch(api.reportDocumentUrl(report.id), { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `The document could not be read (HTTP ${response.status}).`);
        }
        const text = await response.text();
        if (!controller.signal.aborted) setLoaded({ state: "ready", text });
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) setLoaded({ state: "failed", error: error.message });
      });
    return () => controller.abort();
  }, [report.id]);

  // The preview frame claims every navigation and posts it here. Only a web address leaves, in a
  // new browser tab; a relative link has nothing stored beside the document to open.
  useEffect(() => {
    const follow = (event: MessageEvent): void => {
      if (event.source !== frame.current?.contentWindow) return;
      const data = event.data as { type?: string; href?: string } | null;
      if (data?.type !== HTML_PREVIEW_LINK_MESSAGE || typeof data.href !== "string") return;
      if (/^https?:\/\//i.test(data.href)) window.open(data.href, "_blank", "noopener,noreferrer");
    };
    window.addEventListener("message", follow);
    return () => window.removeEventListener("message", follow);
  }, []);

  const name = document?.name ?? "document";
  return (
    <Overlay
      id={OVERLAY_IDS.reportDocument}
      onClose={onClose}
      className="modal report-document-reader"
      role="dialog"
      ariaModal
      ariaLabel={`Report document: ${report.title}`}
    >
      <header className="modal-head">
        <div className="report-document-title">
          <strong>{report.title}</strong>
          <span className="dim"> · {authorName} · {name}</span>
        </div>
        <Tooltip label="Close the document. The report stays where it is">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
        </Tooltip>
      </header>
      <div className="modal-body report-document-body">
        <p className="inbox-line dim">
          The copy Mission Control stored when this report was posted. Reading it does not mark the
          report read.
        </p>
        {loaded.state === "loading" && <p className="inbox-line dim" role="status">Loading {name}…</p>}
        {loaded.state === "failed" && <p className="inbox-line inbox-error" role="alert">{loaded.error}</p>}
        {loaded.state === "ready" && (document?.kind === "html" ? (
          <iframe
            ref={frame}
            className="report-document-frame"
            title={`Report document: ${name}`}
            sandbox={HTML_PREVIEW_SANDBOX}
            srcDoc={htmlPreviewSource(loaded.text)}
          />
        ) : (
          <article className="markdown report-document-markdown">
            <Markdown>{loaded.text}</Markdown>
          </article>
        ))}
      </div>
    </Overlay>
  );
}
