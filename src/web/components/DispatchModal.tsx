import { useEffect, useRef, useState } from "react";
import type { TaskKind, AgentType } from "@shared/types.ts";
import { api, fetchRepos } from "../lib/api.ts";

/**
 * The form fields a dispatch carries. Held by the parent (not the modal) so an
 * accidental close - Escape, backdrop click, Cancel, or the ✕ - keeps a
 * half-written task around; the draft is wiped only once it's actually
 * dispatched or queued, or when the footer's Clear discards it on purpose
 * (see EMPTY_DISPATCH_DRAFT).
 */
export type DispatchDraft = {
  repoRoot: string;
  intent: string;
  title: string;
  kind: TaskKind;
  agent: AgentType;
};

export const EMPTY_DISPATCH_DRAFT: DispatchDraft = {
  repoRoot: "",
  intent: "",
  title: "",
  kind: "ship",
  agent: "claude",
};

/** True when a draft holds nothing worth keeping - so "Clear" has nothing to do. */
export function isEmptyDispatchDraft(d: DispatchDraft): boolean {
  return (
    !d.repoRoot.trim() &&
    !d.intent.trim() &&
    !d.title.trim() &&
    d.kind === EMPTY_DISPATCH_DRAFT.kind &&
    d.agent === EMPTY_DISPATCH_DRAFT.agent
  );
}

/**
 * Launch (or queue) a new agent: pick a repo, describe the task, and dispatch.
 * The daemon provisions an isolated worktree, opens a detached tmux session, and
 * injects the intent - the new session then appears on the grid on the next poll.
 *
 * The form values live in `draft` on the parent so they survive close/reopen;
 * only the transient UI state (repo index, busy, error) is local here.
 */
export function DispatchModal({
  draft,
  onDraftChange,
  onClose,
  onSubmitted,
}: {
  draft: DispatchDraft;
  onDraftChange: (draft: DispatchDraft) => void;
  onClose: () => void;
  onSubmitted: () => void;
}): React.JSX.Element {
  const [repos, setRepos] = useState<string[]>([]);
  const [reposLoading, setReposLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const intentRef = useRef<HTMLTextAreaElement>(null);
  const aliveRef = useRef(true);

  // Merge one field's change into the lifted draft.
  function update(patch: Partial<DispatchDraft>): void {
    onDraftChange({ ...draft, ...patch });
  }

  useEffect(() => {
    intentRef.current?.focus();
  }, []);

  // A dispatch provisions a worktree and a tmux session, so it can outlive the
  // modal instance that started it: close mid-flight, reopen, and the first
  // submit's resolve path would still clear the draft the reopened instance is
  // now holding. Re-armed on mount, not just at init, so a StrictMode remount
  // doesn't leave a live instance marked dead.
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
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
    const r = await api.dispatch({
      repoRoot: draft.repoRoot.trim(),
      intent: draft.intent.trim(),
      title: draft.title.trim() || undefined,
      kind: draft.kind,
      agent: draft.agent,
      queue,
    });
    // The dispatch itself already landed server-side; we only skip the modal-side
    // cleanup, which belongs to an instance that's gone.
    if (!aliveRef.current) return;
    setBusy(false);
    // Clear the draft and close only once it's actually accepted; a failed
    // submit keeps the modal open with the fields intact so you can retry.
    if (r.ok) onSubmitted();
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
