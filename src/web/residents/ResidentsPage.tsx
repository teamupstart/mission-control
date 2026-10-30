import { ResidentLoopControls, ResidentLoopStatusLine } from "./ResidentLoopControls.tsx";
import { residentSessionMark } from "./marker.ts";
import { ResidentSkillSourcesPanel } from "./ResidentSkillSources.tsx";
import { ResidentMcpServersPanel } from "./ResidentMcpServers.tsx";
import { useEffect, useState } from "react";
import { AGENT_IDENTITY } from "@shared/agent.ts";
import type { ResidentProfile, ResidentRunSummary } from "@shared/residents.ts";
import type { PersonaView } from "@shared/workflow.ts";
import { Tooltip } from "../components/Tooltip.tsx";
import { LibraryRailGroup, LibraryRailRow } from "../library/LibraryRail.tsx";
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
 *
 * Which profile is open, and whether a new one is being authored, is the ROUTE
 * (`#/residents/:id`, `#/residents/new`). The editor's unsaved state is reported to the
 * router's dirty-draft gate, the one the Library uses, so choosing another profile, New, the
 * palette, a page shortcut or Back all ask before discarding a draft - there is no second
 * confirm here to disagree with it.
 */
export function ResidentsPage({
  profiles,
  runs = [],
  personas,
  selectedId,
  creating,
  skillSources = false,
  onSkillSources,
  mcpServers = false,
  onMcpServers,
  onSelect,
  onCreate,
  onSettle,
  onDirtyChange,
  onLaunch,
}: {
  profiles: readonly ResidentProfile[];
  runs?: readonly ResidentRunSummary[];
  personas: readonly PersonaView[];
  /** From the route. Null shows the rail with nothing open. */
  selectedId: string | null;
  /** From the route: a new profile is being authored. */
  creating: boolean;
  skillSources?: boolean;
  onSkillSources?: () => void;
  mcpServers?: boolean;
  onMcpServers?: () => void;
  /** An operator choice of profile: gated by the router while a draft is unsaved. */
  onSelect: (profileId: string | null) => void;
  /** Open a blank editor: gated the same way. */
  onCreate: () => void;
  /** Move the route after the page itself settled the draft (saved, archived, discarded). */
  onSettle: (profileId: string | null) => void;
  /** Report unsaved edits to the router's dirty-draft gate. */
  onDirtyChange: (dirty: boolean) => void;
  onLaunch: (profile: ResidentProfile) => void;
}): React.JSX.Element {
  const [dirty, setDirty] = useState(false);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  // A profile saved or archived here may beat its SSE frame back; hold it until the frame lands.
  const [local, setLocal] = useState<ResidentProfile | null>(null);
  // The newer of the catalog's copy and one saved here, whichever frame arrived first.
  const fromCatalog = selectedId ? profiles.find((profile) => profile.id === selectedId) ?? null : null;
  const selected = local && local.id === selectedId && (!fromCatalog || local.revision > fromCatalog.revision)
    ? local
    : fromCatalog;
  // Once the catalog has caught up with a save made here, the local copy has done its job; left
  // standing it would keep showing a profile another window has since archived.
  if (local && fromCatalog && local.id === fromCatalog.id && fromCatalog.revision >= local.revision) {
    setLocal(null);
  }
  // The profile last shown in the editor. When another window archives it, a dirty editor stays
  // mounted on this copy - same key, same branch - so the unsaved draft is not discarded unseen.
  const [held, setHeld] = useState<ResidentProfile | null>(null);
  if (selected && (held?.id !== selected.id || held.revision !== selected.revision)) setHeld(selected);
  const archivedElsewhere = !selected && !creating && dirty && held !== null && held.id === selectedId;
  const shown = selected ?? (archivedElsewhere ? held : null);

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
              <button type="button" className="btn" onClick={onCreate}>
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
                  onSelect={() => onSelect(profile.id)}
                />
              ))}
              {profiles.length === 0 && (
                <p className="lib-rail-group-empty">
                  No resident profiles yet. Choose New to author one.
                </p>
              )}
            </LibraryRailGroup>
            <LibraryRailGroup label="Resources" count={2}>
              <LibraryRailRow className="resident-list-item" name="Skill sources" detail="Global and registered folders" selected={skillSources} tooltip="Browse and rescan skill sources" onSelect={() => onSkillSources?.()} />
              <LibraryRailRow className="resident-list-item" name="Custom MCP servers" detail="Custom servers and each harness's global servers" selected={mcpServers} tooltip="Define custom MCP servers and browse global ones" onSelect={() => onMcpServers?.()} />
            </LibraryRailGroup>
          </div>
        </aside>
        <div className="residents-workspace">
          {selected && !skillSources && !mcpServers && runs.filter((run) => run.profileId === selected.id).map((run) =>
            <section className="resident-live-run" aria-label={`Live run of ${selected.name}`} key={run.id}>
              <strong>Revision {run.profileRevision}</strong>
              <ResidentLoopStatusLine loop={run} />
              <ResidentLoopControls mark={residentSessionMark(run, selected)} />
            </section>
          )}
          {skillSources ? <ResidentSkillSourcesPanel /> : mcpServers ? <ResidentMcpServersPanel /> : creating ? (
            <ResidentProfileEditor
              key="new"
              profile={null}
              personas={personas}
              onDirtyChange={setDirty}
              onSaved={(profile) => {
                setLocal(profile);
                setDirty(false);
                onSettle(profile.id);
              }}
              onArchived={() => {}}
              onLaunch={onLaunch}
            />
          ) : shown ? (
            <ResidentProfileEditor
              // Keyed by profile, not revision: a revision saved elsewhere must not remount the
              // editor and drop unsaved edits. The editor reconciles a newer revision itself.
              key={shown.id}
              profile={shown}
              archivedElsewhere={archivedElsewhere}
              personas={personas}
              onDirtyChange={setDirty}
              onSaved={(profile) => setLocal(profile)}
              onArchived={() => {
                setLocal(null);
                setDirty(false);
                onSettle(null);
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
    </main>
  );
}
