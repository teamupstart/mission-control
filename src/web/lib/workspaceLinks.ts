import { browserImageMediaTypeForPath } from "@shared/browser-images.ts";

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
  return /^[^/:?#]+:\d+(?::\d+)?$/.test(value);
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
export function workspaceFileTarget(
  href: string,
  cwd: string,
  rootFileExists?: (path: string) => boolean,
): WorkspaceFileTarget | null {
  if (!cwd || !href || href.startsWith("#") || href.startsWith("?")) return null;

  const hashAt = href.indexOf("#");
  const queryAt = href.indexOf("?");
  const cutAt = [hashAt, queryAt].filter((at) => at >= 0).reduce((a, b) => Math.min(a, b), href.length);
  const fragment = hashAt >= 0 ? href.slice(hashAt + 1, queryAt > hashAt ? queryAt : undefined) : "";
  const decoded = decodePath(href.slice(0, cutAt));
  if (!decoded || decoded.includes("\0")) return null;
  const scheme = linkScheme(decoded);
  const ambiguousRoot = Boolean(scheme && isRootSourceLocation(decoded));
  if (decoded.startsWith("//") || (scheme && (BLOCKED_LINK_SCHEMES.has(scheme) || !ambiguousRoot))) {
    return null;
  }

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
  if (!path || (ambiguousRoot && !rootFileExists?.(path))) return null;
  return { path, line, column };
}

export function pathDefaultsToPreview(filePath: string): boolean {
  return /\.(?:html?|md|markdown|mdown)$/i.test(filePath)
    || browserImageMediaTypeForPath(filePath) !== null;
}

/**
 * The extensions a token with no slash in it may end in and still read as a file.
 *
 * A token containing a `/` needs no such proof - prose does not use one. A lone word
 * does, or every "e.g" and "vs." in a sentence becomes a path candidate, and the reader
 * that resolves candidates pays a lookup for each.
 */
const KNOWN_PATH_EXTENSIONS = new Set([
  "apng", "avif", "bash", "bmp", "c", "cc", "cjs", "cpp", "css", "gif", "go", "h", "hpp",
  "html", "ico", "java", "jfif", "jpeg", "jpg", "js", "json", "jsx", "kt", "kts", "md",
  "mdx", "mjs", "php", "png", "py", "rb", "rs", "scss", "sh", "sql", "svg", "swift",
  "toml", "ts", "tsx", "txt", "webp", "xml", "yaml", "yml", "zsh",
]);

const LEADING_TOKEN_PUNCTUATION = new Set(["`", "'", "\"", "(", "[", "{", "<"]);
const TRAILING_TOKEN_PUNCTUATION = new Set([
  "`", "'", "\"", ")", "]", "}", ">", ".", ",", ";", ":", "!", "?",
]);

function pathShaped(token: string): boolean {
  if (
    token.length === 0 ||
    token.startsWith("/") ||
    token.includes("\\") ||
    token.includes("://") ||
    !/^[A-Za-z0-9_@+.,=~%/()[\]{}-]+$/.test(token)
  ) {
    return false;
  }
  const segments = token.split("/");
  if (segments.some((segment) => segment === "" || segment === "..")) return false;
  if (token.includes("/")) return true;
  const dot = token.lastIndexOf(".");
  return dot > 0 && KNOWN_PATH_EXTENSIONS.has(token.slice(dot + 1).toLowerCase());
}

export interface PathToken {
  /** The path alone, with any trailing `:line[:column]` taken off. */
  path: string;
  line: number | null;
  column: number | null;
  /** The source text this token covers, source location and all. Render THIS, not `path`. */
  raw: string;
  /** Offsets into the string that was scanned, so a caller can rebuild it around the token. */
  start: number;
  end: number;
}

/**
 * Find the path-shaped tokens in one run of plain prose, with NO list of real files.
 *
 * SHAPE ONLY, and that is a fallback rather than the good answer: guessing from shape is
 * what a caller does when it cannot ask what exists. It costs the extensionless and
 * dotfile names (`Makefile`, `.env`) and anything with a space in it, because nothing here
 * can tell those from ordinary prose. A caller HOLDING the checkout listing should use
 * `matchCheckoutPaths` below, which has no such blind spots because membership decides.
 * The ensemble scorecard is the caller that genuinely cannot: it renders a rationale on
 * its first pass, before selecting artifacts has fetched any file union.
 *
 * The `:line[:column]` suffix is split off rather than rejected: an agent writes
 * `src/App.tsx:42` constantly, and a matcher that reads that as one opaque token finds no
 * file by that name and silently drops the most common file reference there is.
 */
export function detectPathTokens(text: string): PathToken[] {
  const tokens: PathToken[] = [];
  for (const match of text.matchAll(/\S+/g)) {
    const word = match[0];
    if (match.index === undefined) continue;
    let left = 0;
    let right = word.length;
    while (left < right && LEADING_TOKEN_PUNCTUATION.has(word[left]!)) left += 1;
    while (right > left && TRAILING_TOKEN_PUNCTUATION.has(word[right - 1]!)) right -= 1;
    const raw = word.slice(left, right);
    const suffix = raw.match(/:(\d+)(?::(\d+))?$/);
    const path = suffix?.index != null ? raw.slice(0, suffix.index) : raw;
    if (!pathShaped(path)) continue;
    tokens.push({
      path,
      line: suffix ? Number(suffix[1]) : null,
      column: suffix?.[2] ? Number(suffix[2]) : null,
      raw,
      start: match.index + left,
      end: match.index + right,
    });
  }
  return tokens;
}

/**
 * Split a `path:line[:column]` reference, or return the reference unchanged.
 *
 * Shared by both matchers so a source location means the same thing whichever one found
 * it - and kept separate from the membership test, because `src/App.tsx:42` never appears
 * in a file listing while `src/App.tsx` does.
 */
export function splitPathLocation(raw: string): [string, number | null, number | null] {
  const suffix = raw.match(/:(\d+)(?::(\d+))?$/);
  if (suffix?.index == null) return [raw, null, null];
  return [raw.slice(0, suffix.index), Number(suffix[1]), suffix[2] ? Number(suffix[2]) : null];
}

/**
 * Resolve one candidate against the listing, or nothing.
 *
 * The candidate goes through the SAME `normalizeRelative` a written link does, so `./x`
 * and `x` are the one file here as well - a matcher that skipped it would link the href
 * form and not the form agents actually type at a shell.
 *
 * MEMBERSHIP IS THE ONLY TEST. Every listed file is reachable by writing its relative
 * path, with no exception for length, extension or shape, and the one worth naming is
 * a one-character file: a checkout holding `a` links the word "a", in prose, in
 * backticks, as `./a`, anywhere. That is a deliberate choice and it has a cost - in a
 * checkout that really contains such a file, English articles link too, measured at 71
 * of 94 links on one screen. It is the right trade anyway: the link is never WRONG (it
 * opens a file that exists), a hole in the reachable set is a file the operator can see
 * in the Files tab and cannot click to from the conversation that named it, and a
 * one-character filename is close to unheard of, so the cost is confined to a checkout
 * almost nobody has. Do not reintroduce a length rule to buy the aesthetics back.
 */
function listed(
  candidate: string,
  line: number | null,
  column: number | null,
  paths: ReadonlySet<string>,
): { path: string; line: number | null; column: number | null } | null {
  // An absolute path is NOT the listed path with its slash removed, and
  // `normalizeRelative` cannot say so - it drops the empty leading segment like any
  // other, so `/a` arrives here indistinguishable from `a`. Found in a live transcript:
  // an inline `</a>` peeled to the substring `/a` and linked a file called `a`, on an
  // href the checkout resolver then refused, which is a link that does nothing. Only a
  // written link carries the session cwd needed to place an absolute path
  // (`workspaceFileTarget`); a bare one in prose has no such context, so it is not ours.
  if (candidate.startsWith("/")) return null;
  const path = normalizeRelative(candidate);
  if (!path || !paths.has(path)) return null;
  return { path, line, column };
}

/**
 * How many whitespace-separated words the longest path in a listing spans.
 *
 * Almost every checkout answers 1, and that is the point: the multi-word scan below then
 * costs nothing at all, and only a listing that actually contains `docs/My Plan.md` pays
 * for looking. Cached against the listing's identity - it is a stable object per session
 * (see `pathIndex`), so this is computed once per checkout rather than once per message.
 */
const listingWordSpan = new WeakMap<ReadonlySet<string>, number>();

function maxWordSpan(paths: ReadonlySet<string>): number {
  const cached = listingWordSpan.get(paths);
  if (cached !== undefined) return cached;
  let span = 1;
  for (const path of paths) {
    const words = path.split(/\s+/).length;
    if (words > span) span = words;
  }
  listingWordSpan.set(paths, span);
  return span;
}

/**
 * Every way one candidate span can be read, longest first, so longest-match wins.
 *
 * Punctuation is peeled from BOTH ends the same way - repeatedly, one character at a
 * time, stopping at the first character that is not punctuation. The two ends used to
 * disagree: the trailing end looped while the leading end peeled exactly one, so
 * `(README.md)` resolved and `([README.md])` did not. Nesting like that is ordinary in
 * prose and in Markdown - a quoted path inside parentheses, a bracketed one inside a
 * sentence - and the asymmetry made the difference invisible from the outside.
 *
 * Advancing `from` never enters a word: it stops at the first non-punctuation character,
 * so a listed `a` still cannot match inside "cat".
 */
function* candidateSpans(text: string, start: number, end: number): Generator<[number, number]> {
  for (let from = start; from < end; from += 1) {
    let to = end;
    // Longest first: a listing holding both `notes.md` and `notes.md.bak` must match the
    // longer one when the text says so, rather than stopping at the shorter prefix.
    while (to > from) {
      yield [from, to];
      if (!TRAILING_TOKEN_PUNCTUATION.has(text[to - 1]!)) break;
      to -= 1;
    }
    if (!LEADING_TOKEN_PUNCTUATION.has(text[from]!)) break;
  }
}

/**
 * Find the spans of one run of prose that NAME A FILE in this checkout.
 *
 * Membership decides, and nothing else does. That inversion is the whole difference from
 * `detectPathTokens`: a shape rule has to guess, so it has to be conservative, and being
 * conservative is exactly what drops `Makefile`, `.env`, `gradlew` and `docs/My Plan.md` -
 * all perfectly ordinary files whose names carry no evidence that they are files. Asking
 * the listing has no such blind spot, and it is a stronger guarantee in the other
 * direction too: a word only links when this session's checkout really holds a file by
 * exactly that name, so clicking one can never land somewhere that does not exist.
 *
 * EVERY file in the listing is reachable this way - no excluded extension, no excluded
 * shape, no minimum length - because a hole in that set is a file the operator can see in
 * the Files tab and cannot click to from the conversation that named it. `listed` owns
 * what that costs for a one-character name and why it is paid.
 *
 * Word boundaries are what make it safe, and they are the only thing doing that job. A
 * candidate always begins where a whitespace-separated word begins, so a listed `a`
 * matches the word "a" and never the "a" inside "cat"; the longest match at each start
 * wins, so a name is never linked as a fragment of a longer one; and surrounding
 * punctuation is peeled a character at a time, so `docs/a.md` inside `(docs/a.md).`
 * resolves without a rule that guesses at what punctuation means.
 */
export function matchCheckoutPaths(text: string, paths: ReadonlySet<string>): PathToken[] {
  if (paths.size === 0) return [];
  const words = [...text.matchAll(/\S+/g)].flatMap((match) => (
    match.index === undefined ? [] : [{ start: match.index, end: match.index + match[0].length }]
  ));
  const span = maxWordSpan(paths);
  const tokens: PathToken[] = [];
  let index = 0;
  while (index < words.length) {
    const found = matchAt(text, words, index, paths, span);
    if (!found) {
      index += 1;
      continue;
    }
    tokens.push(found.token);
    index = found.nextWord;
  }
  return tokens;
}

function matchAt(
  text: string,
  words: { start: number; end: number }[],
  index: number,
  paths: ReadonlySet<string>,
  maxSpan: number,
): { token: PathToken; nextWord: number } | null {
  const reach = Math.min(maxSpan, words.length - index);
  for (let span = reach; span >= 1; span -= 1) {
    const first = words[index]!;
    const last = words[index + span - 1]!;
    for (const [start, end] of candidateSpans(text, first.start, last.end)) {
      const raw = text.slice(start, end);
      // A file whose name really does end in `:12` beats reading that as a line number.
      const hit = listed(raw, null, null, paths) ?? listed(...splitPathLocation(raw), paths);
      if (hit) return { token: { ...hit, raw, start, end }, nextWord: index + span };
    }
  }
  return null;
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
