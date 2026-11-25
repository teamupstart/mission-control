import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { TooltipDocument } from "./Tooltip.tsx";

export function useVoiceSurface(surface: "pill" | "popover", enabled: boolean) {
  const [root, setRoot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let child: Window | null = null;
    const clear = () => setRoot(null);
    const close = () => child?.close();
    window.addEventListener("pagehide", close);
    const ready = (event: MessageEvent) => {
      if (!child || event.source !== child || event.origin !== location.origin || event.data !== "mission-voice-ready") return;
      setRoot(child.document.getElementById("root"));
      child.addEventListener("pagehide", clear, { once: true });
    };
    window.addEventListener("message", ready);
    // StrictMode can release the effect before a native window has been created.
    queueMicrotask(() => {
      if (active) child = window.open("/#/voice/" + surface, "mission-voice-" + surface);
    });
    return () => {
      active = false;
      window.removeEventListener("message", ready);
      child?.removeEventListener("pagehide", clear);
      window.removeEventListener("pagehide", close);
      close();
      clear();
    };
  }, [enabled, surface]);
  return enabled ? root : null;
}

export function voicePortal(root: HTMLElement, children: ReactNode) {
  return createPortal(<TooltipDocument.Provider value={root.ownerDocument}>{children}</TooltipDocument.Provider>, root);
}
