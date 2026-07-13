// Pure, dependency-free helpers for turning a raw model identifier into a
// friendly display name and inferring its context-window size. Lives in `shared`
// because both the daemon (filling SessionMeta) and the web UI (the card's model
// pill) need identical results - the single source of truth for how a model id
// like "claude-opus-4-8[1m]" becomes "Opus 4.8" + a 1M window.

/** The context-window budget for a model with no size hint (standard Claude). */
export const DEFAULT_CONTEXT_WINDOW = 200_000;
/** At or above this, a model is a "long context" (1M) variant. */
export const LONG_CONTEXT_THRESHOLD = 1_000_000;

/**
 * Some model ids carry a delimited long-context marker (`[1m]`, `(1M)`) or a
 * trailing dated build (`-20251001`). Strip both so the name maps cleanly and the
 * window size is inferred separately.
 */
function coreModelId(id: string): string {
  return id
    .replace(/[[(]\s*\d+\s*[mk]\s*[\])]/i, "") // [1m], (200k)
    .replace(/-\d{6,}$/, "") // trailing YYYYMMDD build suffix
    .trim();
}

/** Title-case a lowercase family token: "opus" -> "Opus". */
function cap(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/**
 * Friendly model name for a raw id, or null when there's nothing to show.
 * Recognizes the Claude and GPT/o-series families; unknown ids fall back to a
 * lightly prettified form rather than being dropped, so a new model still reads
 * sensibly on the card.
 */
export function modelLabel(id: string | null | undefined): string | null {
  if (!id) return null;
  const core = coreModelId(id);
  if (!core) return null;

  // claude-opus-4-8 -> "Opus 4.8"; claude-sonnet-5 -> "Sonnet 5".
  const claude = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/i.exec(core);
  if (claude) {
    const [, family, major, minor] = claude;
    const version = minor ? `${major}.${minor}` : major;
    return `${cap(family!.toLowerCase())} ${version}`;
  }

  // gpt-5-codex -> "GPT-5 Codex"; gpt-4o -> "GPT-4o"; gpt-5 -> "GPT-5".
  const gpt = /^gpt-([\w.]+)(?:-(\w+))?$/i.exec(core);
  if (gpt) {
    const [, ver, variant] = gpt;
    const base = `GPT-${ver}`;
    return variant ? `${base} ${cap(variant.toLowerCase())}` : base;
  }

  // o3 / o4-mini and other OpenAI reasoning ids read fine as-is.
  if (/^o\d/i.test(core)) return core;

  // Unknown: turn "some-new-model" into "Some New Model".
  return core
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => (/\d/.test(w) ? w : cap(w)))
    .join(" ");
}

/**
 * Infer a model's context-window size from its id. Prefer an explicit size that
 * a caller already has (e.g. Claude's statusLine payload or Codex's rollout);
 * this is the fallback for the transcript path, where only the raw id is known.
 * Recognizes a delimited `[1m]` / `(200k)` marker; otherwise assumes the
 * standard window. `longContext` is derived from the resolved size.
 */
export function parseContextWindowSize(id: string | null | undefined): {
  size: number;
  longContext: boolean;
} {
  const size = windowFromId(id) ?? DEFAULT_CONTEXT_WINDOW;
  return { size, longContext: size >= LONG_CONTEXT_THRESHOLD };
}

/** The size a delimited marker in the id encodes (1m -> 1e6, 200k -> 2e5), else null. */
function windowFromId(id: string | null | undefined): number | null {
  if (!id) return null;
  const m = /[[(]\s*(\d+)\s*([mk])\s*[\])]/i.exec(id);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  return m[2]!.toLowerCase() === "m" ? n * 1_000_000 : n * 1_000;
}

/** True when a resolved window size counts as a long-context (1M) model. */
export function isLongContext(size: number | null | undefined): boolean {
  return typeof size === "number" && size >= LONG_CONTEXT_THRESHOLD;
}
