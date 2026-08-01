import { useEffect, useMemo, useState } from "react";
import {
  sessionActionCompletionLabel,
  sessionActionSkillLabel,
  sessionActionsForDisplay,
} from "@shared/workflow.ts";
import type { SessionAction } from "@shared/workflow.ts";
import type { SkillCatalogEntry } from "@shared/types.ts";
import { fetchSkills } from "../lib/api.ts";
import { Tooltip } from "../components/Tooltip.tsx";
import {
  EMPTY_SESSION_ACTION_SEED,
  SessionActionEditor,
  type SessionActionDraftSeed,
} from "./SessionActionEditor.tsx";
import { sessionActionRequest, useSessionActionCapabilities } from "./sessionActionApi.ts";
import {
  WorkflowConfirmModal,
  type WorkflowConfirmRequest,
} from "./WorkflowConfirmModal.tsx";

/**
 * The SessionActions catalog: reusable instructions a workflow can send to the session it is
 * bound to.
 *
 * Structurally the Persona library - sidebar list, one editor, one confirm host, a local row
 * held until SSE catches up - because an operator navigating one should not have to learn the
 * other. Everything it SAYS is different on purpose: a session action is not a reviewer, has
 * no model, returns no verdict, and the copy here never implies one.
 */

export function filterSessionActions(
  actions: readonly SessionAction[],
  state: "active" | "archived",
  search: string,
): SessionAction[] {
  const needle = search.trim().toLocaleLowerCase("en-US");
  return actions.filter((action) => {
    const stateMatches = state === "active"
      ? action.archivedAt === null
      : action.archivedAt !== null;
    return stateMatches && (
      needle.length === 0
      || action.name.toLocaleLowerCase("en-US").includes(needle)
      || action.description.toLocaleLowerCase("en-US").includes(needle)
    );
  });
}

/**
 * The one line a row carries under its name: what it needs, and what proves it finished.
 *
 * An archived row says so instead, the way the Persona list does - a row an operator can no
 * longer add is more usefully described by why than by a skill it will not be asked for.
 */
export function sessionActionRowSummary(action: SessionAction): string {
  if (action.archivedAt !== null) return "Archived";
  return [
    sessionActionSkillLabel(action.requiredSkillId),
    sessionActionCompletionLabel(action.completion),
  ].join(" · ");
}

/** `Revision 3 · updated <date>`, or the honest answer for something that ships with the build. */
export function sessionActionRevisionLine(action: SessionAction): string {
  if (action.builtin) return "Built-in · ships with this build";
  return `Revision ${action.revision} · updated ${new Date(action.updatedAt).toLocaleString()}`;
}

