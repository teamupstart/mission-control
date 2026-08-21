import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  ForemanEpisode,
  PendingTurn,
  ReviewItem,
  ToolCall,
  TranscriptMessage,
  TranscriptStreamMsg,
  Session,
} from "@shared/types.ts";
import type { ConversationView } from "@shared/protocol.ts";
import { AGENT_IDENTITY } from "@shared/agent.ts";
import { withAttachments } from "@shared/attachments.ts";
import { messageBlockReason } from "@shared/pane.ts";
import { pipelineDrivenSentence } from "@shared/pipeline.ts";
import { liveActivity } from "@shared/session.ts";
import { pipelineRunHash } from "../workflows/useWorkflowRoute.ts";
import { api, fetchTranscriptBefore } from "../lib/api.ts";
import { clearDraft, readDraft, writeDraft } from "../lib/drafts.ts";
import { formatChord, useKeybindings } from "../lib/keybindings.ts";
import { sdkDeliveryConfirmation } from "../lib/sdk-delivery.ts";
import {
  latestEditablePendingTurn,
  pendingTurnStatus,
  RECALL_ACKNOWLEDGEMENT_LOST_MESSAGE,
  recallPendingTurnIntoDraft,
  shouldRecallPendingTurn,
} from "../lib/pending-turns.ts";
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
import { toolChip, toolLineTarget, transcriptRows } from "../lib/tools.ts";
import { useWorkspacePaths, type SessionFilesController } from "../lib/sessionFiles.ts";
import { mergeConversation } from "../lib/episodes.ts";
import { projectLaunchPresentation } from "../lib/launch-presentation.ts";
import { parseForemanTerminalReview } from "../lib/foreman-terminal.ts";
import {
  collectHits,
  hitsInScope,
  hitsInWindow,
  buildMatcher,
  splitForHighlight,
  stepIndex,
  toolLineText,
  toolSearchText,
  turnWho,
  type FindHit,
  type FindScope,
} from "../lib/find.ts";
import { ConversationActivity, type ActivityTab } from "./ConversationActivity.tsx";
import { ConversationFindBar, ConversationFindRail } from "./ConversationFind.tsx";
import { ConversationTimestamp } from "./ConversationTimestamp.tsx";
import { TerminalStatusLine, TerminalTitlebar } from "./ConversationTerminal.tsx";
import { useSessionConversationView } from "../lib/conversation-view.ts";
import { duration, promptPath } from "../lib/format.ts";
import { ForemanEpisodeCard } from "./ForemanEpisodeCard.tsx";
import { ReviewAnswerCard } from "./ReviewAnswer.tsx";
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
 * How long a jumped-to turn keeps its flash.
 *
 * Long enough to find with the eye after the scroll settles, short enough that it has
 * gone by the time the reader has finished the message. The stylesheet fades the ring
 * out across the same span, so this is when the class comes off rather than when the
 * flash becomes invisible.
 */
const TURN_FLASH_MS = 2000;

/**
 * Imperative surface the detail holds so the send shortcut can reach this panel's reply box.
 */
export interface TranscriptHandle {
  /** Focus the reply box, reporting whether one is mounted. */
  focusReply: () => boolean;
  /** Scroll to the inline Foreman entry for this episode marker, if it's rendered. */
  scrollToEpisode: (marker: string | null) => void;
  /** Move the conversation reader by one comfortable keyboard step. */
  scrollByArrow: (direction: -1 | 1) => void;
  /** Open find-in-conversation and focus its box. Reports false when there is no
   *  panel mounted, so the caller can reveal the conversation first. */
  openFind: () => boolean;
}

/**
 * What the fleet-wide find chord can do to a mounted transcript. Deliberately one
 * verb: find is a surface the panel owns, and App's job is to ask for it, not to
 * hold its query.
 */
export interface TranscriptFindHandle {
  open: () => void;
}

/** What one open find session holds. Closed is the absence of this, not a flag on it. */
interface FindState {
  query: string;
  caseSensitive: boolean;
  scope: FindScope;
  /** Index into the SCOPED hits, or -1 when nothing matches. */
  index: number;
}

const FIND_INITIAL: FindState = { query: "", caseSensitive: false, scope: "all", index: 0 };

