import { useEffect, useState } from "react";
import {
  RESIDENT_PROFILE_SECTIONS,
  RESIDENT_PROFILE_SECTION_IDS,
  ResidentProfileRevisionRequestSchema,
  type ResidentProfile,
  type ResidentProfileRevision,
  type ResidentProfileSectionId,
} from "@shared/residents.ts";
import type { PersonaView } from "@shared/workflow.ts";
import { Tooltip } from "../components/Tooltip.tsx";
import {
  ResidentRequestError,
  archiveResidentProfile,
  createResidentProfile,
  updateResidentProfile,
} from "./api.ts";
import { RESIDENT_EDITOR_SECTIONS } from "./editor-sections.tsx";
import { WorkflowConfirmModal, type WorkflowConfirmRequest } from "../workflows/WorkflowConfirmModal.tsx";

/**
 * A new profile's draft: no name and no Persona yet, and every other section at its schema
 * default - read from the section registry, so a section a later phase appends arrives here
 * with its defaults and no edit to this function.
 */
export function blankResidentDraft(): ResidentProfileRevision {
  const required = { identity: { name: "", description: "" }, persona: { personaId: "" } };
  const defaulted = Object.fromEntries(
    RESIDENT_PROFILE_SECTION_IDS
      .filter((id) => !(id in required))
      .map((id) => [id, RESIDENT_PROFILE_SECTIONS[id].parse(undefined)]),
  );
  return { ...defaulted, ...required } as ResidentProfileRevision;
}

/** The first thing wrong with a draft, in the operator's words, or null when it can be saved. */
export function residentDraftProblem(draft: ResidentProfileRevision): string | null {
  const parsed = ResidentProfileRevisionRequestSchema.safeParse(draft);
  if (parsed.success) return null;
  return parsed.error.issues[0]?.message ?? "This profile cannot be saved yet.";
}

/**
 * The editor for one resident profile, or for a new one.
 *
 * Every save writes a new immutable revision, compare-and-set on the revision this editor
 * opened; a resident already running keeps the revision it launched with. Sections render from
 * `RESIDENT_EDITOR_SECTIONS`, so a later phase adds its controls by registering a section.
 */
