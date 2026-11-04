import { ResidentLoopControls, ResidentLoopStatusLine } from "./ResidentLoopControls.tsx";
import { residentSessionMark } from "./marker.ts";
import { ResidentSkillSourcesPanel } from "./ResidentSkillSources.tsx";
import { ResidentMcpServersPanel } from "./ResidentMcpServers.tsx";
import { useEffect, useState } from "react";
import { AGENT_IDENTITY } from "@shared/agent.ts";
import {
  type ResidentProfile,
  type ResidentProfileRevision,
  type ResidentRunSummary,
} from "@shared/residents.ts";
import type { Session } from "@shared/types.ts";
import type { PersonaView } from "@shared/workflow.ts";
import { Tooltip } from "../components/Tooltip.tsx";
import { LibraryRailGroup, LibraryRailRow } from "../library/LibraryRail.tsx";
import { ResidentProfileEditor } from "./ResidentProfileEditor.tsx";

/** A built-in's rail tag: an application-owned identity, as the Library marks its own. */
const BUILTIN_TAGS = [{ label: "built-in", tone: "system" }] as const;

/** The rail row's distinguishing facts: whose role it is, and on which harness. */
export function residentProfileFact(profile: ResidentProfile, personas: readonly PersonaView[]): string {
  const { personaId } = profile.settings.persona;
  const persona = personas.find((candidate) => candidate.id === personaId);
  return [
    personaId === "" ? "no Persona" : persona?.name ?? "missing Persona",
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
  sessions = [],
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
  onCreatePersona,
}: {
  profiles: readonly ResidentProfile[];
  runs?: readonly ResidentRunSummary[];
  sessions?: readonly Session[];
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
  /** Open the Library's blank Persona editor: gated by the router like every other move. */
  onCreatePersona?: () => void;
}): React.JSX.Element {
  const [dirty, setDirty] = useState(false);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  /**
   * The settings Duplicate opened the new-profile editor with. Set before the route moves to
   * `creating` (the router may land that a render later), dropped when the route LEAVES
   * `creating`, and cleared by New, so a blank profile never inherits a copy's settings.
   */
  const [seed, setSeed] = useState<{ key: number; settings: ResidentProfileRevision } | null>(null);
  const [wasCreating, setWasCreating] = useState(creating);
  if (creating !== wasCreating) {
    setWasCreating(creating);
    if (!creating) setSeed(null);
  }
  const duplicate = (settings: ResidentProfileRevision): void => {
    setSeed({
      key: (seed?.key ?? 0) + 1,
      settings: { ...settings, identity: { ...settings.identity, name: `${settings.identity.name} copy` } },
    });
    onCreate();
  };
  // Both groups are always listed: a profile of the operator's that predates a built-in of the
  // same name stays under Yours, and the built-in under Built-in, so neither hides the other.
  const builtins = profiles.filter((profile) => profile.builtin);
  const own = profiles.filter((profile) => !profile.builtin);
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
              <button
                type="button"
                className="btn"
                onClick={() => {
                  // Only on the way INTO a new profile. Already on one, New is the same route and
                  // the router's gate never runs, so clearing here would discard a copy unasked.
                  if (!creating) setSeed(null);
                  onCreate();
                }}
              >
                New
              </button>
            </Tooltip>
          </div>
          <div className="residents-rail-list">
            {builtins.length > 0 && (
              <LibraryRailGroup label="Built-in" count={builtins.length}>
                {builtins.map((profile) => (
                  <LibraryRailRow
                    key={profile.id}
                    className="resident-list-item"
                    name={profile.name}
                    detail={residentProfileFact(profile, personas)}
                    tags={BUILTIN_TAGS}
                    selected={!creating && profile.id === selectedId}
                    tooltip={`Open ${profile.name}, which ships with Mission Control`}
                    onSelect={() => onSelect(profile.id)}
                  />
                ))}
              </LibraryRailGroup>
            )}
            <LibraryRailGroup label="Yours" count={own.length}>
              {own.map((profile) => (
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
              {own.length === 0 && (
                <p className="lib-rail-group-empty">
                  {builtins.length > 0
                    ? "No profiles of your own yet. Duplicate a built-in, or choose New to author one."
                    : "No resident profiles yet. Choose New to author one."}
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
              <ResidentLoopStatusLine loop={run} session={sessions.find(session => session.task?.id === run.taskId)} />
              <ResidentLoopControls mark={residentSessionMark(run, selected)} />
            </section>
          )}
          {skillSources ? <ResidentSkillSourcesPanel /> : mcpServers ? <ResidentMcpServersPanel /> : creating ? (
            <ResidentProfileEditor
              key={`new:${seed?.key ?? 0}`}
              profile={null}
              seed={seed?.settings}
              personas={personas}
              onDirtyChange={setDirty}
              onSaved={(profile) => {
                setLocal(profile);
                setDirty(false);
                onSettle(profile.id);
              }}
              onArchived={() => {}}
              onLaunch={onLaunch}
              onCreatePersona={onCreatePersona}
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
              onDuplicate={duplicate}
              onCreatePersona={onCreatePersona}
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