/**
 * A session detail's live conversation. Opens a dedicated SSE stream to the
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
  reviews = [],
  onReplyBox,
  onOpenFile,
  files,
  registerFind,
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
   * The human's answers to this session's reviews, interleaved into the log by the time
   * they were GIVEN.
   *
   * A prop for the same reason the episodes are: they are not in the transcript and the SSE
   * stream this panel opens could not carry them. A review's answer travels to the agent as
   * an MCP tool result, which every harness parser drops as machine noise - so without this
   * the log shows the agent's question as a grey tool chip and then nothing at all where the
   * decision was made. The owner supplies them (`useTimelineReviews`) and re-renders when
   * one is answered.
   */
  reviews?: ReviewItem[];
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
  registerFind?: (id: string, handle: TranscriptFindHandle | null) => void;
  ref?: React.Ref<TranscriptHandle>;
}): React.JSX.Element {
  // The body below was written against these two names and still is; only the PROP changed.
  const sessionId = session.id;
  const agent = session.agent;
  const { bindings } = useKeybindings();
  const sendChord = formatChord(bindings.send);
  // Only a session with a checkout and a handler that can open one has any use for the
  // listing; without both, a path in the prose stays the text the agent typed.
  const filePaths = useWorkspacePaths(files, sessionId, Boolean(session.cwd && onOpenFile));
  // ConsoleDetail builds `onOpenFile` as a fresh closure every render, and `Markdown` is
  // memoized on its props, including
  // this one, because it must be: a skipped render leaves the rendered anchors calling
  // the previous closure, which carries App's active layout and sessions. Handing the same
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
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ text: string; ok: boolean } | null>(null);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  /**
   * Find-in-conversation. `null` is closed, and closed means the rail is not mounted
   * at all - see `ConversationFind` for why that is the invariant rather than a
   * detail. The query survives a close/reopen the way a browser's find does.
   */
  const [find, setFind] = useState<FindState | null>(null);
  /**
   * The narrow layout's Observed-activity disclosure. Closed by default because the
   * rail is ambient rather than asked for: a narrow card's height belongs to the
   * transcript until the reader chooses otherwise. Wide layouts ignore this - the
   * stylesheet shows the list and hides the toggle above the container breakpoint.
   */
  const [activityOpen, setActivityOpen] = useState(false);
  /**
   * Which of the secondary rail's two tabs is up. Held HERE rather than in the rail so
   * it survives find: find unmounts the rail entirely while it owns the column, and a
   * reader who was working through their own messages should get that list back when
   * they close it, not be silently returned to Activity.
   */
  const [railTab, setRailTab] = useState<ActivityTab>("activity");
  /**
   * The turn the "Yours" rail last jumped to.
   *
   * The nonce is what makes clicking the SAME row twice work: keyed on the id alone the
   * state would be unchanged, so the effects below would not re-run and the second click
   * would do nothing at all for a reader who had scrolled away since the first. With it,
   * the log re-centres on the turn and the flash's timer starts again.
   */
  const [jump, setJump] = useState<{ id: string; nonce: number } | null>(null);
  /**
   * The turn currently flashing, cleared on a timer.
   *
   * The two ends of a jump are deliberately different: the RAIL row stays marked, because
   * "which message am I reading?" stays true, while the TURN only flashes, because the
   * log is a conversation and a turn wearing a permanent ring would read as a state the
   * message is in rather than as somewhere the reader was just taken.
   */
  const [flashedTurnId, setFlashedTurnId] = useState<string | null>(null);
  const turnFlashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /**
   * WHY this session cannot be replied to, when it cannot: the reason behind `canSend`.
   *
   * Read off the session rather than taken as a prop, because `canSend` is the boolean every
   * host already computes from the same fact (`canMessage`) and threading a second prop
   * beside it would let a host pass a reason that disagrees with its own gate. Null on every
   * session that can be replied to, which is the overwhelmingly common case.
   */
  const block = messageBlockReason(session);
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

  /**
   * The conversation as a person should READ it, derived from `messages` and never stored.
   *
   * Everything below this line is a display consumer and takes this array; everything that
   * touches the transcript as a FILE - the SSE merge, the history cache, `loadOlder`, and
   * the byte offsets both of those carry - keeps taking `messages`. Paging anchors describe
   * native transcript bytes, so a projection that reached them would couple resume
   * correctness to how many rows happen to be visible.
   *
   * Today this substitutes the human task request for a Mission Control launch contract.
   * See `projectLaunchPresentation` for why that has to happen exactly once, here, rather
   * than inside the turn component.
   */
  const visible = useMemo(() => projectLaunchPresentation(messages), [messages]);
  /**
   * The conversation as rows, computed once and shared by the renderer and the
   * search. Both MUST walk the same list: hits are addressed by row id and offset,
   * so a search over a differently-folded list would highlight the wrong span.
   */
  const rows = mergeConversation(transcriptRows(visible), episodes, reviews);
  const agentLabel = AGENT_IDENTITY[agent].speaker;
  /**
   * What the turn currently arriving is doing, or null when nothing is arriving.
   *
   * The log's rows are the record - turns that were written and read back out of a
   * transcript file. This one line is not in that record and never will be: it is the
   * agent's own report of the step it is on, and the next real turn overwrites it. That
   * is exactly why it belongs at the tail rather than in a band above the pane, and why
   * it is drawn as provisional rather than as another turn.
   *
   * It is NOT the "Observed activity" rail beside this log. That rail is derived from
   * `messages` and lists invocations the transcript recorded, claiming nothing about
   * whether any of them is still running; this is the live report and claims exactly
   * that, for one step, from the session rather than from the log.
   */
  const inProgress = liveActivity(session);
  /**
   * Which rendering this conversation is drawn in - the shipped chat log, or the Native
   * PTY terminal stream. One resolved answer, from one module: this session's own
   * override if it has one, the daemon-stored default otherwise.
   *
   * It changes only the DRAWING. Everything below this line - the stream, the paging, the
   * find state, the pending turns, the composer's draft and attachments - is shared, and
   * that is the whole design: a second conversation implementation is how the two would
   * drift apart on the next fix that only landed in one of them.
   */
  const { view } = useSessionConversationView(sessionId);
  const terminal = view === "terminal";
  // The prompt's `~/leaf`, not the whole checkout: a worktree path is 60 characters of
  // pool bookkeeping and the strip directly above already prints it in full. `promptPath`
  // owns the whole displayed string, prefix included - see its note on why a leaf plus a
  // renderer that adds `~/` is the wrong split.
  const promptCwd = promptPath(session.cwd);

  // Derived, never stored. A streamed turn arriving re-runs the search, which is what
  // keeps the count honest as the conversation grows underneath an open find.
  // Searched with the text the CURRENT rendering puts on screen. The terminal record
  // shows a call's literal input where a chat chip shows the capped summary, so the two
  // renderings have different visible text for the same call - and this module's whole
  // contract is that what is counted is what can be seen.
  const allHits = find
    ? collectHits(
        rows,
        find.query,
        { caseSensitive: find.caseSensitive },
        agentLabel,
        terminal ? toolLineText : toolSearchText,
      )
    : [];
  const hits = find ? hitsInScope(allHits, find.scope) : [];
  // Clamped on read rather than stored clamped: the hit list changes shape as the
  // query, the scope, and the transcript itself move, and a stored index that outlived
  // its list is how a "current" ring ends up pointing at nothing.
  const hitIndex = hits.length === 0 ? -1 : Math.min(find?.index ?? 0, hits.length - 1);
  const current: FindHit | null = hitIndex < 0 ? null : (hits[hitIndex] ?? null);
  const currentKey = current?.key ?? null;

  // Bring the current match into view. Instant, not smooth: a browser's find does not
  // animate, and stepping quickly through matches with Enter outruns a 250ms animation
  // so the view lands somewhere between two hits.
  useEffect(() => {
    if (!currentKey) return;
    const el = logRef.current?.querySelector(`[data-find-key="${CSS.escape(currentKey)}"]`);
    el?.scrollIntoView({ block: "center" });
  }, [currentKey]);

  /**
   * Bring a turn the rail selected into view.
   *
   * Queried out of the DOM rather than held in a ref map, for the reason the episode
   * jump already gives: the target may not be mounted. Both conversation renderings tag
   * their turn roots with `data-turn-id`, so this one effect serves the chat log and the
   * terminal rendering without knowing which is up.
   *
   * `block: "center"` and instant, matching find's jump: the reader asked to land on a
   * message and read what surrounds it, which is the entire point of indexing rather
   * than filtering. A passive effect, not a layout one, so it runs AFTER the tail-follow
   * layout effect and wins the tick they both fire on - the same ordering find relies on.
   */
  useEffect(() => {
    if (!jump) return;
    const el = logRef.current?.querySelector(`[data-turn-id="${CSS.escape(jump.id)}"]`);
    el?.scrollIntoView({ block: "center" });
  }, [jump, terminal]);

  /**
   * Flash the turn that was jumped to, then let it settle back into the conversation.
   *
   * Separate from the scroll above so that switching rendering mid-read re-centres the
   * turn without re-flashing it: the reader did not ask to be taken anywhere the second
   * time. The timer is cleared and restarted per jump, so a run of quick clicks leaves
   * exactly one turn flashing rather than several fading at once.
   *
   * The rewind is what makes a SECOND click on the same row flash again. Setting the id
   * it already holds is a state update React bails on, so the class never leaves the DOM
   * and the CSS animation - which only replays when the class is removed and re-added -
   * would sit at its faded end state while the timer quietly extended. Rewinding the
   * running animation instead restarts the ring without a re-render, without the class
   * flicker a clear-then-set would cost, and without remounting the turn. It finds
   * nothing on a first click, which is correct: there is no animation yet, and applying
   * the class below starts one.
   */
  useEffect(() => {
    if (!jump) return;
    const el = logRef.current?.querySelector(`[data-turn-id="${CSS.escape(jump.id)}"]`);
    for (const animation of el?.getAnimations() ?? []) animation.currentTime = 0;
    setFlashedTurnId(jump.id);
    if (turnFlashTimer.current) clearTimeout(turnFlashTimer.current);
    turnFlashTimer.current = setTimeout(() => {
      turnFlashTimer.current = null;
      setFlashedTurnId(null);
    }, TURN_FLASH_MS);
  }, [jump]);

  useEffect(
    () => () => {
      if (turnFlashTimer.current) clearTimeout(turnFlashTimer.current);
    },
    [],
  );

  // Registered the same way the launchers are: App holds a per-session map and reaches
  // the mounted panel through it. Deregistering on unmount is what stops the chord from
  // opening find on a card that has since collapsed.
  const registerFindRef = useRef(registerFind);
  registerFindRef.current = registerFind;
  useEffect(() => {
    const reg = registerFindRef.current;
    if (!reg) return;
    reg(sessionId, { open: () => setFind((f) => f ?? FIND_INITIAL) });
    return () => reg(sessionId, null);
  }, [sessionId]);

  function closeFind(): void {
    setFind(null);
    // Hand the keyboard back to the grid rather than leaving focus on a box that no
    // longer exists.
    logRef.current?.focus?.();
  }

  function stepFind(direction: 1 | -1): void {
    setFind((f) => (f ? { ...f, index: stepIndex(hits.length, hitIndex, direction) } : f));
  }

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
  // boolean rather than assumed: the detail may have another tab mounted and must know
  // whether to fall back to its own send box.
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
    openFind: () => {
      // Reopening keeps the last query, like a browser - `ConversationFind` selects it
      // on mount so typing replaces it.
      setFind((f) => f ?? FIND_INITIAL);
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
   *
   * `inProgress` is a dependency for the same reason the other two are: it is a row in this
   * log, so it changes `scrollHeight` when it appears and when it goes.
   *
   * Measured honestly, it is currently redundant - and listed anyway. An activity change
   * can only reach the browser as a whole-session upsert, and `session.pendingTurns` is
   * re-parsed to a fresh array by every one of those, so the entry beside it already
   * re-runs this effect on the same tick. That is an accident of the transport, not a
   * contract: the day anything memoizes that array, or hands back the same empty one, the
   * masking goes with it and a reader pinned to the bottom starts drifting off by a row
   * with nothing else in the log having moved. An effect that follows the log's height
   * should say which of its own values changes that height.
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
  }, [messages, session.pendingTurns, inProgress]);

  // Deliberately don't grab focus when the panel opens. Focus mode is opened with
  // `e` and closed with `e`, and the app's global keys (including that toggle)
  // stand down while a text field is focused - so auto-focusing the reply box
  // would swallow the close press. The reader stays on the detail; one click on
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

  async function recall(turn: PendingTurn): Promise<void> {
    const input = inputRef.current;
    if (!input || pendingAction) return;
    if (input.value.length > 0 || attachments.length > 0) {
      showFlash({ text: "Clear the current reply before editing a queued message.", ok: false }, 3500);
      return;
    }
    setPendingAction(turn.id);
    const result = await recallPendingTurnIntoDraft({
      client: api,
      sessionId,
      turn,
      restore: (text) => {
        input.value = text;
        writeDraft(sessionId, "reply", text);
        input.focus();
        input.setSelectionRange(text.length, text.length);
      },
    });
    setPendingAction(null);
    if (!result.ok) {
      showFlash({ text: result.error ?? "That message is no longer editable.", ok: false }, 3500);
      return;
    }
    if (result.acknowledgementLost) {
      showFlash(
        {
          text: RECALL_ACKNOWLEDGEMENT_LOST_MESSAGE,
          ok: false,
        },
        6000,
      );
    }
  }

  async function retry(turn: PendingTurn): Promise<void> {
    if (pendingAction) return;
    setPendingAction(turn.id);
    const result = await api.retryPendingTurn(sessionId, turn.id, turn.revision);
    setPendingAction(null);
    if (!result.ok) showFlash({ text: result.error ?? "Retry failed.", ok: false }, 3500);
  }

  async function markSent(turn: PendingTurn): Promise<void> {
    if (pendingAction) return;
    setPendingAction(turn.id);
    const result = await api.resolvePendingTurn(sessionId, turn.id, turn.revision);
    setPendingAction(null);
    if (!result.ok) showFlash({ text: result.error ?? "Could not resolve message.", ok: false }, 3500);
  }

  const latestEditable = latestEditablePendingTurn(session.pendingTurns);

  /**
   * The conversation itself - the log and the box you answer it in.
   *
   * Held in a variable rather than duplicated down two branches so the terminal frame can
   * wrap exactly this, and so there is no chance of a fix landing on one rendering's copy
   * of the composer and not the other's.
   */
  const conversation = (
    <>
      {/* The split's secondary column has exactly one owner at a time: find while it
          is open, Observed activity otherwise. Both render at the same width, so the
          takeover and the restore never reflow the conversation being read - and the
          log element itself stays mounted throughout, so the reader's scroll position
          survives the swap. */}
      <div className="find-split" data-find={find ? "open" : "closed"}>
        <div className="find-logwrap">
          {find && (
            <ConversationFindBar
              query={find.query}
              onQuery={(query) => setFind((f) => (f ? { ...f, query, index: 0 } : f))}
              caseSensitive={find.caseSensitive}
              onCaseSensitive={(caseSensitive) =>
                setFind((f) => (f ? { ...f, caseSensitive, index: 0 } : f))
              }
              hits={hits}
              index={hitIndex}
              onStep={stepFind}
              onClose={closeFind}
            />
          )}
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
        {status !== "unavailable" && rows.length === 0 && (
          <p className="transcript-empty">{status === "connecting" ? "Loading…" : "No messages yet."}</p>
        )}
        {rows.map((row) =>
              row.kind === "episode" ? (
                <div
                  key={`ep-${row.episode.id}`}
                  className="transcript-episode"
                  data-episode-marker={row.episode.marker}
                >
                  <ForemanEpisodeCard episode={row.episode} absoluteTime />
                </div>
              ) : row.kind === "review" ? (
                <ReviewAnswerCard key={`rv-${row.review.id}`} review={row.review} />
              ) : row.kind === "tools" ? (
                terminal ? (
                  <TerminalToolRun
                    key={row.id}
                    tools={row.tools}
                    ts={row.ts}
                    endTs={row.endTs}
                    agentLabel={agentLabel}
                    find={findFor(hits, row.id, find?.query ?? "", currentKey)}
                  />
                ) : (
                  <ToolRun
                    key={row.id}
                    tools={row.tools}
                    ts={row.ts}
                    agentLabel={agentLabel}
                    find={findFor(hits, row.id, find?.query ?? "", currentKey)}
                  />
                )
              ) : terminal ? (
                <TerminalTurn
                  key={row.id}
                  m={row.message}
                  agentLabel={agentLabel}
                  cwd={promptCwd}
                  fullCwd={session.cwd}
                  onOpenFile={linkHandler}
                  filePaths={filePaths}
                  find={findFor(hits, row.id, find?.query ?? "", currentKey)}
                  flashed={row.id === flashedTurnId}
                />
              ) : (
                <Turn
                  key={row.id}
                  m={row.message}
                  agentLabel={agentLabel}
                  onOpenFile={linkHandler}
                  filePaths={filePaths}
                  find={findFor(hits, row.id, find?.query ?? "", currentKey)}
                  flashed={row.id === flashedTurnId}
                />
              ),
        )}
        {inProgress && (
          <InProgressRow agentLabel={agentLabel} activity={inProgress} terminal={terminal} />
        )}
        {/* AFTER the in-progress row, and the order is the conversation's own. A pending
            turn is a message the human has queued and the agent has NOT yet received; the
            row above is the step it is on right now. Drawn the other way round the queue
            would read as already answered - the log would show messages, then the work
            that supposedly followed them, when in fact that work is what has to finish
            before any of them is delivered. */}
        {session.pendingTurns.map((turn) => (
          <PendingTurnView
            key={turn.id}
            turn={turn}
            editable={latestEditable?.id === turn.id}
            busy={pendingAction === turn.id}
            onEdit={() => void recall(turn)}
            onRetry={() => void retry(turn)}
            onMarkSent={() => void markSent(turn)}
          />
        ))}
          </div>
        </div>
        {/* Sibling of the log wrapper, not a child of it: `.find-split` is the flex row
            that gives the rail its 244px column, and the container query that stacks it
            under the log at narrow widths flips THIS element's direction. Nested inside
            the wrapper the rail would sit above the conversation at every width. */}
        {find ? (
          <ConversationFindRail
            query={find.query}
            scope={find.scope}
            onScope={(scope) => setFind((f) => (f ? { ...f, scope, index: 0 } : f))}
            hits={hits}
            index={hitIndex}
            onJump={(i) => setFind((f) => (f ? { ...f, index: i } : f))}
            loadedOnly={canLoadOlder}
            onLoadOlder={() => void loadOlder()}
          />
        ) : (
          <ConversationActivity
            messages={visible}
            open={activityOpen}
            onToggle={() => setActivityOpen((v) => !v)}
            tab={railTab}
            onTab={(next) => {
              setRailTab(next);
              // Picking a tab reveals it. At rail widths the list is already showing and
              // this changes nothing; at narrow widths the list is behind the disclosure,
              // and choosing a tab whose contents stay hidden is a dead end - the reader
              // asked to see that list, which is the same request the caret makes.
              setActivityOpen(true);
            }}
            selectedTurnId={jump?.id ?? null}
            onSelectTurn={(id) => setJump((j) => ({ id, nonce: (j?.nonce ?? 0) + 1 }))}
          />
        )}
      </div>

      {/*
        An engine-driven session gets a SENTENCE where the box would be, not a disabled box.
        The two are different claims and the difference is the whole point of this phase: a
        greyed-out composer says "not right now", which is what a busy agent's looks like, and
        an operator waits for it to come back. This one never does - the process is running
        under `--print` and reads nothing at all - so the surface says who IS driving it and
        where to act instead. `messageBlockReason` decides; `canMessage` already refused the
        Send box, the mode picker and the work queue through the same fact.
      */}
      {block === "pipeline" && session.pipeline ? (
        <div className="transcript-compose">
          <p className="compose-notice">
            <span className="cn-glyph" aria-hidden>
              ⇶
            </span>
            {pipelineDrivenSentence(session.pipeline)}
            <Tooltip label="Open this pipeline in Runs - its steps, its gate verdicts, and what it is waiting on">
              <a className="cn-link" href={pipelineRunHash(session.pipeline)}>
                Open its run
              </a>
            </Tooltip>
          </p>
        </div>
      ) : (
      <div className="transcript-compose" {...drop.dropProps}>
        <AttachmentStrip attachments={attachments} onRemove={drop.remove} />
        <div className="compose-row">
          {/* Decorative, and marked as such: the box's accessible name stays its
              placeholder, which says what typing here does. A real `<label>` reading
              "mission (s) >" would replace that sentence with a prompt. The key is the
              resolved Send binding, not its default, so rebinding the focus action also
              updates this cue. */}
          <span className="pty-prompt" aria-hidden="true">
            {`mission${sendChord ? ` (${sendChord})` : ""} >`}
          </span>
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
                  : terminal
                    ? // The prompt metaphor, with the keys moved out to the hint beside the
                      // box the way a shell's own footer carries them. The two BLOCKED
                      // placeholders above are deliberately identical in both renderings:
                      // they are the reason you cannot type, and that reason is the same.
                      "Send the next instruction to this process…"
                    : "Reply to this session…  (Enter to send, Shift+Enter for newline, drop or paste images)"
            }
            rows={terminal ? 1 : 2}
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
              if (
                latestEditable &&
                shouldRecallPendingTurn({
                  key: e.key,
                  value: e.currentTarget.value,
                  selectionStart: e.currentTarget.selectionStart,
                  selectionEnd: e.currentTarget.selectionEnd,
                  composing: e.nativeEvent.isComposing,
                  modified: e.altKey || e.ctrlKey || e.metaKey || e.shiftKey,
                  busy: sending || pendingAction !== null,
                  hasAttachments: attachments.length > 0,
                })
              ) {
                e.preventDefault();
                void recall(latestEditable);
                return;
              }
              // The Enter that commits an IME candidate (Japanese/Chinese/Korean) is
              // the same keystroke as the one that sends, and the browser tells them
              // apart only by `isComposing`. Without this, picking a candidate fires
              // off the half-composed reply.
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              } else if (e.key === "Escape") {
                // Blur back to the grid so card keyboard nav (Enter to collapse) works.
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
          {/* The mockup's `enter sends`, carrying the two facts the terminal placeholder
              no longer has room for. Hidden at narrow container widths, where the box
              needs every pixel it can get - the keys still work, unannounced. */}
          {terminal && (
            <span className="pty-sendkey">enter sends · shift+enter newline · drop images</span>
          )}
        </div>
        {flash && (
          <span className={`action-flash${flash.ok ? " is-ok" : ""}`} role="status">
            {flash.text}
          </span>
        )}
        {drop.dropping && <div className="drop-veil">Drop images to attach</div>}
      </div>
      )}
    </>
  );

  return (
    // Stop clicks inside the panel from changing the selected session. The accent
    // is set here rather than per turn: every assistant byline in this log belongs to
    // the same harness, and the stylesheet then names no agent to colour them.
    <div
      className="transcript"
      data-view={view}
      style={agentAccentStyle(agent)}
      onClick={(e) => e.stopPropagation()}
    >
      {terminal ? (
        // A region rather than a bare div: the frame is a named part of the page, and
        // naming it is what lets a reader (and a browser test) address the terminal as
        // the thing it is rather than as "the div around the log".
        <section className="pty-frame" aria-label="Conversation terminal">
          <TerminalTitlebar session={session} attach={status} />
          {conversation}
          <TerminalStatusLine session={session} />
        </section>
      ) : (
        conversation
      )}
    </div>
  );
}

