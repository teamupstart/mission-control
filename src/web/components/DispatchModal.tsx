import { useCallback, useEffect, useRef, useState } from "react";
import type { Task, TaskKind, AgentType } from "@shared/types.ts";
import { withAttachments } from "@shared/attachments.ts";
import { api, fetchRepos } from "../lib/api.ts";
import { RepoCombobox } from "./RepoCombobox.tsx";
import {
  AttachmentStrip,
  readyAttachments,
  revokeAttachments,
  useImageDrop,
  type PendingAttachment,
} from "./ImageDrop.tsx";
import { Overlay, OVERLAY_IDS } from "./Overlay.tsx";

/**
 * The form fields a dispatch carries. Held by `DispatchLayer` (not the modal) so
 * an accidental close - Escape, backdrop click, Cancel, or the ✕ - keeps a
 * half-written task around; the draft is wiped only once it's actually
 * dispatched or shelved, or when the footer's Clear discards it on purpose
 * (see EMPTY_DISPATCH_DRAFT).
 */
type DispatchDraft = {
  repoRoot: string;
  intent: string;
  title: string;
  kind: TaskKind;
  agent: AgentType;
  /** Images dropped on the task box; sent as paths appended to the intent. */
  attachments: PendingAttachment[];
};

const EMPTY_DISPATCH_DRAFT: DispatchDraft = {
  repoRoot: "",
  intent: "",
  title: "",
  kind: "ship",
  agent: "claude",
  attachments: [],
};

/** True when a draft holds nothing worth keeping - so "Clear" has nothing to do. */
function isEmptyDispatchDraft(d: DispatchDraft): boolean {
  return (
    !d.repoRoot.trim() &&
    !d.intent.trim() &&
    !d.title.trim() &&
    d.attachments.length === 0 &&
    d.kind === EMPTY_DISPATCH_DRAFT.kind &&
    d.agent === EMPTY_DISPATCH_DRAFT.agent
  );
}

/**
 * The same form, seeded from a task already sitting in the backlog.
 *
 * Attachments start empty rather than being reconstructed: an image attached earlier
 * is already IN the intent, as the path `withAttachments` appended, so the text box
 * carries it and there is nothing to restore. Anything dropped now appends to that
 * same tail on save.
 */
function draftFromTask(t: Task): DispatchDraft {
  return {
    repoRoot: t.repoRoot,
    intent: t.intent,
    title: t.title,
    kind: t.kind,
    agent: t.agent,
    attachments: [],
  };
}

/**
 * Which task the modal is over, when it is over one. `new` writes a task that does
 * not exist yet; `edit` rewrites one that is waiting in the backlog.
 */
type DispatchMode = { kind: "new" } | { kind: "edit"; task: Task };

/**
 * Field-by-field draft equality. A dispatch POST can resolve after the modal
 * instance that sent it is gone, so its resolve path hands back the draft it sent
 * and the owner compares: still the same draft means nothing newer to lose (see
 * onSubmitted).
 *
 * Attachments compare by identity rather than contents, because the question this
 * answers is "did the human add or drop an image since?" - and an upload landing
 * mid-flight rewrites the row without being an answer to it.
 */
function draftsEqual(a: DispatchDraft, b: DispatchDraft): boolean {
  return (
    a.repoRoot === b.repoRoot &&
    a.intent === b.intent &&
    a.title === b.title &&
    a.kind === b.kind &&
    a.agent === b.agent &&
    a.attachments.length === b.attachments.length &&
    a.attachments.every((att, i) => att.id === b.attachments[i]!.id)
  );
}

/**
 * Owns the dispatch draft and mounts the modal over it. Stays mounted whether or
 * not the modal is open, which is the whole point of the indirection:
 *  - the draft can't live in the modal, which unmounts on close and would take a
 *    half-written task with it;
 *  - it can't live in App either, where every keystroke would re-render the
 *    session grid - dozens of cards, each with an ActionBar - behind the backdrop
 *    where none of it can be seen. A child's state update doesn't re-render its
 *    parent, so parking the draft here keeps typing inside the modal subtree.
 *
 * The modal itself still mounts per open, so its fetch-repos and autofocus
 * effects run each time.
 *
 * TWO drafts, not one. `editTask` reopens this same form over a task already in the
 * backlog, and that working copy is kept in its own slot: a half-written new dispatch
 * must survive someone clicking a backlog card to check what they queued yesterday,
 * and it would not if the two shared a slot. Only one task is held at a time, though -
 * opening the editor on a different card seeds fresh from that card's stored row, so
 * an unsaved edit lives exactly as long as the operator keeps coming back to it.
 */
