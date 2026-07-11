import { useEffect, useRef, useState } from "react";
import type { TaskKind, AgentType } from "@shared/types.ts";
import { api } from "../lib/api.ts";

/**
 * Launch (or queue) a new crewmate: pick a repo, describe the task, and dispatch.
 * The daemon provisions an isolated worktree, opens a detached tmux session, and
 * injects the intent - the new session then appears on the grid on the next poll.
 */
export function DispatchModal({
  repos,
  onClose,
}: {
  repos: string[];
  onClose: () => void;
}): React.JSX.Element {
  const [repoRoot, setRepoRoot] = useState(repos[0] ?? "");
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
        aria-label="Dispatch a crewmate"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h2>Dispatch a crewmate</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </header>

        <div className="dispatch-body">
          <label className="field">
            <span className="field-label">Repo</span>
            <input
              className="field-input mono"
              list="dispatch-repos"
              placeholder="/absolute/path/to/repo"
              value={repoRoot}
              onChange={(e) => setRepoRoot(e.target.value)}
            />
            <datalist id="dispatch-repos">
              {repos.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
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
              placeholder="What should this crewmate do?"
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
