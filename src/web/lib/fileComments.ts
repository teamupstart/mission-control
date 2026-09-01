// What the Files workspace needs to know about line comments, with no React and no I/O.
//
// Everything here is a pure function of the durable model phase 1 publishes plus the text
// currently in the editor. That is deliberate and it is the rule the CodeMirror integration
// rests on: markers and the open panel are DERIVED from `FileCommentThread.startLine` on
// every render, never mapped through a document change. `FileEditor` replaces its whole
// document on an external sync and destroys its `EditorView` outright when `path`,
// `readOnly` or `lineSeparator` change, and position-mapped decorations do not survive
// either. Derived ones do not notice.

import type { FileCommentReview, FileCommentThread, SessionFileDocument } from "@shared/types.ts";
import type { HtmlBlockPathStep } from "@shared/protocol.ts";
import { boundQuote, normalizeQuote } from "@shared/file-comment-anchor.ts";
import {
  holdsQueuePosition,
  isOutstandingThreadStatus,
  isTerminalThreadStatus,
} from "@shared/file-comments.ts";

/**
 * Descendants whose text reads as a separate region even though `textContent` contributes
 * no boundary around them. Kept to HTML elements with stable default block/table/list layout;
 * an inline `style` can add other boxes and is handled alongside this set below.
 */
const HTML_COMMENT_TEXT_BOUNDARY_TAGS = new Set([
  "address", "article", "aside", "blockquote", "caption", "dd", "details", "dialog", "div",
  "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3",
  "h4", "h5", "h6", "header", "hgroup", "hr", "legend", "li", "main", "menu", "nav",
  "ol", "option", "p", "pre", "search", "section", "summary", "table", "tbody", "td",
  "tfoot", "th", "thead", "tr", "ul",
]);

/** Elements whose descendant text is source, metadata, or fallback rather than rendered copy. */
const HTML_COMMENT_NON_RENDERED_TAGS = new Set([
  "base", "head", "link", "meta", "noscript", "script", "style", "template", "title",
]);

const HTML_COMMENT_BLOCK_DISPLAY_VALUES = new Set([
  "block", "flex", "flow-root", "grid", "list-item", "table",
]);

function isHiddenHtmlCommentElement(element: Element): boolean {
  const inlineStyle = element instanceof HTMLElement || element instanceof SVGElement
    ? element.style
    : null;
  const display = inlineStyle?.display.trim().toLowerCase() ?? "";
  const visibility = inlineStyle?.visibility.trim().toLowerCase() ?? "";
  const contentVisibility = inlineStyle?.contentVisibility.trim().toLowerCase() ?? "";
  return element.hasAttribute("hidden")
    || display === "none"
    || visibility === "hidden"
    || visibility === "collapse"
    || contentVisibility === "hidden";
}

function isBlockHtmlCommentDisplay(display: string): boolean {
  if (HTML_COMMENT_BLOCK_DISPLAY_VALUES.has(display)) return true;
  const tokens = display.split(/\s+/u);
  if (tokens.includes("inline")) return false;
  return tokens.includes("block") || tokens.includes("list-item");
}

/**
 * Whether the Editor can anchor a comment in this document.
 *
 * **Deliberately not `previewable`.** That predicate answers a different question - "is
 * there something to render instead of source" - and it includes `image`, which has no
 * lines at all. It is also pinned by a literal source regex in
 * `test/console-arrow-scroll.test.ts`, so it could not be narrowed even if the two
 * questions happened to coincide today. They do not: a plain `.ts` file is commentable and
 * not previewable, and a `.png` is previewable and not commentable.
 *
 * A `binary` or `oversized` document arrives with `text === null` and is refused by that
 * clause rather than by a kind list, which is the same test the Editor itself renders on -
 * so the control is live exactly when there are lines on screen to click.
 *
 * A file too large to EDIT (over the 2 MiB editor limit) still arrives with its text and
 * still renders in the Editor read-only, and it takes comments. Reading is when you want to
 * point at a line; being unable to type into the buffer does not change that.
 */
export function isCommentableDocument(document: SessionFileDocument): boolean {
  return document.kind !== "image" && document.text !== null;
}

