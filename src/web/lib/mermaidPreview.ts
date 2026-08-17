export const MERMAID_RENDERER_PATH = "/mermaid-renderer.html";
export const MERMAID_PREVIEW_SANDBOX = "allow-scripts";

export const MERMAID_MAX_SOURCE_LENGTH = 50_000;
export const MERMAID_MAX_DIAGRAMS = 32;
export const MERMAID_MIN_FRAME_HEIGHT = 148;
export const MERMAID_MAX_FRAME_HEIGHT = 1_200;
export const MERMAID_RENDER_TIMEOUT_MS = 15_000;

export const MERMAID_READY_MESSAGE = "mission:mermaid-ready";
export const MERMAID_RENDER_MESSAGE = "mission:mermaid-render";
export const MERMAID_RENDERED_MESSAGE = "mission:mermaid-rendered";
export const MERMAID_ERROR_MESSAGE = "mission:mermaid-error";

const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const ERROR_MESSAGE_LIMIT = 300;
const ACTIVE_SOURCE_PATTERNS = [
  /(?:^|\n)\s*(?:click|href|link)\b/i,
  /@\{[^}]*\b(?:href|img|link|src|url)\s*:/i,
  /!\s*\[[^\]]*\]\s*\(/,
  /<\s*(?:a|embed|iframe|image|img|object)\b/i,
  /(?:@import\b|\burl\s*\()/i,
  /(?:https?|ftp|file|data|blob|javascript|mailto):/i,
  /(?:^|[\s"'(])\/\/[^\s]/m,
] as const;

export interface MermaidPalette {
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

const PALETTE_TOKENS: Readonly<Record<keyof MermaidPalette, string>> = Object.freeze({
  background: "--bg",
  surface: "--panel-2",
  foreground: "--fg",
  muted: "--muted",
  line: "--border",
  primary: "--working",
  success: "--idle",
  warning: "--attention",
  danger: "--danger",
  secondary: "--purple",
});

interface MermaidRenderRequest {
  type: typeof MERMAID_RENDER_MESSAGE;
  token: string;
  source: string;
  ordinal: number;
  palette: MermaidPalette;
}

export type MermaidRendererMessage =
  | { type: typeof MERMAID_READY_MESSAGE; token: string }
  | { type: typeof MERMAID_RENDERED_MESSAGE; token: string; height: number }
  | { type: typeof MERMAID_ERROR_MESSAGE; token: string; message: string };

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function isMermaidInstanceToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

export function createMermaidInstanceToken(): string {
  return crypto.randomUUID();
}

export function mermaidRendererUrl(token: string): string {
  if (!isMermaidInstanceToken(token)) throw new Error("invalid Mermaid renderer token");
  return `${MERMAID_RENDERER_PATH}#${encodeURIComponent(token)}`;
}

export function mermaidTokenFromHash(hash: string): string | null {
  try {
    const token = decodeURIComponent(hash.replace(/^#/, ""));
    return isMermaidInstanceToken(token) ? token : null;
  } catch {
    return null;
  }
}

export function normalizeMermaidPalette(value: unknown): MermaidPalette | null {
  const input = record(value);
  if (!input) return null;
  const palette = {} as MermaidPalette;
  for (const key of Object.keys(PALETTE_TOKENS) as (keyof MermaidPalette)[]) {
    const color = input[key];
    if (typeof color !== "string" || !COLOR_PATTERN.test(color.trim())) return null;
    palette[key] = color.trim().toLowerCase();
  }
  return palette;
}

/** Read only the fixed Mission Control tokens the opaque renderer is allowed to receive. */
export function readMermaidPalette(
  style: Pick<CSSStyleDeclaration, "getPropertyValue"> = getComputedStyle(document.documentElement),
): MermaidPalette | null {
  const values = {} as MermaidPalette;
  for (const [key, token] of Object.entries(PALETTE_TOKENS) as [keyof MermaidPalette, string][]) {
    values[key] = style.getPropertyValue(token).trim();
  }
  return normalizeMermaidPalette(values);
}

export function createMermaidRenderRequest(
  token: string,
  source: string,
  ordinal: number,
  palette: MermaidPalette,
): MermaidRenderRequest | null {
  if (
    !isMermaidInstanceToken(token) ||
    source.length > MERMAID_MAX_SOURCE_LENGTH ||
    !isPassiveMermaidSource(source) ||
    !Number.isInteger(ordinal) ||
    ordinal < 1 ||
    ordinal > MERMAID_MAX_DIAGRAMS
  ) return null;
  const normalized = normalizeMermaidPalette(palette);
  if (!normalized) return null;
  return { type: MERMAID_RENDER_MESSAGE, token, source, ordinal, palette: normalized };
}

/** Reject source constructs that can create a loader or active destination before Mermaid sees them. */
export function isPassiveMermaidSource(source: string): boolean {
  return !ACTIVE_SOURCE_PATTERNS.some((pattern) => pattern.test(source));
}

export function parseMermaidRenderRequest(value: unknown, expectedToken: string): MermaidRenderRequest | null {
  const input = record(value);
  if (
    !input ||
    input.type !== MERMAID_RENDER_MESSAGE ||
    input.token !== expectedToken ||
    !isMermaidInstanceToken(input.token) ||
    typeof input.source !== "string" ||
    input.source.length > MERMAID_MAX_SOURCE_LENGTH ||
    !isPassiveMermaidSource(input.source) ||
    typeof input.ordinal !== "number" ||
    !Number.isInteger(input.ordinal) ||
    input.ordinal < 1 ||
    input.ordinal > MERMAID_MAX_DIAGRAMS
  ) return null;
  const palette = normalizeMermaidPalette(input.palette);
  if (!palette) return null;
  return {
    type: MERMAID_RENDER_MESSAGE,
    token: input.token,
    source: input.source,
    ordinal: input.ordinal,
    palette,
  };
}

export function clampMermaidFrameHeight(height: number): number {
  if (!Number.isFinite(height)) return MERMAID_MIN_FRAME_HEIGHT;
  return Math.min(MERMAID_MAX_FRAME_HEIGHT, Math.max(MERMAID_MIN_FRAME_HEIGHT, Math.ceil(height)));
}

function boundedErrorMessage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const message = value.replace(/\s+/g, " ").trim();
  if (!message) return null;
  return message.slice(0, ERROR_MESSAGE_LIMIT);
}

export function parseMermaidRendererMessage(
  value: unknown,
  expectedToken: string,
): MermaidRendererMessage | null {
  const input = record(value);
  if (!input || input.token !== expectedToken || !isMermaidInstanceToken(input.token)) return null;
  if (input.type === MERMAID_READY_MESSAGE) {
    return { type: MERMAID_READY_MESSAGE, token: input.token };
  }
  if (input.type === MERMAID_RENDERED_MESSAGE && typeof input.height === "number") {
    return {
      type: MERMAID_RENDERED_MESSAGE,
      token: input.token,
      height: clampMermaidFrameHeight(input.height),
    };
  }
  if (input.type === MERMAID_ERROR_MESSAGE) {
    const message = boundedErrorMessage(input.message);
    return message ? { type: MERMAID_ERROR_MESSAGE, token: input.token, message } : null;
  }
  return null;
}

/** Sandboxed child messages must come from this iframe and carry the opaque `null` origin. */
export function acceptMermaidRendererMessage(
  event: { source: unknown; origin: string; data: unknown },
  expectedSource: unknown,
  expectedToken: string,
): MermaidRendererMessage | null {
  if (event.source !== expectedSource || event.origin !== "null") return null;
  return parseMermaidRendererMessage(event.data, expectedToken);
}

export function mermaidErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return boundedErrorMessage(raw) ?? "The diagram could not be rendered.";
}
