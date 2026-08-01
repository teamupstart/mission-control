import { useEffect, useMemo, useRef, useState } from "react";
import {
  WORKFLOW_LIMITS,
  normalizeSessionActionName,
  sessionActionCompletionLabel,
} from "@shared/workflow.ts";
import type {
  SessionAction,
  SessionActionCompletionCapability,
  SessionActionCompletionKind,
} from "@shared/workflow.ts";
import type { SkillCatalogEntry } from "@shared/types.ts";
import { FileEditor } from "../components/FileEditor.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { Tooltip } from "../components/Tooltip.tsx";
import { sessionActionConflict, sessionActionRequest } from "./sessionActionApi.ts";

/**
 * Authoring one SessionAction: a name, a description, the EXACT instruction a bound session
 * will receive, an optional required skill, and which completion the daemon must observe.
 *
 * Deliberately the Persona editor's shape - draft/dirty/CAS conflict/duplicate - and
 * deliberately not its vocabulary. Nothing here says reviewer, verdict, model or pass: an
 * action is a thing the session DOES, and an operator who reads this page as a second kind
 * of reviewer will place it in a pipeline expecting a judgement it never returns.
 *
 * The prompt is the load-bearing field and the one rule about it is that nothing rewrites it.
 * It is stored, snapshotted at publish and typed into a conversation byte for byte, so the
 * editor keeps the operator's own line endings, leading blank lines and trailing whitespace,
 * and the only thing it enforces is the UTF-8 ceiling the delivery packet can actually carry.
 */

export interface SessionActionDraftSeed {
  name: string;
  description: string;
  promptMarkdown: string;
  requiredSkillId: string | null;
  completionKind: SessionActionCompletionKind;
}

export const EMPTY_SESSION_ACTION_SEED: SessionActionDraftSeed = {
  name: "",
  description: "",
  promptMarkdown: "",
  requiredSkillId: null,
  completionKind: "session_turn",
};

export function sessionActionSeed(action: SessionAction): SessionActionDraftSeed {
  return {
    name: action.name,
    description: action.description,
    promptMarkdown: action.promptMarkdown,
    requiredSkillId: action.requiredSkillId,
    completionKind: action.completion.kind,
  };
}

const DRAFT_FIELDS = [
  "name",
  "description",
  "promptMarkdown",
  "requiredSkillId",
  "completionKind",
] as const;

/**
 * Merge a completed save with edits typed WHILE it was in flight.
 *
 * The Persona editor's rule, restated for this record's five fields rather than shared with
 * it: a generic merge would have to be told which fields exist anyway, and `completionKind`
 * is not a string the Persona shape has. A field the operator changed since the request left
 * keeps their value; every other field adopts what the server acknowledged.
 */
export function reconcileSessionActionSave(
  saved: SessionAction,
  submitted: SessionActionDraftSeed,
  current: SessionActionDraftSeed,
  submittedGeneration: number,
  currentGeneration: number,
): { draft: SessionActionDraftSeed; dirty: boolean } {
  const savedDraft = sessionActionSeed(saved);
  if (submittedGeneration === currentGeneration) return { draft: savedDraft, dirty: false };
  const draft = { ...savedDraft };
  for (const field of DRAFT_FIELDS) {
    if (current[field] !== submitted[field]) {
      // Narrowed per field rather than through one indexed write, which TypeScript cannot
      // prove sound over a union of value types.
      if (field === "completionKind") draft.completionKind = current.completionKind;
      else if (field === "requiredSkillId") draft.requiredSkillId = current.requiredSkillId;
      else draft[field] = current[field];
    }
  }
  return {
    draft,
    dirty: DRAFT_FIELDS.some((field) => draft[field] !== savedDraft[field]),
  };
}

/**
 * The sparse PATCH body an edit means, plus the revision it expects.
 *
 * Sparse rather than a whole-record write so two operators editing different fields of the
 * same action do not overwrite each other merely by having the form open, and so the
 * server's "update has no editable fields" refusal stays reachable for a save that changed
 * nothing - the caller checks for exactly that before sending.
 */
