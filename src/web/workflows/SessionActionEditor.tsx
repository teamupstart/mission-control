import { useEffect, useMemo, useRef, useState } from "react";
import {
  WORKFLOW_LIMITS,
  normalizeSessionActionName,
  sessionActionCompletionLabel,
} from "@shared/workflow.ts";
import type {
  SessionAction,
  SessionActionCompletion,
  SessionActionCompletionCapability,
  SessionActionCompletionKind,
} from "@shared/workflow.ts";
import type { SkillCatalogEntry } from "@shared/types.ts";
import { FileEditor } from "../components/FileEditor.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { Tooltip } from "../components/Tooltip.tsx";
import {
  LibraryPropertyChip,
  LibraryPropertyChips,
} from "../library/LibraryPropertyChip.tsx";
import {
  LibraryWorkspaceHeader,
  type LibraryMenuAction,
  type LibraryPrimaryAction,
} from "../library/LibraryWorkspaceHeader.tsx";
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

/**
 * Why the DAEMON's capability answer forbids this save, or null.
 *
 * Separate from `sessionActionDraftProblem` because it is a different question. That one asks
 * whether the operator's draft is well formed; this one asks whether this build can honour the
 * completion the write would assert. Folding them together was the gap: a brand-new action
 * defaults to `session_turn` and is perfectly well formed, so Save stayed enabled while the
 * selector beside it said no completion could be selected - the surface contradicting itself,
 * and the one boundary it exists to enforce quietly bypassed.
 *
 * `inherited` is what keeps this from breaking a documented behaviour. Duplicating the shipped
 * Pull Request action is SUPPOSED to carry its `pull_request` adapter across - the plan calls
 * for it, so an operator can customise the instruction without losing the PR verification -
 * and an update to an existing row carries whatever that row already holds. Neither asserts a
 * new choice, so neither is blocked. Only a write that PICKS a completion has to prove the
 * daemon can run it, and only that write is stopped while the answer is unknown.
 */
export function sessionActionCapabilityBlock(input: {
  /** The completion this save would write. */
  completionKind: SessionActionCompletionKind;
  /** What the daemon reported. Empty means unread, not "none". */
  capabilities: readonly SessionActionCompletionCapability[];
  /** The capability read is still in flight. */
  loading: boolean;
  /** See `sessionActionCompletionInherited` - the completion was carried, not chosen. */
  inherited: boolean;
}): string | null {
  const { completionKind, capabilities, loading, inherited } = input;
  if (inherited) return null;
  if (loading) return "Waiting for this daemon to report which completions it can prove.";
  if (capabilities.length === 0) {
    return "This daemon has not reported which completions it can prove, so a new session"
      + " action cannot be authored against it yet.";
  }
  const capability = capabilities.find((candidate) => candidate.kind === completionKind);
  if (capability?.available) return null;
  return capability?.unavailableReason
    ?? "This build cannot prove the completion this session action names.";
}

/**
 * Whether the completion a save would write was CARRIED from a real row rather than chosen
 * here - the one input `sessionActionCapabilityBlock` turns on.
 *
 * Two facts, and the first pass shipped only half of the first. `action !== null` looked like
 * the whole question and is not: **Duplicate opens a new editor**, seeded from the source and
 * holding no `action`, so a copy of the shipped Pull Request action read as somebody freshly
 * choosing `pull_request` and could never be saved. That is the advertised "Duplicate it to
 * make a copy you own" path, dead until the adapter ships.
 *
 * So the question is asked of the DRAFT's own history instead:
 *
 *  - `baselineInherited` - the draft started from an existing row (loaded, or duplicated),
 *    rather than from the blank New seed whose `session_turn` default nobody picked;
 *  - the completion still equals that starting value. Change it and the operator has made a
 *    choice, which has to prove itself however the draft began.
 */
