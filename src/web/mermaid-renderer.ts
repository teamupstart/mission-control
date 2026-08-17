/*
 * This file is typechecked as normal TypeScript, then transpiled and appended to Mermaid's
 * published classic bundle by `vite.config.ts`. It deliberately has no imports: a sandboxed
 * opaque origin cannot pass module-script CORS, which is why the normal Vite entry timed out.
 */

declare const mermaid: {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, source: string, root: HTMLElement) => Promise<{ svg: string }>;
};

interface RendererPalette {
  background: string;
  surface: string;
  foreground: string;
  muted: string;
  line: string;
  primary: string;
  success: string;
  warning: string;
  danger: string;
  secondary: string;
}

interface RendererRequest {
  type: "mission:mermaid-render";
  token: string;
  source: string;
  ordinal: number;
  palette: RendererPalette;
}

const READY_MESSAGE = "mission:mermaid-ready";
const RENDERED_MESSAGE = "mission:mermaid-rendered";
const ERROR_MESSAGE = "mission:mermaid-error";
const MAX_SOURCE_LENGTH = 50_000;
const MAX_DIAGRAMS = 32;
const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const ACTIVE_SOURCE_PATTERNS = [
  /(?:^|\n)\s*(?:click|href|link)\b/i,
  /@\{[^}]*\b(?:href|img|link|src|url)\s*:/i,
  /!\s*\[[^\]]*\]\s*\(/,
  /<\s*(?:a|embed|iframe|image|img|object)\b/i,
  /(?:@import\b|\burl\s*\()/i,
  /(?:https?|ftp|file|data|blob|javascript|mailto):/i,
  /(?:^|[\s"'(])\/\/[^\s]/m,
] as const;
const PALETTE_KEYS: (keyof RendererPalette)[] = [
  "background",
  "surface",
  "foreground",
  "muted",
  "line",
  "primary",
  "success",
  "warning",
  "danger",
  "secondary",
];

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function rendererToken(hash: string): string | null {
  try {
    const value = decodeURIComponent(hash.replace(/^#/, ""));
    return TOKEN_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
}

function rendererPalette(value: unknown): RendererPalette | null {
  const input = record(value);
  if (!input) return null;
  const palette = {} as RendererPalette;
  for (const key of PALETTE_KEYS) {
    const color = input[key];
    if (typeof color !== "string" || !COLOR_PATTERN.test(color.trim())) return null;
    palette[key] = color.trim().toLowerCase();
  }
  return palette;
}

function rendererRequest(value: unknown, token: string): RendererRequest | null {
  const input = record(value);
  if (
    !input ||
    input.type !== "mission:mermaid-render" ||
    input.token !== token ||
    typeof input.source !== "string" ||
    input.source.length > MAX_SOURCE_LENGTH ||
    ACTIVE_SOURCE_PATTERNS.some((pattern) => pattern.test(input.source as string)) ||
    typeof input.ordinal !== "number" ||
    !Number.isInteger(input.ordinal) ||
    input.ordinal < 1 ||
    input.ordinal > MAX_DIAGRAMS
  ) return null;
  const palette = rendererPalette(input.palette);
  if (!palette) return null;
  return {
    type: "mission:mermaid-render",
    token,
    source: input.source,
    ordinal: input.ordinal,
    palette,
  };
}

function parentOrigin(): string | null {
  try {
    return document.referrer ? new URL(document.referrer).origin : null;
  } catch {
    return null;
  }
}

function post(message: object, targetOrigin: string): void {
  window.parent.postMessage(message, targetOrigin);
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\s+/g, " ").trim().slice(0, 300) || "The diagram could not be rendered.";
}

function themeVariables(palette: RendererPalette): Record<string, string> {
  return {
    background: palette.background,
    primaryColor: palette.surface,
    primaryTextColor: palette.foreground,
    primaryBorderColor: palette.primary,
    secondaryColor: palette.secondary,
    secondaryTextColor: palette.foreground,
    secondaryBorderColor: palette.secondary,
    tertiaryColor: palette.background,
    tertiaryTextColor: palette.foreground,
    tertiaryBorderColor: palette.line,
    lineColor: palette.muted,
    textColor: palette.foreground,
    mainBkg: palette.surface,
    nodeBorder: palette.primary,
    clusterBkg: palette.background,
    clusterBorder: palette.line,
    titleColor: palette.foreground,
    edgeLabelBackground: palette.background,
    noteBkgColor: palette.surface,
    noteTextColor: palette.foreground,
    noteBorderColor: palette.warning,
    actorBkg: palette.surface,
    actorBorder: palette.primary,
    actorTextColor: palette.foreground,
    actorLineColor: palette.line,
    signalColor: palette.foreground,
    signalTextColor: palette.foreground,
    labelBoxBkgColor: palette.surface,
    labelBoxBorderColor: palette.line,
    labelTextColor: palette.foreground,
    loopTextColor: palette.muted,
    activationBkgColor: palette.surface,
    activationBorderColor: palette.primary,
    pie1: palette.primary,
    pie2: palette.success,
    pie3: palette.warning,
    pie4: palette.secondary,
    pie5: palette.danger,
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
  };
}

/** Remove destinations and active content before generated SVG enters even this sandbox. */
function inertSvg(svg: string, label: string): SVGSVGElement {
  const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (parsed.querySelector("parsererror") || parsed.documentElement.localName !== "svg") {
    throw new Error("Mermaid returned invalid SVG");
  }
  parsed.querySelectorAll("script, iframe, object, embed, image").forEach((element) => element.remove());
  parsed.querySelectorAll("a").forEach((anchor) => anchor.replaceWith(...anchor.childNodes));
  parsed.querySelectorAll("*").forEach((element) => {
    for (let index = element.attributes.length - 1; index >= 0; index -= 1) {
      const attribute = element.attributes.item(index);
      if (!attribute) continue;
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on") || name === "target" || name === "src" || name === "action" || name === "formaction") {
        element.removeAttribute(attribute.name);
        continue;
      }
      if ((name === "href" || name === "xlink:href") && !attribute.value.startsWith("#")) {
        element.removeAttribute(attribute.name);
      }
    }
  });
  const output = parsed.documentElement as unknown as SVGSVGElement;
  output.setAttribute("role", "img");
  output.setAttribute("aria-label", label);
  output.removeAttribute("tabindex");
  return output;
}

function afterLayout(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

const token = rendererToken(window.location.hash);
const root = document.getElementById("diagram");
const expectedParentOrigin = parentOrigin();
if (token && root && expectedParentOrigin) {
  let consumed = false;
  window.addEventListener("message", (event) => {
    if (
      consumed ||
      event.source !== window.parent ||
      event.origin !== expectedParentOrigin
    ) return;
    const request = rendererRequest(event.data, token);
    if (!request) return;
    consumed = true;
    void (async () => {
      try {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "base",
          look: "classic",
          htmlLabels: false,
          maxTextSize: MAX_SOURCE_LENGTH,
          maxEdges: 500,
          suppressErrorRendering: true,
          deterministicIds: true,
          deterministicIDSeed: token,
          fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif",
          themeVariables: themeVariables(request.palette),
          flowchart: { htmlLabels: false, useMaxWidth: true },
          secure: [
            "secure",
            "securityLevel",
            "startOnLoad",
            "theme",
            "themeCSS",
            "themeVariables",
            "look",
            "fontFamily",
            "altFontFamily",
            "htmlLabels",
            "flowchart",
            "maxTextSize",
            "maxEdges",
            "suppressErrorRendering",
            "deterministicIds",
            "deterministicIDSeed",
          ],
        });
        const result = await mermaid.render(`mission-mermaid-${token}`, request.source, root);
        const label = `Mermaid diagram ${request.ordinal}`;
        root.replaceChildren(document.importNode(inertSvg(result.svg, label), true));
        await afterLayout();
        post({
          type: RENDERED_MESSAGE,
          token,
          height: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
        }, expectedParentOrigin);
      } catch (error) {
        root.replaceChildren();
        post({ type: ERROR_MESSAGE, token, message: errorMessage(error) }, expectedParentOrigin);
      }
    })();
  });
  post({ type: READY_MESSAGE, token }, expectedParentOrigin);
}
