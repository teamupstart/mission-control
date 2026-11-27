import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { ARCHIVE_PRIMARY_REPORT_PATH, ARCHIVE_REPORT_DIR, validateArchivePath } from "@shared/archives.ts";
import { MARKDOWN_REMARK_PLUGINS } from "@shared/markdown-config.ts";
import { REPORT_ID_PATTERN, REPORT_LIMITS, type ReportDocumentKind, type ReportItem } from "@shared/reports.ts";
import { reportRelativeReferences } from "./archives/html.ts";
import { caseDistinctPaths } from "./archives/paths.ts";
import { STATE_DIR } from "./config.ts";
import { readFileWithinCap } from "./session-files.ts";

/**
 * A report's attached document, read back from the copy stored when the report was posted
 * (`<state home>/reports/<id>/<name>`), and the static page Publish as scout archives from it.
 *
 * Nothing here reads a checkout. The stored copy is the document: a worktree that was cleaned up,
 * or a checkout file edited after the report was posted, changes neither what Open report shows
 * nor what is published.
 */

/** Where a report's attached document is stored. */
export function reportDocumentDir(id: string, stateDir: string = STATE_DIR): string {
  return join(stateDir, "reports", id);
}

/**
 * Where the files a document links to are stored, under its report's directory. Written as one
 * directory rename, so a reader finds every companion or none.
 */
export const REPORT_COMPANIONS_DIR = "companions";

/** One file a report's document links to, by its path relative to the document. */
export interface ReportCompanion {
  path: string;
  bytes: Buffer;
}

/**
 * The paths a document links to inside its own directory, which a report stores beside it.
 *
 * Read from the page Publish as scout would build (a Markdown document is rendered first), so
 * what is stored is exactly what that page's links name. A path that could not sit beside
 * `report/report.html` in an archive is left out, and so are `report.html` itself, which is the
 * name the page takes there, and any path beneath it.
 */
export function linkedCompanionPaths(kind: ReportDocumentKind, bytes: Buffer): string[] {
  const text = utf8(bytes);
  if (text === null) return [];
  const html = kind === "html" ? text : renderMarkdownPage(text, "");
  const paths = reportRelativeReferences(html)
    .filter((path) => !isUnderPrimaryReport(path)
      && validateArchivePath(`${ARCHIVE_REPORT_DIR}/${path}`) !== null)
    .sort();
  // Paths that collide on a case-insensitive volume (the same path in another case, or a file
  // where another path needs a directory) cannot all be stored or archived. One is kept, chosen
  // the same way every time; a link to any other is unlinked as missing.
  const distinct = caseDistinctPaths(paths);
  return paths.filter((path) => distinct.has(path));
}

/**
 * Whether `path`, relative to the report directory, is the page's own archive name or beneath it.
 * The page is a file at `report/report.html`, so nothing can be stored as `report.html` or under
 * `report.html/`; a link to either is unlinked as missing when the page is published.
 */
export function isUnderPrimaryReport(path: string): boolean {
  // Case-folded: on a case-insensitive volume (the macOS default) `Report.html` names the page.
  const primary = ARCHIVE_PRIMARY_REPORT_PATH.slice(ARCHIVE_REPORT_DIR.length + 1);
  const folded = path.toLowerCase();
  return folded === primary || folded.startsWith(`${primary}/`);
}

/**
 * The companions stored with `report`, in sorted path order, so a page published twice lists them
 * in the same order. A report posted before companions were stored has none.
 *
 * The store is never listed. The candidates are exactly the paths posting looked up: the stored
 * document's linked paths, capped at `REPORT_LIMITS.companionLookups`. Every stored companion is
 * one of them, so a valid store is always read in full however deep its directories, and the work
 * is bounded by that cap whatever is put in the store. A candidate that is not there is skipped,
 * and its link is unlinked as missing. A stored file that cannot be opened or read throws: it was
 * stored, so publishing without it would lose it.
 */
