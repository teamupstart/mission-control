import { useEffect, useMemo, useRef, useState } from "react";
import { sessionActionsForDisplay } from "@shared/workflow.ts";
import type { SessionAction } from "@shared/workflow.ts";
import type { SkillCatalogEntry } from "@shared/types.ts";
import { fetchSkills } from "../lib/api.ts";
import { Tooltip } from "../components/Tooltip.tsx";
import { LibraryBackRow } from "../library/LibraryBackRow.tsx";
import { LibraryRailGroup, LibraryRailRow } from "../library/LibraryRail.tsx";
import { sessionActionContractLabel } from "../library/library-model.ts";
import { useLibraryEscape } from "../library/useLibraryEscape.ts";
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
 * The rail's two groups: what shipped with the build, and what the operator wrote.
 *
 * `groupPersonas`'s rule, restated for this catalog rather than shared with it - the two
 * libraries hold different records and neither should be able to reshape the other's rail by
 * retuning its own. Order inside a group is the order that arrived, which is
 * `normalizedName` from the caller: `sessionActionsForDisplay` has already decided which of a
 * shadowed pair survives, and a second opinion here would be a second source of truth about
 * it.
 */
export function groupSessionActions(
  listed: readonly SessionAction[],
): { builtin: SessionAction[]; yours: SessionAction[] } {
  return {
    builtin: listed.filter((action) => action.builtin),
    yours: listed.filter((action) => !action.builtin),
  };
}