/**
 * The per-session rendering switch, at the head of the launcher run.
 *
 * A toggle BUTTON rather than a second radio group: there are two renderings and the
 * question at this level is "read this one differently", which is one press. `aria-pressed`
 * carries the state, so the control keeps one stable accessible name instead of relabelling
 * itself to the thing it is not currently showing - the relabelling toggle is the one every
 * screen reader user has to read twice.
 *
 * It sits beside the launchers because that strip is already the answer to "where am I and
 * how do I get at this session".
 *
 * Exported so ConsoleDetail can render it into the toolbar's `leading` slot. It takes its state as props and
 * holds none, so the caller's `useSessionConversationView` is still the single reader of
 * that module's map - which matters, because that hook notifies only its OWN caller. A
 * console-detail caller works because the panel re-renders as its child; a SIBLING of the
 * panel would set the override and leave the log drawn in the other rendering.
 */
export function ConversationViewToggle({
  terminal,
  overridden,
  onChange,
}: {
  terminal: boolean;
  overridden: boolean;
  onChange: (next: ConversationView) => void;
}): React.JSX.Element {
  return (
    <Tooltip
      label={
        terminal
          ? "Read this session as a chat log again"
          : "Read this session as a terminal stream - just this session, until you close the tab"
      }
    >
      <button
        type="button"
        className={`launch-btn conv-view-btn${overridden ? " is-overridden" : ""}`}
        aria-pressed={terminal}
        onClick={() => onChange(terminal ? "chat" : "terminal")}
      >
        <span className="launch-glyph-lead" aria-hidden>
          ▤
        </span>
        <span className="launch-word">Terminal view</span>
      </button>
    </Tooltip>
  );
}

