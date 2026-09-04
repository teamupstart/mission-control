import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";

import { fetchSessionFile } from "../lib/api.ts";
import {
  classifyArtifactPreview,
  readArtifactExpanded,
  writeArtifactExpanded,
  type ArtifactPreviewResult,
  type ConversationArtifact,
} from "../lib/conversationArtifacts.ts";
import { formatBytes } from "../lib/format.ts";
import {
  HTML_PREVIEW_LINK_MESSAGE,
  HTML_PREVIEW_SANDBOX,
  htmlPreviewSource,
  inlinePreviewStyles,
} from "../lib/htmlPreview.ts";
import { workspaceAssetPath } from "../lib/workspaceLinks.ts";
import type { WorkspaceLinkHandler } from "./Markdown.tsx";
import { Tooltip } from "./Tooltip.tsx";

type PreviewState =
  | { status: "idle" | "loading"; result: null; previewText: null }
  | { status: "settled"; result: ArtifactPreviewResult; previewText: string | null };

const IDLE_PREVIEW: PreviewState = { status: "idle", result: null, previewText: null };

export interface ConversationArtifactsProps {
  sessionId: string;
  artifacts: readonly ConversationArtifact[];
  onOpenFile?: WorkspaceLinkHandler;
  onCommentInFiles?: (path: string) => void;
}

export function ConversationArtifacts({
  sessionId,
  artifacts,
  onOpenFile,
  onCommentInFiles,
}: ConversationArtifactsProps): React.JSX.Element | null {
  if (artifacts.length === 0) return null;
  return (
    <div className="turn-artifacts">
      {artifacts.map((artifact) => (
        <ArtifactCard
          key={artifact.path}
          sessionId={sessionId}
          path={artifact.path}
          onOpenFile={onOpenFile}
          onCommentInFiles={onCommentInFiles}
        />
      ))}
    </div>
  );
}

function ArtifactCard({
  sessionId,
  path,
  onOpenFile,
  onCommentInFiles,
}: {
  sessionId: string;
  path: string;
  onOpenFile?: WorkspaceLinkHandler;
  onCommentInFiles?: (path: string) => void;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(() => readArtifactExpanded(sessionId, path));
  const [near, setNear] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [preview, setPreview] = useState<PreviewState>(IDLE_PREVIEW);
  const cardRef = useRef<HTMLElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const reactId = useId().replaceAll(":", "");
  const bodyId = `artifact-body-${reactId}`;
  const eligible = expanded && near;

  const slash = path.lastIndexOf("/");
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const directory = slash >= 0 ? path.slice(0, slash + 1) : "";
  const resultSize = preview.status === "settled"
    ? preview.result.kind === "ready"
      ? preview.result.document.size
      : preview.result.size
    : null;

  useEffect(() => {
    const card = cardRef.current;
    if (!card || typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const root = card.closest<HTMLElement>(".transcript-log");
    const observer = new IntersectionObserver(
      ([entry]) => setNear(entry?.isIntersecting === true),
      { root, rootMargin: "600px 0px" },
    );
    observer.observe(card);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!eligible) {
      setPreview(IDLE_PREVIEW);
      return;
    }

    let live = true;
    const abort = new AbortController();
    setPreview({ status: "loading", result: null, previewText: null });
    void (async () => {
      try {
        const response = await fetchSessionFile(sessionId, path, abort.signal);
        if (!live || abort.signal.aborted) return;
        const result = classifyArtifactPreview(response);
        if (result.kind === "refusal") {
          setPreview({ status: "settled", result, previewText: null });
          return;
        }
        const previewText = await inlinePreviewStyles(
          result.document.text ?? "",
          path,
          async (assetPath) => {
            const asset = await fetchSessionFile(sessionId, assetPath, abort.signal);
            return asset.ok ? asset.file.text : null;
          },
          abort.signal,
        );
        if (!live || abort.signal.aborted) return;
        setPreview({ status: "settled", result, previewText });
      } catch {
        if (!live || abort.signal.aborted) return;
        setPreview({
          status: "settled",
          result: classifyArtifactPreview({ ok: false, error: "Preview read failed" }),
          previewText: null,
        });
      }
    })();
    return () => {
      live = false;
      abort.abort();
    };
  }, [eligible, path, refreshNonce, sessionId]);

  useEffect(() => {
    if (!eligible || !onOpenFile) return;
    const onMessage = (event: MessageEvent): void => {
      const data = event.data as { type?: unknown; href?: unknown } | null;
      if (data?.type !== HTML_PREVIEW_LINK_MESSAGE || typeof data.href !== "string") return;
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;
      const target = workspaceAssetPath(data.href, path);
      if (!target) return;
      void Promise.resolve(onOpenFile(target, true)).then((exists) => {
        if (exists) void onOpenFile(target, false);
      });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [eligible, onOpenFile, path]);

  const toggle = useCallback(() => {
    setExpanded((current) => {
      const next = !current;
      writeArtifactExpanded(sessionId, path, next);
      return next;
    });
  }, [path, sessionId]);

  const ready = preview.status === "settled" && preview.result.kind === "ready";
  const refusal = preview.status === "settled" && preview.result.kind === "refusal"
    ? preview.result
    : null;
  const source = eligible && ready && preview.previewText !== null
    ? htmlPreviewSource(preview.previewText)
    : undefined;
  const label = `Preview of ${path}`;

  return (
    <section
      ref={cardRef}
      className={`artifact-card${expanded ? " is-open" : ""}`}
      aria-label={label}
      data-preview-source={preview.previewText === null ? "released" : "loaded"}
    >
      <header className="artifact-head">
        <Tooltip label={`${expanded ? "Collapse" : "Expand"} preview of ${path}`}>
          <button
            type="button"
            className="artifact-disclose"
            aria-expanded={expanded}
            aria-controls={bodyId}
            onClick={toggle}
          >
            <span className="artifact-caret" aria-hidden="true" />
            <span className="artifact-name">{name}</span>
            {directory && <span className="artifact-dir">{directory}</span>}
          </button>
        </Tooltip>
        <span className="artifact-size">
          {resultSize === null ? "Size unavailable" : formatBytes(resultSize)}
        </span>
        <Tooltip label="Re-read this artifact from the checkout">
          <button
            type="button"
            className="artifact-act"
            aria-label={`Refresh preview of ${path}`}
            onClick={() => setRefreshNonce((nonce) => nonce + 1)}
          >
            Refresh
          </button>
        </Tooltip>
        {onCommentInFiles && (
          <Tooltip label="Open this rendered file in Files and start a comment">
            <button
              type="button"
              className="artifact-act is-primary"
              aria-label={`Comment on ${path} in Files`}
              onClick={() => onCommentInFiles(path)}
            >
              Comment in Files
            </button>
          </Tooltip>
        )}
      </header>
      <div
        id={bodyId}
        className={`artifact-body${refusal ? " artifact-refusal" : ""}`}
        hidden={!expanded}
      >
        {refusal ? (
          <>
            <p><strong>{refusal.title}</strong></p>
            <p>{refusal.explanation}</p>
          </>
        ) : (
          <>
            <iframe
              ref={frameRef}
              className="artifact-preview"
              title={label}
              sandbox={HTML_PREVIEW_SANDBOX}
              srcDoc={source}
            />
            {preview.status !== "settled" && (
              <p className="artifact-loading">
                {eligible ? "Loading preview…" : "Preview loads as it approaches the conversation."}
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