export function SessionActionLibrary({
  sessionActions,
  hasSnapshot = false,
  initialActionId = null,
  startNew = false,
  isOverlayOpen,
  onLeave,
  onDirtyChange,
  onSelectionChange,
}: {
  sessionActions: SessionAction[];
  /**
   * Whether the SSE snapshot has landed. Without it an empty catalog and an unread one look
   * identical, and "No session actions yet" beside a New button is an invitation to author a
   * duplicate of something that is about to appear.
   */
  hasSnapshot?: boolean;
  /**
   * The action the ROUTE asked for, read once as this surface mounts. The Persona library's
   * contract, for its reasons: the route is an entry point, selection stays here, and
   * `onSelectionChange` reports back so the address bar names what is open.
   */
  initialActionId?: string | null;
  /** Mount straight into a blank draft, for the Library's "＋ New action" card. */
  startNew?: boolean;
  isOverlayOpen: () => boolean;
  /**
   * Leave this surface for the Library index. App points it at the router's `navigate`, so
   * the back row and Escape leave by ONE path and an unsaved draft raises the existing
   * leave-with-unsaved-changes dialog rather than being dropped.
   */
  onLeave: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onSelectionChange?: (actionId: string | null) => void;
}): React.JSX.Element {
  const ordered = useMemo(
    () => sessionActionsForDisplay(sessionActions)
      .sort((a, b) => a.normalizedName.localeCompare(b.normalizedName, "en-US")),
    [sessionActions],
  );
  const active = useMemo(() => ordered.filter((action) => action.archivedAt === null), [ordered]);
  const [actionState, setActionState] = useState<"active" | "archived">("active");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(
    () => (startNew ? null : initialActionId ?? active[0]?.id ?? null),
  );
  const [seed, setSeed] = useState<SessionActionDraftSeed | null>(
    () => (startNew ? EMPTY_SESSION_ACTION_SEED : null),
  );
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

  // Escape leaves the prompt editor, then leaves the page - the same ladder the back row
  // above the rail is the visible half of.
  useLibraryEscape({ isOverlayOpen, onLeave });

  const listed = useMemo(
    () => filterSessionActions(ordered, actionState, search),
    [actionState, ordered, search],
  );
  const groups = useMemo(() => groupSessionActions(listed), [listed]);
  const archivedCount = useMemo(
    () => ordered.filter((action) => action.archivedAt !== null).length,
    [ordered],
  );
  /*
   * "Nothing yet" is said only where it is true AND useful - `PersonaLibrary` carries the
   * reasoning. Under a search it would be a claim about the catalog rather than about the
   * filter, and with nothing listed at all the empty line below already says it in the right
   * words for the state.
   */
  const yoursIsEmptyAndSaidSo = listed.length > 0
    && groups.yours.length === 0
    && search.trim().length === 0;
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
  // What is open, reported however it came to be open. See `PersonaLibrary`.
  useEffect(() => onSelectionChange?.(selectedId), [onSelectionChange, selectedId]);
  // The blank-draft request, honoured on its edge. `PersonaLibrary` carries the reasoning.
  const newDraftAsked = useRef(startNew);
  useEffect(() => {
    const asked = startNew && !newDraftAsked.current;
    newDraftAsked.current = startNew;
    if (asked) start(EMPTY_SESSION_ACTION_SEED, false);
  }, [startNew]);
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

  /**
   * One rail row.
   *
   * No `Built-in` or `Yours` tag any more: the group head above says it once for every row
   * beneath it, and repeating it on each was the flat list apologising for being flat. The
   * sub-label is the CONTRACT - what this action needs and what proves it finished - because
   * that is the only thing that tells two actions apart. The description sat here and, on the
   * two that ship, it is the title again in a longer sentence.
   */
  function actionRow(action: SessionAction): React.JSX.Element {
    return (
      <LibraryRailRow
        key={action.id}
        className="wf-action-list-item"
        name={action.name}
        detail={sessionActionContractLabel(action)}
        // The contract is two facts and a clause, not a runner and a model: on one line the
        // completion half fell off every row.
        detailLines={2}
        selected={selectedId === action.id}
        tooltip={action.builtin
          ? `Open the built-in ${action.name} - read-only, Duplicate to customize`
          : `Open ${action.name} in the editor`}
        onSelect={() => select(action.id)}
      />
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
        <LibraryBackRow onLeave={onLeave} />
        <div className="wf-action-sidebar-head">
          <div>
            <h3>Session actions</h3>
            <p>{active.length} active</p>
          </div>
          <Tooltip label="Author a new instruction a workflow can send to its bound session">
            <button className="btn" onClick={() => start(EMPTY_SESSION_ACTION_SEED, false)}>New</button>
          </Tooltip>
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
          {groups.builtin.length > 0 && (
            <LibraryRailGroup label="Built-in" count={groups.builtin.length}>
              {groups.builtin.map(actionRow)}
            </LibraryRailGroup>
          )}
          {(groups.yours.length > 0 || yoursIsEmptyAndSaidSo) && (
            <LibraryRailGroup label="Yours" count={groups.yours.length}>
              {groups.yours.map(actionRow)}
              {yoursIsEmptyAndSaidSo && (
                <p className="lib-rail-group-empty">
                  Nothing yet. An action is exact Markdown plus the contract it is checked
                  against - duplicate a built-in to see the shape.
                </p>
              )}
            </LibraryRailGroup>
          )}
        </div>
        {/* The archived filter lives BELOW the list rather than between the heading and it,
            where it was a row of chrome an operator crossed on the way to the action they
            came for. A toggle rather than the Active/Archived select it replaces: one press
            instead of two, and it carries the count - so "is there anything in there?" is
            answered without pressing it at all. */}
        <div className="wf-action-rail-foot">
          <Tooltip
            label={actionState === "archived"
              ? "Back to the active session actions"
              : "Browse the session actions you have archived"}
          >
            <button
              className={`btn btn-ghost wf-action-archived-toggle${actionState === "archived" ? " on" : ""}`}
              aria-pressed={actionState === "archived"}
              onClick={() => setActionState((state) => (state === "archived" ? "active" : "archived"))}
            >
              Archived <span className="wf-action-archived-count mono">{archivedCount}</span>
            </button>
          </Tooltip>
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
