import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import type {
  ForemanEpisode,
  ToolCall,
  TranscriptMessage,
  TranscriptStreamMsg,
  TurnOrigin,
  Session,
} from "@shared/types.ts";
import { AGENT_IDENTITY } from "@shared/agent.ts";
import { withAttachments } from "@shared/attachments.ts";
import { api, fetchTranscriptBefore } from "../lib/api.ts";
import { clearDraft, readDraft, writeDraft } from "../lib/drafts.ts";
import { sdkDeliveryConfirmation } from "../lib/sdk-delivery.ts";
import {
  appendLive,
  backAnchor,
  flattenHistory,
  prependPage,
  readHistory,
  resumeAnchor,
  resumeTail,
  seedTail,
} from "../lib/transcript-history.ts";
import { toolChip, transcriptRows } from "../lib/tools.ts";
import { useWorkspacePaths, type SessionFilesController } from "../lib/sessionFiles.ts";
import { mergeEpisodes } from "../lib/episodes.ts";
import { ForemanEpisodeCard } from "./ForemanEpisodeCard.tsx";
import { useRichText } from "../lib/rich-text.ts";
import { Markdown } from "./Markdown.tsx";
import type { WorkspaceLinkHandler } from "./Markdown.tsx";
import { agentAccentStyle } from "./session-bits.tsx";
import {
  AttachmentStrip,
  readyAttachments,
  revokeAttachments,
  useImageDrop,
  type PendingAttachment,
} from "./ImageDrop.tsx";
import { Tooltip } from "./Tooltip.tsx";
import { SessionLaunchers, type SessionLaunchersHandle } from "./LaunchMenu.tsx";

/** Who typed a turn, when it wasn't the human. "mission control" rather than "harness"
 *  because that's the name on the window the reader is looking at. */
const ORIGIN_LABEL: Record<TurnOrigin, string> = {
  foreman: "foreman",
  harness: "mission control",
  workflow: "workflow",
};

/**
 * Reconnect backoff for the transcript stream, which this panel drives itself rather than
 * leaving to `EventSource` (see the stream effect for why).
 *
 * The floor is short because the common drop is a daemon restart and the reader is
 * watching the log while it happens; the ceiling keeps a session whose transcript has gone
 * for good from retrying in a tight loop for as long as the card stays open.
 */
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 8000;

/**
 * Imperative surface the card holds onto so the send shortcut can reach this panel's
 * reply box - the card's single compose box while it's expanded.
 */
export interface TranscriptHandle {
  /** Focus the reply box, reporting whether there was one (a collapsed card has no
   *  panel mounted at all, and the caller then owns the send flow itself). */
  focusReply: () => boolean;
  /** Scroll to the inline Foreman entry for this episode marker, if it's rendered. */
  scrollToEpisode: (marker: string | null) => void;
  /** Move the conversation reader by one comfortable keyboard step. */
  scrollByArrow: (direction: -1 | 1) => void;
}

/**
 * The expanded card's live conversation. Opens a dedicated SSE stream to the
 * session's transcript (the server tails the JSONL file), renders the turns, and
 * offers an inline reply that types straight into the agent's prompt. Images can
 * be dropped or pasted onto the reply box; they upload as they land and ride along
 * as paths. Closing the panel closes the stream, so the server stops tailing.
 */
