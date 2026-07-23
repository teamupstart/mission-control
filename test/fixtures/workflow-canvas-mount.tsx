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
window.setTimeout(() => {
  window.__workflowCanvasResult = {
    mounted: document.querySelector('[aria-label="Workflow graph editor"]') !== null,
    errors,
    controls: [...document.querySelectorAll<HTMLButtonElement>(".react-flow__controls button")]
      .map((button) => button.getAttribute("aria-label") ?? ""),
    nativeTitles: document.querySelectorAll(".react-flow__controls [title]").length,
    attribution: document.querySelector(".react-flow__attribution a") !== null,
  };
}, 250);
