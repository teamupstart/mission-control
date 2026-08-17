import type { ComponentType } from "react";
import { MermaidDiagram } from "./MermaidDiagram.tsx";

export interface MarkdownDiagramProps {
  source: string;
  ordinal: number;
}

export type MarkdownDiagramRegistry = Readonly<Record<string, ComponentType<MarkdownDiagramProps>>>;

/** The Files Preview capability. Unknown fence tags never leave the normal code path. */
export const FILES_DIAGRAM_RENDERERS: MarkdownDiagramRegistry = Object.freeze({
  mermaid: MermaidDiagram,
});
