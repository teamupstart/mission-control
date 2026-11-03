import { skinById, type SkinId } from "@shared/skins.ts";
import { subscribeUiConfig, uiConfig } from "./uiConfig.ts";

/**
 * Puts the chosen skin in force, and is the ONLY writer of `<html data-skin>`, the document's
 * `color-scheme`, and the desktop window's background.
 *
 * Imported for its side effect from `main.tsx` before React renders. At that moment the
 * `uiConfig` store already holds the cached config (seeded synchronously from `localStorage`),
 * so the first frame paints in the chosen skin rather than a frame of Default that then snaps.
 * After that it follows the store: every commit - the optimistic one when a tile is picked,
 * the daemon's copy when hydration lands, and the rollback when the daemon refuses a write -
 * re-applies when `skin` changed. Nothing in React has to know a skin exists.
 */

let applied: SkinId | null = null;

/** `#rrggbb` for a computed colour, or null if it is not one this can read. */
export function toHexColor(value: string): string | null {
  const text = value.trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  if (/^#[0-9a-f]{6}$/.test(text)) return text;
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(text);
  if (!rgb) return null;
  const channels = [rgb[1], rgb[2], rgb[3]].map((part) => Number(part));
  if (channels.some((channel) => channel > 255)) return null;
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Apply a skin to the document. Default is `:root` itself, so it is the ABSENCE of the
 * attribute rather than `data-skin="default"`: a skin file can never be written against it.
 */
export function applySkin(id: SkinId, root: HTMLElement = document.documentElement): void {
  const skin = skinById(id);
  applied = skin.id;
  if (skin.id === "default") delete root.dataset.skin;
  else root.dataset.skin = skin.id;
  // Inline, so it outranks the `:root` declaration whatever a skin file says, and native
  // scrollbars, form controls and the `select` popup follow the skin.
  root.style.colorScheme = skin.colorScheme;
  // The desktop shell paints its window before the page loads. Telling it this skin's
  // background is what lets the NEXT launch open without a dark frame under a light skin.
  // Optional twice over: a browser tab has no bridge, and an older preload has no method.
  const bridge = typeof window === "undefined" ? undefined : window.missionDesktop;
  if (bridge?.setWindowBackground) {
    const background = toHexColor(getComputedStyle(root).getPropertyValue("--bg"));
    if (background) void bridge.setWindowBackground(background).catch(() => {});
  }
}

/** Re-apply only when the stored skin actually changed; every other preference is noise. */
function follow(): void {
  const next = uiConfig().skin;
  if (next !== applied) applySkin(next);
}

// Only where there is a document to paint; a test importing `toHexColor` has none.
if (typeof document !== "undefined") {
  follow();
  subscribeUiConfig(follow);
}