/**
 * What one row needs to draw its share of an open search: the hits inside it, the
 * live query, and which hit is the current one. Null when find is closed, which is
 * what lets every row below take its pre-existing render path unchanged.
 */
interface RowFind {
  hits: FindHit[];
  query: string;
  currentKey: string | null;
  caseSensitive: boolean;
}

/**
 * Narrow the hit list to one row. Null when there is no search running.
 *
 * Takes the SCOPED hits, not every hit in the log. What is highlighted and what is
 * counted have to be the same set: fed the unscoped list, picking "You" would report a
 * count over user turns while the agent's turns stayed lit up, so the number on the bar
 * described a different search than the one on screen.
 */
function findFor(
  scoped: FindHit[],
  rowId: string,
  query: string,
  currentKey: string | null,
): RowFind | null {
  if (!query) return null;
  const hits = scoped.filter((h) => h.rowId === rowId);
  return { hits, query, currentKey, caseSensitive: false };
}

/**
 * Text with its matches wrapped in `<mark>`.
 *
 * Rendered as React children rather than by injecting elements into the DOM. The
 * design exploration did the latter, which is correct for a static page and wrong
 * here: React owns these nodes, so a streamed turn arriving would destroy injected
 * marks, and mutating React-owned children can trip the reconciler outright.
 *
 * `data-find-key` is what the scroll-into-view effect queries, so the anchor a jump
 * lands on is the very span being highlighted rather than the turn around it.
 */