/** Split exactly as CodeMirror numbers lines, so line N here is line N on screen. */
export function sourceLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/**
 * The anchor a click on line `line` takes, or null when the file has no text to anchor to.
 *
 * A blank line is the case this exists for. `CreateFileCommentSchema` refuses a quote that
 * normalizes to nothing - and it is right to, because such a thread is born unanchorable
 * and no edit could ever repair it - so clicking the blank line between two paragraphs
 * cannot anchor to that line alone. It extends to the nearest line that does say
 * something: forward first, because a blank line reads as belonging to what follows it,
 * and backward only when there is nothing below.
 *
 * The range it returns is what the reader sees quoted back, so it stays as small as it can.
 */
export function anchorForLine(
  text: string,
  line: number,
): { startLine: number; endLine: number; quote: string } | null {
  const lines = sourceLines(text);
  if (line < 1 || line > lines.length) return null;
  const speaks = (index: number): boolean => (lines[index] ?? "").trim().length > 0;
  const at = line - 1;
  if (speaks(at)) {
    return { startLine: line, endLine: line, quote: boundQuote(lines[at] ?? "") };
  }
  for (let forward = at + 1; forward < lines.length; forward += 1) {
    if (!speaks(forward)) continue;
    return {
      startLine: line,
      endLine: forward + 1,
      quote: boundQuote(lines.slice(at, forward + 1).join("\n")),
    };
  }
  for (let back = at - 1; back >= 0; back -= 1) {
    if (!speaks(back)) continue;
    return {
      startLine: back + 1,
      endLine: line,
      quote: boundQuote(lines.slice(back, at + 1).join("\n")),
    };
  }
  return null;
}

/**
 * What a rendered-document comment quotes back to the reader.
 *
 * HTML comments carry two deliberately different representations. `quote` is the source
 * line used by ordinary re-anchoring, and `htmlBlockQuote` is the exact element used by the
 * structural resolver. Both must remain markup so a moved element can still be found. That
 * machinery is not what a person needs to read in the comment panel, though, so the panel
 * projects the exact block to decoded text without changing either durable value.
 *
 * A block with no visible text, such as `<hr>`, keeps its retained element markup. An empty
 * display quote would make the target unknowable, while the element itself is the only useful
 * human description in that case. Server rendering has no DOM parser and keeps the raw value;
 * the live dashboard recomputes this display-only projection in the browser.
 */
export function fileCommentQuoteForDisplay(
  surface: FileCommentThread["surface"],
  quote: string,
  htmlBlockQuote?: string | null,
): string {
  if (surface !== "html") return quote;
  const block = htmlBlockQuote ?? quote;
  if (typeof document === "undefined") return block;

  const template = document.createElement("template");
  template.innerHTML = block;
  const sourceTag = template.content.firstElementChild?.tagName.toLowerCase() ?? null;
  // A collapsed single-select renders only its selected label. A list box (`multiple` or
  // `size > 1`) visibly presents its option list, so the generic descendant projection is
  // correct for that separate control shape.
  for (const select of template.content.querySelectorAll<HTMLSelectElement>(
    "select:not([multiple])",
  )) {
    if (select.size > 1 || isHiddenHtmlCommentElement(select)) continue;
    const selectedLabel = select.selectedOptions.item(0)?.label.trim() ?? "";
    if (selectedLabel) {
      select.replaceWith(document.createTextNode(selectedLabel));
    } else {
      // Preserve the control as the textless fallback without leaking every unselected option.
      select.replaceChildren();
    }
  }
  // `textContent` includes source-only nodes and explicitly hidden descendants. Remove the
  // states we can determine from inert markup before projecting the text a person saw.
  for (const element of template.content.querySelectorAll("*")) {
    if (
      !HTML_COMMENT_NON_RENDERED_TAGS.has(element.tagName.toLowerCase())
      && !isHiddenHtmlCommentElement(element)
    ) {
      continue;
    }
    element.remove();
  }
  // HTML comments are non-rendered nodes rather than elements, so the selector above cannot
  // see them. Remove them separately before the markup fallback is captured or a comment-only
  // container would expose its source note in the quote.
  const commentWalker = document.createTreeWalker(template.content, NodeFilter.SHOW_COMMENT);
  const comments: Comment[] = [];
  while (commentWalker.nextNode()) comments.push(commentWalker.currentNode as Comment);
  for (const comment of comments) comment.remove();
  // Capture the fallback BEFORE adding synthetic text boundaries. It may differ from `block`
  // because source-only or hidden descendants have been removed, and returning `block` here
  // would restore exactly the content this display projection intentionally filtered out.
  const retainedMarkup = template.innerHTML.trim();
  // HTML layout creates visible separation that `textContent` does not represent. Add the
  // boundary on BOTH sides so `<p>First</p>tail` and `lead<p>Second</p>` remain separate.
  // The fragment stays inside an inert template: connecting untrusted checkout HTML to the
  // dashboard document could load an image or iframe merely to compute its styles.
  for (const element of template.content.querySelectorAll("*")) {
    const tag = element.tagName.toLowerCase();
    if (tag === "br") {
      element.replaceWith(document.createTextNode(" "));
      continue;
    }
    const inlineDisplay = element instanceof HTMLElement
      ? element.style.display.trim().toLowerCase()
      : "";
    const styledBlock = isBlockHtmlCommentDisplay(inlineDisplay);
    if (!HTML_COMMENT_TEXT_BOUNDARY_TAGS.has(tag) && !styledBlock) continue;
    element.before(document.createTextNode(" "));
    element.after(document.createTextNode(" "));
  }
  const text = (template.content.textContent ?? "")
    .replace(/[\s\u00a0]+/gu, " ")
    .trim();
  return text || retainedMarkup || (sourceTag ? `<${sourceTag}>` : block);
}

