// A comment being written, which is a DURABLE row from the first keystroke and not a
// string in this tab.
//
// That is `plan.md`'s decision and it is worth restating where it is implemented: the
// opening comment is an ordinary undelivered message, so it survives a reload, a crash and
// the extracted Files window being closed, and the person who wrote half a paragraph about
// line 84 still has it. It is also what makes the thread editable - the row is what the
// message-edit route edits - and what lets phase 3 tell a comment that was written from one
// that was submitted, because the status says so rather than the presence of text.
//
// So the composer's job is to keep one message row in step with a textarea:
//
//   first persistable keystroke -> create the thread and its opening message
//   every keystroke after       -> edit that message, debounced
//   Comment                     -> flush, then queue the thread at the tail
//   Cancel                      -> delete the thread, because nothing was ever submitted
//
// Every request is serialized through one chain. Typing produces more edits than the
// network can retire, and two overlapping writes on the same row can land in the order the
// daemon happened to see them rather than the order they were typed - which shows up as a
// comment that reverts a character while you watch it.
//
// **Two rules hold the asynchrony together, and both were bugs before they were rules.**
//
// 1. A composer CARRIES its target - session, path and revision - captured when it opened.
//    Reading those from a ref that tracks the currently selected file meant that typing a
//    character on file A and switching to file B before the debounce fired created the row
//    with B's path and A's line and quote: a comment filed against a file nobody wrote it
//    about, anchored to text that file does not contain.
// 2. Cancel resolves WHICH row to delete when its turn on the chain arrives, not when the
//    button is clicked. A cancel during the create request saw `threadId` still null, so it
//    deleted nothing and the create landed behind it - leaving a durable draft, and a marker
//    on the line, for a comment the reader had just discarded.
// 3. A queued write asks the same question - which row IS this composer's? - and for the
//    same reason. A composer closed while its create was in flight keeps a snapshot whose
//    `threadId` is null, because the patch that would have filled it in had nothing left to
//    patch. The follow-up write read that null as "no row yet" and created a SECOND one:
//    two durable drafts, two markers, on one line the reader commented on once. Both
//    questions are now answered by `draftKnownRow`, from the chain's own record of what the
//    create returned.
// 4. The record of what the daemon already holds names WHICH message it holds it for. It is
//    an optimisation - an unchanged body costs no request - and an optimisation that answers
//    for the wrong row is a dropped edit. One bare string, shared by every composer, meant
//    that draft A's create could leave A's body in it while the reader was already editing
//    draft B; typing that same sentence into B then looked like "no change" and B's message
//    was never written. Cheap to reason about, silent when wrong, and the failure is the
//    reader's words going missing - so it carries its owner now.

import { useCallback, useEffect, useRef, useState } from "react";
import type { CreateFileCommentBody } from "@shared/protocol.ts";
import type { FileCommentThread } from "@shared/types.ts";
import {
  createFileComment,
  deleteFileComment,
  editFileCommentMessage,
  queueFileComment,
} from "./api.ts";
import { anchorForLine, isPersistableBody, openingMessage } from "./fileComments.ts";

/** How long a keystroke waits before it becomes a request. */
export const FILE_COMMENT_DRAFT_DEBOUNCE_MS = 400;

export interface FileCommentComposerState {
  /**
   * Which composer this is. A monotonic counter, and the thing that makes "the thread this
   * composer created" answerable after the composer has closed - see `createdThreadId`.
   */
  instance: number;
  /**
   * Where this comment is being written, captured when the composer OPENED.
   *
   * Not read from the workspace's current selection at request time. See rule 1 above: the
   * selection can move between the keystroke and the request, and when it does, the request
   * must still describe the file the reader was looking at.
   */
  sessionId: string;
  path: string;
  revision: string | null;
  /** The line the person clicked - which is what the panel opens under. */
  line: number;
  /** The anchor the quote actually covers; wider than `line` only on a blank line. */
  startLine: number;
  endLine: number;
  quote: string;
  text: string;
  /** Null until the first persistable keystroke has been written. */
  threadId: string | null;
  messageId: string | null;
  busy: boolean;
  error: string | null;
}

/** The row one particular composer brought into being, as the create reported it. */
export interface CreatedDraftThread {
  instance: number;
  id: string;
  /** The opening message, which is what a later keystroke edits rather than recreates. */
  messageId: string | null;
}

export interface FileCommentDraftController {
  composer: FileCommentComposerState | null;
  /** Open a fresh composer on a line, or false when the file has no text to anchor to. */
  openLine: (line: number, text: string) => boolean;
  /** Reopen a thread that was never submitted. A draft IS its composer. */
  openDraft: (thread: FileCommentThread) => void;
  change: (value: string) => void;
  submit: () => void;
  cancel: () => void;
  /** Close without deleting - the row stays a draft, which is the point of it being one. */
  dismiss: () => void;
}

