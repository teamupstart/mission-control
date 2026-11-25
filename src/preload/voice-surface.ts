// This document is a same-origin React portal owned by the dashboard. It has no
// dashboard preload privileges. Report only its content height and hit testing.
import { ipcRenderer } from "electron";

ipcRenderer.on("voice:anchor", (_event, right: number) => {
  document.documentElement.style.setProperty("--voice-anchor-right", right + "px");
});

window.addEventListener("DOMContentLoaded", () => {
  const root = document.getElementById("root")!;
  const layout = () => ipcRenderer.send("voice:layout", root.querySelector(".voice-standalone") ? root.getBoundingClientRect().height : 0,
    !!root.querySelector(".rh-pop"));
  new ResizeObserver(layout).observe(root);
  new MutationObserver(layout).observe(root, { childList: true });
  let inside = false;
  const pointer = (next: boolean) => {
    if (next === inside) return;
    inside = next;
    ipcRenderer.send("voice:pointer", inside);
  };
  const hitTest = (x: number, y: number) => pointer(!!document.elementFromPoint(x, y)?.closest(".voice-card,.vc-switch,.rh-pop"));
  ipcRenderer.on("voice:hit-test", (_event, x: number, y: number) => hitTest(x, y));
  document.addEventListener("mousemove", e => hitTest(e.clientX, e.clientY));
  document.addEventListener("mouseleave", () => pointer(false));
});
