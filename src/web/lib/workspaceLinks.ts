export interface WorkspaceFileTarget {
  /** Checkout-relative path accepted by the session file API. */
  path: string;
  /** Optional source location carried by Codex-style file links. */
  line: number | null;
  column: number | null;
}

const BLOCKED_LINK_SCHEMES = new Set(["data", "file", "javascript", "vbscript"]);

function linkScheme(value: string): string | null {
  const colon = value.indexOf(":");
  if (colon < 0) return null;
  const candidate = value.slice(0, colon).replace(/[\u0000-\u0020]/g, "");
  return /^[a-z][a-z\d+.-]*$/i.test(candidate) ? candidate.toLowerCase() : null;
}

function isRootSourceLocation(value: string): boolean {
  const match = value.match(/^([^/:?#]+):\d+(?::\d+)?$/);
  if (!match) return false;
  const fileName = match[1]!;
  // A dot is strong file-name evidence regardless of case (`package.json:12`).
  // For extensionless roots, retain the conventional-capitalization escape hatch
  // (`Makefile:9`) so arbitrary numeric URI schemes still stay external.
  return fileName.includes(".") || /^[A-Z]/.test(fileName);
}

export function markdownLinkUrl(value: string): string {
  const scheme = linkScheme(value);
  return scheme && BLOCKED_LINK_SCHEMES.has(scheme) ? "" : value;
}

/** Decode an href component without letting one malformed escape break the transcript. */
function decodePath(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * Collapse a POSIX path without importing node:path into the browser bundle.
 * Returning null for an upward escape is the client-side first guard; the daemon's
 * realpath containment check remains the authority when the file is read.
 */
function normalizeRelative(value: string): string | null {
  const parts: string[] = [];
  for (const part of value.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.length > 0 ? parts.join("/") : null;
}

/**
 * Turn one Markdown href into a path in the session that emitted it.
 *
 * Codex renders local file links as absolute POSIX paths, optionally followed by
 * `:line[:column]`. Relative Markdown links are useful too, but URL schemes and
 * same-origin dashboard routes must be left to the browser. Absolute paths are only
 * claimed when they sit beneath this session's cwd.
 */
export function workspaceFileTarget(href: string, cwd: string): WorkspaceFileTarget | null {
  if (!cwd || !href || href.startsWith("#") || href.startsWith("?")) return null;

  const hashAt = href.indexOf("#");
  const queryAt = href.indexOf("?");
  const cutAt = [hashAt, queryAt].filter((at) => at >= 0).reduce((a, b) => Math.min(a, b), href.length);
  const fragment = hashAt >= 0 ? href.slice(hashAt + 1, queryAt > hashAt ? queryAt : undefined) : "";
  const decoded = decodePath(href.slice(0, cutAt));
  if (!decoded || decoded.includes("\0")) return null;
  const scheme = linkScheme(decoded);
  if (
    decoded.startsWith("//") ||
    (scheme && (BLOCKED_LINK_SCHEMES.has(scheme) || !isRootSourceLocation(decoded)))
  ) return null;

  let filePath = decoded;
  let line: number | null = null;
  let column: number | null = null;
  const suffix = filePath.match(/:(\d+)(?::(\d+))?$/);
  if (suffix?.index != null) {
    filePath = filePath.slice(0, suffix.index);
    line = Number(suffix[1]);
    column = suffix[2] ? Number(suffix[2]) : null;
  } else {
    const location = fragment.match(/^L(\d+)(?:C(\d+))?/i);
    if (location) {
      line = Number(location[1]);
      column = location[2] ? Number(location[2]) : null;
    }
  }
  if (linkScheme(filePath)) return null;

  const normalizedCwd = cwd.replaceAll("\\", "/").replace(/\/+$/, "");
  let relative: string;
  if (filePath.startsWith("/")) {
    if (!normalizedCwd || !filePath.startsWith(`${normalizedCwd}/`)) return null;
    relative = filePath.slice(normalizedCwd.length + 1);
  } else {
    relative = filePath;
  }
  const path = normalizeRelative(relative);
  return path ? { path, line, column } : null;
}

export function pathDefaultsToPreview(filePath: string): boolean {
  return /\.(?:html?|md|markdown|mdown)$/i.test(filePath);
}

/** Resolve an asset href relative to the HTML file that contains it. */
export function workspaceAssetPath(href: string, documentPath: string): string | null {
  if (!href || href.startsWith("/") || href.startsWith("#") || href.startsWith("?")) return null;
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//")) return null;
  const cutAt = [href.indexOf("#"), href.indexOf("?")]
    .filter((at) => at >= 0)
    .reduce((a, b) => Math.min(a, b), href.length);
  const decoded = decodePath(href.slice(0, cutAt));
  if (!decoded || decoded.includes("\0")) return null;
  const base = documentPath.replaceAll("\\", "/").split("/").slice(0, -1).join("/");
  return normalizeRelative(base ? `${base}/${decoded}` : decoded);
}