function Highlighted({
  text,
  hits,
  currentKey,
}: {
  text: string;
  hits: FindHit[];
  currentKey: string | null;
}): React.JSX.Element {
  const segments = splitForHighlight(
    text,
    hits.map((h) => ({ start: h.start, end: h.end })),
  );
  return (
    <>
      {segments.map((seg, i) => {
        if (!seg.isMatch) return <span key={i}>{seg.text}</span>;
        const hit = hits.find((h) => h.start === seg.start);
        const isCurrent = hit != null && hit.key === currentKey;
        return (
          <mark
            key={i}
            className={`find-hit${isCurrent ? " is-current" : ""}`}
            data-find-key={hit?.key}
          >
            {seg.text}
          </mark>
        );
      })}
    </>
  );
}

/**
 * The turn currently arriving, at the tail of the log where it is arriving.
 *
 * This is the typing-indicator position and it is the honest one: the line describes work
 * that is happening after everything above it and before anything below, which is a claim
 * only the tail can make. Held above the pane - where it used to live - it was a fixed
 * band of chrome that said the same thing about a place the reader was not looking, and
 * cost the conversation 36px whether or not anything was running.
 *
 * Three deliberate shapes:
 *
 * - **One line, clipped.** Not a style preference. The log follows its tail only while the
 *   reader is within 48px of the bottom (`onScroll`), so a row that could wrap to two or
 *   three lines would appear under a bottom-pinned reader, push them past that threshold,
 *   and stop the pane following the conversation - the exact failure this row exists at
 *   the bottom to avoid. The full text rides the tooltip's always-rendered copy, so
 *   clipping costs nothing that cannot be read.
 * - **Not a turn.** No bubble, no timestamp, no find highlighting: those belong to rows
 *   that came out of a transcript and can be searched, quoted and scrolled back to. This
 *   one is a report about the present that the next real turn overwrites, so it is drawn
 *   as provisional - muted text, the working tone reserved for the marker.
 * - **Not announced.** No `role="status"`, on purpose. A busy agent rewrites this line
 *   every few seconds, and a live region here would read every one of them over the turns
 *   actually arriving in the same log. The text is in the document for anyone reading the
 *   log, and the tooltip's hidden copy says what it is.
 *
 * The terminal drawing gives the log a different rhythm - no flex gap, a 24px inset, and a
 * spine with a node per entry - so there the row takes `.pty-entry` and joins the stream.
 * Found in the browser: without it the row sat flush against the last entry and two dozen
 * pixels to the left of everything else, reading as a stray line from another component.
 * Taking the existing class rather than restating its four rules is also what keeps the
 * spine's `:last-child` treatment landing on the row that is actually last.
 */
