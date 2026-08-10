import { useEffect, useMemo, useRef, useState } from "react";
import { WORKFLOW_LIMITS, type WorkflowPersonaDirective } from "@shared/workflow.ts";
import { Overlay, OVERLAY_IDS } from "../components/Overlay.tsx";
import { Tooltip } from "../components/Tooltip.tsx";

export function PersonaDirectiveEditor({
  workflowName,
  runId,
  round,
  personaName,
  directive,
  pendingFor,
  error,
  onSave,
  onRemove,
  onClose,
}: {
  workflowName: string;
  runId: string;
  round: number;
  personaName: string;
  directive: WorkflowPersonaDirective | null;
  pendingFor: (saveIntent: string) => boolean;
  error: string | null;
  onSave: (feedback: string, intentKey: string) => void;
  onRemove: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const [feedback, setFeedback] = useState(directive?.feedback ?? "");
  const [saveIntent, setSaveIntent] = useState(() => crypto.randomUUID());
  const [closeWhenSaved, setCloseWhenSaved] = useState<string | null>(null);
  const [closeWhenRemoved, setCloseWhenRemoved] = useState(false);
  const pending = pendingFor(saveIntent);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const persistedFeedback = feedback.trim();
  const bytes = useMemo(
    () => new TextEncoder().encode(persistedFeedback).byteLength,
    [persistedFeedback],
  );
  const valid = persistedFeedback.length > 0 && bytes <= WORKFLOW_LIMITS.personaDirectiveBytes;

  useEffect(() => {
    textarea.current?.focus();
  }, []);

  useEffect(() => {
    if (closeWhenSaved === null || directive?.feedback !== closeWhenSaved) return;
    onClose();
  }, [closeWhenSaved, directive?.feedback, onClose]);

  useEffect(() => {
    if (!closeWhenRemoved || directive !== null) return;
    onClose();
  }, [closeWhenRemoved, directive, onClose]);

  return (
    <Overlay
      id={OVERLAY_IDS.personaDirective}
      onClose={onClose}
      className="wf-persona-directive-drawer"
      as="aside"
      role="dialog"
      ariaLabel="Guide this reviewer's future rounds"
    >
      <header className="wf-persona-directive-head">
          <div>
            <p className="workflow-eyebrow">Critical Persona feedback</p>
            <h3 id="wf-persona-directive-title">Guide this reviewer's future rounds</h3>
          </div>
          <Tooltip label="Close Persona feedback editor">
            <button className="wf-persona-directive-close" type="button" onClick={onClose} aria-label="Close Persona feedback editor">×</button>
          </Tooltip>
      </header>

      <div className="wf-persona-directive-body">
          <section className="wf-persona-directive-scope" aria-label="Locked feedback scope">
            <strong className="wf-persona-directive-scope-title">⌁ Locked scope</strong>
            <dl>
              <div><dt>Run</dt><dd>{workflowName} · {runId.slice(0, 8)}</dd></div>
              <div><dt>Persona</dt><dd>{personaName}</dd></div>
            </dl>
          </section>

          <section className="wf-persona-directive-persistence">
            <h4>Persists for this run</h4>
            <p>
              The feedback joins this Persona's next execution and every later round. It never
              changes the published Persona or another workflow run.
            </p>
            <div className="wf-persona-directive-rounds" aria-label="Feedback application timeline">
              <span><small>Round {round}</small><strong>Current round</strong></span>
              <span className="is-next"><small>Next execution</small><strong>Feedback applies</strong></span>
              <span><small>Later rounds</small><strong>Repeats until removed</strong></span>
            </div>
          </section>

          <label className="wf-persona-directive-field">
            <span>
              <strong>Feedback for this Persona</strong>
              <em>Extremely critical</em>
            </span>
            <textarea
              ref={textarea}
              aria-label={`Feedback for ${personaName}`}
              value={feedback}
              disabled={pending}
              onChange={(event) => {
                setFeedback(event.target.value);
                setSaveIntent(crypto.randomUUID());
              }}
              placeholder="State the instruction this Persona must prioritize in every later round of this run."
            />
            <small className={bytes > WORKFLOW_LIMITS.personaDirectiveBytes ? "is-over" : ""}>
              {bytes.toLocaleString()} / {WORKFLOW_LIMITS.personaDirectiveBytes.toLocaleString()} UTF-8 bytes
            </small>
          </label>

          <p className="wf-persona-directive-priority">
            <strong>Priority</strong>
            <span>
              This instruction appears at the top of the Persona prompt and takes priority over
              the original intent, published Persona guidance, prior reviewer feedback, and
              evidence text. Safety requirements and the required verdict format still apply.
            </span>
          </p>

          {error && <p className="wf-run-error" role="alert">{error}</p>}

          <footer className="wf-persona-directive-actions">
            {directive && (
              <Tooltip label="Stop applying this feedback to future rounds">
                <button
                  className="btn btn-danger-ghost"
                  type="button"
                  disabled={pending}
                  onClick={() => {
                    setCloseWhenRemoved(true);
                    onRemove();
                  }}
                >
                  Remove feedback
                </button>
              </Tooltip>
            )}
            <Tooltip label="Close without saving changes">
              <button className="btn btn-ghost" type="button" disabled={pending} onClick={onClose}>Cancel</button>
            </Tooltip>
            <Tooltip label="Apply this feedback to the Persona's future rounds in this run">
              <button
                className="btn wf-persona-directive-save"
                type="button"
                disabled={pending || !valid || persistedFeedback === directive?.feedback}
                onClick={() => {
                  setCloseWhenSaved(persistedFeedback);
                  onSave(persistedFeedback, saveIntent);
                }}
              >
                {pending ? "Saving…" : "Save for future rounds"}
              </button>
            </Tooltip>
          </footer>
      </div>
    </Overlay>
  );
}
