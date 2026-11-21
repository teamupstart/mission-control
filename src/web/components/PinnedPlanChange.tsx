import { useState } from "react";
import type { Task } from "@shared/types.ts";
import type { TaskPlanInput, TaskPlanInputChange } from "@shared/managed-plans.ts";
import { managedPlanPreview } from "@shared/managed-plans.ts";
import { dependencyInputKey } from "@shared/task-bulk.ts";
import { api } from "../lib/api.ts";

export function PinnedPlanChange({ task, input, disabled, onChange, onEditing }: {
  task: Task; input: TaskPlanInput; disabled: boolean;
  onEditing: (open: boolean) => void;
  onChange: (change: TaskPlanInputChange | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [planId, setPlanId] = useState(input.planId);
  const [revision, setRevision] = useState("");
  const [files, setFiles] = useState(input.files.join(", "));
  const [preview, setPreview] = useState<Task | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const reset = () => { setPreview(null); setError(""); onChange(null); };
  async function inspect() {
    reset();
    setPending(true);
    const change: TaskPlanInputChange = {
      from: input,
      to: { repoKey: input.repoKey, planId: planId.trim(), revision: Number(revision),
        files: files.split(",").map(file => file.trim()).filter(Boolean) },
      expectedUpdatedAt: task.updatedAt,
    };
    try {
      const result = await api.previewPlanChange(task.id, change);
      if (!result.ok || !result.task) setError(result.error ?? "Could not preview revision");
      else { setPreview(result.task); onChange(change); }
    } catch { setError("Could not reach Mission Control"); }
    finally { setPending(false); }
  }
  if (!open) return <button type="button" className="btn btn-ghost" disabled={disabled}
    onClick={() => { setOpen(true); onEditing(true); }}>Change pinned revision</button>;
  const removed = task.dependencies.filter(edge => !preview?.dependencies.some(next => dependencyInputKey(next) === dependencyInputKey(edge)));
  const added = preview?.dependencies.filter(edge => !task.dependencies.some(old => dependencyInputKey(old) === dependencyInputKey(edge))) ?? [];
  return <fieldset className="pinned-plan-change" disabled={pending}>
    <legend>Change pinned revision</legend>
    <p className="field-hint">Select an exact revision. Newer revisions are never selected automatically. Preview first, then Save the task.</p>
    <label className="field">Plan ID<input className="field-input" value={planId} onChange={e => { reset(); setPlanId(e.target.value); }} /></label>
    <label className="field">Revision<input className="field-input" type="number" min="1" value={revision} onChange={e => { reset(); setRevision(e.target.value); }} /></label>
    <label className="field">Markdown files<input className="field-input" value={files} onChange={e => { reset(); setFiles(e.target.value); }} /><span className="field-hint">Comma-separated exact filenames</span></label>
    <button type="button" className="btn" onClick={() => void inspect()} disabled={!revision || disabled}>Preview revision change</button>{" "}
    <button type="button" className="btn btn-ghost" onClick={() => { reset(); setOpen(false); onEditing(false); }}>Cancel revision change</button>
    {error && <p role="alert">{error}</p>}
    {preview && <section aria-label="Pinned revision preview">
      <p><strong>Old:</strong> <a href={managedPlanPreview(input.planId, input.revision)} target="_blank" rel="noreferrer">{input.planId} revision {input.revision}</a> · {input.files.join(", ")}</p>
      <p><strong>New:</strong> <a href={managedPlanPreview(planId.trim(), Number(revision))} target="_blank" rel="noreferrer">{planId.trim()} revision {revision}</a> · {files}</p>
      <p><strong>Remove:</strong> {removed.map(edge => edge.title).join(", ") || "None"}</p>
      <p><strong>Add:</strong> {added.map(edge => edge.title).join(", ") || "None"}</p>
      <p><strong>Retain:</strong> {preview.dependencies.filter(edge => !added.includes(edge)).map(edge => edge.title + (edge.satisfiedAt !== null ? " (merged/published)" : " (waiting)")).join(", ") || "None"}</p>
      <p className="field-hint">Ready to save the pin and prerequisites together. Other dependencies stay unchanged.</p>
    </section>}
  </fieldset>;
}