/** A thread's opening comment - the row a draft edits and the one a reader sees first. */
export function openingMessage(thread: FileCommentThread): FileCommentThread["messages"][number] | null {
  return thread.messages[0] ?? null;
}

/**
 * The threads this file's Editor draws, newest anchor last.
 *
 * `orphaned` never appears: its session is gone, so the thread is the prune's and there is
 * nothing a person can do to it. `resolved` appears only behind the toggle - the point of
 * closing a thread is that it stops taking up room in the file.
 */
export function threadsForFile(
  threads: readonly FileCommentThread[],
  sessionId: string,
  path: string | null,
  showResolved: boolean,
): FileCommentThread[] {
  if (!path) return [];
  return threads
    .filter((thread) => thread.sessionId === sessionId && thread.path === path)
    .filter((thread) => thread.status !== "orphaned")
    .filter((thread) => showResolved || thread.status !== "resolved")
    .sort((a, b) => a.startLine - b.startLine || a.createdAt - b.createdAt);
}

/** Anchor line to the threads on it, in the order they were written. */
export function threadsByLine(
  threads: readonly FileCommentThread[],
): Map<number, FileCommentThread[]> {
  const byLine = new Map<number, FileCommentThread[]>();
  for (const thread of threads) {
    const bucket = byLine.get(thread.startLine);
    if (bucket) bucket.push(thread);
    else byLine.set(thread.startLine, [thread]);
  }
  return byLine;
}

function sameHtmlBlockPath(
  left: readonly HtmlBlockPathStep[],
  right: readonly HtmlBlockPathStep[],
): boolean {
  return left.length === right.length
    && left.every((step, index) => {
      const other = right[index];
      return other?.index === step.index && other.tag === step.tag;
    });
}

function preferredThread(threads: readonly FileCommentThread[]): FileCommentThread | null {
  return threads.find((thread) => thread.status === "draft") ?? threads[0] ?? null;
}

/**
 * The existing thread a rendered block owns, or null when this is a new block to comment on.
 *
 * Markdown has one source range per rendered block, so its line bucket remains sufficient.
 * Compact HTML can put several distinct elements on the same line. A click carrying the
 * server-resolved identity must therefore match that identity before the old line fallback.
 * Only rows created before block identity shipped use that fallback; a different identified
 * block on the same line is a new comment target rather than somebody else's thread.
 */
export function threadForRenderedBlock(
  threads: readonly FileCommentThread[],
  anchor: {
    htmlBlockPath?: readonly HtmlBlockPathStep[] | null;
    htmlBlockQuote?: string | null;
  },
  surface: "markdown" | "html",
): FileCommentThread | null {
  const path = anchor.htmlBlockPath;
  const quote = anchor.htmlBlockQuote;
  if (surface !== "html" || !path || !quote) return preferredThread(threads);

  const identified = threads.filter(
    (thread) => thread.surface === "html" && thread.htmlBlockPath && thread.htmlBlockQuote,
  );
  const exact = identified.filter(
    (thread) => sameHtmlBlockPath(thread.htmlBlockPath!, path) && thread.htmlBlockQuote === quote,
  );
  if (exact.length > 0) return preferredThread(exact);

  const pathMatches = identified.filter((thread) => sameHtmlBlockPath(thread.htmlBlockPath!, path));
  if (pathMatches.length > 0) return preferredThread(pathMatches);

  const quoteMatches = identified.filter((thread) => thread.htmlBlockQuote === quote);
  if (quoteMatches.length === 1) return quoteMatches[0]!;

  const legacy = threads.filter(
    (thread) => thread.htmlBlockPath == null || thread.htmlBlockQuote == null,
  );
  return preferredThread(legacy);
}