/**
 * The create request a composer describes, or null when there is nothing to write yet.
 *
 * Pure, exported and built from the composer ALONE, which is the whole point: there is no
 * argument here through which the currently selected file could reach the request. A test
 * can therefore state rule 1 directly - a composer opened on file A describes file A - and
 * the only way to break it again is to stop calling this.
 */
export function draftCreateRequest(
  composer: FileCommentComposerState,
): { sessionId: string; body: CreateFileCommentBody } | null {
  const body = composer.text.trim();
  if (!isPersistableBody(body)) return null;
  return {
    sessionId: composer.sessionId,
    body: {
      path: composer.path,
      startLine: composer.startLine,
      endLine: composer.endLine,
      quote: composer.quote,
      revision: composer.revision,
      surface: "editor",
      body,
    },
  };
}

/**
 * The durable row this composer already has, resolved from what is known WHEN IT RUNS.
 *
 * `composer.threadId` covers the settled case - a reopened draft, or one whose create came
 * back while the composer was still open. `created` covers rules 2 and 3: the create was in
 * flight when the composer closed, so it never learned its own id, and the chain has since
 * recorded what came back. Every later job on that chain - the delete a Cancel owes, the
 * write a dismiss owes - has to see the row rather than the null.
 *
 * The instance check is what keeps that from over-reaching. Without it, a draft DISMISSED on
 * one line (which creates a row and deliberately keeps it) followed by a new composer on
 * another would let the second's Cancel delete the first's perfectly good draft, and the
 * second's first keystroke edit it.
 */
export function draftKnownRow(
  composer: FileCommentComposerState,
  created: CreatedDraftThread | null,
): { threadId: string; messageId: string | null } | null {
  if (composer.threadId) return { threadId: composer.threadId, messageId: composer.messageId };
  if (created && created.instance === composer.instance) {
    return { threadId: created.id, messageId: created.messageId };
  }
  return null;
}

/** Which row a cancel has to delete - see `draftKnownRow`. */
export function draftThreadToDelete(
  composer: FileCommentComposerState,
  created: CreatedDraftThread | null,
): string | null {
  return draftKnownRow(composer, created)?.threadId ?? null;
}

/** What the daemon is known to hold, and for WHICH message it is known to hold it. */
export interface PersistedBody {
  /** The message the body belongs to, once there is one. */
  messageId: string | null;
  /** The composer that wrote it, which is the only key available before the create lands. */
  instance: number;
  body: string;
}

/**
 * The body an edit has to write, or null when there is nothing worth writing.
 *
 * Suppression is the point of this function and the danger in it. An unchanged body costs no
 * request, which matters because every keystroke asks - but "unchanged" is only meaningful
 * about the SAME message. See rule 4: a cache that answered for whichever composer last
 * spoke could tell composer B that B's new text was already saved, because A's create had
 * just put that same text in it.
 *
 * So the cached value counts only when it belongs here: same message id where there is one,
 * and before there is one, same composer.
 */
export function draftBodyToWrite(
  composer: FileCommentComposerState,
  known: { threadId: string; messageId: string | null },
  written: PersistedBody | null,
): string | null {
  const body = composer.text.trim();
  if (!isPersistableBody(body) || !known.messageId) return null;
  const ours = written !== null
    && (written.messageId === null
      ? written.instance === composer.instance
      : written.messageId === known.messageId);
  return ours && written.body === body ? null : body;
}

