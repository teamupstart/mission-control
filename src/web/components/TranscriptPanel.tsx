import { useEffect, useImperativeHandle, useRef, useState } from "react";
import type {
  AgentType,
  ToolCall,
  TranscriptMessage,
  TranscriptStreamMsg,
  TurnOrigin,
} from "@shared/types.ts";
import { withAttachments } from "@shared/attachments.ts";
import { api } from "../lib/api.ts";
import { clearDraft, readDraft, writeDraft } from "../lib/drafts.ts";
import { toolChip, transcriptRows } from "../lib/tools.ts";
import { useRichText } from "../lib/rich-text.tsx";
import { Markdown } from "./Markdown.tsx";
import {
  AttachmentStrip,
  readyAttachments,
  revokeAttachments,
  useImageDrop,
  type PendingAttachment,
} from "./ImageDrop.tsx";

const AGENT_LABEL: Record<AgentType, string> = { claude: "claude", codex: "codex" };

/** Who typed a turn, when it wasn't the human. "mission control" rather than "harness"
 *  because that's the name on the window the reader is looking at. */
const ORIGIN_LABEL: Record<TurnOrigin, string> = { foreman: "foreman", harness: "mission control" };

/**
 * Imperative surface the card holds onto so the send shortcut can reach this panel's
 * reply box - the card's single compose box while it's expanded.
 */
export interface TranscriptHandle {
  /** Focus the reply box, reporting whether there was one (a collapsed card has no
   *  panel mounted at all, and the caller then owns the send flow itself). */
  focusReply: () => boolean;
}

/**
 * The expanded card's live conversation. Opens a dedicated SSE stream to the
 * session's transcript (the server tails the JSONL file), renders the turns, and
 * offers an inline reply that types straight into the agent's prompt. Images can
 * be dropped or pasted onto the reply box; they upload as they land and ride along
 * as paths. Closing the panel closes the stream, so the server stops tailing.
 */
export function TranscriptPanel({
  sessionId,
  agent,
  canSend,
  dialogOpen = false,
  onReplyBox,
  resetNonce = 0,
  ref,
}: {
  sessionId: string;
  agent: AgentType;
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
  ref?: React.Ref<TranscriptHandle>;
}): React.JSX.Element {
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [status, setStatus] = useState<"connecting" | "live" | "unavailable">("connecting");
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const atBottom = useRef(true);
  const drop = useImageDrop({ attachments, onChange: setAttachments, disabled: !canSend });

  // The reply box is deliberately NOT conditioned on the transcript. Replying needs a
  // pane to paste into (`canSend`) and nothing else - the transcript is how you READ a
  // session, not how you write to it. An auto-discovered session whose JSONL we can't
  // resolve is exactly the one you most want to answer from here, and gating the box on
  // the stream left it with only the action bar's cramped fallback input, which can't
  // take newlines or images. So: mounted panel, reply box - reported as such.
  const notifyRef = useRef(onReplyBox);
  notifyRef.current = onReplyBox;
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
    setMessages([]);
    setStatus("connecting");
    setNote("");
    const es = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/transcript/stream`);
    es.onmessage = (ev) => {
      let msg: TranscriptStreamMsg;
      try {
        msg = JSON.parse(ev.data) as TranscriptStreamMsg;
      } catch {
        return;
      }
      if (msg.type === "init") {
        setMessages(msg.messages);
        setStatus("live");
      } else if (msg.type === "append") {
        setMessages((prev) => mergeById(prev, msg.messages));
      } else if (msg.type === "unavailable") {
        setStatus("unavailable");
        setNote(msg.reason);
      }
    };
    // EventSource auto-reconnects on transient errors; keep the last view.
    return () => es.close();
  }, [sessionId]);

  // Follow the tail only when the reader is already at the bottom.
  useEffect(() => {
    const el = logRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Deliberately don't grab focus when the panel opens. Focus mode is opened with
  // `e` and closed with `e`, and the grid's global keys (including that toggle)
  // stand down while a text field is focused - so auto-focusing the reply box
  // would swallow the collapse press. The reader stays on the grid; one click on
  // the (prominent, full-width) reply box drops in when it's time to respond.
  function onScroll(): void {
    const el = logRef.current;
    if (el) atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
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
      // Delivered - so this is the one path that forgets the draft. A failed send
      // leaves it be: the text is all the human has, and it's about to be retried.
      clearDraft(sessionId, "reply");
      if (inputRef.current) inputRef.current.value = "";
      revokeAttachments(attachments);
      setAttachments([]);
    } else {
      setFlash(r.error ?? "send failed");
      setTimeout(() => setFlash(null), 3500);
    }
  }

  return (
    // Stop clicks inside the panel from re-selecting / collapsing the card.
    <div className="transcript" onClick={(e) => e.stopPropagation()}>
      <div className="transcript-log" ref={logRef} onScroll={onScroll}>
        {status === "unavailable" ? (
          <p className="transcript-empty">{note}</p>
        ) : messages.length === 0 ? (
          <p className="transcript-empty">{status === "connecting" ? "Loading…" : "No messages yet."}</p>
        ) : (
          transcriptRows(messages).map((row) =>
            row.kind === "tools" ? (
              <ToolRun key={row.id} tools={row.tools} agentLabel={AGENT_LABEL[agent]} />
            ) : (
              <Turn key={row.id} m={row.message} agentLabel={AGENT_LABEL[agent]} />
            ),
          )
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
          <button
            className="btn btn-send"
            disabled={!canSend || dialogOpen || sending || drop.uploading}
            onClick={() => void send()}
          >
            {drop.uploading ? "Uploading…" : "Send"}
          </button>
        </div>
        {flash && <span className="action-flash">{flash}</span>}
        {drop.dropping && <div className="drop-veil">Drop images to attach</div>}
      </div>
    </div>
  );
}

function Turn({ m, agentLabel }: { m: TranscriptMessage; agentLabel: string }): React.JSX.Element {
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
          {richText ? <Markdown breaks>{m.text}</Markdown> : m.text}
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
          <span key={`${t.name}-${i}`} className="tool-chip" title={chip.title}>
            <span className="tool-chip-name">{chip.name}</span>
            {chip.detail && <span className="tool-chip-detail">{chip.detail}</span>}
          </span>
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