/** How a thread's state reads on a marker and in a thread header. */
export function threadStateLabel(thread: FileCommentThread): string {
  if (thread.outdated) return "moved";
  switch (thread.status) {
    case "draft": return "draft";
    case "queued": return "queued";
    case "sending":
    case "awaiting": return "sent";
    case "answered": return "answered";
    case "unanswered": return "no answer";
    case "resolved": return "resolved";
    case "orphaned": return "session ended";
  }
}

/** Whether a person can still close this thread, as opposed to reopen it. */
export function canResolveThread(thread: FileCommentThread): boolean {
  return !isTerminalThreadStatus(thread.status);
}

/**
 * The accessible name of a line's marker.
 *
 * It names the LINE and the STATE, because those are the two things a marker communicates
 * to a sighted reader by position and colour and to nobody else otherwise.
 */
export function markerLabel(line: number, threads: readonly FileCommentThread[]): string {
  const first = threads[0];
  if (!first) return `Comment on line ${line}`;
  if (threads.length > 1) {
    return `${threads.length} comments on line ${line}`;
  }
  const replies = Math.max(0, first.messageCount - 1);
  const state = threadStateLabel(first);
  const tail = replies === 0 ? "" : `, ${replies} ${replies === 1 ? "reply" : "replies"}`;
  return `Comment ${first.shortId} on line ${line}, ${state}${tail}`;
}

/** The marker's visual class, so a resolved or stale thread does not read as a live one. */
export function markerTone(threads: readonly FileCommentThread[]): string {
  const first = threads[0];
  if (!first) return "is-draft";
  if (first.status === "resolved") return "is-resolved";
  if (first.outdated) return "is-outdated";
  if (first.status === "answered") return "is-answered";
  if (first.status === "draft") return "is-draft";
  return "is-queued";
}

/**
 * Whether a body is worth persisting as a draft yet.
 *
 * The create route trims and requires at least one character, and it computes the quote
 * hash off `normalizeQuote`, so a body of only whitespace is refused rather than stored.
 * Asking here keeps the first keystroke from spending a request that cannot succeed.
 */
export function isPersistableBody(body: string): boolean {
  return body.trim().length > 0 && normalizeQuote(body).length > 0;
}

// ---- the review queue (phase 3's walkthrough) ----

/**
 * The comments a session's review still holds, in the order they will be delivered.
 *
 * Spans every FILE, unlike `threadsForFile` above, and that is the difference that matters:
 * a review is a pass over a working tree, not over one document, so the queue panel has to
 * name each comment's path. The threads arrive here already ordered by `queue_seq` from the
 * daemon's own comparator, but the wire list is keyed by id and carries every session's
 * threads, so the order is re-established rather than assumed.
 *
 * `sending` and `awaiting` keep their positions - they hold `queue_seq` and are what
 * `QUEUE_POSITION_THREAD_STATUSES` names - so the comment currently out with the agent is
 * still in this list, at the head, which is where a reader expects to find it.
 */
/**
 * Agent replies this session has received and nobody has read yet - the Files tab's pip.
 *
 * **Replies, not queue depth.** How many comments are still queued is the human's OWN work,
 * and a badge counting it would light up the moment they wrote a comment, saying "somebody
 * needs you" about a note they just typed. What deserves attention is an answer that arrived
 * while they were looking somewhere else.
 *
 * Read from the durable `readAt` stamp rather than from browser state, for the reason drafts
 * are durable: the integrated Files tab and the extracted Files window are two instances that
 * converge only through the daemon, so a badge kept in one of them would be wrong in the
 * other. Expanding a thread clears it, for both, in the same frame.
 *
 * Terminal threads are excluded. An `orphaned` thread has left the collection anyway, and a
 * `resolved` one is a conversation the person has already closed - re-raising a pip for it
 * would make closing a thread the one action that cannot be finished.
 */
