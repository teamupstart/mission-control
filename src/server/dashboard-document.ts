import { skinById, type SkinId } from "@shared/skins.ts";

/**
 * The dashboard's HTML document, served with the stored skin already on it.
 *
 * The dashboard's first paint used to come from the browser's local preference cache, which a
 * new browser profile - a first desktop launch, a new tab origin - does not have. That profile
 * painted Default until the daemon's answer arrived and only then repainted in the stored skin,
 * which under Daylight is a dark dashboard frame. The stylesheet is render-blocking and the
 * module script is not, so the only way to have the right skin in the FIRST frame is to put it
 * on `<html>` in the document itself.
 *
 * Two things are written, both derived from the registry:
 *  - `data-skin` and `color-scheme` on `<html>`, exactly as `src/web/lib/skin.ts` sets them,
 *    so the very first frame paints in the stored skin;
 *  - `<meta name="mission-skin">`, which the preference store (`src/web/lib/uiConfig.ts`) takes
 *    as its first-paint seed over a cache that is missing or stale, so `lib/skin.ts` keeps the
 *    attribute rather than replacing it with the cache's guess.
 * Default is the absence of the attribute, as everywhere else.
 */
export function renderDashboardDocument(html: string, skinId: SkinId): string {
  const skin = skinById(skinId);
  const attributes = `${skin.id === "default" ? "" : ` data-skin="${skin.id}"`} style="color-scheme: ${skin.colorScheme}"`;
  return html
    .replace(/<html(\s[^>]*)?>/i, (_, existing: string | undefined) => `<html${existing ?? ""}${attributes}>`)
    .replace(/<head(\s[^>]*)?>/i, (open: string) => `${open}\n    <meta name="mission-skin" content="${skin.id}" />`);
}