export function sessionActionUpdatePatch(
  action: SessionAction,
  draft: SessionActionDraftSeed,
  expectedRevision: number,
): Record<string, unknown> {
  return sessionActionPatchFrom(sessionActionSeed(action), draft, expectedRevision);
}

/**
 * The same patch, measured from a BASELINE rather than from a row.
 *
 * The distinction is what makes Reapply a three-way merge instead of an overwrite. "My
 * changes" are the fields where the draft differs from the seed it started at - not the
 * fields where it differs from whatever the server currently holds. A patch built the second
 * way sends back every field the OTHER tab changed, at the values this editor loaded before
 * they changed them, silently reverting their save under the banner that was reporting it.
 */
export function sessionActionPatchFrom(
  baseline: SessionActionDraftSeed,
  draft: SessionActionDraftSeed,
  expectedRevision: number,
): Record<string, unknown> {
  const patch: Record<string, unknown> = { expectedRevision };
  if (draft.name !== baseline.name) patch.name = draft.name;
  if (draft.description !== baseline.description) patch.description = draft.description;
  if (draft.promptMarkdown !== baseline.promptMarkdown) patch.promptMarkdown = draft.promptMarkdown;
  if (draft.requiredSkillId !== baseline.requiredSkillId) {
    patch.requiredSkillId = draft.requiredSkillId;
  }
  if (draft.completionKind !== baseline.completionKind) {
    patch.completion = { kind: draft.completionKind };
  }
  return patch;
}

/** The create body, which is always whole because there is no prior revision to diff against. */
export function sessionActionCreateBody(draft: SessionActionDraftSeed): Record<string, unknown> {
  return {
    name: draft.name,
    description: draft.description,
    promptMarkdown: draft.promptMarkdown,
    requiredSkillId: draft.requiredSkillId,
    completion: { kind: draft.completionKind },
  };
}

/** Which gesture is being made. All three write; only the first is the ordinary one. */
export type SessionActionSaveMode = "save" | "reapply" | "duplicate";

/**
 * Which row a write lands on, what its changes are measured from, and which revision it
 * expects to find there.
 *
 * Save and Reapply differ in exactly ONE of those three - the expected revision - and saying
 * so here is the point. Both write the operator's own changes, measured from the seed the
 * draft started at; Reapply simply aims them at the revision that now exists instead of the
 * one that no longer does. That is what makes it a three-way merge rather than an overwrite:
 * a field the operator never touched is absent from the patch, so the other tab's value for
 * it survives.
 *
 * `duplicate` measures against nothing - it is a create, and the copy is a new row.
 *
 * `null` means the gesture is not available in this state, which the caller treats as a
 * no-op rather than an error: a Reapply with no conflict is a button that should not have
 * been reachable.
 */
export type SessionActionSaveTarget =
  | { kind: "create" }
  | {
      kind: "update";
      id: string;
      baseline: SessionActionDraftSeed;
      expectedRevision: number;
    };

export function sessionActionSaveTarget(input: {
  mode: SessionActionSaveMode;
  action: SessionAction | null;
  conflict: SessionAction | null;
  loadedRevision: number | null;
  /** The seed the current draft started from: what "my changes" are measured against. */
  baseline: SessionActionDraftSeed;
}): SessionActionSaveTarget | null {
  const { mode, action, conflict, loadedRevision, baseline } = input;
  if (mode === "duplicate") return { kind: "create" };
  if (mode === "reapply") {
    // The conflict row IS the same action - a CAS refusal reports the current state of the
    // row that was written to - so this lands where a workflow already points.
    return conflict === null
      ? null
      : { kind: "update", id: conflict.id, baseline, expectedRevision: conflict.revision };
  }
  if (action === null) return { kind: "create" };
  return loadedRevision === null
    ? null
    : { kind: "update", id: action.id, baseline, expectedRevision: loadedRevision };
}

/**
 * Why this draft cannot be saved yet, as one sentence, or null.
 *
 * Checked in the browser as well as at the route because the two refusals read completely
 * differently: this one names the field while the operator is still in it, and the route's
 * arrives as a banner after a round trip. The bounds are the shared ones, so they cannot
 * disagree about where the ceiling is.
 */
