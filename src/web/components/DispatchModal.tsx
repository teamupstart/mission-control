import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskKind, AgentType } from "@shared/types.ts";
import { api, fetchRepos } from "../lib/api.ts";

/**
 * The form fields a dispatch carries. Held by `DispatchLayer` (not the modal) so
 * an accidental close - Escape, backdrop click, Cancel, or the ✕ - keeps a
 * half-written task around; the draft is wiped only once it's actually
 * dispatched or queued, or when the footer's Clear discards it on purpose
 * (see EMPTY_DISPATCH_DRAFT).
 */
type DispatchDraft = {
  repoRoot: string;
  intent: string;
  title: string;
  kind: TaskKind;
  agent: AgentType;
};

const EMPTY_DISPATCH_DRAFT: DispatchDraft = {
  repoRoot: "",
  intent: "",
  title: "",
  kind: "ship",
  agent: "claude",
};

/** True when a draft holds nothing worth keeping - so "Clear" has nothing to do. */
function isEmptyDispatchDraft(d: DispatchDraft): boolean {
  return (
    !d.repoRoot.trim() &&
    !d.intent.trim() &&
    !d.title.trim() &&
    d.kind === EMPTY_DISPATCH_DRAFT.kind &&
    d.agent === EMPTY_DISPATCH_DRAFT.agent
  );
}

/**
 * Field-by-field draft equality. A dispatch POST can resolve after the modal
 * instance that sent it is gone, so its resolve path hands back the draft it sent
 * and the owner compares: still the same draft means nothing newer to lose (see
 * onSubmitted).
 */
