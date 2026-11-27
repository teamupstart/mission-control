import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { ARCHIVE_PRIMARY_REPORT_PATH, ARCHIVE_REPORT_DIR, validateArchivePath } from "@shared/archives.ts";
import { MARKDOWN_REMARK_PLUGINS } from "@shared/markdown-config.ts";
import { REPORT_ID_PATTERN, REPORT_LIMITS, type ReportDocumentKind, type ReportItem } from "@shared/reports.ts";
import { reportRelativeReferences } from "./archives/html.ts";
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
 * `report/report.html` in an archive is left out, and so is `report.html` itself, which is the
 * name the page takes there.
 */
export function linkedCompanionPaths(kind: ReportDocumentKind, bytes: Buffer): string[] {
  const text = utf8(bytes);
  if (text === null) return [];
  const html = kind === "html" ? text : renderMarkdownPage(text, "");
  return reportRelativeReferences(html)
    .filter((path) => `${ARCHIVE_REPORT_DIR}/${path}` !== ARCHIVE_PRIMARY_REPORT_PATH
      && validateArchivePath(`${ARCHIVE_REPORT_DIR}/${path}`) !== null)
    .sort();
}

/**
 * The companions stored with `report`, sorted by path, so a page published twice lists them in
 * the same order. A report posted before companions were stored has none. Entries that are not
 * regular files, or whose path an archive could not hold, are skipped, and reads stop at the
 * bounds the post enforced. A stored file that cannot be opened or read throws: it was stored, so
 * publishing without it would lose it.
 */
export async function readStoredReportCompanions(
  report: Pick<ReportItem, "id">,
  stateDir?: string,
): Promise<ReportCompanion[]> {
  if (!REPORT_ID_PATTERN.test(report.id)) return [];
  const root = join(reportDocumentDir(report.id, stateDir), REPORT_COMPANIONS_DIR);
  const paths: string[] = [];
  const visit = async (relative: string): Promise<void> => {
    const entries = await readdir(relative ? join(root, relative) : root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return [];
      throw error;
    });
    for (const entry of entries) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (validateArchivePath(`${ARCHIVE_REPORT_DIR}/${path}`) === null) continue;
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) paths.push(path);
    }
  };
  await visit("");
  const companions: ReportCompanion[] = [];
  let total = 0;
  for (const path of paths.sort()) {
    if (companions.length >= REPORT_LIMITS.companionFiles) break;
    const handle = await open(join(root, ...path.split("/")), constants.O_RDONLY | constants.O_NOFOLLOW)
      .catch((error: NodeJS.ErrnoException) => {
        // Gone since it was listed, or a symlink put in its place: it is not a stored companion,
        // so its link is unlinked as missing. Any other failure (permissions, I/O) is thrown, so
        // Publish answers 500 rather than archiving, for ever, a page without a file it holds.
        if (error.code === "ENOENT" || error.code === "ELOOP") return null;
        throw error;
      });
    if (!handle) continue;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > REPORT_LIMITS.companionBytes - total) continue;
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
