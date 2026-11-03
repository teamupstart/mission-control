import { useEffect, useMemo, useRef, useState } from "react";
import {
  MERMAID_ERROR_MESSAGE,
  MERMAID_MAX_SOURCE_LENGTH,
  MERMAID_MIN_FRAME_HEIGHT,
  MERMAID_PREVIEW_SANDBOX,
  MERMAID_READY_MESSAGE,
  MERMAID_RENDER_TIMEOUT_MS,
  MERMAID_RENDERED_MESSAGE,
  acceptMermaidRendererMessage,
  createMermaidInstanceToken,
  createMermaidRenderRequest,
  mermaidRendererUrl,
  readMermaidPalette,
} from "../lib/mermaidPreview.ts";
import { skinById } from "@shared/skins.ts";
import { useUiConfig } from "../lib/uiConfig.ts";
import type { MarkdownDiagramProps } from "./markdownDiagramRegistry.tsx";

type RenderState =
  | { kind: "loading"; message: string; height: number }
  | { kind: "rendered"; height: number; skin: string }
  | { kind: "error"; message: string };

function SourceFailure({ message, source }: { message: string; source: string }): React.JSX.Element {
  return (
    <div className="mermaid-diagram-failure">
      <p role="alert">{message}</p>
      <pre><code className="language-mermaid">{source}</code></pre>
    </div>
  );
}

export function MermaidDiagram({ source, ordinal }: MarkdownDiagramProps): React.JSX.Element {
  const figure = useRef<HTMLElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const token = useMemo(createMermaidInstanceToken, []);
  const [nearViewport, setNearViewport] = useState(false);
  const [state, setState] = useState<RenderState>({
    kind: "loading",
    message: "Waiting to render…",
    height: MERMAID_MIN_FRAME_HEIGHT,
  });
  const tooLarge = source.length > MERMAID_MAX_SOURCE_LENGTH;
  const label = `Mermaid diagram ${ordinal}`;
  // The palette is read from computed tokens when the diagram renders, so a skin change has
  // to render it again. The renderer consumes one request per frame, so the frame is keyed on
  // the skin below and a change mounts a fresh one that asks for the new palette.
  const skin = useUiConfig().skin;
  // A render belongs to the skin it was drawn in. The moment the skin changes, the frame keyed on
  // it is a fresh document still in the renderer's initial dark scheme, so it is shown as loading
  // - hidden under the status line - in that same commit, until it reports a render in the new
  // skin. Derived here rather than reset in an effect, which would leave one committed frame with
  // the replacement on screen.
  const shown: RenderState =
    state.kind === "rendered" && state.skin !== skin
      ? { kind: "loading", message: "Rendering diagram…", height: state.height }
      : state;

  useEffect(() => {
    if (tooLarge || nearViewport) return;
    const host = figure.current;
    if (!host || typeof IntersectionObserver === "undefined") {
      setNearViewport(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setNearViewport(true);
        observer.disconnect();
      }
    }, { rootMargin: "600px 0px" });
    observer.observe(host);
    return () => observer.disconnect();
  }, [nearViewport, tooLarge]);

  useEffect(() => {
    if (!nearViewport || tooLarge) return;
    let settled = false;
    let sent = false;
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      setState({
        kind: "error",
        message: "Diagram rendering timed out. The Mermaid source is shown below.",
      });
    }, MERMAID_RENDER_TIMEOUT_MS);

    const settle = (next: RenderState): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      setState(next);
    };
    const onMessage = (event: MessageEvent): void => {
      const target = frame.current?.contentWindow;
      if (!target) return;
      const message = acceptMermaidRendererMessage(event, target, token);
      if (!message) return;
      if (message.type === MERMAID_READY_MESSAGE) {
        if (sent) return;
        sent = true;
        const palette = readMermaidPalette();
        const request = palette
          ? createMermaidRenderRequest(token, source, ordinal, palette, skinById(skin).colorScheme)
          : null;
        if (!request) {
          settle({
            kind: "error",
            message: "The diagram palette or source could not be validated. The Mermaid source is shown below.",
          });
          return;
        }
        setState({
          kind: "loading",
          message: "Rendering diagram…",
          height: MERMAID_MIN_FRAME_HEIGHT,
        });
        target.postMessage(request, "*");
        return;
      }
      if (message.type === MERMAID_RENDERED_MESSAGE) {
        settle({ kind: "rendered", height: message.height, skin });
        return;
      }
      if (message.type === MERMAID_ERROR_MESSAGE) {
        settle({
          kind: "error",
          message: `Diagram could not render: ${message.message}`,
        });
      }
    };

    window.addEventListener("message", onMessage);
    return () => {
      settled = true;
      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
    };
  }, [nearViewport, ordinal, skin, source, token, tooLarge]);

  return (
    <figure
      ref={figure}
      className={`mermaid-diagram is-${tooLarge ? "error" : shown.kind}`}
      aria-label={label}
      data-mermaid-state={tooLarge ? "too-large" : shown.kind}
    >
      <figcaption><span>Mermaid</span><span>Diagram {String(ordinal).padStart(2, "0")}</span></figcaption>
      {tooLarge ? (
        <SourceFailure
          message={`Diagram not rendered because its source exceeds ${MERMAID_MAX_SOURCE_LENGTH.toLocaleString()} characters.`}
          source={source}
        />
      ) : shown.kind === "error" ? (
        <SourceFailure message={shown.message} source={source} />
      ) : (
        <div className="mermaid-diagram-stage">
          {nearViewport && (
            <iframe
              key={skin}
              ref={frame}
              className="mermaid-diagram-frame"
              title={label}
              sandbox={MERMAID_PREVIEW_SANDBOX}
              referrerPolicy="origin"
              loading="lazy"
              src={mermaidRendererUrl(token)}
              style={{ height: shown.height }}
            />
          )}
          {shown.kind === "loading" && (
            <p className="mermaid-diagram-status" role="status">{shown.message}</p>
          )}
        </div>
      )}
    </figure>
  );
}
