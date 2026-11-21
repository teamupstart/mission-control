import { useState } from "react";
import type { Task, TaskDependency } from "@shared/types.ts";
import type { TaskPlanInput, TaskPlanInputChange } from "@shared/managed-plans.ts";
import { managedPlanPreview } from "@shared/managed-plans.ts";
import { dependencyInputKey } from "@shared/task-bulk.ts";
import { api } from "../lib/api.ts";
import { Tooltip } from "./Tooltip.tsx";

function previewDependencyKey(edge: TaskDependency): string {
  return JSON.stringify([dependencyInputKey(edge), "episodeId" in edge ? edge.episodeId : null,
    edge.satisfiedAt, "prUrl" in edge ? edge.prUrl : null]);
}

function changedDependencyLabel(edge: TaskDependency): string {
  const episode = "episodeId" in edge && edge.episodeId ? `episode ${edge.episodeId}, ` : "";
  return `${edge.title} (${episode}${edge.satisfiedAt !== null ? "merged/published" : "waiting"})`;
}

export function PinnedPlanChange({ task, input, disabled, onChange, onEditing, onPending }: {
  task: Task; input: TaskPlanInput; disabled: boolean;
  onEditing: (open: boolean) => void;
  onChange: (change: TaskPlanInputChange | null) => void;
  onPending: (pending: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [planId, setPlanId] = useState(input.planId);
  const [revision, setRevision] = useState("");
  const [files, setFiles] = useState(input.files.join(", "));
  const [preview, setPreview] = useState<{ before: Task; after: Task; replacement: TaskPlanInput } | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const reset = () => { setPreview(null); setError(""); onChange(null); };
  async function inspect() {
    reset();
    setPending(true);
    onPending(true);
    const change: TaskPlanInputChange = {
      from: input,
      to: { repoKey: input.repoKey, planId: planId.trim(), revision: Number(revision),
        files: files.split(",").map(file => file.trim()).filter(Boolean) },
      expectedUpdatedAt: task.updatedAt,
    };
    try {
      const result = await api.previewPlanChange(task.id, change);
      const inputIndex = result.before?.planInputs?.findIndex(pin => pin.repoKey === change.from.repoKey
        && pin.planId === change.from.planId && pin.revision === change.from.revision
        && JSON.stringify(pin.files) === JSON.stringify(change.from.files)) ?? -1;
      const replacement = result.task?.planInputs?.[inputIndex];
      if (!result.ok || !result.task || !result.before || !replacement) setError(result.error ?? "Could not preview revision");
      else { setPreview({ before: result.before, after: result.task, replacement }); onChange(change); }
    } catch { setError("Could not reach Mission Control"); }
    finally { setPending(false); onPending(false); }
  }
  if (!open) return <Tooltip label="Choose an exact replacement plan revision and preview its prerequisites"><button type="button" className="btn btn-ghost" disabled={disabled}
    onClick={() => { setOpen(true); onEditing(true); }}>Change pinned revision</button></Tooltip>;
  const removed = preview?.before.dependencies.filter(edge => !preview.after.dependencies.some(next => previewDependencyKey(next) === previewDependencyKey(edge))) ?? [];
  const added = preview?.after.dependencies.filter(edge => !preview.before.dependencies.some(old => previewDependencyKey(old) === previewDependencyKey(edge))) ?? [];
  return <fieldset className="pinned-plan-change" disabled={pending}>
    <legend>Change pinned revision</legend>
    <p className="field-hint">Select an exact revision. Newer revisions are never selected automatically. Preview first, then Save the task.</p>
    <label className="field">Plan ID<input className="field-input" value={planId} onChange={e => { reset(); setPlanId(e.target.value); }} /></label>
    <label className="field">Revision<input className="field-input" type="number" min="1" value={revision} onChange={e => { reset(); setRevision(e.target.value); }} /></label>
    <label className="field">Markdown files<input className="field-input" value={files} onChange={e => { reset(); setFiles(e.target.value); }} /><span className="field-hint">Comma-separated exact filenames</span></label>
    <Tooltip label="Validate the selected revision and show changes without saving"><button type="button" className="btn" onClick={() => void inspect()} disabled={!revision || disabled}>Preview revision change</button></Tooltip>{" "}
    <Tooltip label="Discard the revision selection and keep the saved pin"><button type="button" className="btn btn-ghost" onClick={() => { reset(); setOpen(false); onEditing(false); }}>Cancel revision change</button></Tooltip>
    {error && <p role="alert">{error}</p>}
    {preview && <section aria-label="Pinned revision preview">
      <p><strong>Old:</strong> <Tooltip label="Open the currently pinned plan revision in a new tab"><a href={managedPlanPreview(input.planId, input.revision)} target="_blank" rel="noreferrer">{input.planId} revision {input.revision}</a></Tooltip> · {input.files.join(", ")}</p>
      <p><strong>New:</strong> <Tooltip label="Open the selected replacement revision in a new tab"><a href={managedPlanPreview(preview.replacement.planId, preview.replacement.revision)} target="_blank" rel="noreferrer">{preview.replacement.planId} revision {preview.replacement.revision}</a></Tooltip> · {preview.replacement.files.join(", ")}</p>
      <p><strong>Remove:</strong> {removed.map(changedDependencyLabel).join(", ") || "None"}</p>
      <p><strong>Add:</strong> {added.map(changedDependencyLabel).join(", ") || "None"}</p>
      <p><strong>Retain:</strong> {preview.after.dependencies.filter(edge => !added.includes(edge)).map(edge => edge.title + (edge.satisfiedAt !== null ? " (merged/published)" : " (waiting)")).join(", ") || "None"}</p>
      <p className="field-hint">Ready to save the pin and prerequisites together. Other dependencies stay unchanged.</p>
    </section>}
  </fieldset>;
}