export function SessionActionLibrary({
  sessionActions,
  hasSnapshot = false,
  isOverlayOpen,
  onDirtyChange,
}: {
  sessionActions: SessionAction[];
  /**
   * Whether the SSE snapshot has landed. Without it an empty catalog and an unread one look
   * identical, and "No session actions yet" beside a New button is an invitation to author a
   * duplicate of something that is about to appear.
   */
  hasSnapshot?: boolean;
  isOverlayOpen: () => boolean;
  onDirtyChange: (dirty: boolean) => void;
}): React.JSX.Element {
  const ordered = useMemo(
    () => sessionActionsForDisplay(sessionActions)
      .sort((a, b) => a.normalizedName.localeCompare(b.normalizedName, "en-US")),
    [sessionActions],
  );
  const active = useMemo(() => ordered.filter((action) => action.archivedAt === null), [ordered]);
  const [actionState, setActionState] = useState<"active" | "archived">("active");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(() => active[0]?.id ?? null);
  const [seed, setSeed] = useState<SessionActionDraftSeed | null>(null);
  /**
   * Whether `seed` was COPIED from an existing action rather than started blank.
   *
   * The editor cannot tell on its own - a duplicate opens with no `action`, exactly like a
   * New - and the difference decides whether the seed's completion has to prove itself
   * against the daemon's capability answer. A copy of the shipped Pull Request action keeps
   * the adapter it was duplicated for; a blank draft's default does not get that pass.
   */
  const [seedInherited, setSeedInherited] = useState(false);
  const [localAction, setLocalAction] = useState<SessionAction | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<WorkflowConfirmRequest | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  const [skills, setSkills] = useState<readonly SkillCatalogEntry[]>([]);
  const capabilities = useSessionActionCapabilities();

  const listed = useMemo(
    () => filterSessionActions(ordered, actionState, search),
    [actionState, ordered, search],
  );
  const streamed = ordered.find((action) => action.id === selectedId) ?? null;
  // The route response can beat its SSE event. Keep the acknowledged revision visible until
  // the stream catches up, especially for archive, where falling back would briefly re-enable
  // the editor on a row the server has already retired.
  const selected = localAction?.id === selectedId
      && (streamed === null || localAction.revision > streamed.revision)
    ? localAction
    : streamed;

  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => {
    if (selectedId === null && seed === null && !dirty && active[0]) setSelectedId(active[0].id);
  }, [active, dirty, seed, selectedId]);
  useEffect(() => {
    const current = localAction
      ? sessionActions.find((action) => action.id === localAction.id)
      : null;
    if (localAction && current && current.revision >= localAction.revision) setLocalAction(null);
  }, [localAction, sessionActions]);
  // Read ONCE rather than polled. The skills catalog is parsed from files on disk and only
  // moves when a build does; a second 4-second poll beside the SSE stream would be a fetch
  // loop bought for a picker that changes about as often as the app itself.
  useEffect(() => {
    let alive = true;
    void fetchSkills().then((view) => {
      if (alive && view) setSkills(view.skills);
    });
    return () => { alive = false; };
  }, []);

  function guardDiscard(what: string, action: () => void): void {
    if (!dirty) {
      action();
      return;
    }
    setConfirm({
      title: "Discard unsaved session action changes",
      body: `The editor has changes that have not been saved. ${what} discards them.`,
      confirmLabel: "Discard changes",
      confirmHint: "Throw the unsaved edits away and continue",
      danger: true,
      onConfirm: action,
    });
  }

  function select(id: string): void {
    const action = ordered.find((candidate) => candidate.id === id);
    guardDiscard(`Opening ${action?.name ?? "another session action"}`, () => {
      setSeed(null);
      setSelectedId(id);
      setEditorKey((key) => key + 1);
      setDirty(false);
      setError(null);
    });
  }

  function start(seedValue: SessionActionDraftSeed, inherited: boolean): void {
    guardDiscard(
      seedValue.name ? `Duplicating ${seedValue.name}` : "Starting a new session action",
      () => {
        setSelectedId(null);
        setSeed(seedValue);
        setSeedInherited(inherited);
        setEditorKey((key) => key + 1);
        setDirty(false);
        setError(null);
      },
    );
  }

  async function archive(action: SessionAction): Promise<void> {
    try {
      const archived = await sessionActionRequest<SessionAction>(
        `/api/session-actions/${action.id}`,
        { method: "DELETE", body: JSON.stringify({ expectedRevision: action.revision }) },
      );
      setLocalAction(archived);
      setDirty(false);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not archive this session action");
    }
  }

  return (
    <section className="wf-action-library">
      <aside className="wf-action-sidebar" aria-label="Session action library">
        <div className="wf-action-sidebar-head">
          <div>
            <h3>Session actions</h3>
            <p>{active.length} active</p>
          </div>
          <Tooltip label="Author a new instruction a workflow can send to its bound session">
            <button className="btn" onClick={() => start(EMPTY_SESSION_ACTION_SEED, false)}>New</button>
          </Tooltip>
        </div>
        <div className="wf-action-filter-row">
          <label>
            State
            <Tooltip label="Choose whether to browse active or archived session actions">
              <select
                value={actionState}
                onChange={(event) => setActionState(event.target.value as "active" | "archived")}
              >
                <option value="active">Active</option>
                <option value="archived">Archived</option>
              </select>
            </Tooltip>
          </label>
        </div>
        <label className="wf-action-search">
          <span className="sr-only">Search session actions by name or description</span>
          <input
            type="search"
            value={search}
            placeholder="Search session actions"
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <div className="wf-action-list">
          {listed.length === 0 && (
            <p className="wf-action-list-empty">
              {!hasSnapshot
                ? "Loading session actions…"
                : search.trim()
                  ? "No session actions match this search."
                  : actionState === "archived"
                    ? "No archived session actions."
                    : "No session actions yet. New authors the first one."}
            </p>
          )}
          {listed.map((action) => (
            <Tooltip
              key={action.id}
              label={action.builtin
                ? `Open the built-in ${action.name} - read-only, Duplicate to customize`
                : `Open ${action.name} in the editor`}
            >
              <button
                className={`wf-action-list-item${selectedId === action.id ? " active" : ""}`}
                onClick={() => select(action.id)}
              >
                <span className="wf-action-list-name">
                  <span>{action.name}</span>
                  {action.builtin
                    ? <em className="wf-action-list-tag">Built-in</em>
                    : <em className="wf-action-list-tag is-owned">Yours</em>}
                </span>
                <small>{action.description || "No description"}</small>
                <small className="wf-action-list-meta">{sessionActionRowSummary(action)}</small>
                <small className="wf-action-list-meta">{sessionActionRevisionLine(action)}</small>
              </button>
            </Tooltip>
          ))}
        </div>
      </aside>

      <div className="wf-action-workspace">
        {error && <p className="wf-error" role="alert">{error}</p>}
        {!selected && !seed && (
          <section className="workflow-empty wf-action-empty">
            <h3>Choose a session action</h3>
            <p>
              A session action sends one exact instruction to the session a workflow is bound to,
              waits for that turn to finish, then captures fresh evidence for the stages below it.
              Select one, or author a new one.
            </p>
          </section>
        )}
        {(selected || seed) && (
          <SessionActionEditor
            key={editorKey}
            action={selected}
            seed={seed ?? undefined}
            seedInherited={seedInherited}
            capabilities={capabilities.completions}
            capabilitiesLoading={capabilities.loading}
            capabilityError={capabilities.error}
            skills={skills}
            isOverlayOpen={isOverlayOpen}
            onDirtyChange={setDirty}
            onSaved={(action) => {
              setLocalAction(action);
              setSelectedId(action.id);
              setSeed(null);
              setError(null);
            }}
            onDuplicate={(draft) => start(draft, true)}
            onArchive={(action) => {
              setConfirm({
                title: `Archive ${action.name}`,
                body: dirty
                  ? `Unsaved changes in the editor are discarded. ${action.name} moves to the `
                    + "Archived list and stops being offered to new workflow stages; every "
                    + "published version keeps the snapshot it was published with."
                  : `${action.name} moves to the Archived list and stops being offered to new `
                    + "workflow stages. Every published version keeps the snapshot it was "
                    + "published with, so runs already pinned to one are unaffected.",
                confirmLabel: "Archive session action",
                confirmHint: "Retire this action from new workflows, keeping published history",
                danger: true,
                onConfirm: () => void archive(action),
              });
            }}
          />
        )}
      </div>

      {confirm && <WorkflowConfirmModal request={confirm} onClose={() => setConfirm(null)} />}
    </section>
  );
}