export function ResidentProfileEditor({
  profile,
  personas,
  onSaved,
  onArchived,
  onLaunch,
  onDirtyChange,
  onCreatePersona,
  archivedElsewhere = false,
}: {
  /** The profile being edited, or null for a new one. The parent keys this per profile. */
  profile: ResidentProfile | null;
  /**
   * Another window archived this profile while the draft here had unsaved edits. The editor
   * stays mounted to say so: the draft can be read and copied, then discarded, but not saved.
   */
  archivedElsewhere?: boolean;
  personas: readonly PersonaView[];
  onSaved: (profile: ResidentProfile) => void;
  onArchived: (profile: ResidentProfile) => void;
  onLaunch: (profile: ResidentProfile) => void;
  onDirtyChange?: (dirty: boolean) => void;
  /** Open the Library's blank Persona editor, offered at the end of the Persona picker. */
  onCreatePersona?: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<ResidentProfileRevision>(() => profile?.settings ?? blankResidentDraft());
  const [dirty, setDirtyState] = useState(profile === null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<WorkflowConfirmRequest | null>(null);
  const setDirty = (next: boolean): void => {
    setDirtyState(next);
    onDirtyChange?.(next);
  };
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  /**
   * The revision this draft was seeded from. Saves and archives compare-and-set against it, and
   * the editor stays mounted when the catalog moves on: a revision saved elsewhere replaces a
   * clean draft, and is held as a visible conflict over a dirty one rather than discarding it.
   */
  const [base, setBase] = useState<ResidentProfile | null>(profile);
  const newer = profile && base && profile.id === base.id && profile.revision > base.revision
    ? profile
    : null;
  if (newer && !dirty) {
    setBase(newer);
    setDraft(newer.settings);
  }
  const conflict = newer && dirty && !archivedElsewhere ? newer : null;

  const update = <K extends ResidentProfileSectionId>(id: K, value: ResidentProfileRevision[K]): void => {
    setDraft((current) => ({ ...current, [id]: value }));
    setDirty(true);
    setError(null);
  };

  const problem = residentDraftProblem(draft);

  /** Save the draft, on top of `expectedRevision` - the base, or a newer one the operator chose to overwrite. */
  async function save(expectedRevision = base?.revision ?? null): Promise<void> {
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      const parsed = ResidentProfileRevisionRequestSchema.parse(draft);
      const saved = base && expectedRevision !== null
        ? await updateResidentProfile(base.id, expectedRevision, parsed)
        : await createResidentProfile(parsed);
      setBase(saved);
      setDraft(saved.settings);
      setDirty(false);
      onSaved(saved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save this profile");
    } finally {
      setBusy(false);
    }
  }

  /** Discard the draft and adopt the revision saved elsewhere. */
  function loadNewer(): void {
    if (!conflict) return;
    setBase(conflict);
    setDraft(conflict.settings);
    setDirty(false);
    setError(null);
  }

  /**
   * Archive, asking first when there are unsaved edits: archiving closes the editor, and a draft
   * is never thrown away without the operator choosing to. One dialog for both decisions, as the
   * Persona library does.
   */
  function requestArchive(): void {
    if (!base || busy) return;
    if (!dirty) {
      void archive();
      return;
    }
    setConfirm({
      title: `Archive ${base.name}`,
      body: `Unsaved changes in the editor are discarded. ${base.name} moves to the archive and `
        + "stops being offered in Dispatch; running residents keep the revision they launched with.",
      confirmLabel: "Discard changes and archive",
      confirmHint: "Throw the unsaved edits away and archive this profile",
      cancelHint: "Keep editing; nothing is archived",
      danger: true,
      onConfirm: () => void archive(),
    });
  }

  async function archive(): Promise<void> {
    if (!base || busy) return;
    setBusy(true);
    setError(null);
    try {
      const archived = await archiveResidentProfile(base.id, base.revision);
      setDirty(false);
      onArchived(archived);
    } catch (cause) {
      setError(cause instanceof ResidentRequestError || cause instanceof Error
        ? cause.message
        : "Could not archive this profile");
    } finally {
      setBusy(false);
    }
  }

  const title = draft.identity.name.trim() || (profile ? profile.name : "New resident");
  return (
    <section className="resident-editor" aria-label={profile ? `Resident profile ${profile.name}` : "New resident profile"}>
      <header className="resident-editor-head">
        <div>
          <h3>{title}</h3>
          <p className="resident-editor-meta">
            {base
              ? `Revision ${base.revision}${dirty ? " · unsaved changes" : ""}. Edits apply at the next launch.`
              : "Not saved yet."}
          </p>
        </div>
        <div className="resident-editor-actions">
          {profile && (
            <Tooltip label="Move this profile to the archive; running residents keep their revision">
              <button type="button" className="btn btn-ghost" disabled={busy || archivedElsewhere} onClick={requestArchive}>
                Archive
              </button>
            </Tooltip>
          )}
          <Tooltip
            label={archivedElsewhere
              ? "This profile was archived elsewhere, so there is nothing to save to"
              : conflict
              ? "A newer revision was saved elsewhere; choose below whether to keep yours"
              : problem ?? (dirty ? "Save these settings as a new revision" : "Nothing to save")}
          >
            <button
              type="button"
              className="btn"
              disabled={busy || !dirty || problem !== null || conflict !== null || archivedElsewhere}
              onClick={() => void save()}
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </Tooltip>
          <Tooltip
            label={!profile
              ? "Save the profile before launching it"
              : dirty
                ? "Save or discard your changes before launching"
                : "Launch this resident from Dispatch"}
          >
            <button
              type="button"
              className="btn btn-primary"
              disabled={!profile || dirty || busy || archivedElsewhere}
              onClick={() => profile && onLaunch(profile)}
            >
              Launch
            </button>
          </Tooltip>
        </div>
      </header>
      {archivedElsewhere && (
        <div className="resident-conflict" role="alert">
          <p>
            This profile was archived elsewhere while you were editing. Your unsaved changes are
            still here to copy; they can no longer be saved to it.
          </p>
          <div className="resident-conflict-actions">
            <Tooltip label="Discard your changes and close this profile">
              <button type="button" className="btn btn-ghost" onClick={() => setDirty(false)}>
                Discard changes
              </button>
            </Tooltip>
          </div>
        </div>
      )}
      {conflict && (
        <div className="resident-conflict" role="alert">
          <p>
            Revision {conflict.revision} of this profile was saved elsewhere while you were editing.
            Your unsaved changes are still here.
          </p>
          <div className="resident-conflict-actions">
            <Tooltip label={`Discard your changes and show revision ${conflict.revision}`}>
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={loadNewer}>
                Load revision {conflict.revision}
              </button>
            </Tooltip>
            <Tooltip label={problem ?? `Save your changes as the revision after ${conflict.revision}`}>
              <button
                type="button"
                className="btn"
                disabled={busy || problem !== null}
                onClick={() => void save(conflict.revision)}
              >
                Save mine over it
              </button>
            </Tooltip>
          </div>
        </div>
      )}
      {error && <p className="resident-error" role="alert">{error}</p>}
      {!error && dirty && problem && <p className="field-hint resident-problem">{problem}</p>}
      {RESIDENT_EDITOR_SECTIONS.map(({ id, title: heading, blurb, Body }) => (
        <section key={id} className="resident-section" aria-labelledby={`resident-section-${id}`}>
          <h4 id={`resident-section-${id}`}>{heading}</h4>
          <p className="resident-section-blurb">{blurb}</p>
          <Body draft={draft} update={update} personas={personas} disabled={busy} onCreatePersona={onCreatePersona} />
        </section>
      ))}
      {confirm && <WorkflowConfirmModal request={confirm} onClose={() => setConfirm(null)} />}
    </section>
  );
}
