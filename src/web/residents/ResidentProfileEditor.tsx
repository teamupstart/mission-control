import { useState } from "react";
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
}: {
  /** The profile being edited, or null for a new one. The parent keys this per profile. */
  profile: ResidentProfile | null;
  personas: readonly PersonaView[];
  onSaved: (profile: ResidentProfile) => void;
  onArchived: (profile: ResidentProfile) => void;
  onLaunch: (profile: ResidentProfile) => void;
  onDirtyChange?: (dirty: boolean) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<ResidentProfileRevision>(() => profile?.settings ?? blankResidentDraft());
  const [dirty, setDirtyState] = useState(profile === null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setDirty = (next: boolean): void => {
    setDirtyState(next);
    onDirtyChange?.(next);
  };

  const update = <K extends ResidentProfileSectionId>(id: K, value: ResidentProfileRevision[K]): void => {
    setDraft((current) => ({ ...current, [id]: value }));
    setDirty(true);
    setError(null);
  };

  const problem = residentDraftProblem(draft);

  async function save(): Promise<void> {
    if (problem || busy) return;
    setBusy(true);
    setError(null);
    try {
      const parsed = ResidentProfileRevisionRequestSchema.parse(draft);
      const saved = profile
        ? await updateResidentProfile(profile.id, profile.revision, parsed)
        : await createResidentProfile(parsed);
      setDraft(saved.settings);
      setDirty(false);
      onSaved(saved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save this profile");
    } finally {
      setBusy(false);
    }
  }

  async function archive(): Promise<void> {
    if (!profile || busy) return;
    setBusy(true);
    setError(null);
    try {
      const archived = await archiveResidentProfile(profile.id, profile.revision);
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
            {profile
              ? `Revision ${profile.revision}${dirty ? " · unsaved changes" : ""}. Edits apply at the next launch.`
              : "Not saved yet."}
          </p>
        </div>
        <div className="resident-editor-actions">
          {profile && (
            <Tooltip label="Move this profile to the archive; running residents keep their revision">
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void archive()}>
                Archive
              </button>
            </Tooltip>
          )}
          <Tooltip label={problem ?? (dirty ? "Save these settings as a new revision" : "Nothing to save")}>
            <button
              type="button"
              className="btn"
              disabled={busy || !dirty || problem !== null}
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
              disabled={!profile || dirty || busy}
              onClick={() => profile && onLaunch(profile)}
            >
              Launch
            </button>
          </Tooltip>
        </div>
      </header>
      {error && <p className="resident-error" role="alert">{error}</p>}
      {!error && dirty && problem && <p className="field-hint resident-problem">{problem}</p>}
      {RESIDENT_EDITOR_SECTIONS.map(({ id, title: heading, blurb, Body }) => (
        <section key={id} className="resident-section" aria-labelledby={`resident-section-${id}`}>
          <h4 id={`resident-section-${id}`}>{heading}</h4>
          <p className="resident-section-blurb">{blurb}</p>
          <Body draft={draft} update={update} personas={personas} disabled={busy} />
        </section>
      ))}
    </section>
  );
}