export function TranscriptPanel({
  session,
  canSend,
  dialogOpen = false,
  episodes = [],
  onReplyBox,
  onOpenFile,
  files,
  registerLaunchers,
  resetNonce = 0,
  ref,
}: {
  /**
   * The whole session, not an id and an agent.
   *
   * It was those two fields until the launchers landed above the log, which need the
   * checkout, the runtime, the pane handles and the conversation id to decide what they
   * can do. Both call sites already hold the session, so passing it whole is fewer props
   * rather than more - and it keeps this panel from growing one prop per new fact the
   * toolbar learns to read.
   */
  session: Session;
  canSend: boolean;
  /**
   * Whether the session is parked on an option menu right now.
   *
   * Typing is CLOSED while one is up, and this is a correctness guard rather than a
   * nicety: a dialog swallows pasted text entirely - nothing is focused to receive it -
   * and the Enter that follows confirms whichever row was already highlighted. So a reply
   * sent at a menu doesn't fail, it silently answers a question with the default and
   * attributes it to the human (see `pane-dialog.ts`). The rows are offered as buttons
   * just above this box; that is the only safe way to answer one.
   */
  dialogOpen?: boolean;
  /**
   * Foreman's decisions on this session, interleaved into the log by timestamp.
   *
   * They arrive as a prop rather than being fetched here because they are not part of
   * the transcript: the JSONL knows nothing about them, and the SSE stream this panel
   * opens would have no way to carry them. The owner fetches them and re-renders when
   * the note moves.
   */
  episodes?: ForemanEpisode[];
  /**
   * Bumped whenever this session is reset. The reply box is uncontrolled - its text
   * lives in the draft map, re-read only on mount - so a reset that clears the draft
   * wouldn't empty a box that's open on screen. Keying the textarea on this remounts
   * it, re-hydrating from the (now-empty) draft, so reset visibly clears the reply the
   * same way it clears the queue.
   */
  resetNonce?: number;
  /**
   * Whether this panel is currently rendering a reply box, reported as it mounts and
   * unmounts. The card's send box may only be open when there is none, and whether
   * there is one is this panel's fact alone.
   */
  onReplyBox?: (present: boolean) => void;
  /** Claim links that resolve to a file in this transcript's session checkout. */
  onOpenFile?: WorkspaceLinkHandler;
  /**
   * The session files store, for the checkout listing that decides which bare paths in
   * the prose are real files. Only ever read through `useWorkspacePaths` below - this
   * panel does not browse files, it only needs to know which words name one.
   */
  files?: SessionFilesController;
  /** Register the launch buttons so App's selection shortcuts drive these exact controls. */
  registerLaunchers?: (id: string, handle: SessionLaunchersHandle | null) => void;
  ref?: React.Ref<TranscriptHandle>;
}): React.JSX.Element {
  // The body below was written against these two names and still is; only the PROP changed.
  const sessionId = session.id;
  const agent = session.agent;
  // Only a session with a checkout and a handler that can open one has any use for the
  // listing; without both, a path in the prose stays the text the agent typed.
  const filePaths = useWorkspacePaths(files, sessionId, Boolean(session.cwd && onOpenFile));
  // Both hosts build `onOpenFile` as a fresh closure every render (`cardProps`,
  // ConsoleDetail's inline arrow), and `Markdown` is memoized on its props - including
  // this one, because it must be: a skipped render leaves the rendered anchors calling
  // the previous closure, which carries App's `layout` and `sessions`. Handing the same
  // wrapper down every time makes that comparison true HONESTLY, so the turns below stay
  // memoized through every SSE frame while a click still reaches the newest handler.
  const openFileRef = useRef(onOpenFile);
  openFileRef.current = onOpenFile;
  const openFile = useCallback<WorkspaceLinkHandler>(
    (href, probe) => openFileRef.current?.(href, probe) ?? false,
    [],
  );
  const linkHandler = onOpenFile ? openFile : undefined;
  // Hydrated from the history map rather than starting empty, so re-opening a session
  // you had scrolled back through shows that scroll-back immediately instead of blanking
  // to the stream's tail and making you find your place again.
  const [messages, setMessages] = useState<TranscriptMessage[]>(() =>
    flattenHistory(readHistory(sessionId)),
  );
  const [canLoadOlder, setCanLoadOlder] = useState(() => backAnchor(readHistory(sessionId)) !== null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  const [status, setStatus] = useState<"connecting" | "live" | "unavailable">("connecting");
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [flash, setFlash] = useState<{ text: string; ok: boolean } | null>(null);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const atBottom = useRef(true);
  const historyEpoch = useRef(0);
  /**
   * Scroll height captured just before a page of older turns is spliced in above the
   * reader, so the layout effect below can put back what prepending pushed down.
   * Null when no restore is pending.
   */
  const pendingRestore = useRef<number | null>(null);
  const drop = useImageDrop({ attachments, onChange: setAttachments, disabled: !canSend });

  // The reply box is deliberately NOT conditioned on the transcript. Replying needs a
  // pane to paste into (`canSend`) and nothing else - the transcript is how you READ a
  // session, not how you write to it. An auto-discovered session whose JSONL we can't
  // resolve is exactly the one you most want to answer from here, and gating the box on
  // the stream left it with only the action bar's cramped fallback input, which can't
  // take newlines or images. So: mounted panel, reply box - reported as such.
  const notifyRef = useRef(onReplyBox);
  notifyRef.current = onReplyBox;

  function showFlash(next: { text: string; ok: boolean }, duration: number): void {
    if (flashTimer.current) clearTimeout(flashTimer.current);
    setFlash(next);
    flashTimer.current = setTimeout(() => {
      flashTimer.current = null;
      setFlash(null);
    }, duration);
  }

  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    },
    [],
  );
  useEffect(() => {
    notifyRef.current?.(true);
    // Retract on unmount without depending on the callback identity - a card whose
    // transcript has gone owns its send box again.
    return () => notifyRef.current?.(false);
  }, []);

  // The panel deliberately never takes focus on its own (see below), but the send
  // shortcut is an explicit "I want to type now" - so it gets a way in. Reported as a
  // boolean rather than assumed: a collapsed card has no panel mounted at all, and the
  // card must know that to fall back to its own send box.
  useImperativeHandle(ref, () => ({
    focusReply: () => {
      const el = inputRef.current;
      if (!el) return false;
      el.focus();
      // Land at the end of a re-hydrated draft, where you'd resume typing - not at
      // whatever offset the last mount happened to leave behind.
      const end = el.value.length;
      el.setSelectionRange(end, end);
      return true;
    },
    scrollToEpisode: (marker) => {
      if (!marker) return;
      // Queried out of the DOM rather than tracked in a ref map, because the target
      // may not be mounted: the episode list and the transcript load independently,
      // and the strip is clickable before either has settled. A missing node is a
      // no-op, which is the right outcome for "scroll to something not on screen".
      const el = logRef.current?.querySelector(`[data-episode-marker="${CSS.escape(marker)}"]`);
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
    },
    scrollByArrow: (direction) => {
      const el = logRef.current;
      if (!el) return;
      el.scrollBy({ top: direction * Math.max(80, el.clientHeight * 0.18) });
    },
  }), []);

  // The reply's attachments are the panel's own, and unlike the TEXT beside them they
  // do not survive a collapse - so their thumbnails are ours to release. Read through
  // a ref because the cleanup runs once, at unmount, and must see the list as it ended
  // - not as it was on the render that armed it.
  //
  // The asymmetry is deliberate, not an oversight to tidy up later. Parking these in
  // the draft map would strand any drop still uploading when the card closed: the
  // upload's callback patches its row through THIS mount's `setAttachments`, so the
  // path would land nowhere and the chip would re-hydrate stuck on "uploading"
  // forever, wedging the Send button that waits on it. Persisting them means hoisting
  // the uploads out of this component first (what DispatchLayer does for its draft).
  // Losing a chip is at least visible: the strip is plainly empty, which is a far
  // better failure than a prompt that cites an image the agent never got.
  const attachRef = useRef(attachments);
  attachRef.current = attachments;
  useEffect(() => () => revokeAttachments(attachRef.current), []);

  // A reset discards the task, so the reply's pending images go with its text: the
  // textarea's remount drops the words, this drops the chips (and frees their previews).
  // Read through the ref so it sees the list as it stands at reset, and depend on the
  // nonce alone so an ordinary drop can't wipe itself. On the first mount the list is
  // empty, so both calls no-op.
  useEffect(() => {
    revokeAttachments(attachRef.current);
    setAttachments([]);
  }, [resetNonce]);

  useEffect(() => {
    historyEpoch.current += 1;
    // Show whatever this session already has while the stream connects, instead of
    // clearing to "Loading…" and throwing away scroll-back the map still holds.
    setMessages(flattenHistory(readHistory(sessionId)));
    setCanLoadOlder(backAnchor(readHistory(sessionId)) !== null);
    setLoadingOlder(false);
    setOlderError(null);
    setStatus("connecting");
    setNote("");
    // The reconnect is OURS, not the browser's.
    //
    // `EventSource` retries the URL it was constructed with, which would pin `?from=` to
    // whatever offset this mount started at - so a reconnect an hour in would ask the
    // server to replay an hour of turns it already has. Reconnecting by hand is what lets
    // each attempt carry the offset the reader has actually reached, which is the whole
    // point of resuming: the anchor never moves, so the pages scrolled back to survive.
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let delay = RECONNECT_MIN_MS;
    let closed = false;

    const connect = (): void => {
      if (closed) return;
      const from = resumeAnchor(sessionId);
      const base = `/api/sessions/${encodeURIComponent(sessionId)}/transcript/stream`;
      es = new EventSource(from === null ? base : `${base}?from=${encodeURIComponent(String(from))}`);
      es.onopen = () => {
        delay = RECONNECT_MIN_MS;
      };
      es.onmessage = (ev) => {
        let msg: TranscriptStreamMsg;
        try {
          msg = JSON.parse(ev.data) as TranscriptStreamMsg;
        } catch {
          return;
        }
        if (msg.type === "init") {
          // The start-over path: a first connect, or a resume the server refused because
          // the file moved or too much was written to bridge. `seedTail` keeps whatever
          // pages still abut this window and reports what survived.
          const next = seedTail(sessionId, msg);
          setMessages(flattenHistory(next));
          setCanLoadOlder(backAnchor(next) !== null);
          setStatus("live");
        } else if (msg.type === "resume") {
          // The reconnect path: the reader keeps every page and the anchor stays put, so
          // only genuinely missed turns arrive. A cache that has since been dropped (a
          // reset, an eviction) leaves nothing to continue, so fall back to seeding.
          const next = resumeTail(sessionId, msg);
          if (next) {
            setMessages(flattenHistory(next));
            setCanLoadOlder(backAnchor(next) !== null);
          } else {
            setMessages((prev) => mergeById(prev, msg.messages));
          }
          setStatus("live");
        } else if (msg.type === "append") {
          const next = appendLive(sessionId, msg.messages, msg.pos);
          if (next) setMessages(flattenHistory(next));
          else setMessages((prev) => mergeById(prev, msg.messages));
        } else if (msg.type === "unavailable") {
          setStatus("unavailable");
          setNote(msg.reason);
        }
      };
      es.onerror = () => {
        // Close before retrying: left open, the browser starts its own reconnect against
        // the stale URL and we would have two streams on one session.
        es?.close();
        es = null;
        if (closed) return;
        retry = setTimeout(connect, delay);
        delay = Math.min(delay * 2, RECONNECT_MAX_MS);
      };
    };
    connect();

    return () => {
      closed = true;
      historyEpoch.current += 1;
      if (retry) clearTimeout(retry);
      es?.close();
    };
  }, [resetNonce, sessionId]);

  /**
   * Fetch the page above what we hold and splice it in.
   *
   * Guarded on `loadingOlder` because the scroll handler fires continuously while the
   * reader sits at the top: without it one flick would launch a dozen overlapping
   * requests for the same anchor, and the winners would each try to prepend the same
   * range.
   */
  const loadOlder = useCallback(async () => {
    if (loadingOlder) return;
    const anchor = backAnchor(readHistory(sessionId));
    if (anchor === null) {
      setCanLoadOlder(false);
      return;
    }
    setLoadingOlder(true);
    setOlderError(null);
    const requestEpoch = historyEpoch.current;
    const res = await fetchTranscriptBefore(sessionId, anchor);
    if (requestEpoch !== historyEpoch.current) return;
    if (!res.ok) {
      setOlderError(res.error);
      setLoadingOlder(false);
      return;
    }
    // Measured before the state change so the layout effect can hold the reader's place;
    // React commits the taller list before paint, so reading it here is the last chance.
    pendingRestore.current = logRef.current?.scrollHeight ?? null;
    const next = prependPage(sessionId, res);
    if (next) {
      setMessages(flattenHistory(next));
      setCanLoadOlder(backAnchor(next) !== null);
    } else {
      // The page did not abut what we hold - the file moved under the request. Nothing is
      // spliced, so nothing needs restoring.
      pendingRestore.current = null;
      setCanLoadOlder(backAnchor(readHistory(sessionId)) !== null);
    }
    setLoadingOlder(false);
  }, [loadingOlder, sessionId]);

  /**
   * Keep the reader's place across both kinds of list growth.
   *
   * Prepending older turns pushes everything down by exactly the height that arrived, so
   * the scroll offset has to gain the same amount or the content the reader was looking
   * at slides off the bottom of the viewport. That correction must happen before paint -
   * in a passive effect it renders as a visible jump - which is what makes this the one
   * layout effect in the panel. Appends are the ordinary case and only follow the tail
   * when the reader was already there.
   */
  useLayoutEffect(() => {
    const el = logRef.current;
    if (!el) return;
    const before = pendingRestore.current;
    if (before !== null) {
      pendingRestore.current = null;
      el.scrollTop += el.scrollHeight - before;
      return;
    }
    if (atBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Deliberately don't grab focus when the panel opens. Focus mode is opened with
  // `e` and closed with `e`, and the grid's global keys (including that toggle)
  // stand down while a text field is focused - so auto-focusing the reply box
  // would swallow the collapse press. The reader stays on the grid; one click on
  // the (prominent, full-width) reply box drops in when it's time to respond.
  function onScroll(): void {
    const el = logRef.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    // Reaching for the top is the request to see what came before. Fired a little short
    // of the edge so the page is already arriving by the time the reader gets there, and
    // never while one is in flight or the file has nothing older.
    if (canLoadOlder && !loadingOlder && el.scrollTop < 120) void loadOlder();
  }

  /**
   * Deliver the reply as ONE submission via `/inject`'s bracketed paste, rather
   * than `/send`'s literal send-keys.
   *
   * `/send` types the text character by character, so every newline in it lands as
   * an Enter and submits - which makes the "Shift+Enter for newline" this box
   * advertises a lie (a two-line reply arrives as two half-prompts), and makes
   * attachment paths on their own lines impossible. One paste, one Enter, one turn.
   */
  async function send(): Promise<void> {
    const text = inputRef.current?.value.trim() ?? "";
    const ready = readyAttachments(attachments);
    // An image mid-upload has no path yet, and sending now would quietly leave it
    // out of the very prompt it was dropped on. The button says so; this guards the
    // Enter key, which doesn't.
    // `dialogOpen` is re-checked here and not only on the disabled textarea, because the
    // menu can open in the gap between reading the box and sending it. Everything else in
    // this guard is a nuisance if it slips; this one silently answers a question.
    if (dialogOpen || drop.uploading || sending || (!text && ready.length === 0)) return;
    setSending(true);
    const r = await api.injectPrompt(sessionId, withAttachments(text, ready));
    setSending(false);
    if (r.ok) {
      const confirmation = sdkDeliveryConfirmation(r.delivery);
      if (confirmation) {
        showFlash({ text: confirmation, ok: true }, 5000);
      }
      // Delivered - so this is the one path that forgets the draft. A failed send
      // leaves it be: the text is all the human has, and it's about to be retried.
      clearDraft(sessionId, "reply");
      if (inputRef.current) inputRef.current.value = "";
      revokeAttachments(attachments);
      setAttachments([]);
    } else {
      showFlash({ text: r.error ?? "send failed", ok: false }, 3500);
    }
  }

  return (
    // Stop clicks inside the panel from re-selecting / collapsing the card. The accent
    // is set here rather than per turn: every assistant byline in this log belongs to
    // the same harness, and the stylesheet then names no agent to colour them.
    <div
      className="transcript"
      style={agentAccentStyle(agent)}
      onClick={(e) => e.stopPropagation()}
    >
      <SessionLaunchers session={session} registerLaunchers={registerLaunchers} />
      <div className="transcript-log" ref={logRef} onScroll={onScroll}>
        {/* An unavailable transcript still shows Foreman's record, and this is the
            case that most needs it: a session with no resolvable JSONL is exactly
            where its decisions are the ONLY account of what happened. The reason
            line stays above them, so "no transcript" is still said rather than
            implied by its absence. */}
        {status === "unavailable" && <p className="transcript-empty">{note}</p>}
        {(canLoadOlder || loadingOlder || olderError) && (
          <div className="transcript-older">
            {olderError ? (
              <Tooltip label={olderError}>
                <button type="button" className="transcript-older-btn" onClick={() => void loadOlder()}>
                  Couldn't load older messages - retry
                </button>
              </Tooltip>
            ) : loadingOlder ? (
              <span className="transcript-older-note">Loading older messages…</span>
            ) : (
              <Tooltip label="Read further back in this session's transcript">
                <button type="button" className="transcript-older-btn" onClick={() => void loadOlder()}>
                  Load older messages
                </button>
              </Tooltip>
            )}
          </div>
        )}
        {status !== "unavailable" && messages.length === 0 && episodes.length === 0 && (
          <p className="transcript-empty">{status === "connecting" ? "Loading…" : "No messages yet."}</p>
        )}
        {mergeEpisodes(transcriptRows(messages), episodes).map((row) =>
              row.kind === "episode" ? (
                <div
                  key={`ep-${row.episode.id}`}
                  className="transcript-episode"
                  data-episode-marker={row.episode.marker}
                >
                  <ForemanEpisodeCard episode={row.episode} />
                </div>
              ) : row.kind === "tools" ? (
                <ToolRun key={row.id} tools={row.tools} agentLabel={AGENT_IDENTITY[agent].speaker} />
              ) : (
                <Turn
                  key={row.id}
                  m={row.message}
                  agentLabel={AGENT_IDENTITY[agent].speaker}
                  onOpenFile={linkHandler}
                  filePaths={filePaths}
                />
              ),
        )}
      </div>

      <div className="transcript-compose" {...drop.dropProps}>
        <AttachmentStrip attachments={attachments} onRemove={drop.remove} />
        <div className="compose-row">
          <textarea
            // Remount on reset so an open box drops the text the reset discarded;
            // `defaultValue` then re-hydrates from the emptied draft. See `resetNonce`.
            key={resetNonce}
            ref={inputRef}
            className="transcript-input"
            placeholder={
              !canSend
                ? "No pane to send to"
                : dialogOpen
                  ? "Waiting on a menu - pick an option above to answer it"
                  : "Reply to this session…  (Enter to send, Shift+Enter for newline, drop or paste images)"
            }
            rows={2}
            disabled={!canSend || dialogOpen}
            // Stays uncontrolled - that's why typing here has never re-rendered the
            // log above it, and a reply written against a streaming transcript can't
            // afford to start. `defaultValue` re-hydrates whatever the last mount was
            // holding when the card collapsed; `onChange` keeps that copy current at
            // the cost of a Map set per keystroke.
            defaultValue={readDraft(sessionId, "reply")}
            onChange={(e) => writeDraft(sessionId, "reply", e.currentTarget.value)}
            onPaste={drop.onPaste}
            onKeyDown={(e) => {
              // The Enter that commits an IME candidate (Japanese/Chinese/Korean) is
              // the same keystroke as the one that sends, and the browser tells them
              // apart only by `isComposing`. Without this, picking a candidate fires
              // off the half-composed reply.
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              } else if (e.key === "Escape") {
                // Blur back to the grid so card keyboard nav (e to collapse) works.
                e.currentTarget.blur();
              }
            }}
          />
          <Tooltip
            label={
              !canSend
                ? "No pane to send to"
                : dialogOpen
                  ? "Answer the prompt above first"
                  : drop.uploading
                    ? "Waiting for the attachments to finish uploading"
                    : "Send this reply to the agent's prompt (Enter)"
            }
          >
            <button
              className="btn btn-send"
              disabled={!canSend || dialogOpen || sending || drop.uploading}
              onClick={() => void send()}
            >
              {drop.uploading ? "Uploading…" : "Send"}
            </button>
          </Tooltip>
        </div>
        {flash && (
          <span className={`action-flash${flash.ok ? " is-ok" : ""}`} role="status">
            {flash.text}
          </span>
        )}
        {drop.dropping && <div className="drop-veil">Drop images to attach</div>}
      </div>
    </div>
  );
}

function Turn({
  m,
  agentLabel,
  onOpenFile,
  filePaths,
}: {
  m: TranscriptMessage;
  agentLabel: string;
  onOpenFile?: WorkspaceLinkHandler;
  filePaths?: ReadonlySet<string> | null;
}): React.JSX.Element {
  const [richText] = useRichText();
  // A turn the human didn't type says who did. Much of the "user" side of a supervised
  // session is Foreman delivering work or the dashboard reloading skills, and reading
  // those back as "you" makes the log claim the human asked for things they never asked
  // for - while hiding the machinery that did.
  const who = m.role === "assistant" ? agentLabel : m.origin ? ORIGIN_LABEL[m.origin] : "you";
  return (
    <div className={`turn turn-${m.origin ?? m.role}`}>
      <div className="turn-role">{who}</div>
      {m.text && (
        // Formatted turns still wear `turn-text` - the bubble's colour, padding, and per-role
        // tint are the same either way. Only what's inside it changes, and `markdown` swaps
        // the `pre-wrap` raw text for parsed blocks.
        <div className={`turn-text${richText ? " markdown" : ""}`}>
          {richText
            ? (
              <Markdown breaks onLinkClick={onOpenFile} filePaths={filePaths}>
                {m.text}
              </Markdown>
            )
            : m.text}
        </div>
      )}
      {m.tools.length > 0 && <ToolChips tools={m.tools} />}
    </div>
  );
}

/**
 * A run of back-to-back tool-only turns, on one line. Reads as a single sentence -
 * "claude executed  bash ls  bash wc" - because to the person watching, that's what
 * it was: one stretch of the agent working, not a dozen turns worth a header each.
 */
function ToolRun({ tools, agentLabel }: { tools: ToolCall[]; agentLabel: string }): React.JSX.Element {
  return (
    <div className="turn turn-assistant turn-toolrun">
      <div className="turn-role">{agentLabel} executed</div>
      <ToolChips tools={tools} />
    </div>
  );
}

function ToolChips({ tools }: { tools: ToolCall[] }): React.JSX.Element {
  return (
    <div className="turn-tools">
      {tools.map((t, i) => {
        // The name alone ("Bash", nine times over) is frame without content; the chip
        // carries what the call actually touched, and the title the literal input.
        const chip = toolChip(t);
        return (
          <Tooltip key={`${t.name}-${i}`} label={chip.title}>
            <span className="tool-chip">
              <span className="tool-chip-name">{chip.name}</span>
              {chip.detail && <span className="tool-chip-detail">{chip.detail}</span>}
            </span>
          </Tooltip>
        );
      })}
    </div>
  );
}

/** Append only turns we haven't already shown (init and append can overlap). */
function mergeById(prev: TranscriptMessage[], next: TranscriptMessage[]): TranscriptMessage[] {
  if (next.length === 0) return prev;
  const seen = new Set(prev.map((m) => m.id));
  const add = next.filter((m) => !seen.has(m.id));
  return add.length ? [...prev, ...add] : prev;
}