function InProgressRow({
  agentLabel,
  activity,
  terminal,
}: {
  agentLabel: string;
  activity: string;
  terminal: boolean;
}): React.JSX.Element {
  return (
    <Tooltip
      label={`What ${agentLabel} reports it is doing right now: ${activity}. A live report from the session, not a turn the transcript recorded - the next real turn replaces it.`}
    >
      <p className={terminal ? "turn-progress pty-entry" : "turn-progress"}>
        {/* The log's own byline class, so the row reads in the same rhythm as the turns
            above it. It does NOT take `.turn-assistant`, so the name stays dim rather than
            picking up the agent's accent: this line is provisional, and the accent is how
            the log marks what the agent actually said. */}
        <span className="turn-role turn-progress-who">{agentLabel}</span>
        <span className="turn-progress-glyph" aria-hidden>
          ⟳
        </span>
        <span className="turn-progress-text">{activity}</span>
      </p>
    </Tooltip>
  );
}

export function PendingTurnView({
  turn,
  editable,
  busy = false,
  onEdit,
  onRetry,
  onMarkSent,
}: {
  turn: PendingTurn;
  editable: boolean;
  busy?: boolean;
  onEdit?: () => void;
  onRetry?: () => void;
  onMarkSent?: () => void;
}): React.JSX.Element {
  return (
    <div className={`turn turn-user pending-turn is-${turn.state}`} data-pending-state={turn.state}>
      <div className="turn-role pending-turn-role">
        <span>You</span>
        <span className="pending-turn-state" role="status">
          {pendingTurnStatus(turn)}
        </span>
      </div>
      <div className="turn-text">{turn.text}</div>
      <div className="pending-turn-actions">
        {turn.state === "queued" && editable && (
          <Tooltip label="Move this queued message back into the reply box">
            <button type="button" className="pending-turn-action" disabled={busy} onClick={onEdit}>
              Edit
            </button>
          </Tooltip>
        )}
        {turn.state === "uncertain" && (
          <>
            <Tooltip label="Queue this message again because it was not delivered">
              <button type="button" className="pending-turn-action" disabled={busy} onClick={onRetry}>
                Retry
              </button>
            </Tooltip>
            <Tooltip label="Remove this warning because the agent already received the message">
              <button type="button" className="pending-turn-action" disabled={busy} onClick={onMarkSent}>
                Mark sent
              </button>
            </Tooltip>
          </>
        )}
        {turn.state === "queued" && editable && (
          <span className="pending-turn-hint">Up Arrow in an empty reply box</span>
        )}
        {turn.lastError && <span className="pending-turn-error">{turn.lastError}</span>}
      </div>
    </div>
  );
}

function Turn({
  m,
  agentLabel,
  onOpenFile,
  filePaths,
  find,
  flashed,
}: {
  m: TranscriptMessage;
  agentLabel: string;
  onOpenFile?: WorkspaceLinkHandler;
  filePaths?: ReadonlySet<string> | null;
  find?: RowFind | null;
  /** The "Yours" rail just jumped here, so say so briefly. */
  flashed?: boolean;
}): React.JSX.Element {
  const [richText] = useRichText();
  const textHits = find ? find.hits.filter((h) => h.toolIndex === null) : [];
  // A turn the human didn't type says who did. Much of the "user" side of a supervised
  // session is Foreman delivering work or the dashboard reloading skills, and reading
  // those back as "you" makes the log claim the human asked for things they never asked
  // for - while hiding the machinery that did.
  const who = turnWho(m, agentLabel);
  /**
   * A turn that CONTAINS matches renders its literal text while find is open, even
   * with markdown on. Offsets are computed over `m.text`, and parsed markdown is a
   * different string - the syntax characters are gone - so a highlight placed by
   * source offset would land beside the match or on nothing at all. Rendering the
   * bytes the match was found in is the only way every counted match is also a
   * visible one, which is the property the whole count depends on.
   *
   * Scoped to matching turns rather than the whole log, so typing into find does not
   * reflow a conversation wholesale: the turns you are not being sent to keep their
   * formatting.
   */
  const highlight = textHits.length > 0;
  return (
    // An `article`, matching what the terminal rendering has always drawn a turn as: one
    // turn is a self-contained composition, and having both renderings say so means a
    // reader - or a test - can address "the turn holding this message" without reaching
    // for a class. `data-turn-id` is what the rail's jump effect queries, so a click on a
    // row lands on the turn itself rather than on the nearest thing carrying an id.
    //
    // Named by its author, which is what the ARIA feed pattern asks of an article in a
    // stream of them: unnamed, every turn announces as a bare "article" and a reader
    // moving between them is told nothing about which is which. The name is the byline
    // already drawn below, so it repeats one word rather than the message.
    <article
      className={`turn turn-${m.origin ?? m.role}${flashed ? " is-flashed" : ""}`}
      aria-label={who}
      data-turn-id={m.id}
    >
      {/* Not searched: a byline is chrome, not conversation. Were it included,
          "you" would match the label above every message the human ever sent. */}
      <div className="turn-role">
        {who}
        <ConversationTimestamp at={m.ts} className="turn-time" />
      </div>
      {m.text && (
        // Formatted turns still wear `turn-text` - the bubble's colour, padding, and per-role
        // tint are the same either way. Only what's inside it changes, and `markdown` swaps
        // the `pre-wrap` raw text for parsed blocks.
        <div className={`turn-text${richText && !highlight ? " markdown" : ""}`}>
          <TurnProse
            text={m.text}
            hits={textHits}
            currentKey={find?.currentKey ?? null}
            richText={richText}
            onOpenFile={onOpenFile}
            filePaths={filePaths}
          />
        </div>
      )}
      {m.tools.length > 0 && <ToolChips tools={m.tools} find={find} />}
    </article>
  );
}

/**
 * One turn's words: the literal bytes while a match is being highlighted inside them,
 * parsed markdown when formatting is on, and the raw text otherwise.
 *
 * Shared by both renderings rather than written twice, because the middle branch is the
 * subtle one (see `Turn`'s note on source offsets) and a terminal copy of it would be a
 * second place for that rule to be got wrong. The wrapper element differs between the two
 * - a bubble there, a stdout block here - so only the CONTENTS live here.
 */
function TurnProse({
  text,
  hits,
  currentKey,
  richText,
  onOpenFile,
  filePaths,
}: {
  text: string;
  hits: FindHit[];
  currentKey: string | null;
  richText: boolean;
  onOpenFile?: WorkspaceLinkHandler;
  filePaths?: ReadonlySet<string> | null;
}): React.JSX.Element {
  if (hits.length > 0) return <Highlighted text={text} hits={hits} currentKey={currentKey} />;
  if (richText) {
    return (
      <Markdown breaks onLinkClick={onOpenFile} filePaths={filePaths}>
        {text}
      </Markdown>
    );
  }
  return <>{text}</>;
}