export function DispatchLayer({
  open,
  editTask,
  onClose,
}: {
  open: boolean;
  /** The backlog task being edited, or null for a fresh dispatch. */
  editTask: Task | null;
  onClose: () => void;
}): React.JSX.Element | null {
  const [draft, setDraft] = useState<DispatchDraft>(EMPTY_DISPATCH_DRAFT);
  // Read by the dispatch-accepted callback below, which can fire after the modal
  // instance that armed it is gone - a stale closure would compare against
  // whatever the draft held when that instance last rendered.
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // The working copy of the task being edited, if any. Seeded during render rather
  // than from an effect: an effect would show one frame of whatever the slot last
  // held - an empty form, or the PREVIOUS task's text - and a task whose intent
  // blinks blank is a task that looks like it lost its intent.
  const [edit, setEdit] = useState<{ id: string; draft: DispatchDraft } | null>(null);
  const editDraft = editTask
    ? edit?.id === editTask.id
      ? edit.draft
      : draftFromTask(editTask)
    : null;
  // The effective slot, refreshed every render, for the two callbacks below that can
  // fire long after the render that armed them.
  const editRef = useRef<{ id: string; draft: DispatchDraft } | null>(null);
  editRef.current = editTask && editDraft ? { id: editTask.id, draft: editDraft } : null;

  const onEditDraftChange = useCallback((next: DispatchDraft) => {
    const cur = editRef.current;
    if (cur) setEdit({ id: cur.id, draft: next });
  }, []);

  // A dispatch is accepted server-side. The reply to an async network POST can
  // land after the modal has been closed and reopened, so reconcile against what
  // the draft holds *now*, not against the instance that sent it:
  //  - unchanged since dispatch -> it's been consumed; clear and close, whether or
  //    not the modal is still open (a closed modal makes the close a no-op, and
  //    reopening shows an empty form instead of a ghost that invites a duplicate).
  //  - edited since dispatch -> that's newer input; keep it and leave the modal be.
  const onSubmitted = useCallback(
    (submitted: DispatchDraft) => {
      if (!draftsEqual(draftRef.current, submitted)) return;
      // The task has the paths now; these thumbnails are the last thing holding the
      // blobs. (The files themselves stay on the daemon - the agent hasn't read them
      // yet, and won't for as long as it takes to provision a worktree.)
      revokeAttachments(draftRef.current.attachments);
      setDraft(EMPTY_DISPATCH_DRAFT);
      onClose();
    },
    [onClose],
  );

  // The same reconciliation for a saved edit, against the edit slot. Dropping the slot
  // is what makes the next open re-read the row we just wrote, rather than re-showing
  // a working copy that is now merely a duplicate of it.
  const onEditSubmitted = useCallback(
    (submitted: DispatchDraft) => {
      const cur = editRef.current;
      if (!cur || !draftsEqual(cur.draft, submitted)) return;
      revokeAttachments(cur.draft.attachments);
      setEdit(null);
      onClose();
    },
    [onClose],
  );

  /**
   * Attachment writes go through a functional update with a STABLE identity, which
   * the other fields don't need and this one can't do without: an upload resolves
   * a network round-trip after the drop that started it, and patches its row from
   * a callback captured back then. Handed a plain `{...draft, attachments}` from
   * that render, a late upload would restore the intent as it read at drop time,
   * silently eating everything typed since.
   */
  const onAttachmentsChange = useCallback((attachments: PendingAttachment[]) => {
    setDraft((d) => ({ ...d, attachments }));
  }, []);

  /** The same, for the edit slot - where the ref, not a functional update, is what
   *  keeps a late upload from resurrecting the text as it read at drop time. */
  const onEditAttachmentsChange = useCallback((attachments: PendingAttachment[]) => {
    const cur = editRef.current;
    if (cur) setEdit({ id: cur.id, draft: { ...cur.draft, attachments } });
  }, []);

  if (!open) return null;
  if (editTask && editDraft) {
    return (
      <DispatchModal
        // Remounted per task, so the autofocus and repo-index effects run for each one
        // and the box you land in is that task's, not the previous card's.
        key={editTask.id}
        mode={{ kind: "edit", task: editTask }}
        draft={editDraft}
        onDraftChange={onEditDraftChange}
        onAttachmentsChange={onEditAttachmentsChange}
        onClose={onClose}
        onSubmitted={onEditSubmitted}
      />
    );
  }
  return (
    <DispatchModal
      mode={{ kind: "new" }}
      draft={draft}
      onDraftChange={setDraft}
      onAttachmentsChange={onAttachmentsChange}
      onClose={onClose}
      onSubmitted={onSubmitted}
    />
  );
}

