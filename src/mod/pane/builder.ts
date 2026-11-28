import type { ModPanePlacement, ModPaneTab } from "../host.ts";
import type { PaneButton, PaneInput, PaneLine, PaneNode, PaneView } from "./types.ts";

export interface ViewBuilder {
  text: (text: string, style?: Omit<PaneLine, "text">) => void;
  button: (button: PaneButton) => void;
  input: (input: PaneInput) => void;
  build: () => PaneView;
}

export function viewBuilder(tab: ModPaneTab, placement: ModPanePlacement): ViewBuilder {
  const nodes: PaneNode[] = [];
  return {
    text: (text, style) => void nodes.push({ kind: "text", line: { text, ...style } }),
    button: (button) => void nodes.push({ kind: "button", button }),
    input: (input) => void nodes.push({ kind: "input", input }),
    build: () => {
      // The first answer or row takes focus when the pane does; chrome never does.
      const first = nodes.find((n) => n.kind === "button" && (n.button.group === undefined || n.button.group === "action" || n.button.group === "row"));
      if (first && first.kind === "button") first.button.autoFocus = true;
      return {
        tab,
        placement,
        nodes,
        lines: nodes.flatMap((n) => (n.kind === "text" ? [n.line.text] : [])),
        buttons: nodes.flatMap((n) => (n.kind === "button" ? [n.button] : [])),
        inputs: nodes.flatMap((n) => (n.kind === "input" ? [n.input] : [])),
      };
    },
  };
}