function draftsEqual(a: DispatchDraft, b: DispatchDraft): boolean {
  return (
    a.repoRoot === b.repoRoot &&
    a.intent === b.intent &&
    a.title === b.title &&
    a.kind === b.kind &&
    a.agent === b.agent
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
 */
export function DispatchLayer({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): React.JSX.Element | null {
  const [draft, setDraft] = useState<DispatchDraft>(EMPTY_DISPATCH_DRAFT);
  // Read by the dispatch-accepted callback below, which can fire after the modal
  // instance that armed it is gone - a stale closure would compare against
  // whatever the draft held when that instance last rendered.
  const draftRef = useRef(draft);
  draftRef.current = draft;

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
      setDraft(EMPTY_DISPATCH_DRAFT);
      onClose();
    },
    [onClose],
  );

  if (!open) return null;
  return (
    <DispatchModal
      draft={draft}
      onDraftChange={setDraft}
      onClose={onClose}
      onSubmitted={onSubmitted}
    />
  );
}

/**
 * Launch (or queue) a new agent: pick a repo, describe the task, and dispatch.
 * The daemon provisions an isolated worktree, opens a detached tmux session, and
 * injects the intent - the new session then appears on the grid on the next poll.
 *
 * The form values live in `draft` on `DispatchLayer` so they survive close/reopen;
 * only the transient UI state (repo index, busy, error) is local here.
 */
function DispatchModal({
  draft,
  onDraftChange,
  onClose,
  onSubmitted,
}: {
  draft: DispatchDraft;
  onDraftChange: (draft: DispatchDraft) => void;
  onClose: () => void;
  onSubmitted: (submitted: DispatchDraft) => void;
}): React.JSX.Element {
  const [repos, setRepos] = useState<string[]>([]);
  const [reposLoading, setReposLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const intentRef = useRef<HTMLTextAreaElement>(null);

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

  // Close on Escape (unless typing in a field where Esc should just blur nothing).
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Discard the draft without closing: every close path preserves it, so this is
  // the one way to start a fresh dispatch.
  function clearDraft(): void {
    onDraftChange(EMPTY_DISPATCH_DRAFT);
    setError(null);
    intentRef.current?.focus();
  }

  async function submit(queue: boolean): Promise<void> {
    if (!draft.repoRoot.trim() || !draft.intent.trim() || busy) return;
    setBusy(true);
    setError(null);
    // Dispatching is an async network POST, so this promise can resolve after the
    // modal has been closed - even a short round-trip leaves room for a quick
    // Escape, a reopen, and fresh typing. Hand the exact draft we sent back to the
    // owner, which clears it only if nothing newer has been typed since - see
    // onSubmitted in DispatchLayer.
    const submitted = draft;
    const r = await api.dispatch({
      repoRoot: submitted.repoRoot.trim(),
      intent: submitted.intent.trim(),
      title: submitted.title.trim() || undefined,
      kind: submitted.kind,
      agent: submitted.agent,
      queue,
    });
    setBusy(false);
    // Clear the draft and close only once the task row exists - the worktree and
    // tmux session are provisioned in the background after this reply, and any
    // failure there surfaces on the task card rather than here. A rejected submit
    // keeps the modal open with the fields intact so you can retry.
    if (r.ok) onSubmitted(submitted);
    else setError(r.error ?? "dispatch failed");
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal dispatch-modal"
        role="dialog"
        aria-label="Dispatch an agent"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h2>Dispatch an agent</h2>
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
              Title <span className="field-hint">optional - names the tmux session / card</span>
            </span>
            <input
              className="field-input"
              placeholder="auto from the task if left blank"
              value={draft.title}
              onChange={(e) => update({ title: e.target.value })}
            />
          </label>

          <label className="field">
            <span className="field-label">Task</span>
            <textarea
              ref={intentRef}
              className="field-input field-textarea"
              placeholder="What should this agent do?"
              rows={5}
              value={draft.intent}
              onChange={(e) => update({ intent: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit(false);
              }}
            />
          </label>

          {error && <p className="dispatch-error">{error}</p>}
        </div>

        <footer className="modal-foot">
          <button className="btn btn-ghost" onClick={() => void submit(true)} disabled={busy}>
            Add to backlog
          </button>
          <button
            className="btn btn-ghost"
            onClick={clearDraft}
            disabled={busy || isEmptyDispatchDraft(draft)}
            title="Reset the form"
          >
            Clear
          </button>
          <span className="actions-spacer" />
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={() => void submit(false)}
            disabled={busy || !draft.repoRoot.trim() || !draft.intent.trim()}
            title="⌘/Ctrl+Enter"
          >
            {busy ? "Dispatching…" : "Dispatch now"}
          </button>
        </footer>
      </div>
    </div>
  );
}

/**
 * A themed combobox for the repo path. Replaces the native <datalist>, whose
 * dropdown is browser-chrome and can't be styled to match the dark UI. Filters
 * the known repos as you type, with arrow/enter/click selection and a dropdown
 * that inherits the app's tokens.
 */
function RepoCombobox({
  repos,
  value,
  onChange,
}: {
  repos: string[];
  value: string;
  onChange: (v: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const q = value.trim().toLowerCase();
  const matches = q ? repos.filter((r) => r.toLowerCase().includes(q)) : repos;
  // Nothing to offer once the text already equals the only remaining match.
  const showList = open && matches.length > 0 && !(matches.length === 1 && matches[0] === value);

  // Collapse when focus/click leaves the widget.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent): void {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Keep the highlighted row in range as the match list shrinks.
  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, matches.length - 1)));
  }, [matches.length]);

  // Keep the highlighted row visible while arrowing through a long repo list.
  useEffect(() => {
    if (!showList) return;
    const el = listRef.current?.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [active, showList]);

  function choose(r: string): void {
    onChange(r);
    setActive(0);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!showList) setOpen(true);
      else setActive((a) => Math.min(a + 1, matches.length - 1));
    } else if (e.key === "ArrowUp") {
      if (!showList) return;
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      if (showList && matches[active]) {
        e.preventDefault();
        choose(matches[active]);
      }
    } else if (e.key === "Escape" && open) {
      // Close only the dropdown; keep the dispatch modal open.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  }

  return (
    <div className="combobox" ref={rootRef}>
      <input
        className="field-input mono"
        role="combobox"
        aria-expanded={showList}
        aria-autocomplete="list"
        placeholder="search repos or type a path…"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {showList && (
        <ul className="combobox-list" role="listbox" ref={listRef}>
          {matches.map((r, i) => (
            <li
              key={r}
              role="option"
              aria-selected={i === active}
              className={`combobox-option${i === active ? " is-active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                // Pick before the input's blur fires, so the click registers.
                e.preventDefault();
                choose(r);
              }}
            >
              {r}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
