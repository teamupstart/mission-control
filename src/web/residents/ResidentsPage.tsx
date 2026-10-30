import { useState } from "react";
import { AGENT_IDENTITY } from "@shared/agent.ts";
import type { ResidentProfile } from "@shared/residents.ts";
import type { PersonaView } from "@shared/workflow.ts";
import { Tooltip } from "../components/Tooltip.tsx";
import { LibraryRailGroup, LibraryRailRow } from "../library/LibraryRail.tsx";
import { WorkflowConfirmModal, type WorkflowConfirmRequest } from "../workflows/WorkflowConfirmModal.tsx";
import { ResidentProfileEditor } from "./ResidentProfileEditor.tsx";

/** The rail row's distinguishing facts: whose role it is, and on which harness. */
export function residentProfileFact(profile: ResidentProfile, personas: readonly PersonaView[]): string {
  const persona = personas.find((candidate) => candidate.id === profile.settings.persona.personaId);
  return [
    persona?.name ?? "missing Persona",
    AGENT_IDENTITY[profile.settings.execution.agent].label,
    profile.settings.execution.model ?? "default model",
  ].join(" · ");
}

/**
 * `#/residents`: author resident profiles and launch them.
 *
 * A rail of live profiles beside the editor, on the Library's rail primitives. The profiles
 * are the SSE `residentProfiles` collection, so a save here or anywhere else reaches the rail
 * through the same frame. Launch hands the profile to Dispatch's Resident mode, which owns
 * the repository and run instructions and is the one place a launch is submitted.
 */
export function ResidentsPage({
  profiles,
  personas,
  selectedId,
  onSelect,
  onLaunch,
}: {
  profiles: readonly ResidentProfile[];
  personas: readonly PersonaView[];
  /** From the route. Null shows the rail with nothing open. */
  selectedId: string | null;
  onSelect: (profileId: string | null) => void;
  onLaunch: (profile: ResidentProfile) => void;
}): React.JSX.Element {
  const [creating, setCreating] = useState(false);
  const [dirty, setDirty] = useState(false);
  // A profile saved or archived here may beat its SSE frame back; hold it until the frame lands.
  const [local, setLocal] = useState<ResidentProfile | null>(null);
  const [confirm, setConfirm] = useState<WorkflowConfirmRequest | null>(null);
  // The newer of the catalog's copy and one saved here, whichever frame arrived first.
  const fromCatalog = selectedId ? profiles.find((profile) => profile.id === selectedId) ?? null : null;
  const selected = local && local.id === selectedId && (!fromCatalog || local.revision > fromCatalog.revision)
    ? local
    : fromCatalog;

  const leave = (next: () => void): void => {
    const go = (): void => {
      setDirty(false);
      next();
    };
    if (!dirty) {
      go();
      return;
    }
    setConfirm({
      title: "Discard unsaved changes",
      body: "This resident profile has changes that are not saved. Leaving discards them; the saved revision is unchanged.",
      confirmLabel: "Discard changes",
      confirmHint: "Leave this profile without saving",
      danger: true,
      onConfirm: go,
    });
  };

  return (
    <main className="workflow-page residents-page">
      <header className="workflow-page-head">
        <div>
          <p className="workflow-eyebrow">Agents</p>
          <h2>Residents</h2>
        </div>
        <p className="workflow-page-blurb">
          Long-running agents with a standing role. Author a profile once, then launch it from
          Dispatch.
        </p>
      </header>
      <section className="residents-body">
        <aside className="residents-rail" aria-label="Resident profiles">
          <div className="residents-rail-head">
            <div>
              <h3>Profiles</h3>
              <p>{profiles.length} live</p>
            </div>
            <Tooltip label="Author a new resident profile">
              <button
                type="button"
                className="btn"
                onClick={() => leave(() => {
                  setCreating(true);
                  onSelect(null);
                })}
              >
                New
              </button>
            </Tooltip>
          </div>
          <div className="residents-rail-list">
            <LibraryRailGroup label="Yours" count={profiles.length}>
              {profiles.map((profile) => (
                <LibraryRailRow
                  key={profile.id}
                  className="resident-list-item"
                  name={profile.name}
                  detail={residentProfileFact(profile, personas)}
                  selected={!creating && profile.id === selectedId}
                  tooltip={`Open ${profile.name}`}
                  onSelect={() => leave(() => {
                    setCreating(false);
                    onSelect(profile.id);
                  })}
                />
              ))}
              {profiles.length === 0 && (
                <p className="lib-rail-group-empty">
                  No resident profiles yet. Choose New to author one.
                </p>
              )}
            </LibraryRailGroup>
          </div>
        </aside>
        <div className="residents-workspace">
          {creating ? (
            <ResidentProfileEditor
              key="new"
              profile={null}
              personas={personas}
              onDirtyChange={setDirty}
              onSaved={(profile) => {
                setLocal(profile);
                setCreating(false);
                setDirty(false);
                onSelect(profile.id);
              }}
              onArchived={() => {}}
              onLaunch={onLaunch}
            />
          ) : selected ? (
            <ResidentProfileEditor
              // Keyed by profile, not revision: a revision saved elsewhere must not remount the
              // editor and drop unsaved edits. The editor reconciles a newer revision itself.
              key={selected.id}
              profile={selected}
              personas={personas}
              onDirtyChange={setDirty}
              onSaved={(profile) => setLocal(profile)}
              onArchived={() => {
                setLocal(null);
                setDirty(false);
                onSelect(null);
              }}
              onLaunch={onLaunch}
            />
          ) : (
            <section className="workflow-empty resident-empty">
              <h3>{selectedId ? "This resident profile is not available" : "Choose a resident"}</h3>
              <p>
                {selectedId
                  ? "It may have been archived. Choose another profile or author a new one."
                  : "Select a profile to edit it, or choose New to author one."}
              </p>
            </section>
          )}
        </div>
      </section>
      {confirm && <WorkflowConfirmModal request={confirm} onClose={() => setConfirm(null)} />}
    </main>
  );
}