export function sessionActionDraftProblem(
  draft: SessionActionDraftSeed,
  promptBytes: number,
): string | null {
  if (draft.name.trim().length === 0) return "A session action needs a name.";
  if (draft.promptMarkdown.trim().length === 0) {
    return "A session action needs an instruction to send.";
  }
  if (promptBytes > WORKFLOW_LIMITS.sessionActionPromptBytes) {
    return `The instruction is ${promptBytes.toLocaleString()} UTF-8 bytes, over the `
      + `${WORKFLOW_LIMITS.sessionActionPromptBytes.toLocaleString()} a session action packet can carry.`;
  }
  if (
    draft.requiredSkillId !== null
    && !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(draft.requiredSkillId)
  ) {
    return "A required skill is a catalog id, not a command.";
  }
  return null;
}

/** A file name for the prompt editor's toolbar, derived the way the Persona editor derives its own. */
export function sessionActionPromptPath(name: string): string {
  const slug = normalizeSessionActionName(name)
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}._-]/gu, "");
  return `${slug || "session-action"}.md`;
}

/**
 * Cmd/Ctrl+S, ignored while an overlay owns the screen.
 *
 * A local copy of the Persona editor's predicate rather than an import of it: the two
 * editors are siblings and neither should be able to break the other by retuning its own
 * save shortcut, and a function named for Personas doing the work here would read as a
 * miswiring rather than as reuse.
 */
export function isSessionActionSaveShortcut(
  event: Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "key">,
  overlayOpen: boolean,
): boolean {
  return !overlayOpen && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s";
}

/**
 * The completion options an operator may pick from, plus a RETAINED one for a stored value
 * this build cannot offer.
 *
 * The retained arm is what stops opening the built-in Pull Request action - whose adapter is
 * unavailable until Phase 4 - from silently rewriting it to `session_turn` on the next save.
 * It renders disabled, so it can be read and never chosen.
 */
export function completionChoices(
  capabilities: readonly SessionActionCompletionCapability[],
  selected: SessionActionCompletionKind,
  /**
   * Whether the capability read is still in flight.
   *
   * Without it the retained arm below fires for the ~one round trip before the daemon
   * answers, and every freshly opened action briefly accuses itself of naming a completion
   * this build cannot prove. Loading is not a refusal, so it says nothing.
   */
  loading = false,
): Array<{ kind: SessionActionCompletionKind; label: string; disabled: boolean; note: string | null }> {
  const offered = capabilities
    .filter((capability) => capability.available)
    .map((capability) => ({
      kind: capability.kind,
      label: capability.label,
      disabled: false,
      note: null,
    }));
  if (offered.some((choice) => choice.kind === selected)) return offered;
  const retained = capabilities.find((capability) => capability.kind === selected);
  return [
    {
      kind: selected,
      // The shared table supplies the WORDING when the daemon's answer has not arrived. That
      // is not the client deciding availability - `available` still comes only from the
      // response - it is the difference between an operator reading "Pull request is opened
      // and verified" and reading the wire spelling `pull_request`.
      label: retained?.label ?? sessionActionCompletionLabel({ kind: selected }),
      disabled: true,
      note: loading
        ? null
        : retained?.unavailableReason ?? "This build cannot prove this completion.",
    },
    ...offered,
  ];
}