/**
 * A run of back-to-back tool-only turns, on one line. Reads as a single sentence -
 * "claude executed  bash ls  bash wc" - because to the person watching, that's what
 * it was: one stretch of the agent working, not a dozen turns worth a header each.
 */
function ToolRun({
  tools,
  ts,
  agentLabel,
  find,
}: {
  tools: ToolCall[];
  /** Start of the folded run: transcriptRows deliberately keeps its first turn's time. */
  ts: number;
  agentLabel: string;
  find?: RowFind | null;
}): React.JSX.Element {
  return (
    <div className="turn turn-assistant turn-toolrun">
      <div className="turn-role">{agentLabel} executed</div>
      <ToolChips tools={tools} find={find} />
      {/* The same byline time as a prose turn, but a child of the row rather than of the
          label: a folded run lays its label and its chips along one line, so the right
          edge the timestamp is pinned to belongs to the row, not to the byline. */}
      <ConversationTimestamp at={ts} className="turn-time" />
    </div>
  );
}

/**
 * One turn, drawn as terminal traffic: what you typed is a prompt line, what the agent
 * said is stdout under a speaker header.
 *
 * The split is on ROLE, not on authorship, because that is what the metaphor is about -
 * input versus output. Who typed the input is still said: `turnWho` decides the host part
 * exactly as it decides the chat byline, so a turn Foreman sent reads `foreman@mission`
 * and never claims the operator asked for it.
 */
function TerminalTurn({
  m,
  agentLabel,
  cwd,
  fullCwd,
  onOpenFile,
  filePaths,
  find,
  flashed,
}: {
  m: TranscriptMessage;
  agentLabel: string;
  /** The prompt's working directory as it is DRAWN - `~/leaf`, or `~` with no checkout. */
  cwd: string;
  /** The whole path the leaf above stands for, for the tooltip. */
  fullCwd: string | null;
  onOpenFile?: WorkspaceLinkHandler;
  filePaths?: ReadonlySet<string> | null;
  find?: RowFind | null;
  /** The "Yours" rail just jumped here, so say so briefly. */
  flashed?: boolean;
}): React.JSX.Element {
  const [richText] = useRichText();
  const textHits = find ? find.hits.filter((h) => h.toolIndex === null) : [];
  const who = turnWho(m, agentLabel);
  const currentKey = find?.currentKey ?? null;
  // Tagged in BOTH renderings, and with the same attribute: the terminal view is the
  // shipped default, so a rail that could only jump in chat mode would not work for most
  // readers most of the time.
  if (m.role === "user") {
    const foreman = m.origin === "foreman";
    return (
      <article
        className={`pty-entry pty-user${foreman ? " pty-foreman" : ""}${flashed ? " is-flashed" : ""}`}
        aria-label={who}
        data-turn-id={m.id}
      >
        <p className="pty-commandline">
          {/* A shell host is one token, so a two-word author becomes one: "mission
              control" is `mission-control@mission`, the same name the titlebar uses. */}
          <span className="pty-host">{who.replace(/\s+/g, "-")}@mission</span>
          {/* `~/leaf` is the shell's own shorthand and the shape the mockup drew, which
              means it is short by leaving something out. The whole path is one hover
              away, so the abbreviation never has to be taken at face value. Rendered
              verbatim: `promptPath` has already decided whether there is a leaf to show. */}
          <Tooltip label={fullCwd ?? "this session has no checkout"}>
            <span className="pty-cwd">{cwd}</span>
          </Tooltip>
          <span className="pty-caret" aria-hidden="true">
            ❯
          </span>
          {/* Never markdown, whatever the formatting preference says: this is the command
              line, and a command line shows what was typed. Highlighting still applies -
              a match must be visible wherever it was counted. */}
          {!foreman && (
            <span className="pty-command">
              {textHits.length > 0 ? (
                <Highlighted text={m.text} hits={textHits} currentKey={currentKey} />
              ) : (
                m.text
              )}
            </span>
          )}
          {!foreman && <ConversationTimestamp at={m.ts} className="pty-time" />}
        </p>
        {foreman && (
          <ForemanTerminalMessage
            text={m.text}
            ts={m.ts}
            hits={textHits}
            currentKey={currentKey}
          />
        )}
        {m.tools.length > 0 && <ToolChips tools={m.tools} find={find} lines />}
      </article>
    );
  }
  const highlight = textHits.length > 0;
  return (
    <article
      className={`pty-entry pty-agent${flashed ? " is-flashed" : ""}`}
      aria-label={who}
      data-turn-id={m.id}
    >
      <header className="pty-speaker">
        {who} / stdout
        <ConversationTimestamp at={m.ts} className="pty-time" />
      </header>
      {m.text && (
        // Wears `turn-text` as well as `pty-copy`, which is what buys the whole markdown
        // stylesheet (`.turn-text.markdown pre`, tables, headings) for free rather than a
        // second copy of it under a terminal selector. `.pty-copy` then strips the bubble
        // the chat log wants and this one does not.
        <div className={`turn-text pty-copy${richText && !highlight ? " markdown" : ""}`}>
          <TurnProse
            text={m.text}
            hits={textHits}
            currentKey={currentKey}
            richText={richText}
            onOpenFile={onOpenFile}
            filePaths={filePaths}
          />
        </div>
      )}
      {/* Lines, like the folded record's - so EVERY tool call in this rendering is drawn
          the same way. Not a nicety: the panel searches this rendering with
          `toolLineText`, and a call drawn as a chip here would be searched over text it
          does not show. */}
      {m.tools.length > 0 && <ToolChips tools={m.tools} find={find} lines />}
    </article>
  );
}

/**
 * A Foreman-authored terminal turn.
 *
 * It remains input on the stream: the shell prompt above says where it went, and the
 * timeline node keeps its place among the surrounding traffic. The bounded panel only
 * changes how the machine-authored payload is read. Completion reviews use the fixed
 * template's real fields; every other message stays literal beneath the same provenance
 * header, so styling never invents a verdict Foreman did not make.
 */