export async function readStoredReportCompanions(
  report: Pick<ReportItem, "id">,
  page: Buffer,
  stateDir?: string,
  hooks: StoredCompanionReadHooks = {},
): Promise<ReportCompanion[]> {
  if (!REPORT_ID_PATTERN.test(report.id)) return [];
  const absent = (error: NodeJS.ErrnoException): null => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  };
  // Only the reports store is canonicalized. Below it, the report's own directory and its
  // `companions` store must each be a real directory: a symlink at either would hand every read
  // beneath it to wherever it points. Every file read is then held to this root, which no later
  // swap can move.
  const reportsStore = await realpath(dirname(reportDocumentDir(report.id, stateDir))).catch(absent);
  if (!reportsStore) return [];
  const reportDir = join(reportsStore, report.id);
  const reportInfo = await lstat(reportDir).catch(absent);
  if (!reportInfo?.isDirectory()) return [];
  const root = join(reportDir, REPORT_COMPANIONS_DIR);
  const rootInfo = await lstat(root).catch(absent);
  if (!rootInfo?.isDirectory()) return [];
  // Chosen from the page being published, never from a second read of the stored document, so
  // the links the archive keeps and the files it carries come from one snapshot.
  const candidates = linkedCompanionPaths("html", page).slice(0, REPORT_LIMITS.companionLookups);
  const companions: ReportCompanion[] = [];
  let total = 0;
  for (const path of candidates) {
    if (companions.length >= REPORT_LIMITS.companionFiles) break;
    const filePath = join(root, ...path.split("/"));
    await hooks.beforeOpen?.(filePath);
    // `O_NONBLOCK` so a named pipe put in the store cannot hold the open waiting for a writer;
    // the regular-file check below then rejects it. A regular file reads the same either way.
    const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      .catch((error: NodeJS.ErrnoException) => {
        // Not stored (never, or gone since), a symlink put in its place, or a path through a
        // file: it is not a stored companion, so its link is unlinked as missing. Any other
        // failure (permissions, I/O) is thrown, so Publish answers 500 rather than archiving, for
        // ever, a page without a file it holds.
        if (error.code === "ENOENT" || error.code === "ELOOP" || error.code === "ENOTDIR" || error.code === "ENXIO") return null;
        throw error;
      });
    if (!handle) continue;
    try {
      await hooks.afterOpen?.(filePath);
      const info = await handle.stat();
      if (!info.isFile() || info.size > REPORT_LIMITS.companionBytes - total) continue;
      // `O_NOFOLLOW` guards only the last component: a directory on the way swapped for a
      // symlink is followed by `open`, whether it points outside the store or at another
      // directory inside it. So the handle is checked after the fact, component by component
      // from the canonical reports store: every directory on the path must be a real directory,
      // never a symlink, and the file at the end must be the one the handle holds. A handle
      // reached through a swapped directory fails, whether or not the swap was undone in between,
      // and is left out rather than read. Gone since the open is absence; any other failure
      // (permissions, I/O) is thrown, so Publish answers 500 rather than unlinking a file it
      // holds into a permanent partial archive.
      const segments = [report.id, REPORT_COMPANIONS_DIR, ...path.split("/")];
      let walked = reportsStore;
      let contained = true;
      for (const [index, segment] of segments.entries()) {
        walked = join(walked, segment);
        const entry = await lstat(walked).catch(absent);
        const last = index === segments.length - 1;
        if (!entry || entry.isSymbolicLink()
          || (last ? !entry.isFile() || entry.dev !== info.dev || entry.ino !== info.ino : !entry.isDirectory())) {
          contained = false;
          break;
        }
      }
      if (!contained) continue;
      const { bytes, exceeded } = await readFileWithinCap(handle, info.size);
      if (exceeded) continue;
      total += bytes.byteLength;
      companions.push({ path, bytes: Buffer.from(bytes) });
    } finally {
      await handle.close();
    }
  }
  return companions;
}

/**
 * Test seams around each stored companion's open, for the window a directory swap would race.
 * The daemon passes none.
 */
export interface StoredCompanionReadHooks {
  beforeOpen?: (path: string) => void | Promise<void>;
  afterOpen?: (path: string) => void | Promise<void>;
}

/** Why a stored document could not be read, with the status a route answers. */
export class ReportDocumentError extends Error {
  constructor(message: string, readonly status: 404 | 409 | 500) {
    super(message);
  }
}

export interface StoredReportDocument {
  name: string;
  kind: ReportDocumentKind;
  bytes: Buffer;
}

/**
 * The stored copy of `report`'s document. The path is generated from the report's id and the
 * name recorded at post time, which was already a bare file name; both are re-checked here so a
 * hand-edited row cannot point the read anywhere else. Opened without following a final symlink,
 * and read under the same cap the post enforced.
 */