/**
 * Launch (or shelve) a new agent: pick a repo, describe the task, and dispatch.
 * The daemon provisions an isolated worktree, opens a detached tmux session, and
 * injects the intent - the new session then appears on the grid on the next poll.
 *
 * Also the EDITOR for a task already in the backlog (`mode.kind === "edit"`), which
 * is the same form over a row that exists: shelved work is written here, so it is
 * read and corrected here too rather than through a second, thinner dialog that would
 * inevitably offer fewer fields than the one that created it. The verbs shift with the
 * mode - "Add to backlog" becomes "Save", "Clear" becomes "Revert" - and "Dispatch
 * now" means the same thing in both: this is ready, start it.
 *
 * The form values live in a draft on `DispatchLayer` so they survive close/reopen;
 * only the transient UI state (repo index, in-flight action, error) is local here.
 */
function DispatchModal({
  mode,
  draft,
  onDraftChange,
  onAttachmentsChange,
  onClose,
  onSubmitted,
}: {
  mode: DispatchMode;
  draft: DispatchDraft;
  onDraftChange: (draft: DispatchDraft) => void;
  onAttachmentsChange: (attachments: PendingAttachment[]) => void;
  onClose: () => void;
  onSubmitted: (submitted: DispatchDraft) => void;
}): React.JSX.Element {
  const editing = mode.kind === "edit" ? mode.task : null;
  const [repos, setRepos] = useState<string[]>([]);
  const [reposLoading, setReposLoading] = useState(true);
  // Which action is in flight, not merely whether one is: both footer buttons submit,
  // and only the one that was pressed should say so.
  const [pending, setPending] = useState<null | "shelve" | "dispatch">(null);
  const busy = pending !== null;
  const [error, setError] = useState<string | null>(null);
  const intentRef = useRef<HTMLTextAreaElement>(null);
  const drop = useImageDrop({ attachments: draft.attachments, onChange: onAttachmentsChange });

  // Merge one field's change into the lifted draft.
  function update(patch: Partial<DispatchDraft>): void {
    onDraftChange({ ...draft, ...patch });
  }

  useEffect(() => {
    intentRef.current?.focus();
  }, []);

  // Index the workspace's repos so the base can be searched/picked. Re-fetched on
  // every open so a freshly-cloned repo shows up without a full app reload.
  useEffect(() => {
    let alive = true;
    void fetchRepos().then((list) => {
      if (!alive) return;
      setRepos(list);
      setReposLoading(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  // Put the form back where it started without closing: every close path preserves
  // what's typed, so this is the one way to abandon it. For a new dispatch that means
  // an empty form; for an edit it means the task as the daemon still holds it, which
  // is the only "start again" an edit has.
  function clearDraft(): void {
    revokeAttachments(draft.attachments);
    onDraftChange(editing ? draftFromTask(editing) : EMPTY_DISPATCH_DRAFT);
    setError(null);
    intentRef.current?.focus();
  }

  async function submit(dispatchNow: boolean): Promise<void> {
    // An image still uploading has no path yet, so dispatching now would launch the
    // agent on a task missing the screenshot it was written around. The buttons say
    // so; this also guards ⌘Enter, which doesn't.
    if (!draft.repoRoot.trim() || !draft.intent.trim() || busy || drop.uploading) return;
    setPending(dispatchNow ? "dispatch" : "shelve");
    setError(null);
    // Submitting is an async network POST, so this promise can resolve after the
    // modal has been closed - even a short round-trip leaves room for a quick
    // Escape, a reopen, and fresh typing. Hand the exact draft we sent back to the
    // owner, which clears it only if nothing newer has been typed since - see
    // onSubmitted in DispatchLayer.
    const submitted = draft;
    const fields = {
      repoRoot: submitted.repoRoot.trim(),
      // Paths ride at the end of the intent, which the dispatcher already delivers
      // as one bracketed paste - so the agent's first prompt cites the screenshot
      // exactly as a terminal drag would have.
      intent: withAttachments(submitted.intent.trim(), readyAttachments(submitted.attachments)),
      kind: submitted.kind,
      agent: submitted.agent,
    };
    // An emptied title means different things to the two endpoints, and both are the
    // right meaning: on create, "no title given, go and summarize one"; on update,
    // "drop the title I had, derive it from the intent as it now reads". Only the
    // create path can express the first as an absent field.
    const r = editing
      ? await api.updateTask(editing.id, { ...fields, title: submitted.title.trim() })
      : await api.dispatch({ ...fields, title: submitted.title.trim() || undefined, backlog: !dispatchNow });
    // An edit is a save first and a launch second, so the two are two calls: the save
    // has landed by the time the dispatch is asked for, and a refused dispatch leaves
    // the modal open over a task whose text is already stored - nothing to lose, and
    // the same button to press again.
    const launched = r.ok && editing && dispatchNow ? await api.dispatchBacklog(editing.id) : null;
    setPending(null);
    // Clear the draft and close only once the task row exists - the worktree and
    // tmux session are provisioned in the background after this reply, and any
    // failure there surfaces on the task card rather than here. A rejected submit
    // keeps the modal open with the fields intact so you can retry.
    if (!r.ok) setError(r.error ?? (editing ? "could not save the task" : "dispatch failed"));
    else if (launched && !launched.ok) setError(`saved, but ${launched.error ?? "could not dispatch"}`);
    else onSubmitted(submitted);
  }

  return (
    <Overlay
      id={OVERLAY_IDS.dispatch}
      onClose={onClose}
      className="modal dispatch-modal"
      role="dialog"
      ariaLabel={editing ? "Edit a backlog task" : "Dispatch an agent"}
    >
      <header className="modal-head">
        <h2>{editing ? "Edit backlog task" : "Dispatch an agent"}</h2>
        <button className="icon-btn" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </header>

      <div className="dispatch-body">
        <label className="field">
          <span className="field-label">
            Repo{" "}
            <span className="field-hint">
              {reposLoading
                ? "indexing workspace…"
                : `${repos.length} repo${repos.length === 1 ? "" : "s"} found - type to filter`}
            </span>
          </span>
          <RepoCombobox
            repos={repos}
            value={draft.repoRoot}
            onChange={(v) => update({ repoRoot: v })}
          />
        </label>

        <div className="field-row">
          <label className="field">
            <span className="field-label">Kind</span>
            <select
              className="field-input"
              value={draft.kind}
              onChange={(e) => update({ kind: e.target.value as TaskKind })}
            >
              <option value="ship">ship - deliver a change</option>
              <option value="scout">scout - investigate / report</option>
            </select>
          </label>
          <label className="field">
            <span className="field-label">Agent</span>
            <select
              className="field-input"
              value={draft.agent}
              onChange={(e) => update({ agent: e.target.value as AgentType })}
            >
              <option value="claude">Claude Code</option>
              <option value="codex">Codex</option>
            </select>
          </label>
        </div>

        <label className="field">
          <span className="field-label">
            Title{" "}
            <span className="field-hint">
              {/* "optional" is a promise about a field you are yet to fill in. On a task
                  that already has a title, the useful half of that sentence is what the
                  title will go on to name. */}
              {editing ? "names the tmux session / card" : "optional - names the tmux session / card"}
            </span>
          </span>
          <input
            className="field-input"
            placeholder={
              editing ? "clear it to re-derive one from the task" : "summarized from the task if left blank"
            }
            value={draft.title}
            onChange={(e) => update({ title: e.target.value })}
          />
        </label>

        <label className="field">
          <span className="field-label">
            Task <span className="field-hint">drop or paste images to attach them</span>
          </span>
          <div className="drop-zone" {...drop.dropProps}>
            <textarea
              ref={intentRef}
              className="field-input field-textarea"
              placeholder="What should this agent do?"
              rows={5}
              value={draft.intent}
              onChange={(e) => update({ intent: e.target.value })}
              onPaste={drop.onPaste}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit(true);
              }}
            />
            <AttachmentStrip attachments={draft.attachments} onRemove={drop.remove} />
            {drop.dropping && <div className="drop-veil">Drop images to attach</div>}
          </div>
        </label>

        {error && <p className="dispatch-error">{error}</p>}
      </div>

      <footer className="modal-foot">
        <button
          className="btn btn-ghost"
          onClick={() => void submit(false)}
          disabled={busy || drop.uploading || !draft.repoRoot.trim() || !draft.intent.trim()}
          title={editing ? "Keep it in the backlog" : "Shelve it without launching an agent"}
        >
          {editing
            ? pending === "shelve"
              ? "Saving…"
              : "Save"
            : pending === "shelve"
              ? "Shelving…"
              : "Add to backlog"}
        </button>
        <button
          className="btn btn-ghost"
          onClick={clearDraft}
          disabled={
            busy ||
            (editing ? draftsEqual(draft, draftFromTask(editing)) : isEmptyDispatchDraft(draft))
          }
          title={editing ? "Undo these edits" : "Reset the form"}
        >
          {editing ? "Revert" : "Clear"}
        </button>
        <span className="actions-spacer" />
        <button className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn btn-primary"
          onClick={() => void submit(true)}
          disabled={busy || drop.uploading || !draft.repoRoot.trim() || !draft.intent.trim()}
          title="⌘/Ctrl+Enter"
        >
          {pending === "dispatch" ? "Dispatching…" : drop.uploading ? "Uploading…" : "Dispatch now"}
        </button>
      </footer>
    </Overlay>
  );
}