export function sessionActionCompletionInherited(input: {
  baselineInherited: boolean;
  baselineCompletionKind: SessionActionCompletionKind;
  completionKind: SessionActionCompletionKind;
}): boolean {
  return input.baselineInherited && input.completionKind === input.baselineCompletionKind;
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
 * Once the daemon has answered it renders disabled, so it can be read and never chosen.
 *
 * `disabled` on that arm therefore means REFUSED, and it is the one fact the editor's chip
 * marks itself from. It is deliberately not "absent from what was offered", which would also
 * be true of every action while nothing has been offered yet.
 */
export function completionChoices(
  capabilities: readonly SessionActionCompletionCapability[],
  selected: SessionActionCompletionKind,
  /**
   * Whether the capability read is still in flight.
   *
   * Without it the retained arm below fires for the ~one round trip before the daemon
   * answers, and every freshly opened action briefly accuses itself of naming a completion
   * this build cannot prove. Loading is not a refusal, so the arm says nothing, is not
   * struck out, and does not mark the chip that reads it.
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
      // `disabled` on this arm means REFUSED - the daemon was asked and cannot prove this
      // one - which is why it also drives the chip's mark. A read still in flight has
      // refused nothing, so the arm holds the value without greying it out: an operator who
      // opened the picker mid-fetch was shown a single option, struck through, which is the
      // same false claim the chip used to make with a colour.
      disabled: !loading,
      note: loading
        ? null
        : capabilities.length === 0
          // No answer at all is NOT the same as an answer of no. Saying "this build cannot
          // prove it" here sends an operator looking for a missing feature when what is
          // actually missing is the daemon's reply.
          ? "This daemon has not said which completions it can prove yet."
          : retained?.unavailableReason ?? "This build cannot prove this completion.",
    },
    ...offered,
  ];
}

/**
 * When the row behind this editor was last written, as the dim line under its name.
 *
 * Null for a draft, which has no history to state, and null for a built-in: the eyebrow above
 * it already says `Built-in session action` and the status line below says what that means, so
 * a third sentence about the same fact is three places to read the same thing. This replaces
 * the rail's fourth `small` per row - a revision and a timestamp on every row was provenance
 * about four actions at once, none of which was the one open.
 */
export function sessionActionUpdatedLine(action: SessionAction | null): string | null {
  if (action === null || action.builtin) return null;
  return `Updated ${new Date(action.updatedAt).toLocaleString()}`;
}

/**
 * Everything the header does NOT promote, as data.
 *
 * A list rather than markup, for `personaOverflowActions`'s reason: which verbs a built-in, an
 * archived row and an unsaved draft each offer is behaviour, and asserting it about the
 * buttons rather than about the row they sit in is what survives a rearrangement of the
 * header. Their labels are unchanged - a menu is where they live now, not what they are
 * called.
 *
 * A read-only action returns an EMPTY list, and the menu renders nothing at all rather than a
 * `⋯` with nothing behind it: Duplicate is the promoted verb there, and Archive is a write a
 * built-in cannot take.
 */
export function sessionActionOverflowActions({
  action,
  builtin,
  archived,
  onDuplicate,
  onArchive,
}: {
  action: boolean;
  builtin: boolean;
  archived: boolean;
  onDuplicate: () => void;
  onArchive: () => void;
}): LibraryMenuAction[] {
  const actions: LibraryMenuAction[] = [];
  // Not on a read-only action, where Duplicate is the promoted verb: offering it twice makes
  // the more prominent one the one nobody can find again later.
  if (action && !archived && !builtin) {
    actions.push({
      id: "duplicate",
      label: "Duplicate",
      hint: "Copy this session action into a new one",
      onSelect: onDuplicate,
    });
    actions.push({
      id: "archive",
      label: "Archive",
      hint: "Archive this session action - published versions keep their snapshot",
      danger: true,
      onSelect: onArchive,
    });
  }
  return actions;
}

/**
 * The required-skill `select`, lifted out of the four-across field row into the chip's
 * popover.
 *
 * Exported because a closed popover renders nothing and `renderToStaticMarkup` cannot open
 * one - so the rule worth asserting (a stored id this build's catalog no longer carries stays
 * selectable rather than vanishing) would otherwise have no test at all. The same split, for
 * the same reason, as `PersonaProviderControl`.
 */
export function SessionActionSkillControl({
  skills,
  value,
  unlisted,
  disabled,
  onChange,
}: {
  skills: readonly SkillCatalogEntry[];
  value: string | null;
  /** The stored id is not in this build's catalog - or the catalog has not been read yet. */
  unlisted: boolean;
  disabled: boolean;
  onChange: (skillId: string | null) => void;
}): React.JSX.Element {
  return (
    <label className="wf-action-chip-field">
      <span>Required skill</span>
      <Tooltip label="A skill the bound session must have loaded before this instruction is sent. Optional.">
        <select
          value={value ?? ""}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value || null)}
        >
          <option value="">No required skill</option>
          {/* A stored id this build's catalog no longer carries stays selectable so opening
              the action cannot silently drop the requirement it was saved with. */}
          {unlisted && value !== null && <option value={value}>Unavailable: {value}</option>}
          {skills.map((skill) => (
            <option key={skill.id} value={skill.id}>{skill.name}</option>
          ))}
        </select>
      </Tooltip>
    </label>
  );
}