function ForemanTerminalMessage({
  text,
  ts,
  hits,
  currentKey,
}: {
  text: string;
  ts: number;
  hits: FindHit[];
  currentKey: string | null;
}): React.JSX.Element {
  const review = parseForemanTerminalReview(text);
  const highlighted = hits.length > 0;
  return (
    <section className="pty-foreman-message" aria-label="Foreman message">
      <header className="pty-foreman-head">
        <span className="pty-foreman-mark" aria-hidden>◆</span>
        <span className="pty-foreman-badge">Foreman</span>
        <span className="pty-foreman-status">
          {review ? "review · needs work" : "automated turn"}
        </span>
        <ConversationTimestamp at={ts} className="pty-time" />
      </header>
      {highlighted ? (
        <div className="pty-foreman-copy">
          <Highlighted text={text} hits={hits} currentKey={currentKey} />
        </div>
      ) : review ? (
        <div className="pty-foreman-review">
          <p className="pty-foreman-intro">{review.intro}</p>
          <p className="pty-foreman-request">{review.request}</p>
          <p className="pty-foreman-summary">{review.summary}</p>
          <div className="pty-foreman-findings">
            {review.findings.map((finding) => (
              <section className="pty-foreman-finding" key={finding.number}>
                <header className="pty-foreman-finding-head">
                  <span>{finding.number}.</span>
                  <span className="pty-foreman-kind">[{finding.kind}]</span>
                  <strong>{finding.path}</strong>
                </header>
                <p>
                  <span>What&apos;s missing:</span> {finding.detail}
                </p>
                <p>
                  <span>Suggested fix:</span> {finding.fix}
                </p>
              </section>
            ))}
          </div>
          <p className="pty-foreman-safety">{review.safety}</p>
        </div>
      ) : (
        <div className="pty-foreman-copy">{text}</div>
      )}
    </section>
  );
}

/**
 * A folded run of tool-only turns, as a disclosure record under the output.
 *
 * Closed by default: the mockup's point is that a stretch of tool work is ONE event to
 * the person reading, and opening it is asking for the detail. Open, it lists the literal
 * command or path per call - `toolChip().title`, the same uncapped string the chat chip
 * puts in its tooltip - because a terminal record that named `bash` nine times would be
 * the very non-information the fold exists to delete.
 *
 * The trailing `· 1m 04s` is the span between the run's first and last turn, and appears
 * only when there is more than one turn and at least a second between them. It is NOT a
 * duration for any tool: nothing in the transcript records one, and the tooltip says which
 * of the two this number is.
 */
function TerminalToolRun({
  tools,
  ts,
  endTs,
  agentLabel,
  find,
}: {
  tools: ToolCall[];
  ts: number;
  endTs: number;
  agentLabel: string;
  find?: RowFind | null;
}): React.JSX.Element {
  const span = endTs > ts && ts > 0 ? endTs - ts : 0;
  // Open when it holds a match, because a closed record is not on screen: find counts a
  // hit the reader cannot see, and stepping onto it would scroll to nothing. Uncontrolled
  // otherwise - `open` as a starting state, so the reader's own click still wins.
  const hasHit = (find?.hits.length ?? 0) > 0;
  return (
    <details className="pty-toolrun" open={hasHit || undefined}>
      {/* One tooltip on the row rather than one per part: the span needs a sentence saying
          which of the two times it is, and a second bubble nested inside this one would
          fire under the same pointer. */}
      <Tooltip
        label={
          span >= 1000
            ? `Show the commands in this run · ${duration(span)} between its first and last call, which is not how long any of them took`
            : "Show the commands in this run"
        }
      >
        <summary>
          <b>
            {agentLabel} executed {tools.length} {tools.length === 1 ? "command" : "commands"}
          </b>
          {span >= 1000 && <span className="pty-span"> · {duration(span)}</span>}
          <ConversationTimestamp at={ts} className="pty-time" />
        </summary>
      </Tooltip>
      <ToolChips tools={tools} find={find} lines />
    </details>
  );
}

/**
 * The tool calls a row made, in one of two shapes.
 *
 * `chips` (the default) is the inline row the chat log has always drawn. `lines` is the
 * terminal record's list, one call per line with the literal input around the same target
 * span - and it is a VARIANT of this component rather than a component of its own on
 * purpose: hits are addressed by offset into `"<name> <detail>"`, and a second renderer
 * doing that arithmetic separately is how one of them ends up marking the wrong span.
 */
function ToolChips({
  tools,
  find,
  lines = false,
}: {
  tools: ToolCall[];
  find?: RowFind | null;
  lines?: boolean;
}): React.JSX.Element {
  // Tool calls are searchable because this is where the file paths are, and a path is
  // the single most likely thing to be looking for in an agent's transcript. The searched
  // string is the call AS RENDERED, so what matches is what the reader can see - which is
  // why the two variants search different strings: a chip shows the capped summary, a line
  // shows the literal input. `toolLineText`/`toolSearchText` are the same two projections
  // the panel hands `collectHits`, so a hit's offsets and these windows always agree.
  const matcher = find ? buildMatcher(find.query, { caseSensitive: find.caseSensitive }) : null;
  return (
    <div className={lines ? "turn-tools turn-tools-lines" : "turn-tools"}>
      {tools.map((t, i) => {
        // The name alone ("Bash", nine times over) is frame without content; the chip
        // carries what the call actually touched, and the line the literal input.
        const chip = toolChip(t);
        const chipHits = find ? find.hits.filter((h) => h.toolIndex === i) : [];
        // The one span after the name, and the ONE string it draws. Deliberately not the
        // chip's detail spliced into its own title: that split put text on screen which
        // no offset addressed, so `status --short` was readable in an opened record and
        // uncountable by find - the exact "a wrong number looks like a right one" failure
        // the find model exists to prevent.
        const target = lines ? toolLineTarget(t) : chip.detail;
        const searchText = lines ? toolLineText(t) : toolSearchText(t);
        const targetOffset = searchText.length - (target?.length ?? 0);
        // Hits are collected over "<name> <target>" but rendered as two spans, so each
        // is re-expressed in its own span's coordinates. `hitsInWindow` clips rather
        // than filters, which is what lets a match spanning the two - "read prompt" -
        // mark both halves instead of neither.
        const nameHits = hitsInWindow(chipHits, 0, chip.name.length);
        const targetHits = hitsInWindow(chipHits, targetOffset, searchText.length);
        const body = (
          <span className={`tool-chip${chipHits.length ? " has-find-hit" : ""}`}>
            <span className="tool-chip-name">
              {nameHits.length && matcher ? (
                <Highlighted text={chip.name} hits={nameHits} currentKey={find?.currentKey ?? null} />
              ) : (
                chip.name
              )}
            </span>
            {/* A real space, and only on a line. The chat chip separates its two spans with
                flex `gap`, which is a gap in the LAYOUT and not in the text - fine for a
                pill you read, wrong for a line you copy, which is the whole point of this
                record: `bash` and `git status --short` would come off the clipboard as
                `bashgit status --short`. Adding it in both variants would instead give the
                chip an anonymous flex item and a second gap. */}
            {lines && target && " "}
            {target &&
              (targetHits.length && matcher ? (
                <span className="tool-chip-detail">
                  <Highlighted
                    text={target}
                    hits={targetHits}
                    currentKey={find?.currentKey ?? null}
                  />
                </span>
              ) : (
                <span className="tool-chip-detail">{target}</span>
              ))}
          </span>
        );
        // No tooltip on a line: the line already shows what the chip's tooltip was for.
        return lines ? (
          <span key={`${t.name}-${i}`} className="tool-line">
            {body}
          </span>
        ) : (
          <Tooltip key={`${t.name}-${i}`} label={chip.title}>
            {body}
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
