export interface DiagramHastNode {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  data?: Record<string, unknown>;
  children?: DiagramHastNode[];
}

export const DIAGRAM_TAG_PROPERTY = "dataMissionDiagramTag";
export const DIAGRAM_ORDINAL_PROPERTY = "dataMissionDiagramOrdinal";
export const DIAGRAM_LIMIT_PROPERTY = "dataMissionDiagramLimit";

function languageTag(node: DiagramHastNode): string | null {
  // remark-rehype preserves any words after the fence language in `data.meta`.
  // A metadata-bearing fence is not the exact capability tag, even though its
  // generated class is still only `language-mermaid`.
  if (typeof node.data?.meta === "string" && node.data.meta.trim()) return null;
  const classes = node.properties?.className;
  if (!Array.isArray(classes)) return null;
  for (const value of classes) {
    if (typeof value === "string" && value.startsWith("language-")) {
      return value.slice("language-".length);
    }
  }
  return null;
}

/**
 * Annotate only real fenced block-code nodes. The custom `pre` renderer consumes these
 * properties, so inline code and language-looking prose can never enter the registry.
 */
export function rehypeDiagramFences(options: {
  tags: readonly string[];
  limit: number;
}): (tree: DiagramHastNode) => void {
  const tags = new Set(options.tags);
  return (tree) => {
    let ordinal = 0;
    const visit = (node: DiagramHastNode): void => {
      if (node.type === "element" && node.tagName === "pre") {
        const code = node.children?.length === 1 ? node.children[0] : null;
        if (code?.type === "element" && code.tagName === "code") {
          const tag = languageTag(code);
          if (tag && tags.has(tag)) {
            ordinal += 1;
            code.properties ??= {};
            code.properties[DIAGRAM_TAG_PROPERTY] = tag;
            code.properties[DIAGRAM_ORDINAL_PROPERTY] = ordinal;
            code.properties[DIAGRAM_LIMIT_PROPERTY] = ordinal > options.limit;
          }
        }
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

export function hastText(node: DiagramHastNode): string {
  if (node.type === "text") return node.value ?? "";
  return node.children?.map(hastText).join("") ?? "";
}

export function diagramFenceFromPre(node: DiagramHastNode | undefined): {
  tag: string;
  ordinal: number;
  overLimit: boolean;
  source: string;
} | null {
  const code = node?.tagName === "pre" && node.children?.length === 1 ? node.children[0] : null;
  const tag = code?.properties?.[DIAGRAM_TAG_PROPERTY];
  const ordinal = code?.properties?.[DIAGRAM_ORDINAL_PROPERTY];
  const overLimit = code?.properties?.[DIAGRAM_LIMIT_PROPERTY];
  if (!code || typeof tag !== "string" || typeof ordinal !== "number" || typeof overLimit !== "boolean") {
    return null;
  }
  return { tag, ordinal, overLimit, source: hastText(code) };
}