export function SessionActionEditorStatus({
  dirty,
  conflict,
  archived,
  builtin = false,
  onReload,
  onReapply,
  onDuplicate,
}: {
  dirty: boolean;
  conflict: SessionAction | null;
  archived: boolean;
  builtin?: boolean;
  onReload: () => void;
  /** Write the preserved draft onto the revision the conflict reported. */
  onReapply: () => void;
  onDuplicate: () => void;
}): React.JSX.Element | null {
  if (builtin) {
    return (
      <p className="wf-state builtin">
        Built-in - this session action ships with Mission Control and carries the instruction
        this build was made from. Duplicate it to make a copy you own and can edit.
      </p>
    );
  }
  if (archived) {
    return (
      <p className="wf-state archived">
        Archived - this session action is read-only and is no longer offered to new stages.
        Every published version keeps the instruction it was published with.
      </p>
    );
  }
  if (conflict) {
    /**
     * Three ways out, and they are three genuinely different decisions about the SAME
     * action - which is why Reapply has to be one of them rather than being folded into
     * Duplicate. Duplicate keeps the edits by making a DIFFERENT action, so an operator who
     * wanted their change on the row a workflow already points at is left with no route
     * except retyping it over a reload.
     *
     * Nothing here writes until one of the three is pressed, and none of them touches the
     * draft on the way in: the banner reports, it does not resolve.
     */
    return (
      <div className="wf-state conflict" role="alert">
        <span>
          A newer revision (r{conflict.revision}) exists. Your instruction has not been changed.
        </span>
        <Tooltip label="Discard your unsaved edits and load the newer revision">
          <button className="btn" onClick={onReload}>Reload latest</button>
        </Tooltip>
        <Tooltip
          label={`Write your edits onto revision ${conflict.revision}, keeping this the same session action`}
        >
          <button className="btn" onClick={onReapply}>Reapply my changes</button>
        </Tooltip>
        <Tooltip label="Keep your edits by saving them as a new session action">
          <button className="btn" onClick={onDuplicate}>Save as duplicate</button>
        </Tooltip>
      </div>
    );
  }
  return dirty ? <p className="wf-state dirty">Unsaved changes</p> : null;
}

