import { useEffect, useRef, useState } from "react";
import type { TaskKind, AgentType } from "@shared/types.ts";
import { api, fetchRepos } from "../lib/api.ts";

/**
 * Launch (or queue) a new agent: pick a repo, describe the task, and dispatch.
 * The daemon provisions an isolated worktree, opens a detached tmux session, and
 * injects the intent - the new session then appears on the grid on the next poll.
 */
export function DispatchModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [repos, setRepos] = useState<string[]>([]);
  const [reposLoading, setReposLoading] = useState(true);
  const [repoRoot, setRepoRoot] = useState("");
  const [intent, setIntent] = useState("");
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<TaskKind>("ship");
  const [agent, setAgent] = useState<AgentType>("claude");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const intentRef = useRef<HTMLTextAreaElement>(null);

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

  async function submit(queue: boolean): Promise<void> {
    if (!repoRoot.trim() || !intent.trim() || busy) return;
    setBusy(true);
    setError(null);
    const r = await api.dispatch({
      repoRoot: repoRoot.trim(),
      intent: intent.trim(),
      title: title.trim() || undefined,
      kind,
      agent,
      queue,
    });
    setBusy(false);
    if (r.ok) onClose();
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
            <RepoCombobox repos={repos} value={repoRoot} onChange={setRepoRoot} />
          </label>

          <div className="field-row">
            <label className="field">
              <span className="field-label">Kind</span>
              <select
                className="field-input"
                value={kind}
                onChange={(e) => setKind(e.target.value as TaskKind)}
              >
                <option value="ship">ship - deliver a change</option>
                <option value="scout">scout - investigate / report</option>
              </select>
            </label>
            <label className="field">
              <span className="field-label">Agent</span>
              <select
                className="field-input"
                value={agent}
                onChange={(e) => setAgent(e.target.value as AgentType)}
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
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>

          <label className="field">
            <span className="field-label">Task</span>
            <textarea
              ref={intentRef}
              className="field-input field-textarea"
              placeholder="What should this agent do?"
              rows={5}
              value={intent}
              onChange={(e) => setIntent(e.target.value)}
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
          <span className="actions-spacer" />
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={() => void submit(false)}
            disabled={busy || !repoRoot.trim() || !intent.trim()}
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