export async function readStoredReportDocument(
  report: Pick<ReportItem, "id" | "document">,
  stateDir?: string,
): Promise<StoredReportDocument> {
  const document = report.document;
  if (!document) throw new ReportDocumentError("This report has no attached document.", 404);
  if (!REPORT_ID_PATTERN.test(report.id) || document.name !== basename(document.name)
    || document.name === "" || document.name.startsWith(".") || document.name.includes("\\")) {
    throw new ReportDocumentError("This report's stored document cannot be read.", 404);
  }
  const path = join(reportDocumentDir(report.id, stateDir), document.name);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    // Only a file that is not there is "missing". A symlink put in its place (ELOOP under
    // O_NOFOLLOW) or a path component that is not a directory is unreadable, never followed, and
    // says nothing about what it points at. Anything else - permissions, descriptor exhaustion, an
    // I/O error - is the daemon's own failure: a 500 that keeps the code, so it can be diagnosed
    // rather than sending the operator to look for a file that is actually there.
    if (code === "ENOENT") {
      throw new ReportDocumentError(
        `The stored copy of ${document.name} is missing from Mission Control's state folder.`,
        404,
      );
    }
    if (code === "ELOOP" || code === "ENOTDIR") {
      throw new ReportDocumentError("This report's stored document cannot be read.", 404);
    }
    throw new ReportDocumentError(
      `Mission Control could not open the stored copy of ${document.name} (${code ?? "unknown error"}).`,
      500,
    );
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new ReportDocumentError(`The stored copy of ${document.name} is not a file.`, 404);
    const { bytes, exceeded } = await readFileWithinCap(handle, REPORT_LIMITS.documentBytes);
    if (exceeded) throw new ReportDocumentError(`The stored copy of ${document.name} is larger than a report may attach.`, 409);
    return { name: document.name, kind: document.kind, bytes: Buffer.from(bytes) };
  } finally {
    await handle.close();
  }
}

/** The media type a stored document is served under. Closed: only the two kinds a report stores. */
export function reportDocumentMediaType(kind: ReportDocumentKind): string {
  return kind === "html" ? "text/html; charset=utf-8" : "text/markdown; charset=utf-8";
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Inline styling for a rendered Markdown page. Inline CSS only, with no `url()`, so the page
 * stays inside what the archive's static checker accepts.
 */
const PAGE_STYLE = [
  "body{margin:0;padding:32px 20px;font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1f2328;background:#fff}",
  "main{max-width:820px;margin:0 auto}",
  "h1,h2,h3{line-height:1.25}",
  "pre{background:#f6f8fa;padding:12px;overflow:auto;border-radius:6px}",
  "code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}",
  "table{border-collapse:collapse}td,th{border:1px solid #d0d7de;padding:4px 10px}",
  "blockquote{margin:0;padding-left:12px;border-left:3px solid #d0d7de;color:#59636e}",
].join("");

/**
 * Render Markdown to a complete static HTML page, with the dialect the dashboard reads
 * (`MARKDOWN_REMARK_PLUGINS`). React Markdown never passes raw HTML through and drops unsafe
 * link schemes, so what comes out is markup the document's own text described.
 */
export function renderMarkdownPage(markdown: string, title: string): string {
  const body = renderToStaticMarkup(
    createElement(ReactMarkdown, { remarkPlugins: MARKDOWN_REMARK_PLUGINS }, markdown),
  );
  return `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>${escapeHtml(title)}</title>\n` +
    `<style>${PAGE_STYLE}</style>\n</head>\n<body>\n<main>\n${body}\n</main>\n</body>\n</html>\n`;
}

/** Bytes that are not UTF-8 text are refused rather than replaced: a page must say what it said. */
function utf8(bytes: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export type ReportPageBuild =
  | { ok: true; page: Buffer }
  | { ok: false; status: 404 | 409 | 422 | 500; problems: string[] };

/**
 * The page Publish as scout archives, built from the stored document and nothing else. An HTML
 * document is its stored bytes, exactly. A Markdown document is rendered here, by the daemon, to
 * a static page. The browser never supplies or shapes it.
 */
export async function buildReportPage(
  report: Pick<ReportItem, "id" | "title" | "document">,
  stateDir?: string,
): Promise<ReportPageBuild> {
  if (!report.document) {
    return { ok: false, status: 409, problems: ["This report has no attached document, so there is nothing to publish."] };
  }
  let stored: StoredReportDocument;
  try {
    stored = await readStoredReportDocument(report, stateDir);
  } catch (error) {
    if (error instanceof ReportDocumentError) return { ok: false, status: error.status, problems: [error.message] };
    throw error;
  }
  if (stored.kind === "html") return { ok: true, page: stored.bytes };
  const text = utf8(stored.bytes);
  if (text === null) return { ok: false, status: 422, problems: [`${stored.name} is not UTF-8 text.`] };
  return { ok: true, page: Buffer.from(renderMarkdownPage(text, report.title), "utf8") };
}
