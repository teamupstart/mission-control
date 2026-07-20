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
 * The standard context-window tiers a Claude model runs in, ascending. A session
 * is on exactly one of these; used to recover the real window when the id doesn't
 * carry a size marker (see `effectiveContextWindow`).
 */
export const CONTEXT_WINDOW_TIERS = [DEFAULT_CONTEXT_WINDOW, LONG_CONTEXT_THRESHOLD];

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

// ---- the pickable model catalog (dispatch-time model selection) ----

/**
 * A model the operator can pick for a dispatched agent. `id` is passed verbatim to
 * the agent binary's `--model` flag; `label` is what the picker shows.
 */
export interface ModelChoice {
  id: string;
  label: string;
  /** One short line on when to reach for it, shown beside the label in the picker. */
  hint: string;
}

/**
 * The models each harness offers, best-first.
 *
 * Hand-maintained on purpose: neither CLI exposes a machine-readable list of the
 * models the signed-in account may use, so shelling out to discover them would buy
 * a slow, failure-prone startup dependency and still guess. The cost of drift is
 * small and bounded - a new model is one line here, and until it is added the
 * operator can still reach it, because `--model` is only ever passed through and a
 * value stored by another version is preserved in the picker (see `modelChoicesFor`).
 *
 * Order matters: the picker renders it as written, so the most capable model per
 * harness leads. Ids only - no `[1m]` markers - because these are pasted onto a
 * command line (`ModelIdSchema` in protocol.ts enforces that shape).
 */
export const MODEL_CATALOG: Record<"claude" | "codex", readonly ModelChoice[]> = {
  claude: [
    { id: "claude-fable-5", label: "Fable 5", hint: "most capable, hardest work" },
    { id: "claude-opus-4-8", label: "Opus 4.8", hint: "strong all-rounder" },
    { id: "claude-sonnet-5", label: "Sonnet 5", hint: "near-Opus, cheaper" },
    { id: "claude-haiku-4-5", label: "Haiku 4.5", hint: "fastest, simple tasks" },
  ],
  codex: [
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", hint: "most capable" },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", hint: "balanced" },
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", hint: "fastest" },
    { id: "gpt-5.5", label: "GPT-5.5", hint: "previous generation" },
  ],
};

/**
 * The catalog for one harness, with `extra` folded in when it isn't already there.
 *
 * The `extra` argument is what keeps a hand-maintained catalog from silently eating
 * a stored value: a default set on a newer build (or typed straight into the config
 * route) would otherwise be absent from the `<select>`, which renders as "no model
 * chosen" and would overwrite the real setting on the next unrelated edit. Passing
 * the stored id here keeps it selectable and honest about being off-catalog.
 */
export function modelChoicesFor(
  agent: "claude" | "codex",
  extra?: string | null,
): readonly ModelChoice[] {
  const known = MODEL_CATALOG[agent];
  if (!extra || known.some((c) => c.id === extra)) return known;
  return [...known, { id: extra, label: modelLabel(extra) ?? extra, hint: "not in this build" }];
}

/**
 * Infer a model's context-window size from its id. Prefer an explicit size that
 * a caller already has (e.g. Claude's statusLine payload or Codex's rollout);
 * this is the fallback for the transcript path, where only the raw id is known.
 * Recognizes a delimited `[1m]` / `(200k)` marker; otherwise falls back to the
 * model family's default window. `longContext` is derived from the resolved size.
 */
export function parseContextWindowSize(id: string | null | undefined): {
  size: number;
  longContext: boolean;
} {
  const size = windowFromId(id) ?? defaultWindowForModel(id);
  return { size, longContext: size >= LONG_CONTEXT_THRESHOLD };
}

/**
 * The context window a model runs at when its id carries no explicit size marker.
 * Claude Code enables the 1M (`[1m]`) window by default for its long-context
 * models - Opus 4.x and Sonnet 4.x/5 - but the transcript records the bare id with
 * the marker stripped, so those families would otherwise read as the 200k default
 * and their context% would be ~5x too high. Map them to 1M here; everything else
 * (Haiku, Claude 3.x, unknown ids) keeps the standard 200k window.
 */
export function defaultWindowForModel(id: string | null | undefined): number {
  if (!id) return DEFAULT_CONTEXT_WINDOW;
  const m = /^claude-(opus|sonnet)-(\d+)/i.exec(coreModelId(id).toLowerCase());
  if (m && Number(m[2]) >= 4) return LONG_CONTEXT_THRESHOLD;
  return DEFAULT_CONTEXT_WINDOW;
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

/**
 * The real context window for a session, reconciling an id-inferred size with the
 * tokens actually observed in context. Claude's transcript records the bare model
 * id (`claude-opus-4-8`) with the `[1m]` long-context marker stripped, so a 1M
 * session would otherwise read as the 200k default and its context% would be
 * ~5x too high (and clamped to 100% once usage passes 200k). But you can't fit
 * more tokens than the window holds: an observed count above a tier is proof the
 * real window is at least the next tier up. Returns the smallest standard tier
 * that both covers `observedTokens` and is at least `idSize` - never an
 * underestimate. Falls back to the raw count if usage somehow exceeds every tier.
 */
export function effectiveContextWindow(
  idSize: number,
  observedTokens: number | null | undefined,
): number {
  if (typeof observedTokens !== "number" || observedTokens <= idSize) return idSize;
  return CONTEXT_WINDOW_TIERS.find((t) => t >= observedTokens) ?? observedTokens;
}