/** The completion `select` and its options, in the completion chip's popover. See above. */
export function SessionActionCompletionControl({
  choices,
  value,
  disabled,
  onChange,
}: {
  choices: ReturnType<typeof completionChoices>;
  value: SessionActionCompletionKind;
  disabled: boolean;
  onChange: (kind: SessionActionCompletionKind) => void;
}): React.JSX.Element {
  return (
    <label className="wf-action-chip-field">
      <span>Completes when</span>
      <Tooltip label="What Mission Control must observe before the stages after this action run">
        <select
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value as SessionActionCompletionKind)}
        >
          {choices.map((choice) => (
            <option key={choice.kind} value={choice.kind} disabled={choice.disabled}>
              {choice.label}
            </option>
          ))}
        </select>
      </Tooltip>
    </label>
  );
}

/**
 * The contract, as the one sentence the two chips above it form.
 *
 * An Action is the only Library asset carrying a machine-checked contract - a skill that has
 * to be present on the bound session, and something OBSERVABLE that has to happen before a
 * stage may call it done - and the screen had never stated it. Two unlabelled selects sitting
 * third and fourth in a row of four fields do not say "requires `pull-request`, completes on a
 * verified pull request" to anybody; written out, "requires `retro`, completes when a commit
 * lands" is obviously coherent and "requires `pull-request`, completes when the turn finishes"
 * is obviously suspicious.
 *
 * The completion clause is the SHARED string, printed rather than paraphrased.
 * `test/session-action-completion-copy.test.ts` pins that no browser surface re-derives this
 * sentence from a two-armed test on the kind, and the reason is stronger here than anywhere
 * else it applies: this line's whole job is to state the guarantee, so a confident wrong one
 * is worse than none. It also makes the chip and the sentence agree letter for letter, which
 * is what tells a reader they are two views of one value rather than two claims.
 */