export function useFileCommentDraft(input: {
  sessionId: string;
  path: string | null;
  revision: string | null;
}): FileCommentDraftController {
  const [composer, setComposer] = useState<FileCommentComposerState | null>(null);
  const state = useRef<FileCommentComposerState | null>(null);
  state.current = composer;
  /**
   * The workspace's CURRENT selection. Read at exactly one moment - when a composer opens -
   * and never during a request. See rule 1 in this file's header.
   */
  const target = useRef(input);
  target.current = input;

  const instances = useRef(0);
  /** The thread the most recent composer created, so a cancel can still find it. */
  const createdThreadId = useRef<CreatedDraftThread | null>(null);
  /** The composer whose create has already been asked for, so only one ever is. */
  const createRequested = useRef<number | null>(null);
  /** What the daemon currently holds, so an unchanged body costs no request. */
  const written = useRef<PersistedBody | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const mounted = useRef(true);
  /** Set below, once `persist` exists; read only from the unmount cleanup. */
  const flushOnUnmount = useRef<(() => void) | null>(null);
  useEffect(() => () => {
    mounted.current = false;
    // A pending keystroke is still owed to the daemon. Leaving with the timer merely
    // cleared would drop the last few characters of a comment - which is precisely the
    // loss persisting from the first keystroke exists to prevent - and switching detail
    // tabs unmounts this, so it is the ordinary exit rather than a rare one.
    flushOnUnmount.current?.();
  }, []);

  const patch = useCallback((change: Partial<FileCommentComposerState>) => {
    if (!mounted.current) return;
    setComposer((previous) => (previous ? { ...previous, ...change } : previous));
  }, []);

  /** Every write on this composer, in the order it was asked for. */
  const enqueue = useCallback(<T,>(job: () => Promise<T>): Promise<T | null> => {
    const next = chain.current.then(job, job);
    chain.current = next.catch(() => undefined);
    return next as Promise<T | null>;
  }, []);

  /**
   * Bring the daemon's copy of the opening message up to the text in the given composer.
   *
   * Answers the thread id only when the daemon HOLDS that text - so a caller may treat an id
   * as permission to act on the row, and null as "not saved", whether that is because there
   * was nothing to write, because the create failed, or because the edit was refused.
   *
   * The snapshot is an argument rather than a read of the ref, because `dismiss` closes the
   * composer and persists what was in it - and by the time the queued job runs, the ref it
   * would otherwise read has already been cleared by that close.
   */
  const persist = useCallback(async (
    snapshot?: FileCommentComposerState | null,
  ): Promise<string | null> => {
    const current = snapshot === undefined ? state.current : snapshot;
    if (!current) return null;
    // Asked of the CHAIN, not of the snapshot: a composer closed mid-create carries a null
    // `threadId` that means "nobody told me", not "no row exists". See rule 3.
    const known = draftKnownRow(current, createdThreadId.current);
    if (!known) {
      const request = draftCreateRequest(current);
      if (!request) return null;
      const created = await createFileComment(request.sessionId, request.body);
      if (!created.ok) {
        patch({ error: created.error });
        return null;
      }
      written.current = {
        messageId: openingMessage(created.thread)?.id ?? null,
        instance: current.instance,
        body: request.body.body,
      };
      // Recorded BEFORE the React patch, and outside it: a cancel that ran while this
      // request was in flight has already closed the composer, so `patch` is a no-op and
      // this ref is the only remaining way to find the row it has to delete.
      createdThreadId.current = {
        instance: current.instance,
        id: created.thread.id,
        messageId: openingMessage(created.thread)?.id ?? null,
      };
      patch({
        threadId: created.thread.id,
        messageId: openingMessage(created.thread)?.id ?? null,
        error: null,
      });
      // The state ref is updated synchronously as well: the next queued job may run before
      // React has re-rendered, and it must not create a second thread for the same comment.
      // Guarded on the instance, so a composer that has since been closed and replaced is
      // not handed the previous one's thread.
      if (state.current?.instance === current.instance) {
        state.current = {
          ...state.current,
          threadId: created.thread.id,
          messageId: openingMessage(created.thread)?.id ?? null,
        };
      }
      return created.thread.id;
    }
    const body = draftBodyToWrite(current, known, written.current);
    if (body === null || !known.messageId) return known.threadId;
    const edited = await editFileCommentMessage(known.messageId, body);
    if (!edited.ok) {
      patch({ error: edited.error });
      // NULL, not the thread id. The row exists but the daemon does not hold what the reader
      // is looking at, and the caller cannot tell those apart from an id alone: `submit`
      // read one as "saved" and queued the previous body - sending the agent text the
      // reader had just replaced, with the correction sitting on screen looking submitted.
      // Nothing was written, so nothing is submittable; the composer keeps the error and
      // stays editable so the same click can be tried again.
      return null;
    }
    written.current = { messageId: known.messageId, instance: current.instance, body };
    patch({ error: null });
    return known.threadId;
  }, [patch]);

  flushOnUnmount.current = () => {
    if (!timer.current) return;
    clearTimeout(timer.current);
    timer.current = null;
    const pending = state.current;
    if (pending) void enqueue(() => persist(pending));
  };

  const openLine = useCallback((line: number, text: string): boolean => {
    const { sessionId, path, revision } = target.current;
    if (!path) return false;
    const anchor = anchorForLine(text, line);
    if (!anchor) return false;
    written.current = null;
    createdThreadId.current = null;
    createRequested.current = null;
    instances.current += 1;
    setComposer({
      instance: instances.current,
      sessionId,
      path,
      revision,
      line,
      startLine: anchor.startLine,
      endLine: anchor.endLine,
      quote: anchor.quote,
      text: "",
      threadId: null,
      messageId: null,
      busy: false,
      error: null,
    });
    return true;
  }, []);

  const openDraft = useCallback((thread: FileCommentThread) => {
    const opening = openingMessage(thread);
    instances.current += 1;
    // What the daemon holds for THIS message, which is exactly what the thread just said.
    written.current = opening
      ? { messageId: opening.id, instance: instances.current, body: opening.body }
      : null;
    // Its target comes from the THREAD, which is the record of where it was written, rather
    // than from the file that happens to be open now.
    createdThreadId.current = {
      instance: instances.current,
      id: thread.id,
      messageId: opening?.id ?? null,
    };
    // The row already exists, so no composer opened this way ever asks for a create.
    createRequested.current = instances.current;
    setComposer({
      instance: instances.current,
      sessionId: thread.sessionId,
      path: thread.path,
      revision: thread.revision,
      line: thread.startLine,
      startLine: thread.startLine,
      endLine: thread.endLine,
      quote: thread.quote,
      text: opening?.body ?? "",
      threadId: thread.id,
      messageId: opening?.id ?? null,
      busy: false,
      error: null,
    });
  }, []);

  const change = useCallback((value: string) => {
    // A submission in flight owns this composer. `FileCommentComposer` freezes its box, and
    // this is the same rule stated where the requests are: an edit accepted here would be
    // queued BEHIND the queue call and would rewrite a message the reader had submitted.
    if (state.current?.busy) return;
    patch({ text: value });
    if (state.current) state.current = { ...state.current, text: value };
    if (timer.current) clearTimeout(timer.current);

    /*
     * The FIRST persistable keystroke is written at once. Everything after it is debounced.
     *
     * "Durable from the first keystroke" was a promise with a 400ms hole in it: a reader who
     * typed a sentence and reloaded, closed the extracted window, or navigated inside that
     * window had begun no request at all, and the flush the unmount owes cannot outlive a
     * page that is already going away. The debounce exists to keep typing from becoming one
     * request per character - it was never meant to gate the row's existence.
     *
     * Guarded on the instance so it happens once per composer: a second keystroke arriving
     * while the create is still in the air must not start a second create. Once the chain
     * has the row, `draftKnownRow` turns every later write into an edit.
     */
    const current = state.current;
    const unwritten = current
      && !current.threadId
      && createdThreadId.current?.instance !== current.instance
      && createRequested.current !== current.instance;
    if (unwritten && isPersistableBody(value)) {
      createRequested.current = current.instance;
      timer.current = null;
      void enqueue(() => persist());
      return;
    }

    timer.current = setTimeout(() => {
      timer.current = null;
      void enqueue(() => persist());
    }, FILE_COMMENT_DRAFT_DEBOUNCE_MS);
  }, [enqueue, patch, persist]);

  const submit = useCallback(() => {
    const current = state.current;
    if (!current || current.busy || !isPersistableBody(current.text)) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    patch({ busy: true, error: null });
    // On the ref as well as in React: `change` and `cancel` are called from event handlers
    // that can run before this render lands, and both ask the ref whether the composer is
    // still the reader's to alter.
    state.current = { ...current, busy: true };
    void enqueue(async () => {
      const threadId = await persist(current);
      if (!threadId) {
        patch({ busy: false });
        return;
      }
      const queued = await queueFileComment(threadId);
      if (!queued.ok) {
        patch({ busy: false, error: queued.error });
        return;
      }
      if (mounted.current) setComposer(null);
    });
  }, [enqueue, patch, persist]);

  const cancel = useCallback(() => {
    const current = state.current;
    // Nothing to discard once it is on its way into the queue - see `change`.
    if (current?.busy) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setComposer(null);
    state.current = null;
    if (!current) return;
    // Nothing was ever submitted, so the row goes with the composer. Leaving it would put a
    // marker on the line for a comment the person just discarded.
    //
    // WHICH row is resolved inside the job, not here. The chain guarantees an in-flight
    // create has finished by the time this runs, and `createdThreadId` is where it left the
    // id the closed composer never got to see.
    void enqueue(async () => {
      const id = draftThreadToDelete(current, createdThreadId.current);
      if (!id) return;
      if (createdThreadId.current?.instance === current.instance) createdThreadId.current = null;
      await deleteFileComment(id);
    });
  }, [enqueue]);

  const dismiss = useCallback(() => {
    const current = state.current;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setComposer(null);
    state.current = null;
    if (current) void enqueue(() => persist(current));
  }, [enqueue, persist]);

  return { composer, openLine, openDraft, change, submit, cancel, dismiss };
}