export function unreadAgentReplies(
  threads: readonly FileCommentThread[],
  sessionId: string,
): number {
  let unread = 0;
  for (const thread of threads) {
    if (thread.sessionId !== sessionId || isTerminalThreadStatus(thread.status)) continue;
    for (const message of thread.messages) {
      if (message.author === "agent" && message.readAt === null) unread += 1;
    }
  }
  return unread;
}

export function reviewQueue(
  threads: readonly FileCommentThread[],
  sessionId: string,
): FileCommentThread[] {
  return threads
    .filter((thread) => thread.sessionId === sessionId && holdsQueuePosition(thread.status))
    .sort((a, b) => (a.queueSeq ?? 0) - (b.queueSeq ?? 0) || a.createdAt - b.createdAt);
}

/** The comment out with the agent right now, or null between two turns. */
export function outstandingThread(queue: readonly FileCommentThread[]): FileCommentThread | null {
  return queue.find((thread) => isOutstandingThreadStatus(thread.status)) ?? null;
}

/**
 * The message a queued comment would send next: its oldest human message not yet delivered.
 *
 * The same selection the daemon's payload renderer makes, and the reason edit-unsent edits
 * this row rather than the thread's opening comment - a thread that timed out and was replied
 * to would otherwise offer to edit a comment the agent has already read.
 *
 * Null when there is nothing left to send, and null is also what a truncated frame yields for
 * a thread past the message cap: the wire list carries the NEWEST fifty, so an undelivered
 * message older than those is not in it. Editing is refused rather than guessed at there,
 * which is the safe direction - fifty replies deep on one line, the composer is not the
 * problem.
 */
export function unsentMessage(thread: FileCommentThread): FileCommentThread["messages"][number] | null {
  return thread.messages.find((m) => m.author === "human" && m.deliveredAt === null) ?? null;
}

/**
 * The one line of text a queue row shows for a comment.
 *
 * The comment somebody WROTE, not the line they wrote it about. `unsentMessage` goes null the
 * moment a comment is delivered, and falling back to the quote there made the head row - the
 * one row a reader is actually watching - stop showing the sentence it just sent and start
 * showing the source line instead, which reads as the queue having lost it. So the latest
 * human message wins whether or not it has gone, and the quote is only the answer for a
 * thread that somehow carries no human message at all.
 */
export function queueRowText(thread: FileCommentThread): string {
  const written = [...thread.messages].reverse().find((m) => m.author === "human");
  return written?.body ?? thread.quote;
}

/**
 * Whether this comment can still be rewritten, reordered or dropped.
 *
 * False for the one in flight, INCLUDING during the `sending` window before delivery is
 * confirmed: the bytes are already committed to the outbox, and the daemon refuses the edit
 * outright, so offering the control would only produce a 409 the reader cannot act on.
 */
export function isEditableInQueue(thread: FileCommentThread): boolean {
  return !isOutstandingThreadStatus(thread.status);
}

/**
 * What the walkthrough is doing, in one sentence, for the queue panel's live region.
 *
 * Announced rather than merely drawn because the whole feature is a queue draining without
 * anybody watching it: a sighted reader sees the head move, and without this a screen-reader
 * user is left guessing whether their review is running at all.
 */
export function reviewAnnouncement(
  review: FileCommentReview | null,
  queue: readonly FileCommentThread[],
): string {
  const waiting = queue.filter((thread) => thread.status === "queued").length;
  const out = outstandingThread(queue);
  const remaining = `${waiting} comment${waiting === 1 ? "" : "s"} waiting`;
  // Deliberately WITHOUT the pause reason. The reason is drawn beside this line in its own
  // `role="alert"`, which a screen reader announces too, so carrying it here as well read as
  // the same sentence twice - on screen, literally twice, one under the other.
  if (review?.state === "paused") return `Review paused. ${remaining}.`;
  if (review?.state !== "running") {
    return waiting === 0
      ? "No comments are queued for review."
      : `Review not started. ${remaining}.`;
  }
  return out
    ? `${out.shortId} on ${out.path} line ${out.startLine} is out with the agent. ${remaining}.`
    : `Review running. ${remaining}.`;
}