export function SessionActionContractLine({
  requiredSkillId,
  completion,
}: {
  requiredSkillId: string | null;
  completion: SessionActionCompletion;
}): React.JSX.Element {
  return (
    <p className="wf-action-contract">
      The stage sends this instruction to the bound session,{" "}
      {requiredSkillId === null
        ? "whatever skills that session has loaded."
        : <>which must be able to invoke the <code>{requiredSkillId}</code> skill.</>}
      {" "}Mission Control calls it done when it observes{" "}
      <b>{sessionActionCompletionLabel(completion)}</b>, never because the session said so.
      Whatever changed while it worked, fresh evidence is captured afterwards and only the
      stages below this one read it.
    </p>
  );
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
  seedInherited = false,
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
  /**
   * The `seed` was copied from an existing action rather than started blank.
   *
   * Only Duplicate sets it. It is what lets a copy of the shipped Pull Request action keep the
   * `pull_request` adapter it was duplicated FOR, while a blank New draft still has to prove
   * its `session_turn` default against what the daemon reported.
   */
  seedInherited?: boolean;
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
  /** Whether `baselineRef` came from a real row - a loaded action, or a duplicated source. */
  const baselineInheritedRef = useRef(action !== null || seedInherited);
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
    baselineInheritedRef.current = true;
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
  const capabilityBlock = sessionActionCapabilityBlock({
    completionKind: draft.completionKind,
    capabilities,
    loading: capabilitiesLoading,
    inherited: sessionActionCompletionInherited({
      baselineInherited: baselineInheritedRef.current,
      baselineCompletionKind: baselineRef.current.completionKind,
      completionKind: draft.completionKind,
    }),
  });
  const choices = completionChoices(capabilities, draft.completionKind, capabilitiesLoading);
  /*
   * The stored completion this build cannot prove, and the single fact behind the chip's mark,
   * its tooltip and the note beneath the chips.
   *
   * It reads `disabled`, which `completionChoices` defines as REFUSED - the daemon was asked
   * and cannot prove this one - rather than as "not offered". The difference is the review
   * finding: "not offered" is true of every action for the round trip before the answer lands,
   * because nothing has been offered yet, so this drew amber and claimed "This build cannot
   * prove the completion this action names" about `session_turn`, on a daemon that plainly
   * runs it. That is a false statement on the one surface whose whole job is to state a
   * guarantee, not a cosmetic flash.
   *
   * Loading is not a refusal, so there is nothing to mark until the answer is in. The honest
   * signal for a pending read is Save standing down with `sessionActionCapabilityBlock`'s
   * "Waiting for this daemon to report which completions it can prove", which is unchanged.
   * An empty answer once the read has FINISHED does mark, because "the daemon never said" is a
   * state to act on where "the daemon has not said yet" is one to wait through.
   */
  const retainedCompletion = choices.find(
    (choice) => choice.kind === draft.completionKind && choice.disabled,
  );
  /*
   * What the closed chip reads: the SHARED clause, by the same call the contract line beneath
   * it makes.
   *
   * This read the daemon's `label` off the matching choice, which was wrong in the one way
   * this screen cannot afford. The chip and the contract line are two views of a single value
   * - that is the whole reason the line reads letter for letter like the chip above it - and
   * sourcing them differently made "the completion sentence has exactly one owner" false the
   * moment a daemon a version ahead worded its capability differently. Two strings for one
   * stored completion, on one screen, with nothing to say which was the contract.
   *
   * The `select` inside the popover still lists what the DAEMON said, in the daemon's words,
   * because it is a picker over what that daemon can prove rather than a statement of what
   * this action promises. `completionChoices` owns that, unchanged.
   */
  const completionValue = sessionActionCompletionLabel({ kind: draft.completionKind });
  const promptOverLimit = promptBytes > WORKFLOW_LIMITS.sessionActionPromptBytes;
  const promptPath = sessionActionPromptPath(draft.name);
  /*
   * True for a stored id this build's catalog does not carry - and also for the ~one round
   * trip before the catalog is read at all, which is why it only keeps the option selectable
   * and never marks the chip. Loading is not a refusal; the completion capability code
   * upstream learned the same lesson the harder way.
   */
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
    baselineInheritedRef.current = true;
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
    // Re-asked here rather than trusted from the disabled button: the window-level Cmd+S
    // handler reaches this function without passing one. `inherited` is widened to every mode
    // but an ordinary save of a NEW row - a duplicate carries its source's adapter across on
    // purpose, and an update carries whatever the row already holds.
    const refused = sessionActionCapabilityBlock({
      completionKind: submitted.completionKind,
      capabilities,
      loading: capabilitiesLoading,
      inherited: sessionActionCompletionInherited({
        baselineInherited: baselineInheritedRef.current,
        baselineCompletionKind: baselineRef.current.completionKind,
        completionKind: submitted.completionKind,
      }),
    });
    if (refused) {
      setError(refused);
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
      baselineInheritedRef.current = true;
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

  const saveHint = problem
    ? problem
    : capabilityBlock
      ? capabilityBlock
      : action !== null && !dirty
        ? "No unsaved changes"
        : "Save this session action as a new revision";
  const duplicate = (): void => onDuplicate({ ...draft, name: `${draft.name} copy` });
  /*
   * ONE promoted verb, and on a read-only action it is Duplicate rather than a disabled Save.
   * Save sat first in the row permanently greyed out on both shipped actions, which reads as
   * "the thing you want, unavailable" - when the thing you want was one control to its right
   * and perfectly available. Nothing is hidden by this: Save is not offered because there is
   * no revision this editor could write.
   */
  const primary: LibraryPrimaryAction = readOnly && action
    ? {
      label: "Duplicate to edit",
      hint: builtin
        ? "Start an editable copy of this built-in session action"
        : "Start an editable copy of this archived session action",
      onClick: duplicate,
    }
    : {
      label: saving ? "Saving…" : "Save",
      hint: saveHint,
      disabled: readOnly
        || saving
        || problem !== null
        || capabilityBlock !== null
        || (action !== null && !dirty),
      onClick: () => void save(),
    };
  const overflow = sessionActionOverflowActions({
    action: action !== null,
    builtin,
    archived,
    onDuplicate: duplicate,
    onArchive: () => {
      if (action) void onArchive(action);
    },
  });
  const updated = sessionActionUpdatedLine(action);

  return (
    <article
      className={`wf-action-editor${archived ? " is-archived" : ""}${builtin ? " is-builtin" : ""}`}
    >
      <LibraryWorkspaceHeader
        className="wf-action-editor-head"
        // `wf-action-fields` no longer names a grid of four. It names the header's identity
        // block - this action's own scalar fields, name and description - now that the
        // required skill and the completion have become chips. The class stays because it
        // still names exactly that, and because three Playwright specs reach the Name and
        // Description inputs through it.
        titleClassName="wf-action-fields"
        title={
          <>
            {/* The visible title IS the Name field now, rather than a heading printing the
                same string a labelled input three rows below also held. The document still
                needs a heading, so it keeps one only a screen reader reads. */}
            <h2 className="sr-only">{draft.name || "Untitled session action"}</h2>
            <div className="lib-work-name">
              <label className="lib-work-name-field">
                <span className="sr-only">Name</span>
                <input
                  value={draft.name}
                  readOnly={readOnly}
                  maxLength={WORKFLOW_LIMITS.sessionActionName}
                  placeholder="Untitled session action"
                  onChange={(event) => edit({ name: event.target.value })}
                />
              </label>
              {builtin && <span className="lib-tag lib-tag-builtin">built-in</span>}
            </div>
          </>
        }
        subtitle={
          <label className="lib-work-subtitle">
            <span className="sr-only">Description</span>
            <input
              value={draft.description}
              readOnly={readOnly}
              maxLength={WORKFLOW_LIMITS.sessionActionDescription}
              placeholder="One line on what this instruction does"
              onChange={(event) => edit({ description: event.target.value })}
            />
          </label>
        }
        meta={
          <div className="lib-work-meta">
            <p className="workflow-eyebrow">
              {action
                ? (builtin ? "Built-in session action" : `Revision ${loadedRevision}`)
                : "New session action"}
            </p>
            {updated && <p className="wf-action-updated">{updated}</p>}
          </div>
        }
        primary={primary}
        menuLabel="More session action options"
        actions={overflow}
      />

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
          This daemon has not said which completions it can prove, so a new session action
          cannot be authored against it yet. <code>{capabilityError}</code>
        </p>
      )}

      <LibraryPropertyChips>
        <LibraryPropertyChip
          name="requires skill"
          value={draft.requiredSkillId ?? "none"}
          mono={draft.requiredSkillId !== null}
          // Quiet when this action asks for nothing, solid when it does: an action with no
          // required skill is not inheriting a default, it is asserting nothing, and the row
          // reads the same way either way - solid means "this asset says something".
          state={draft.requiredSkillId === null ? "inherited" : "overridden"}
          tooltip={draft.requiredSkillId === null
            ? "This action requires no skill - open to require one before it is sent"
            : "The bound session must be able to invoke this skill before the instruction is sent"}
          controlLabel="Required skill"
        >
          <SessionActionSkillControl
            skills={skills}
            value={draft.requiredSkillId}
            unlisted={skillUnlisted}
            disabled={readOnly}
            onChange={(requiredSkillId) => edit({ requiredSkillId })}
          />
        </LibraryPropertyChip>
        <LibraryPropertyChip
          name="completes when"
          value={completionValue}
          // Always solid: every action names a completion, and none of them inherits one.
          state="overridden"
          // Marked, and readable while shut, rather than a disabled option inside a closed
          // dropdown. A stored completion this build cannot prove is the one fact on this row
          // that is waiting on somebody, and it was previously invisible until you opened the
          // select that could not offer it.
          tone={retainedCompletion ? "attention" : undefined}
          tooltip={retainedCompletion
            ? "This build cannot prove the completion this action names - it is kept, not offered"
            : "What Mission Control must observe before the stages after this action run"}
          controlLabel="Completes when"
        >
          <SessionActionCompletionControl
            choices={choices}
            value={draft.completionKind}
            disabled={readOnly}
            onChange={(completionKind) => edit({ completionKind })}
          />
        </LibraryPropertyChip>
        {/* The instruction's exact size, as a property of the asset rather than a span in the
            file toolbar - where it was the one toolbar in the app carrying one. */}
        <LibraryPropertyChip
          name="utf-8 bytes"
          value={`${promptBytes.toLocaleString()} / ${WORKFLOW_LIMITS.sessionActionPromptBytes.toLocaleString()}`}
          mono
          align="end"
          tone={promptOverLimit ? "danger" : undefined}
          tooltip={promptOverLimit
            ? "The instruction is over the byte limit and cannot be saved until it is shorter"
            : "Exact UTF-8 size of the instruction, against the ceiling a delivery packet can carry"}
        />
      </LibraryPropertyChips>
      {/* Kept on the face rather than inside the chip's popover: a completion this build
          cannot prove is something to act on, and a closed chip that read as an ordinary
          choice would report a guarantee nothing here can keep. */}
      {retainedCompletion?.note && (
        <p className="lib-props-note">{retainedCompletion.note}</p>
      )}

      <SessionActionContractLine
        requiredSkillId={draft.requiredSkillId}
        completion={{ kind: draft.completionKind }}
      />

      <section className="wf-action-prompt" aria-label="Session action instruction">
        <header className="file-toolbar wf-action-prompt-toolbar">
          <span className="file-path mono">{promptPath}</span>
          <span className="file-language">Markdown</span>
          {/* The byte count is a property of the asset, so it is a property chip above with
              the contract it belongs to. It was here and in no other file toolbar in the app,
              which is what made this one wider than it needed to be. */}
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
      {/*
       * The "used by" slot. Phase 5 fills it - which workflows send this action, and whether
       * a run is waiting on it right now - and until then nothing renders here.
       *
       * Deliberately not an empty strip with the label already in it. A person reading
       * "used by" over blank space concludes the question was asked and the answer was
       * "nothing", and for an action a published workflow sends that is the worst of the
       * three things this screen could say. The reference is not derivable in the browser -
       * an action id lives only inside a workflow graph, which the SSE snapshot does not
       * carry - so a half-answer here would be a guess rather than a partial.
       */}
    </article>
  );
}
