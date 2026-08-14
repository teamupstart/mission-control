import { workspaceAssetPath } from "./workspaceLinks.ts";

/**
 * The dashboard's ONE sandboxed HTML preview boundary.
 *
 * Two surfaces render untrusted HTML: the Files tab, showing a page out of a live checkout,
 * and Scouts, showing `report/report.html` out of an immutable archive. They share this
 * module rather than each carrying a copy, because the thing being shared is a security
 * policy - and a security policy that exists twice is a security policy that stops agreeing
 * with itself the first time only one copy is edited.
 *
 * The contract both surfaces get:
 *
 * - `default-src 'none'` with `connect-src 'none'`, so a previewed document reaches nothing.
 * - `script-src` naming exactly two SHA-256 hashes, so the ONLY JavaScript that can run is
 *   the two bridge scripts below. `allow-scripts` on the iframe is what lets those run; the
 *   document's own `<script>` is blocked by the hash allowlist, not by the sandbox.
 * - No `allow-same-origin`, ever. The pair `allow-scripts allow-same-origin` would let a
 *   previewed page reach into the dashboard origin and undo the whole boundary.
 * - Every non-fragment navigation is claimed by the parent (see `PREVIEW_LINK_SCRIPT`).
 *
 * A caller may not weaken any of this for its own documents. Scouts in particular must not
 * relax it to make an archived report render: an archive is untrusted input that may have
 * been copied in from another machine.
 */

const PREVIEW_SCROLL_MESSAGE = "mission:file-preview-scroll";
const PREVIEW_SCROLL_SCRIPT = `addEventListener("message",event=>{if(event.source===parent&&event.data?.type==="${PREVIEW_SCROLL_MESSAGE}"&&typeof event.data.top==="number")scrollBy({top:event.data.top})})`;
const PREVIEW_SCROLL_SCRIPT_HASH = "boIuepZJzJEM7sUoJjNJy7i6nq6MHE3t38Bfnj4GnvM=";
/**
 * Every anchor click leaves the document through the parent, or not at all.
 *
 * A srcdoc document resolves relative hrefs against the DASHBOARD's URL, so letting one
 * navigate turns `<a href="b.html">` into a request the daemon answers with the SPA
 * fallback - a second dashboard shell inside the sandbox, whose assets the opaque origin
 * then CORS-blocks into a white pane. The `navigate-to` CSP directive that was meant to
 * stop this never shipped in any browser. So navigation is claimed here instead: every
 * non-fragment click is cancelled and its href posted up, and the parent decides whether
 * it names a checkout file worth selecting. Fragment links stay native - same-document
 * scrolling is the one navigation the sandbox does correctly.
 *
 * `composedPath` rather than `target.closest`, because a click inside an open shadow root
 * retargets to the host and a missed anchor here is not a dead link - it is the default
 * navigation going through, which is the white pane again.
 *
 * What the parent DOES with the href differs per surface and is not this module's business:
 * Files resolves it against the checkout, and Scouts resolves it only to a verified report
 * companion artifact, leaving every unclaimed link inert.
 */
const PREVIEW_LINK_MESSAGE = "mission:file-preview-link";
const PREVIEW_LINK_SCRIPT = `document.addEventListener("click",event=>{const origin=event.composedPath()[0];const anchor=origin instanceof Element?origin.closest("a[href]"):null;if(!anchor)return;const href=anchor.getAttribute("href");if(!href||href.startsWith("#"))return;event.preventDefault();parent.postMessage({type:"${PREVIEW_LINK_MESSAGE}",href},"*")},true)`;
const PREVIEW_LINK_SCRIPT_HASH = "ADNimZ0/NOY6W/JTdVdn5R5DYWseUUp14To0zvMfzF4=";
const PREVIEW_CSP =
  `default-src 'none'; connect-src 'none'; script-src 'sha256-${PREVIEW_SCROLL_SCRIPT_HASH}' 'sha256-${PREVIEW_LINK_SCRIPT_HASH}'; style-src 'unsafe-inline'; img-src data: blob:; ` +
  "font-src data:; form-action 'none'; navigate-to 'none'";

