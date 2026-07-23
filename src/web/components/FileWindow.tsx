import { useEffect, useRef, useState } from "react";
import type { Session } from "@shared/types.ts";
import type { SessionFilesController } from "../lib/sessionFiles.ts";
import { Overlay, OVERLAY_IDS } from "./Overlay.tsx";
import { FileWorkspace } from "./FileWorkspace.tsx";
import { Tooltip } from "./Tooltip.tsx";

interface Rect { x: number; y: number; width: number; height: number }

function initialRect(): Rect {
  const width = Math.min(1180, Math.max(720, window.innerWidth - 96));
  const height = Math.min(780, Math.max(520, window.innerHeight - 96));
  return { x: (window.innerWidth - width) / 2, y: (window.innerHeight - height) / 2, width, height };
}

export function FileWindow({
  session,
  controller,
  onClose,
}: {
  session: Session;
  controller: SessionFilesController;
  onClose: () => void;
}): React.JSX.Element {
  const [rect, setRect] = useState(initialRect);
  const [maximized, setMaximized] = useState(() => window.innerWidth < 760);
  const restore = useRef(rect);

  useEffect(() => () => controller.flush(session.id), [controller.flush, session.id]);

  function drag(event: React.PointerEvent<HTMLElement>): void {
    if (maximized || (event.target as HTMLElement).closest("button,input")) return;
    const start = { x: event.clientX, y: event.clientY, rect };
    const move = (next: PointerEvent) => setRect({
      ...start.rect,
      x: Math.max(0, Math.min(window.innerWidth - 120, start.rect.x + next.clientX - start.x)),
      y: Math.max(0, Math.min(window.innerHeight - 52, start.rect.y + next.clientY - start.y)),
    });
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function resize(event: React.PointerEvent<HTMLDivElement>): void {
    event.stopPropagation();
    const start = { x: event.clientX, y: event.clientY, rect };
    const move = (next: PointerEvent) => setRect({
      ...start.rect,
      width: Math.max(620, Math.min(window.innerWidth - start.rect.x, start.rect.width + next.clientX - start.x)),
      height: Math.max(420, Math.min(window.innerHeight - start.rect.y, start.rect.height + next.clientY - start.y)),
    });
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function toggleMaximize(): void {
    if (!maximized) restore.current = rect;
    else setRect(restore.current);
    setMaximized((value) => !value);
  }

  return (
    <Overlay id={OVERLAY_IDS.files} onClose={onClose} className="file-window-shell" role="dialog" ariaLabel={`Files for ${session.name}`}>
      <div className={`file-window${maximized ? " is-maximized" : ""}`} style={maximized ? undefined : { left: rect.x, top: rect.y, width: rect.width, height: rect.height }}>
        <header className="file-window-head" onPointerDown={drag} onDoubleClick={toggleMaximize}>
          <div><strong>{session.name}</strong><span>Files</span></div>
          <div className="file-window-actions">
            <Tooltip label={maximized ? "Restore this window to its previous size" : "Maximize this window"}><button className="icon-btn" onClick={toggleMaximize} aria-label={maximized ? "Restore files window" : "Maximize files window"}>{maximized ? "❐" : "□"}</button></Tooltip>
            <Tooltip label="Close the files window"><button className="icon-btn" onClick={onClose} aria-label="Close files window">✕</button></Tooltip>
          </div>
        </header>
        <FileWorkspace session={session} controller={controller} extracted />
        {!maximized && <div className="file-window-resize" onPointerDown={resize} aria-hidden />}
      </div>
    </Overlay>
  );
}