export function SessionActionEditor({
  action,
  seed,
  capabilities,
  capabilitiesLoading = false,
  capabilityError = null,
  skills,
  isOverlayOpen,
  onDirtyChange,
  onSaved,
  onDuplicate,
  onArchive,
}: {
  action: SessionAction | null;
  seed?: SessionActionDraftSeed;
  /** What the DAEMON reported it can prove. Empty means nothing may be selected. */
  capabilities: readonly SessionActionCompletionCapability[];
  /** The capability read is still in flight, so silence is not a refusal. */
  capabilitiesLoading?: boolean;
  capabilityError?: string | null;
  /** The Mission Control skills catalog, for the optional required-skill picker. */
  skills: readonly SkillCatalogEntry[];
  isOverlayOpen: () => boolean;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: (action: SessionAction) => void;
  onDuplicate: (seed: SessionActionDraftSeed) => void;
  onArchive: (action: SessionAction) => void | Promise<void>;
}): React.JSX.Element {
  const [draft, setDraft] = useState<SessionActionDraftSeed>(
    () => action ? sessionActionSeed(action) : seed ?? EMPTY_SESSION_ACTION_SEED,
  );
  const draftRef = useRef(draft);
  /**
   * The seed the current draft STARTED from, which is what "my changes" are measured against.
   *
   * A separate ref because the `action` prop cannot answer it: the SSE upsert that raises a
   * conflict replaces `action` with the newer row, so by the time an operator presses Reapply
   * the prop holds the other tab's state rather than the one this draft diverged from.
   */
  const baselineRef = useRef(draft);
  const editGeneration = useRef(0);
  const [loadedRevision, setLoadedRevisionState] = useState(action?.revision ?? null);
  const [dirty, setDirtyState] = useState(false);
  /**
   * The revision this editor has ACCEPTED, and whether it holds unsaved text - both mirrored
   * in refs the reconciling effect below reads instead of its own closure.
   *
   * A passive effect runs after its render commits, and it keeps that render's values. A save
   * that finishes while an SSE upsert for the same write is in flight therefore leaves an
   * effect scheduled from BEFORE the save landed: it wakes holding the old revision, decides
   * the incoming row is newer, and raises a conflict against a revision the save has already
   * adopted. Nothing afterwards clears it, because every later run of the effect correctly
   * finds nothing new to report. Reading the refs makes the effect reconcile against what is
   * true now rather than against what was true when it was scheduled.
   */
  const loadedRevisionRef = useRef(loadedRevision);
  const dirtyRef = useRef(false);
  const setLoadedRevision = (next: number | null): void => {
    loadedRevisionRef.current = next;
    setLoadedRevisionState(next);
  };
  const setDirty = (next: boolean): void => {
    dirtyRef.current = next;
    setDirtyState(next);
  };
  const [conflict, setConflict] = useState<SessionAction | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [promptMode, setPromptMode] = useState<"editor" | "preview">("editor");
  const archived = action?.archivedAt != null;
  const builtin = action?.builtin === true;
  const readOnly = archived || builtin;

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  // An SSE upsert for this action may land while the editor owns typed text. A clean draft
  // follows it; a dirty one freezes and raises an explicit conflict without replacing a byte
  // of the instruction the operator is writing.
  useEffect(() => {
    // `<=`, and read from the ref: a row at or below what this editor has already accepted
    // reports nothing, whichever render scheduled this effect.
    if (!action || action.revision <= (loadedRevisionRef.current ?? 0)) return;
    if (dirtyRef.current) {
      setConflict(action);
      return;
    }
    const next = sessionActionSeed(action);
    draftRef.current = next;
    baselineRef.current = next;
    setDraft(next);
    setLoadedRevision(action.revision);
    setConflict(null);
  }, [action, dirty, loadedRevision]);

  const promptBytes = useMemo(
    () => new TextEncoder().encode(draft.promptMarkdown).byteLength,
    [draft.promptMarkdown],
  );
  const lineSeparator = useMemo(
    () => (draft.promptMarkdown.match(/\r\n|\r|\n/)?.[0] ?? "\n") as "\r\n" | "\r" | "\n",
    [draft.promptMarkdown],
  );
  const problem = sessionActionDraftProblem(draft, promptBytes);
  const choices = completionChoices(capabilities, draft.completionKind, capabilitiesLoading);
  const retainedCompletion = choices.find(
    (choice) => choice.kind === draft.completionKind && choice.disabled,
  );
  const promptPath = sessionActionPromptPath(draft.name);
  const skillUnlisted = draft.requiredSkillId !== null
    && !skills.some((skill) => skill.id === draft.requiredSkillId);

  function edit(patch: Partial<SessionActionDraftSeed>): void {
    const next = { ...draftRef.current, ...patch };
    editGeneration.current += 1;
    draftRef.current = next;
    setDraft(next);
    setDirty(true);
    setConflict(null);
    setError(null);
  }

  /** Adopt a server row wholesale: the draft becomes it, and there is nothing left in conflict. */
  function adopt(row: SessionAction): void {
    const next = sessionActionSeed(row);
    draftRef.current = next;
    baselineRef.current = next;
    setDraft(next);
    setLoadedRevision(row.revision);
    setDirty(false);
    setConflict(null);
    setError(null);
  }

  async function save(mode: SessionActionSaveMode = "save"): Promise<void> {
    if (readOnly || saving) return;
    // Only the ORDINARY save is suppressed when nothing changed. Reapply and Duplicate are
    // deliberate gestures on a conflicted editor, and the draft they act on is precisely the
    // one `dirty` is reporting.
    if (mode === "save" && action !== null && !dirty) return;
    const target = sessionActionSaveTarget({
      mode,
      action,
      conflict,
      loadedRevision,
      baseline: baselineRef.current,
    });
    if (!target) return;
    const submitted = draftRef.current;
    const submittedGeneration = editGeneration.current;
    // Measured from the text being SENT rather than from `promptBytes`, which is a memo over
    // render state. The two agree in every ordinary flow, and the one that matters is the
    // one where they might not: a save fired from the window-level Cmd+S handler closes over
    // whatever render registered it.
    const blocked = sessionActionDraftProblem(
      submitted,
      new TextEncoder().encode(submitted.promptMarkdown).byteLength,
    );
    if (blocked) {
      setError(blocked);
      return;
    }
    let updateBody: Record<string, unknown> | null = null;
    if (target.kind === "update") {
      updateBody = sessionActionPatchFrom(target.baseline, submitted, target.expectedRevision);
      // A patch carrying only `expectedRevision` is a save of nothing; the route refuses it,
      // and sending it would turn "no changes" into an error banner.
      if (Object.keys(updateBody).length === 1) {
        // For a REAPPLY that means the draft already says exactly what the newer revision
        // holds - the two tabs agreed - so adopting that revision IS the reapply, and it is
        // also the only thing that clears the conflict truthfully.
        // Nothing of the operator's survives as a difference, so the newer revision is
        // already what they wanted; adopting it IS the reapply.
        if (mode === "reapply") adopt(conflict!);
        else {
          setDirty(false);
          setConflict(null);
        }
        return;
      }
    }
    setSaving(true);
    setError(null);
    try {
      const body = target.kind === "create"
        // `sessionActionDraftProblem` already refused an empty name above, so the duplicate
        // suffix has a real name to attach to.
        ? sessionActionCreateBody({
            ...submitted,
            name: mode === "duplicate" ? `${submitted.name} copy` : submitted.name,
          })
        : updateBody!;
      const saved = await sessionActionRequest<SessionAction>(
        target.kind === "create"
          ? "/api/session-actions"
          : `/api/session-actions/${target.id}`,
        { method: target.kind === "create" ? "POST" : "PATCH", body: JSON.stringify(body) },
      );
      const reconciled = reconcileSessionActionSave(
        saved,
        submitted,
        draftRef.current,
        submittedGeneration,
        editGeneration.current,
      );
      draftRef.current = reconciled.draft;
      baselineRef.current = sessionActionSeed(saved);
      setDraft(reconciled.draft);
      setLoadedRevision(saved.revision);
      setDirty(reconciled.dirty);
      setConflict(null);
      onSaved(saved);
    } catch (cause) {
      const current = sessionActionConflict(cause, "session_action_revision_conflict");
      if (current) setConflict(current);
      setError(cause instanceof Error ? cause.message : "Could not save this session action");
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!isSessionActionSaveShortcut(event, isOverlayOpen())) return;
      event.preventDefault();
      void save();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function reload(): void {
    if (conflict) adopt(conflict);
  }

  const saveHint = builtin
    ? "Built-in session actions cannot be edited - use Duplicate"
    : archived
      ? "This session action is archived and cannot be edited"
      : problem
        ? problem
        : action !== null && !dirty
          ? "No unsaved changes"
          : "Save this session action as a new revision";

  return (
    <article
      className={`wf-action-editor${archived ? " is-archived" : ""}${builtin ? " is-builtin" : ""}`}
    >
      <header className="wf-action-editor-head">
        <div>
          <p className="workflow-eyebrow">
            {action
              ? (builtin ? "Built-in session action" : `Revision ${loadedRevision}`)
              : "New session action"}
          </p>
          <h3>{draft.name || "Untitled session action"}</h3>
        </div>
        <div className="wf-action-actions">
          <Tooltip label={saveHint}>
            <button
              className="btn"
              disabled={readOnly || saving || problem !== null || (action !== null && !dirty)}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </Tooltip>
          {action && (
            <Tooltip
              label={builtin
                ? "Start an editable copy of this built-in session action"
                : "Copy this session action into a new one"}
            >
              <button
                className="btn btn-ghost"
                onClick={() => onDuplicate({ ...draft, name: `${draft.name} copy` })}
              >
                Duplicate
              </button>
            </Tooltip>
          )}
          {action && !archived && !builtin && (
            <Tooltip label="Archive this session action - published versions keep their snapshot">
              <button className="btn btn-danger" onClick={() => void onArchive(action)}>
                Archive
              </button>
            </Tooltip>
          )}
        </div>
      </header>

      <SessionActionEditorStatus
        dirty={dirty}
        conflict={conflict}
        archived={archived}
        builtin={builtin}
        onReload={reload}
        onReapply={() => void save("reapply")}
        onDuplicate={() => void save("duplicate")}
      />
      {error && <p className="wf-error" role="alert">{error}</p>}
      {capabilityError && (
        <p className="wf-error" role="alert">
          {capabilityError} Until this daemon answers, no completion can be selected.
        </p>
      )}

      <section className="wf-action-fields">
        <label>
          <span>Name</span>
          <input
            value={draft.name}
            readOnly={readOnly}
            maxLength={WORKFLOW_LIMITS.sessionActionName}
            onChange={(event) => edit({ name: event.target.value })}
          />
        </label>
        <label>
          <span>Description</span>
          <input
            value={draft.description}
            readOnly={readOnly}
            maxLength={WORKFLOW_LIMITS.sessionActionDescription}
            onChange={(event) => edit({ description: event.target.value })}
          />
        </label>
        <label>
          <span>Required skill</span>
          <Tooltip label="A skill the bound session must have loaded before this instruction is sent. Optional.">
            <select
              value={draft.requiredSkillId ?? ""}
              disabled={readOnly}
              onChange={(event) => edit({ requiredSkillId: event.target.value || null })}
            >
              <option value="">No required skill</option>
              {/* A stored id this build's catalog no longer carries stays selectable so
                  opening the action cannot silently drop the requirement it was saved with. */}
              {skillUnlisted && (
                <option value={draft.requiredSkillId!}>
                  Unavailable: {draft.requiredSkillId}
                </option>
              )}
              {skills.map((skill) => (
                <option key={skill.id} value={skill.id}>{skill.name}</option>
              ))}
            </select>
          </Tooltip>
        </label>
        <label>
          <span>Completes when</span>
          <Tooltip label="What Mission Control must observe before the stages after this action run">
            <select
              value={draft.completionKind}
              disabled={readOnly}
              onChange={(event) =>
                edit({ completionKind: event.target.value as SessionActionCompletionKind })}
            >
              {choices.map((choice) => (
                <option key={choice.kind} value={choice.kind} disabled={choice.disabled}>
                  {choice.label}
                </option>
              ))}
            </select>
          </Tooltip>
        </label>
        <p className="wf-action-note">
          {retainedCompletion
            ? retainedCompletion.note
            : "Whatever the session changes while it works, Mission Control captures fresh"
              + " evidence afterwards and only the stages below this one review it."}
        </p>
      </section>

      <section className="wf-action-prompt" aria-label="Session action instruction">
        <header className="file-toolbar wf-action-prompt-toolbar">
          <span className="file-path mono">{promptPath}</span>
          <span className="file-language">Markdown</span>
          <span
            className={`file-size${
              promptBytes > WORKFLOW_LIMITS.sessionActionPromptBytes ? " is-over-limit" : ""}`}
          >
            {promptBytes.toLocaleString()} / {WORKFLOW_LIMITS.sessionActionPromptBytes.toLocaleString()} UTF-8 bytes
          </span>
          <span className="file-toolbar-spacer" />
          <div className="file-mode" role="group" aria-label="Session action instruction view">
            <Tooltip label="Render the instruction as the session will read it">
              <button
                className={promptMode === "preview" ? "on" : ""}
                aria-pressed={promptMode === "preview"}
                onClick={() => setPromptMode("preview")}
              >
                Preview
              </button>
            </Tooltip>
            <Tooltip label="Edit the exact Markdown the session receives">
              <button
                className={promptMode === "editor" ? "on" : ""}
                aria-pressed={promptMode === "editor"}
                onClick={() => setPromptMode("editor")}
              >
                Editor
              </button>
            </Tooltip>
          </div>
        </header>
        <div className="wf-action-prompt-content file-content">
          {promptMode === "editor" && (
            <div className="wf-action-editor-host" aria-label={`Editor for ${promptPath}`}>
              <FileEditor
                path={promptPath}
                value={draft.promptMarkdown}
                readOnly={readOnly}
                lineSeparator={lineSeparator}
                onChange={(promptMarkdown) => edit({ promptMarkdown })}
                onBlur={() => {}}
              />
            </div>
          )}
          {promptMode === "preview" && (
            <article className="wf-action-markdown file-markdown-preview markdown">
              {draft.promptMarkdown
                ? <Markdown>{draft.promptMarkdown}</Markdown>
                : <p>The session receives this text exactly as written.</p>}
            </article>
          )}
        </div>
      </section>
    </article>
  );
}
