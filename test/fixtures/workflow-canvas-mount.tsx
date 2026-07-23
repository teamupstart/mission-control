import { createRoot } from "react-dom/client";
import type { WorkflowDraftGraph } from "@shared/workflow.ts";
import { WorkflowCanvas } from "../../src/web/workflows/WorkflowCanvas.tsx";

declare global {
  interface Window {
    __workflowCanvasResult?: {
      mounted: boolean;
      errors: string[];
      controls: string[];
      nativeTitles: number;
      attribution: boolean;
      maxZoomDisabled: boolean;
      maxZoomDescription: string;
      minZoomDisabled: boolean;
      minZoomDescription: string;
    };
  }
}

const errors: string[] = [];
window.addEventListener("error", (event) => {
  errors.push(event.error instanceof Error ? event.error.message : event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  errors.push(event.reason instanceof Error ? event.reason.message : String(event.reason));
});

const graph: WorkflowDraftGraph = {
  nodes: [
    { id: "session", kind: "session", position: { x: 0, y: 0 } },
    { id: "end", kind: "end", outcome: "Approved", position: { x: 300, y: 0 } },
  ],
  edges: [],
};
const root = document.querySelector<HTMLDivElement>("#root");
if (!root) throw new Error("Missing workflow canvas root");

createRoot(root).render(<WorkflowCanvas graph={graph} personas={[]} onChange={() => {}} />);
window.setTimeout(async () => {
  for (let i = 0; i < 30; i++) {
    const zoomIn = document.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]');
    if (!zoomIn) throw new Error("Missing workflow zoom-in control");
    if (zoomIn.disabled) break;
    zoomIn.click();
    await new Promise((resolve) => window.setTimeout(resolve, 20));
  }
  const zoomIn = document.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]');
  if (!zoomIn) throw new Error("Missing workflow zoom-in control");
  const maxZoomDisabled = zoomIn.disabled;
  const maxZoomDescription =
    document.getElementById(zoomIn.getAttribute("aria-describedby") ?? "")?.textContent ?? "";

  for (let i = 0; i < 30; i++) {
    const zoomOut = document.querySelector<HTMLButtonElement>('[aria-label="Zoom out"]');
    if (!zoomOut) throw new Error("Missing workflow zoom-out control");
    if (zoomOut.disabled) break;
    zoomOut.click();
    await new Promise((resolve) => window.setTimeout(resolve, 20));
  }
  const zoomOut = document.querySelector<HTMLButtonElement>('[aria-label="Zoom out"]');
  if (!zoomOut) throw new Error("Missing workflow zoom-out control");
  const minZoomDescription =
    document.getElementById(zoomOut.getAttribute("aria-describedby") ?? "")?.textContent ?? "";

  window.__workflowCanvasResult = {
    mounted: document.querySelector('[aria-label="Workflow graph editor"]') !== null,
    errors,
    controls: [...document.querySelectorAll<HTMLButtonElement>(".react-flow__controls button")]
      .map((button) => button.getAttribute("aria-label") ?? ""),
    nativeTitles: document.querySelectorAll(".react-flow__controls [title]").length,
    attribution: document.querySelector(".react-flow__attribution a") !== null,
    maxZoomDisabled,
    maxZoomDescription,
    minZoomDisabled: zoomOut.disabled,
    minZoomDescription,
  };
}, 250);
