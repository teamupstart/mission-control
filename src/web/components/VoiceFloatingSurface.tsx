import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { TooltipDocument } from "./Tooltip.tsx";

export function useVoiceSurface(surface: "pill" | "popover", enabled: boolean) {
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const opener = useRef<(() => void) | null>(null);
  const requestOpen = useCallback(() => opener.current?.(), []);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let child: Window | null = null;
    const clear = () => { child = null; setRoot(null); };
    const left = (event: PageTransitionEvent) => { if (event.currentTarget === child) clear(); };
    const close = () => child?.close();
    window.addEventListener("pagehide", close);
    const ready = (event: MessageEvent) => {
      if (!child || event.source !== child || event.origin !== location.origin || event.data !== "mission-voice-ready") return;
      setRoot(child.document.getElementById("root"));
      child.addEventListener("pagehide", left, { once: true });
    };
    window.addEventListener("message", ready);
    // The same request warms the window or replaces one the operator closed.
    // StrictMode may release the effect before the queued open is needed.
    opener.current = () => queueMicrotask(() => {
      if (active && (!child || child.closed)) child = window.open("/#/voice/" + surface, "mission-voice-" + surface);
    });
    requestOpen();
    return () => {
      active = false;
      opener.current = null;
      window.removeEventListener("message", ready);
      child?.removeEventListener("pagehide", left);
      window.removeEventListener("pagehide", close);
      close();
      clear();
    };
  }, [enabled, surface, requestOpen]);
  return { root: enabled ? root : null, requestOpen };
}

export function voicePortal(root: HTMLElement, children: ReactNode) {
  return createPortal(<TooltipDocument.Provider value={root.ownerDocument}>{children}</TooltipDocument.Provider>, root);
}

/** Move the portal container, keeping the dashboard's keyed card tree mounted across placements. */
export function VoiceCardOutlet({ root, placement, hidden, children }: {
  root: HTMLElement | null; placement: "pill" | "popover" | "toast"; hidden: boolean; children: ReactNode;
}) {
  const [container] = useState(() => {
    const element = document.createElement("div");
    element.style.display = "contents";
    return element;
  });
  const attach = useCallback((slot: HTMLDivElement | null) => { slot?.appendChild(container); }, [container]);
  return <>
    {root ? createPortal(<div ref={attach} className={`voice-standalone voice-${placement}`} hidden={hidden} />, root)
      : <div ref={attach} style={{ display: "contents" }} />}
    {createPortal(<TooltipDocument.Provider value={root?.ownerDocument ?? document}>{children}</TooltipDocument.Provider>, container)}
  </>;
}