/** The message a preview posts up when a non-fragment link is clicked inside it. */
export const HTML_PREVIEW_LINK_MESSAGE = PREVIEW_LINK_MESSAGE;
/** The message the parent posts down to scroll a preview it cannot reach into. */
export const HTML_PREVIEW_SCROLL_MESSAGE = PREVIEW_SCROLL_MESSAGE;

/**
 * The sandbox attribute every preview iframe must carry.
 *
 * Exported as a constant so no call site can quietly add a token. `allow-scripts` alone is
 * what runs the two hashed bridges; adding `allow-same-origin` beside it would hand the
 * previewed document the dashboard's origin.
 */
export const HTML_PREVIEW_SANDBOX = "allow-scripts";

export function htmlPreviewSource(source: string): string {
  const headContent = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"><script>${PREVIEW_SCROLL_SCRIPT}</script><script>${PREVIEW_LINK_SCRIPT}</script>`;
  // This prefix must be parsed before a single checkout-controlled byte. Searching
  // for <head> is unsafe: a match inside an HTML comment can absorb the CSP and bridge,
  // after which `allow-scripts` would run the document's own JavaScript unrestricted.
  // The HTML parser supplies the implicit html/head elements here; a later doctype or
  // explicit head in a complete source document is harmless and cannot precede this CSP.
  return `<!doctype html>${headContent}${source}`;
}

interface StylesheetLink {
  index: number;
  length: number;
  path: string;
}

const MAX_PREVIEW_STYLESHEETS = 32;
const PREVIEW_STYLESHEET_CONCURRENCY = 4;

function htmlAttribute(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(
    // The backtick is written as \u0060 rather than literally: this is a template
    // literal, and a bare backtick would end it early.
    `\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\u0060]+))`,
    "i",
  ));
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : null;
}

function escapeHtmlAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

/** Find checkout-local stylesheet links without treating remote CSS as readable workspace data. */
function localStylesheets(source: string, documentPath: string): StylesheetLink[] {
  const found: StylesheetLink[] = [];
  for (const match of source.matchAll(/<link\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)) {
    if (match.index == null) continue;
    const tag = match[0];
    const rel = htmlAttribute(tag, "rel") ?? "";
    if (!rel.split(/\s+/).some((part) => part.toLowerCase() === "stylesheet")) continue;
    const href = htmlAttribute(tag, "href");
    const path = href ? workspaceAssetPath(href, documentPath) : null;
    if (path) found.push({ index: match.index, length: tag.length, path });
  }
  return found;
}

/**
 * Inline local CSS before an HTML document enters its opaque sandbox.
 *
 * A srcDoc document otherwise resolves `theme.css` against the dashboard URL, which is
 * neither the checkout nor a file-serving endpoint. Keeping style-src inline-only is the
 * useful security boundary, so local CSS is read through the same contained session-file
 * API as the document and embedded rather than granting the iframe network access.
 *
 * The FILES tab needs this; Scouts does not, because a scout report is required at capture
 * time to be self-contained with inline CSS and is refused if it is not. It stays here
 * beside the boundary it exists to preserve rather than moving back into the Files
 * component, so the whole "how does untrusted HTML get rendered" story is one file.
 */
export async function inlinePreviewStyles(
  source: string,
  documentPath: string,
  read: (path: string) => Promise<string | null>,
  signal?: AbortSignal,
): Promise<string> {
  const links = localStylesheets(source, documentPath);
  if (links.length === 0) return source;
  const paths = [...new Set(links.map((link) => link.path))].slice(0, MAX_PREVIEW_STYLESHEETS);
  const css = new Map<string, string | null>();
  let cursor = 0;
  await Promise.all(Array.from(
    { length: Math.min(PREVIEW_STYLESHEET_CONCURRENCY, paths.length) },
    async () => {
      while (!signal?.aborted) {
        const path = paths[cursor++];
        if (!path) return;
        css.set(path, await read(path));
      }
    },
  ));
  if (signal?.aborted) return source;
  let output = "";
  cursor = 0;
  for (let i = 0; i < links.length; i++) {
    const link = links[i]!;
    output += source.slice(cursor, link.index);
    const text = css.get(link.path);
    if (text != null) {
      const safe = text.replace(/<\/style/gi, "<\\/style");
      output += `<style data-mission-source="${escapeHtmlAttribute(link.path)}">\n${safe}\n</style>`;
    }
    cursor = link.index + link.length;
  }
  return output + source.slice(cursor);
}
