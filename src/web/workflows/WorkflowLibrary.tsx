import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addableSessionActions,
  normalizeWorkflowName,
  personasForDisplay,
  WORKFLOW_CHECK_SLOTS,
  WORKFLOW_LIMITS,
  workflowCommandStatusSentence,
  type PersonaView,
  type SessionAction,
  type WorkflowCheckSlot,
  type WorkflowCommandView,
  type WorkflowDefinition,
  type WorkflowDraftNode,
  type WorkflowEdge,
  type WorkflowSourcePort,
  type WorkflowSummary,
  type WorkflowTargetPort,
  type WorkflowVersion,
} from "@shared/workflow.ts";
import {
  WORKFLOW_NODE_SOURCE_PORTS,
  WORKFLOW_NODE_TARGET_PORTS,
  connectionAllowed,
  validateWorkflowGraph,
} from "@shared/workflow-graph.ts";
import {
  nodeLabel,
  projectStages,
  stageBlockers,
  type StageNode,
} from "@shared/workflow-stages.ts";
import {
  autoLayoutWorkflow,
  WorkflowCanvas,
  type WorkflowCanvasHandle,
  type WorkflowSelection,
} from "./WorkflowCanvas.tsx";
import { PipelineEditor } from "./PipelineEditor.tsx";
import { WorkflowPipelineProperties, WorkflowProperties } from "./WorkflowProperties.tsx";
import {
  WorkflowConfirmModal,
  type WorkflowConfirmRequest,
} from "./WorkflowConfirmModal.tsx";
import { WorkflowVersionHistory } from "./WorkflowVersionHistory.tsx";
import { NEW_NODE_MIME, type NewWorkflowNode } from "./new-node.ts";
import { useSessionActionCapabilities } from "./sessionActionApi.ts";
import {
  useWorkflowDraft,
  workflowArchiveBlocked,
  workflowPublishBlocked,
} from "./useWorkflowDraft.ts";
import { WorkflowApiError, workflowRequest } from "./workflowApi.ts";
import { missionRouteHash } from "./useWorkflowRoute.ts";
import {
  readLastWorkflowId,
  readRequestedWorkflowVersion,
  rememberWorkflowId,
} from "./workflowSelection.ts";
import { Tooltip } from "../components/Tooltip.tsx";
import { DeleteButton } from "../components/DeleteButton.tsx";
import { LibraryBackRow } from "../library/LibraryBackRow.tsx";
import { useLibraryEscape } from "../library/useLibraryEscape.ts";
import { useTourTargetRef } from "../tour/target-context.tsx";

interface CreateResponse { summary: WorkflowSummary }

export function nextWorkflowName(
  base: string,
  summaries: WorkflowSummary[],
  requiredSuffix = "",
): string {
  const names = new Set(summaries.map((workflow) => normalizeWorkflowName(workflow.name)));
  let n = 1;
  while (true) {
    const suffix = `${requiredSuffix}${n === 1 ? "" : ` ${n}`}`;
    const stem = base.trim().slice(0, WORKFLOW_LIMITS.workflowName - suffix.length).trimEnd();
    const candidate = `${stem}${suffix}`;
    if (!names.has(normalizeWorkflowName(candidate))) return candidate;
    n += 1;
  }
}

export function workflowSelectionRestore(
  initialized: boolean,
  selectedId: string | null,
  active: WorkflowSummary[],
  rememberedId: string | null,
  all: WorkflowSummary[] = active,
  explicitlyRequestedId: string | null = null,
): string | undefined {
  if (initialized || selectedId !== null || all.length === 0) return undefined;
  if (rememberedId === explicitlyRequestedId) {
    const requested = all.find((workflow) => workflow.id === explicitlyRequestedId);
    if (requested) return requested.id;
  }
  return active.find((workflow) => workflow.id === rememberedId)?.id ?? active[0]?.id;
}

export function workflowSelectionAfterRemoval(
  hasSnapshot: boolean,
  selectedId: string | null,
  summaries: WorkflowSummary[],
  observedIds: ReadonlySet<string>,
  hasUnsavedChanges = false,
): string | null | undefined {
  if (
    !hasSnapshot
    || !selectedId
    || !observedIds.has(selectedId)
    || summaries.some((workflow) => workflow.id === selectedId)
    || hasUnsavedChanges
  ) {
    return undefined;
  }
  return summaries.find((workflow) => workflow.archivedAt === null)?.id ?? null;
}

export const WORKFLOW_REMOVED_UNSAVED_ERROR =
  "This workflow was deleted elsewhere. These unsaved changes cannot be saved because the workflow no longer exists. Copy anything you need before selecting another workflow or creating a new one.";

export function workflowLifecycleError(caught: unknown): string {
  if (caught instanceof WorkflowApiError) {
    switch (caught.body?.code) {
      case "workflow_published":
        return "This workflow has already been published. Archive it instead of deleting it.";
      case "workflow_not_archived":
        return "This workflow was already restored. Reload the latest draft before trying again.";
      case "workflow_revision_conflict":
        return "This workflow changed in another tab. Reload the latest draft before trying again.";
    }
  }
  return caught instanceof Error ? caught.message : "Workflow action failed";
}

export function WorkflowLoadError({
  error,
  canRetry,
  onRetry,
}: {
  error: string | null;
  canRetry: boolean;
  onRetry: () => void;
}): React.JSX.Element | null {
  if (!error) return null;
  return (
    <p className="wf-error" role="alert">
      {error}
      {canRetry && (
        <Tooltip label="Try loading this workflow again">
          <button className="btn btn-ghost" onClick={onRetry}>Retry</button>
        </Tooltip>
      )}
    </p>
  );
}

/**
 * Which editing surface a draft opens on.
 *
 * `null` is "whatever this graph expresses" - the default - and it is deliberately NOT
 * resolved into a concrete mode in state: a draft that is stage-expressible opens on the
 * Pipeline, one that is not opens on the Graph, and an operator who picks a surface keeps it
 * until they open a different workflow. A stored concrete default would strand a graph that
 * stopped being expressible (an undo in Graph view) on a Pipeline that cannot draw it.
 */
export function workflowEditorMode(
  chosen: "pipeline" | "graph" | null,
  expressible: boolean,
): "pipeline" | "graph" {
  return expressible ? chosen ?? "pipeline" : "graph";
}

/**
 * Why this workflow is read-only, in one sentence, or nothing.
 *
 * Built-in comes FIRST, following `PersonaEditor`: an operator reading "Archived" about a
 * workflow they never archived would go looking for the wrong control. A built-in is never
 * archived anyway, so the order only ever matters if that stops being true - which is exactly
 * when getting it wrong would be hardest to spot.
 */
export function WorkflowStateNotice({
  builtin,
  archived,
}: {
  builtin: boolean;
  archived: boolean;
}): React.JSX.Element | null {
  if (builtin) {
    return (
      <p className="wf-state builtin">
        Built-in - this workflow ships with Mission Control, always carries the graph this
        build was made from, and is already published. Duplicate it to make a copy you own and
        can edit.
      </p>
    );
  }
  if (archived) {
    return (
      <p className="wf-state archived">
        Archived - this workflow is read-only. Its published versions and past run history stay
        readable, and you can restore it.
      </p>
    );
  }
  return null;
}

export function WorkflowLibrary({
  summaries,
  personas,
  sessionActions = [],
  workflowCommands = [],
  hasSnapshot,
  initialWorkflowId = null,
  startNew = false,
  isOverlayOpen,
  onLeave,
  onDirtyChange,
  onSelectionChange,
  onBindVersion = () => {},
  onBindWorkflow,
}: {
  summaries: WorkflowSummary[];
  personas: PersonaView[];
  /**
   * The whole SessionAction catalog, archived rows included: it names whatever a draft
   * already points at, and the add controls narrow it to what is addressable and runnable
   * before offering anything.
   */
  sessionActions?: SessionAction[];
  /**
   * The Global Command catalog, read to say whether the slot the palette is offering has
   * anything configured behind it.
   *
   * Read-only here, and never a gate: a portable workflow is MEANT to name a slot a given
   * machine may not configure - it passes with a note there. The palette states that instead
   * of refusing to add the node, and links to the Library card that would change it.
   */
  workflowCommands?: WorkflowCommandView[];
  hasSnapshot: boolean;
  /**
   * The workflow the ROUTE asked for, read once as this surface mounts.
   *
   * It outranks the remembered id below for exactly one mount: a link naming a workflow has
   * to win over "whatever this browser had open last", or a shared deep link opens someone
   * else's draft. Everything after that mount is this surface's own selection, reported back
   * through `onSelectionChange`.
   */
  initialWorkflowId?: string | null;
  /** Create a draft as this surface mounts, for the Library's "＋ New workflow" card. */
  startNew?: boolean;
  /** Whether any `<Overlay>` owns the screen, so the Escape ladder stands down for it. */
  isOverlayOpen: () => boolean;
  /**
   * Leave this surface for the Library index. App points it at the router's `navigate`, so
   * the back row and Escape leave by ONE path and an unsaved draft raises the existing
   * leave-with-unsaved-changes dialog rather than being dropped.
   */
  onLeave: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onSelectionChange?: (workflowId: string | null) => void;
  onBindVersion?: (version: WorkflowVersion) => void;
  /**
   * Opens the binding dialog with no session pinned, for the workflow the operator is READING.
   *
   * Takes the workflow rather than nothing, because the button that reaches this sits inside
   * one workflow's pipeline and its label promises to bind THAT one. Handing over `{}` left the
   * dialog to guess, and its guess was catalog position - so an operator reading No-Mistakes
   * Review was offered whichever workflow sorted first by name. Absent in surfaces App does
   * not host.
   */
  onBindWorkflow?: (workflow: WorkflowDefinition) => void;
}): React.JSX.Element {
  const ordered = useMemo(() => [...summaries].sort((a, b) => a.name.localeCompare(b.name)), [summaries]);
  const active = ordered.filter((workflow) => workflow.archivedAt === null);
  const [showArchived, setShowArchived] = useState(false);
  const listed = showArchived ? ordered : active;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [transitioning, setTransitioning] = useState(false);
  const transitionRef = useRef(false);
  // `startNew` decides the first selection by creating one, so the restore below must stand
  // down rather than flash the first workflow in the list on the way there.
  const selectionInitialized = useRef(startNew);
  const observedWorkflowIds = useRef(new Set<string>());
  const [selection, setSelection] = useState<WorkflowSelection>(null);
  const streamed = ordered.find((workflow) => workflow.id === selectedId) ?? null;
  const removalTarget = workflowSelectionAfterRemoval(
    hasSnapshot,
    selectedId,
    ordered,
    observedWorkflowIds.current,
  );
  // The fourth authoring surface takes the same ladder as the three detail screens, so the
  // Library does not disagree with itself about what Escape means one level under its card
  // wall. Two of its nested Escapes - the graph's connect dialog, the pipeline's insert
  // picker - are React handlers that `preventDefault`, so the ladder's first stand-down rung
  // leaves their press alone. The canvas is the exception and is handled by name: React Flow
  // unselects on Escape WITHOUT preventing the default, so `.react-flow` is an inner layer
  // the ladder peels rather than navigates over. See `LIBRARY_EDITOR_SELECTOR`.
  useLibraryEscape({ isOverlayOpen, onLeave });

  const selectedWorkflowRemoved = removalTarget !== undefined;
  const draft = useWorkflowDraft(
    selectedId,
    streamed,
    onDirtyChange,
    selectedWorkflowRemoved,
  );
  const workflow = draft.workflow;
  const validation = useMemo(
    () => workflow
      ? validateWorkflowGraph({
          graph: workflow.draft,
          personas,
          sessionActions,
          completionPolicy: workflow.completionPolicy,
        })
      : null,
    [personas, sessionActions, workflow?.completionPolicy, workflow?.draft],
  );
  const alreadyPublished = Boolean(workflow && draft.versions.some((version) => version.sourceDraftRevision === workflow.draftRevision));
  // The same rule the daemon enforces in `deleteWorkflowCas`, and BOTH halves of it for the
  // same reason the store checks both: `currentVersionId` is the pointer, the version list is
  // the truth. The pointer is what makes this correct on first paint - it arrives with the
  // workflow detail, while `versions` is a second request that is briefly `[]` in flight, so
  // asking the list alone offered Delete on a published workflow until that request landed.
  // Gating on it keeps the refusal out of the operator's way rather than letting them reach a
  // 409 that only tells them what they cannot do.
  // `!builtin` is stated rather than left to the version checks: a built-in always names a
  // current version, so those already answer false, but Delete is refused because it ships
  // with the app and not because of how many versions it happens to have.
  const neverPublished = Boolean(workflow)
    && !workflow?.builtin
    && workflow?.currentVersionId === null
    && draft.versions.length === 0;
  const activePersonas = useMemo(
    () => personasForDisplay(personas).filter((persona) => persona.archivedAt === null),
    [personas],
  );
  // Read ONCE here, at the surface that hosts both editing modes, and passed down. The
  // Pipeline picker, the Graph palette and the properties rail all have to agree about which
  // adapters this daemon can run, and three independent reads is three chances to disagree
  // while one of them is still in flight.
  const capabilities = useSessionActionCapabilities();
  const addableActions = useMemo(
    () => addableSessionActions(sessionActions, capabilities.available),
    [capabilities.available, sessionActions],
  );
  // One walk answers both questions: the sentences the Graph-view banner shows, and whether
  // the Pipeline can draw this graph at all. Passing the live Personas is what keeps a draft
  // reviewer's blocker from reading "Missing persona".
  const blockers = useMemo(
    () => workflow ? stageBlockers(workflow.draft, personas, sessionActions) : [],
    [personas, sessionActions, workflow?.draft],
  );
  const pipeline = useMemo(
    () => workflow ? projectStages(workflow.draft) : null,
    [workflow?.draft],
  );
  /*
   * The guided tour's four semantic handles on the builder: what exists and what adds to it,
   * the two views of one workflow, the control that freezes a version, and the one that
   * attaches a published version to a session. Inert unless a tour is running.
   */
  const tourRailRef = useTourTargetRef<HTMLElement>("library:workflow-rail");
  const tourSurfaceToggleRef = useTourTargetRef<HTMLDivElement>("library:workflow-surface-toggle");
  const tourPublishRef = useTourTargetRef<HTMLButtonElement>("library:workflow-publish");
  const tourBindRef = useTourTargetRef<HTMLButtonElement>("library:workflow-bind");
  const [chosenMode, setChosenMode] = useState<"pipeline" | "graph" | null>(null);
  const mode = workflowEditorMode(chosenMode, blockers.length === 0);
  // One expression, so the canvas, the pipeline, both properties rails and every graph-editing
  // affordance answer "can this be changed?" identically. A built-in is app data: the daemon
  // refuses the write, and offering the control anyway is a button that reports an error.
  const readOnly = !workflow || workflow.archivedAt !== null || workflow.builtin;
  const [confirm, setConfirm] = useState<WorkflowConfirmRequest | null>(null);
  const [palettePersona, setPalettePersona] = useState(activePersonas[0]?.id ?? "");
  const [paletteSlot, setPaletteSlot] = useState<WorkflowCheckSlot>(WORKFLOW_CHECK_SLOTS[0]);
  // Held as a raw id and RESOLVED against the addable list at render, not seeded from it: the
  // catalog and the capability answer both arrive after first paint, so a `useState`
  // initializer would pin an empty string and never recover.
  const [paletteActionId, setPaletteActionId] = useState<string | null>(null);
  const paletteAction = addableActions.some((action) => action.id === paletteActionId)
    ? paletteActionId!
    : addableActions[0]?.id ?? "";
  const setPaletteAction = (id: string): void => setPaletteActionId(id);
  const canvasRef = useRef<WorkflowCanvasHandle | null>(null);
  const connectTrigger = useRef<HTMLButtonElement | null>(null);
  const [connectSource, setConnectSource] = useState<string | null>(null);
  const [connectSourcePort, setConnectSourcePort] = useState<WorkflowSourcePort>("pass");
  const [connectTarget, setConnectTarget] = useState("");
  const [connectTargetPort, setConnectTargetPort] = useState<WorkflowTargetPort>("activate");
  const [announcement, setAnnouncement] = useState("");
  const [assertiveAnnouncement, setAssertiveAnnouncement] = useState("");
  const previousValidationErrors = useRef(new Set<string>());
  const [mobileDrawer, setMobileDrawer] = useState<"library" | "properties" | null>(null);
  const openWorkflow = useCallback((id: string | null): void => {
    selectionInitialized.current = true;
    rememberWorkflowId(id);
    setSelection(null);
    // A surface choice belongs to the workflow it was made on, so the next one opens on
    // whatever IT expresses rather than inheriting the last draft's fallback.
    setChosenMode(null);
    setConfirm(null);
    setSelectedId(id);
  }, []);
  useEffect(() => {
    for (const summary of ordered) observedWorkflowIds.current.add(summary.id);
  }, [ordered]);
  useEffect(() => {
    const explicitlyRequestedId = ordered.find((summary) =>
      readRequestedWorkflowVersion(summary.id) !== null)?.id ?? null;
    // A route-named workflow is treated exactly as a version request is: it is BOTH the
    // remembered id and the explicit one, which is the pair `workflowSelectionRestore` reads
    // as "open this, even if it is archived". Passing it only as the remembered id would
    // silently fall back to the first active row for an archived deep link.
    const next = workflowSelectionRestore(
      selectionInitialized.current,
      selectedId,
      active,
      initialWorkflowId ?? readLastWorkflowId(),
      ordered,
      initialWorkflowId ?? explicitlyRequestedId,
    );
    if (next === undefined) return;
    selectionInitialized.current = true;
    rememberWorkflowId(next);
    if (ordered.find((workflow) => workflow.id === next)?.archivedAt !== null) {
      setShowArchived(true);
    }
    setSelectedId(next);
  }, [active, initialWorkflowId, ordered, selectedId]);
  // What is open, reported back so the address bar can name it. One effect on the id rather
  // than a call inside `openWorkflow`, because the restore above and the removal handler
  // below both set it without going through there.
  useEffect(() => onSelectionChange?.(selectedId), [onSelectionChange, selectedId]);
  useEffect(() => {
    if (removalTarget === undefined) return;
    const next = workflowSelectionAfterRemoval(
      hasSnapshot,
      selectedId,
      ordered,
      observedWorkflowIds.current,
      draft.dirty || draft.saving,
    );
    if (next === undefined) {
      draft.showError(workflowLifecycleError(new Error(WORKFLOW_REMOVED_UNSAVED_ERROR)));
      return;
    }
    openWorkflow(next);
  }, [draft.dirty, draft.saving, hasSnapshot, openWorkflow, ordered, removalTarget, selectedId]);
  useEffect(() => {
    if (!activePersonas.some((persona) => persona.id === palettePersona)) setPalettePersona(activePersonas[0]?.id ?? "");
  }, [activePersonas, palettePersona]);
  useEffect(() => {
    const current = new Set((validation?.diagnostics ?? [])
      .filter((item) => item.severity === "error")
      .map((item) => `${item.code}:${item.nodeId ?? ""}:${item.edgeId ?? ""}`));
    const introduced = [...current].filter((key) => !previousValidationErrors.current.has(key));
    previousValidationErrors.current = current;
    if (introduced.length > 0) {
      setAssertiveAnnouncement(
        `${introduced.length} workflow validation error${introduced.length === 1 ? "" : "s"} introduced`,
      );
    }
  }, [validation?.diagnostics]);

  // Memoised because `WorkflowCanvas` lists it in the dependency array that projects its
  // node array, and that projection is synced into React Flow's store from an effect: a
  // fresh closure every render would re-run the sync every render, which is the churn the
  // canvas's own comments describe as ending in "Maximum update depth exceeded".
  const graphRef = workflow?.draft ?? null;
  const labelFor = useCallback(
    (node: StageNode): string =>
      graphRef ? nodeLabel(graphRef, node, personas, sessionActions) : node.kind,
    [graphRef, personas, sessionActions],
  );

  const runTransition = async (work: () => Promise<void>): Promise<void> => {
    if (transitionRef.current) return;
    transitionRef.current = true;
    setTransitioning(true);
    draft.clearError();
    try {
      await work();
    } catch (caught) {
      draft.showError(workflowLifecycleError(caught));
    } finally {
      transitionRef.current = false;
      setTransitioning(false);
    }
  };

  /**
   * Leaving a TOMBSTONED draft is the discard, so it takes a deliberate answer.
   *
   * The banner tells the operator to copy what they need before selecting another workflow
   * or creating one. Nothing enforced that: both paths skip the usual `saveNow()` guard,
   * correctly - the workflow is gone and a save can only fail - and then dropped the draft on
   * the next click of the list. This is what makes the banner's instruction true. It is a
   * confirmation rather than a block because refusing to navigate would strand the operator
   * on a workflow that no longer exists.
   *
   * Returns whether it took over; the caller proceeds only when it did not.
   */
  const requireTombstoneDiscard = (proceed: () => void): boolean => {
    if (!selectedWorkflowRemoved || !draft.dirty) return false;
    setConfirm({
      title: "Discard unsaved changes",
      body: `${workflow?.name ?? "This workflow"} was deleted elsewhere, so these unsaved changes cannot be saved anywhere. Leaving now discards them for good.`,
      confirmLabel: "Discard and continue",
      confirmHint: "Discards these unsavable changes and leaves the deleted workflow",
      danger: true,
      onConfirm: proceed,
    });
    return true;
  };

  const selectNow = async (id: string): Promise<void> => {
    await runTransition(async () => {
      if (selectedWorkflowRemoved) {
        if (draft.saving) await draft.saveNow();
      } else if (!(await draft.saveNow())) {
        return;
      }
      openWorkflow(id);
    });
  };

  const select = async (id: string): Promise<void> => {
    if (id === selectedId || transitionRef.current) return;
    if (requireTombstoneDiscard(() => void selectNow(id))) return;
    await selectNow(id);
  };

  const createNow = async (): Promise<void> => {
    await runTransition(async () => {
      if (selectedWorkflowRemoved) {
        if (draft.saving) await draft.saveNow();
      } else if (!(await draft.saveNow())) {
        return;
      }
      const response = await workflowRequest<CreateResponse>("/api/workflows", {
        method: "POST",
        body: JSON.stringify({ name: nextWorkflowName("Untitled workflow", ordered) }),
      });
      openWorkflow(response.summary.id);
    });
  };

  const create = async (): Promise<void> => {
    if (transitionRef.current) return;
    if (requireTombstoneDiscard(() => void createNow())) return;
    await createNow();
  };

  // The Library's "＋ New workflow" card, honoured here rather than by the card: a workflow
  // draft is a durable row, so the create goes through the same `create` the sidebar's New
  // button uses - CAS, transition lock, unsaved-draft save and all - rather than a second
  // POST beside it.
  //
  // It fires on the EDGE of the request, not on its presence. That is what makes it run once
  // per ask under StrictMode's double-invoked mount effects (which would otherwise leave an
  // orphan "Untitled workflow 2" behind on every visit in development), while still honouring
  // a later ask - a `/new` link pasted while this surface is already up. App replaces the
  // `/new` hash with the created id as soon as the selection is reported, so a reload cannot
  // repeat it either.
  //
  // `create` is deliberately not a dependency: it is rebuilt every render from live state,
  // and the edge above is the whole control.
  const newDraftAsked = useRef(false);
  useEffect(() => {
    const asked = startNew && !newDraftAsked.current;
    newDraftAsked.current = startNew;
    if (asked) void create();
  }, [startNew]);

  const duplicate = async (): Promise<void> => {
    await runTransition(async () => {
      if (!draft.conflict && !(await draft.saveNow())) return;
      const current = draft.current();
      if (!current) return;
      const summary = await draft.duplicate(nextWorkflowName(current.name, ordered, " copy"));
      if (summary) openWorkflow(summary.id);
    });
  };

  const addNode = (spec: NewWorkflowNode, at?: { x: number; y: number }): void => {
    if (!workflow || readOnly) return;
    if (spec.kind === "persona" && !spec.personaId) return;
    // The same guard a Persona gets, plus the capability question a Persona does not have.
    // A drop payload can name an action this daemon cannot run - a stale drag from a tab
    // opened before the catalog changed - and the honest answer is to do nothing rather than
    // to add a node whose graph the server will refuse at Publish.
    if (spec.kind === "session_action"
      && !addableActions.some((action) => action.id === spec.sessionActionId)) return;
    const offset = workflow.draft.nodes.length * 26;
    const id = crypto.randomUUID();
    const center = canvasRef.current?.viewportCenter();
    const requestedPosition = at ?? center ?? { x: 220 + offset, y: 100 + offset };
    const position = {
      x: Math.max(
        -WORKFLOW_LIMITS.canvasCoordinateAbs,
        Math.min(WORKFLOW_LIMITS.canvasCoordinateAbs, requestedPosition.x),
      ),
      y: Math.max(
        -WORKFLOW_LIMITS.canvasCoordinateAbs,
        Math.min(WORKFLOW_LIMITS.canvasCoordinateAbs, requestedPosition.y),
      ),
    };
    const node: WorkflowDraftNode = spec.kind === "persona"
      ? { id, kind: "persona", personaId: spec.personaId, position }
      : spec.kind === "all_pass"
        ? { id, kind: "all_pass", position }
        : spec.kind === "check"
          ? { id, kind: "check", slot: spec.slot, position }
          : spec.kind === "session_action"
            ? { id, kind: "session_action", sessionActionId: spec.sessionActionId, position }
            : { id, kind: "end", outcome: "Complete", position };
    draft.update({ draft: { ...workflow.draft, nodes: [...workflow.draft.nodes, node] } });
    setSelection({ kind: "node", id });
    setAnnouncement(
      `${nodeLabel({ ...workflow.draft, nodes: [...workflow.draft.nodes, node] }, node, personas, sessionActions)} node added at the viewport center`,
    );
  };

  const selectedIds = selection?.kind === "multi"
    ? selection.nodeIds
    : selection?.kind === "node"
      ? [selection.id]
      : [];
  /**
   * The selected nodes Duplicate can actually copy.
   *
   * The control is gated on THIS rather than on "something is selected", because a button that
   * lit up and then did nothing would be indistinguishable from a bug. Two kinds are refused,
   * for two different reasons.
   *
   * Session, because a graph has exactly one.
   *
   * And a session action whose source this daemon cannot currently offer. Duplicating a node
   * is an ADD control by another name - it is the third way to put one in a graph, beside the
   * palette button and the drop handler - so it has to answer the same question they do, and
   * `addableActions` is that question. Without this, a draft that already names an archived or
   * unavailable action (one can arrive through the raw draft API, and Phase 4's Pull Request
   * is unavailable by design) became a way to mint a SECOND unpublishable stage from inside a
   * builder whose every other add control refuses it.
   *
   * An addable action duplicates freely. Two actions in one repair round is a legitimate
   * pipeline - each captures its own evidence segment - and the copy arrives unrouted, exactly
   * like a duplicated Persona.
   */
  const duplicableIds = selectedIds.filter((id) => {
    const node = workflow?.draft.nodes.find((candidate) => candidate.id === id);
    if (!node || node.kind === "session") return false;
    if (node.kind !== "session_action") return true;
    return addableActions.some((action) => action.id === node.sessionActionId);
  });

  const removeCanvasSelection = (nodeIds: string[], edgeIds: string[]): void => {
    if (!workflow || readOnly) return;
    const removable = new Set(nodeIds.filter((id) =>
      workflow.draft.nodes.find((node) => node.id === id)?.kind !== "session"));
    const touching = workflow.draft.edges.filter((edge) =>
      removable.has(edge.source) || removable.has(edge.target));
    const removedEdges = new Set([...edgeIds, ...touching.map((edge) => edge.id)]);
    if (removable.size === 0 && removedEdges.size === 0) return;
    const names = workflow.draft.nodes
      .filter((node) => removable.has(node.id))
      .map((node) => labelFor(node));
    const routes = `${removedEdges.size} connected route${removedEdges.size === 1 ? "" : "s"}`;
    setConfirm({
      title: "Remove selection",
      body: names.length > 0
        ? `Remove ${names.join(", ")} and ${routes}?`
        : `Remove ${routes}?`,
      confirmLabel: "Remove",
      confirmHint: "Removes the selected nodes and the routes touching them",
      danger: true,
      onConfirm: () => {
        draft.update({
          draft: {
            nodes: workflow.draft.nodes.filter((node) => !removable.has(node.id)),
            edges: workflow.draft.edges.filter((edge) => !removedEdges.has(edge.id)),
          },
        });
        setSelection(null);
        setAnnouncement(
          `Removed ${names.length > 0 ? names.join(", ") : "no nodes"} and ${routes}`,
        );
      },
    });
  };

  const duplicateNodes = (): void => {
    if (!workflow || readOnly) return;
    // Session is excluded because a graph has exactly one; `duplicableIds` is the rule.
    const originals = workflow.draft.nodes.filter((node) => duplicableIds.includes(node.id));
    if (originals.length === 0) return;
    const ids = new Map(originals.map((node) => [node.id, crypto.randomUUID()]));
    const copies = originals.map((node) => ({
      ...node,
      id: ids.get(node.id)!,
      position: {
        x: Math.min(WORKFLOW_LIMITS.canvasCoordinateAbs, node.position.x + 36),
        y: Math.min(WORKFLOW_LIMITS.canvasCoordinateAbs, node.position.y + 36),
      },
    })) as WorkflowDraftNode[];
    const copiedEdges = workflow.draft.edges.flatMap((edge) => {
      const source = ids.get(edge.source);
      const target = ids.get(edge.target);
      return source && target
        ? [{ ...edge, id: crypto.randomUUID(), source, target }]
        : [];
    });
    draft.update({
      draft: {
        nodes: [...workflow.draft.nodes, ...copies],
        edges: [...workflow.draft.edges, ...copiedEdges],
      },
    });
    setSelection(copies.length === 1
      ? { kind: "node", id: copies[0]!.id }
      : { kind: "multi", nodeIds: copies.map((node) => node.id), edgeIds: [] });
    setAnnouncement(`Duplicated ${copies.length} node${copies.length === 1 ? "" : "s"}`);
  };

  const startKeyboardConnect = (sourceId?: string): void => {
    const source = sourceId ?? selectedIds[0];
    if (!source) return;
    const node = workflow?.draft.nodes.find((candidate) => candidate.id === source);
    if (!node || node.kind === "end") return;
    const sourcePort = WORKFLOW_NODE_SOURCE_PORTS[node.kind][0];
    if (!sourcePort) return;
    const target = workflow?.draft.nodes.find((candidate) => {
      if (candidate.id === source) return false;
      return WORKFLOW_NODE_TARGET_PORTS[candidate.kind].some((targetPort) =>
        connectionAllowed(node, sourcePort, candidate, targetPort));
    });
    setConnectSource(source);
    setConnectSourcePort(sourcePort);
    setConnectTarget(target?.id ?? "");
    setConnectTargetPort(
      target ? WORKFLOW_NODE_TARGET_PORTS[target.kind][0] ?? "activate" : "activate",
    );
    window.setTimeout(() => {
      document.querySelector<HTMLSelectElement>("#workflow-connect-source")?.focus();
    });
  };

  const finishKeyboardConnect = (): void => {
    if (!workflow || !connectSource) return;
    const source = workflow.draft.nodes.find((node) => node.id === connectSource);
    const target = workflow.draft.nodes.find((node) => node.id === connectTarget);
    if (!source || !target) return;
    if (!connectionAllowed(source, connectSourcePort, target, connectTargetPort)) {
      setAnnouncement("That connection is not allowed by the workflow validator");
      return;
    }
    const edge: WorkflowEdge = {
      id: crypto.randomUUID(),
      source: source.id,
      sourcePort: connectSourcePort,
      target: target.id,
      targetPort: connectTargetPort,
    };
    draft.update({ draft: { ...workflow.draft, edges: [...workflow.draft.edges, edge] } });
    setConnectSource(null);
    setSelection({ kind: "edge", id: edge.id });
    setAnnouncement(`Connected ${labelFor(source)} ${connectSourcePort} to ${labelFor(target)} ${connectTargetPort}`);
    connectTrigger.current?.focus();
  };

  const sourceNode = workflow?.draft.nodes.find((node) => node.id === connectSource) ?? null;
  const targetNode = workflow?.draft.nodes.find((node) => node.id === connectTarget) ?? null;
  const sourcePortOptions: WorkflowSourcePort[] = sourceNode
    ? [...WORKFLOW_NODE_SOURCE_PORTS[sourceNode.kind]]
    : [];
  const targetPortOptions: WorkflowTargetPort[] = targetNode
    ? [...WORKFLOW_NODE_TARGET_PORTS[targetNode.kind]]
    : [];
  const connectTargets = sourceNode
    ? workflow?.draft.nodes.filter((candidate) => {
        if (candidate.id === sourceNode.id) return false;
        return WORKFLOW_NODE_TARGET_PORTS[candidate.kind].some((port) =>
          connectionAllowed(sourceNode, connectSourcePort, candidate, port));
      }) ?? []
    : [];

  const downloadLocalDraft = (): void => {
    if (!workflow) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(workflow, null, 2)], {
      type: "application/json",
    }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `workflow-draft-${workflow.id}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section
      className="workflow-builder"
      onKeyDown={(event) => {
        if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return;
        const target = event.target as HTMLElement;
        if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable) return;
        event.preventDefault();
        if (event.shiftKey) draft.redo();
        else draft.undo();
      }}
    >
      <div className="workflow-mobile-drawers">
        <Tooltip label="Show or hide the workflow library and node palette">
          <button
            className="btn btn-ghost"
            aria-expanded={mobileDrawer === "library"}
            onClick={() => setMobileDrawer((value) => value === "library" ? null : "library")}
          >
            Library
          </button>
        </Tooltip>
        <Tooltip label="Show or hide properties for the current workflow selection">
          <button
            className="btn btn-ghost"
            aria-expanded={mobileDrawer === "properties"}
            onClick={() => setMobileDrawer((value) => value === "properties" ? null : "properties")}
          >
            Properties
          </button>
        </Tooltip>
      </div>
      <aside
        className={`workflow-library-sidebar${mobileDrawer === "library" ? " mobile-open" : ""}`}
        aria-label="Workflow library and node palette"
        ref={tourRailRef}
      >
        <LibraryBackRow onLeave={onLeave} />
        <header><div><h3>Workflows</h3><p>Drafts and published versions</p></div><Tooltip label="Create a new workflow draft"><button className="btn" disabled={transitioning} onClick={() => void create()}>New</button></Tooltip></header>
        <div className="workflow-library-list">
          {listed.length === 0 && <p>No workflow drafts yet.</p>}
          {listed.map((summary) => (
            <Tooltip
              key={summary.id}
              label={summary.builtin
                ? `Open the built-in ${summary.name} - read-only, Duplicate to customize`
                : `Open ${summary.name} in the builder`}
            >
              <button disabled={transitioning} className={selectedId === summary.id ? "active" : ""} onClick={() => void select(summary.id)}>
                <strong>{summary.name}{summary.builtin && <em className="wf-list-tag">Built-in</em>}</strong>
                <span>{summary.archivedAt !== null ? "Archived" : summary.errorCount ? `${summary.errorCount} errors` : "Draft valid"}{summary.publishedVersion ? ` · v${summary.publishedVersion}` : ""}</span>
              </button>
            </Tooltip>
          ))}
          {ordered.some((summary) => summary.archivedAt !== null) && <label className="workflow-show-archived"><Tooltip label="Include archived workflows in this list"><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} /></Tooltip> Show archived</label>}
        </div>
        {workflow && !readOnly && mode === "graph" && (
          <section className="workflow-palette">
            <h4>Node palette</h4>
            <p>Session is fixed. Add review and terminal nodes.</p>
            <Tooltip label="Which Persona a new review node runs">
              <select aria-label="Persona for new node" disabled={transitioning} value={palettePersona} onChange={(event) => setPalettePersona(event.target.value)}>
                <option value="">Choose a Persona</option>
                {activePersonas.map((persona) => <option key={persona.id} value={persona.id}>{persona.name}</option>)}
              </select>
            </Tooltip>
            <Tooltip label={palettePersona ? "Add a review node running the chosen Persona - or drag it onto the canvas" : "Choose a Persona above first"}>
              <button disabled={transitioning || !palettePersona} draggable={!transitioning && Boolean(palettePersona)} onDragStart={(event) => event.dataTransfer.setData(NEW_NODE_MIME, JSON.stringify({ kind: "persona", personaId: palettePersona }))} onClick={() => addNode({ kind: "persona", personaId: palettePersona })}>＋ Persona</button>
            </Tooltip>
            <Tooltip label="Add a join that waits for every incoming branch to pass - or drag it onto the canvas">
              <button disabled={transitioning} draggable={!transitioning} onDragStart={(event) => event.dataTransfer.setData(NEW_NODE_MIME, JSON.stringify({ kind: "all_pass" }))} onClick={() => addNode({ kind: "all_pass" })}>＋ All-pass Join</button>
            </Tooltip>
            <Tooltip label="Which deterministic gate a new Command node runs">
              <select aria-label="Slot for new Command node" disabled={transitioning} value={paletteSlot} onChange={(event) => setPaletteSlot(event.target.value as WorkflowCheckSlot)}>
                {WORKFLOW_CHECK_SLOTS.map((slot) => <option key={slot} value={slot}>{slot}</option>)}
              </select>
            </Tooltip>
            <Tooltip label="Add a gate on whatever this machine configures for that Command - or drag it onto the canvas">
              <button disabled={transitioning} draggable={!transitioning} onDragStart={(event) => event.dataTransfer.setData(NEW_NODE_MIME, JSON.stringify({ kind: "check", slot: paletteSlot }))} onClick={() => addNode({ kind: "check", slot: paletteSlot })}>＋ Command</button>
            </Tooltip>
            {/* What that slot is actually configured to run, said where the node is added.
                The workflow stays portable - it stores the slot and nothing else - so this is
                a fact about THIS machine, and the link is how an operator changes it without
                hunting for where commands live. */}
            <p className="workflow-palette-note">
              {workflowCommandStatusSentence(
                workflowCommands.find((view) => view.slot === paletteSlot),
                hasSnapshot,
              )}{" "}
              <Tooltip label={`Set what the ${paletteSlot} Command runs on this machine`}>
                <a
                  className="workflow-palette-link"
                  href={missionRouteHash({
                    page: "library",
                    shelf: "commands",
                    assetId: paletteSlot,
                  })}
                >
                  Configure {paletteSlot} in Library →
                </a>
              </Tooltip>
            </p>
            {/* The whole entry is absent when nothing is addable, rather than a disabled
                button beside an empty select. There are two reasons an operator can be in
                that state - no action authored, or none this daemon can run - and neither is
                answered by a control that is present and refuses. */}
            {addableActions.length > 0 && (
              <>
                <Tooltip label="Which instruction a new session action node sends to the bound session">
                  <select aria-label="Session action for new node" disabled={transitioning} value={paletteAction} onChange={(event) => setPaletteAction(event.target.value)}>
                    {addableActions.map((action) => <option key={action.id} value={action.id}>{action.name}</option>)}
                  </select>
                </Tooltip>
                <Tooltip label={paletteAction ? "Add a node that sends the chosen instruction and waits for that turn to finish - or drag it onto the canvas" : "Choose a session action above first"}>
                  <button disabled={transitioning || !paletteAction} draggable={!transitioning && Boolean(paletteAction)} onDragStart={(event) => event.dataTransfer.setData(NEW_NODE_MIME, JSON.stringify({ kind: "session_action", sessionActionId: paletteAction }))} onClick={() => addNode({ kind: "session_action", sessionActionId: paletteAction })}>＋ Session action</button>
                </Tooltip>
              </>
            )}
            <Tooltip label="Add a terminal outcome node - or drag it onto the canvas">
              <button disabled={transitioning} draggable={!transitioning} onDragStart={(event) => event.dataTransfer.setData(NEW_NODE_MIME, JSON.stringify({ kind: "end" }))} onClick={() => addNode({ kind: "end" })}>＋ End</button>
            </Tooltip>
          </section>
        )}
      </aside>

      <div className="workflow-builder-main">
        {!selectedId && (
          <section className="workflow-empty"><span className="workflow-empty-mark">◇</span><h3>Build a review workflow</h3><p>Create a draft, then connect Session, Personas, joins, and End outcomes.</p><Tooltip label="Create a new workflow draft"><button className="btn" disabled={transitioning} onClick={() => void create()}>New workflow</button></Tooltip></section>
        )}
        {draft.loading && <section className="workflow-empty"><p>Loading workflow…</p></section>}
        <WorkflowLoadError error={draft.error} canRetry={Boolean(selectedId && !workflow && !draft.loading)} onRetry={() => void draft.reload()} />
        {workflow && (
          <>
            {/* Three groups: what you are looking at, what you are editing with, and what
                leaves the draft. Archive used to sit filled-red beside Publish, which is one
                mis-click between "ship this" and "retire this". */}
            <header className="workflow-builder-toolbar">
              <div><p className="workflow-eyebrow">{workflow.builtin ? "Built-in workflow" : `Draft revision ${workflow.draftRevision}`}</p><h3>{workflow.name}</h3></div>
              <span className={draft.saving || transitioning ? "is-saving" : draft.dirty ? "is-dirty" : "is-saved"}>{transitioning ? "Working…" : draft.saving ? "Saving…" : draft.dirty ? "Unsaved changes" : "Saved"}</span>
              <div
                className="wf-view-toggle"
                role="group"
                aria-label="Editing surface"
                ref={tourSurfaceToggleRef}
              >
                <Tooltip label={blockers.length === 0
                  ? "Author this workflow as stages of reviewers"
                  : "This graph is not a pipeline - see the reasons below the toolbar"}>
                  <button
                    className={mode === "pipeline" ? "active" : ""}
                    aria-pressed={mode === "pipeline"}
                    disabled={blockers.length > 0}
                    onClick={() => setChosenMode("pipeline")}
                  >
                    Pipeline
                  </button>
                </Tooltip>
                <Tooltip label="Edit the underlying graph directly">
                  <button
                    className={mode === "graph" ? "active" : ""}
                    aria-pressed={mode === "graph"}
                    onClick={() => setChosenMode("graph")}
                  >
                    Graph
                  </button>
                </Tooltip>
              </div>
              <div className="workflow-toolbar-group">
                <Tooltip label={draft.canUndo ? "Undo the last local draft edit" : "Nothing to undo"}>
                  <button className="btn btn-ghost" disabled={!draft.canUndo} onClick={draft.undo}>
                    Undo
                  </button>
                </Tooltip>
                <Tooltip label={draft.canRedo ? "Redo the last undone draft edit" : "Nothing to redo"}>
                  <button className="btn btn-ghost" disabled={!draft.canRedo} onClick={draft.redo}>
                    Redo
                  </button>
                </Tooltip>
                <Tooltip label={workflow.builtin
                  ? "Start an editable copy of this built-in workflow - this is how you customize it"
                  : "Copy this workflow into a new draft"}>
                  <button className="btn btn-ghost" disabled={transitioning} onClick={() => void duplicate()}>Duplicate</button>
                </Tooltip>
                {mode === "graph" && (
                  <>
                    <Tooltip label={duplicableIds.length > 0 ? "Duplicate selected Persona, All-pass Join, Command, or End nodes" : "Select a Persona, All-pass Join, Command, or End node first"}>
                      <button className="btn btn-ghost" disabled={duplicableIds.length === 0} onClick={duplicateNodes}>
                        Duplicate nodes
                      </button>
                    </Tooltip>
                    <Tooltip label="Arrange the graph visually without changing its meaning">
                      <button
                        className="btn btn-ghost"
                        onClick={() => {
                          draft.update({ draft: autoLayoutWorkflow(workflow.draft) });
                          window.requestAnimationFrame(() => canvasRef.current?.fit());
                          setAnnouncement("Workflow auto-layout complete");
                        }}
                      >
                        Auto-layout
                      </button>
                    </Tooltip>
                    <Tooltip label={selectedIds.length === 1 ? "Connect the selected node with a keyboard dialog" : "Select one non-terminal node first"}>
                      <button
                        ref={connectTrigger}
                        className="btn btn-ghost"
                        disabled={selectedIds.length !== 1 || workflow.draft.nodes.find((node) => node.id === selectedIds[0])?.kind === "end"}
                        onClick={() => startKeyboardConnect()}
                      >
                        Connect…
                      </button>
                    </Tooltip>
                  </>
                )}
              </div>
              <div className="workflow-toolbar-group workflow-toolbar-ship">
                {neverPublished && (
                  <DeleteButton
                    className="btn btn-danger-ghost"
                    disabled={transitioning}
                    tooltip="Delete this workflow permanently - offered only before its first publish"
                    onClick={() => setConfirm({
                      title: "Delete workflow",
                      body: `Delete ${workflow.name}? It has never been published, so there are no versions, bindings, or run history to keep. This cannot be undone.`,
                      confirmLabel: "Delete",
                      confirmHint: "Permanently deletes this never-published workflow",
                      danger: true,
                      shortcut: "delete",
                      onConfirm: () => void runTransition(async () => {
                        if (!(await draft.saveNow())) return;
                        const current = draft.current();
                        if (!current) return;
                        await workflowRequest(`/api/workflows/${current.id}/delete`, { method: "POST", body: JSON.stringify({ expectedDraftRevision: current.draftRevision }) });
                        openWorkflow(active.find((item) => item.id !== current.id)?.id ?? null);
                      }),
                    })}
                  >Delete</DeleteButton>
                )}
                {workflow.archivedAt === null ? (
                  // All three strings state the same two facts, because each is read on its
                  // own: an ACTIVE binding blocks the archive outright (`archiveWorkflowCas`
                  // refuses with `active_binding`), and what survives one is the published
                  // versions. Saying only the second, as these did, offered reassurance for a
                  // case the guard never lets happen.
                  // A built-in is never archived, so it always lands in this branch. It gets
                  // the Archive button disabled with its OWN reason: "blocked while a binding
                  // is active" would send the operator hunting for a binding to release.
                  <Tooltip label={workflow.builtin
                    ? "Built-in workflows cannot be archived - Duplicate one to own a copy you can retire"
                    : "Archive this workflow - blocked while a binding is active; published versions stay readable"}>
                    <button className="btn btn-danger-ghost" disabled={workflowArchiveBlocked({ transitioning, archived: false, builtin: workflow.builtin })} onClick={() => setConfirm({
                      title: "Archive workflow",
                      body: `Archive ${workflow.name}? Archiving is blocked while any binding is still active. Published versions and past run history stay readable, and you can restore it later.`,
                      confirmLabel: "Archive",
                      confirmHint: "Archives the workflow unless a binding is still active - its published versions stay readable",
                      danger: true,
                      onConfirm: () => void runTransition(async () => {
                        if (!(await draft.saveNow())) return;
                        const current = draft.current();
                        if (!current) return;
                        await workflowRequest(`/api/workflows/${current.id}`, { method: "DELETE", body: JSON.stringify({ expectedDraftRevision: current.draftRevision }) });
                        openWorkflow(active.find((item) => item.id !== current.id)?.id ?? null);
                      }),
                    })}>Archive</button>
                  </Tooltip>
                ) : (
                  // No confirmation: restoring destroys nothing, and the name it reclaims was
                  // never released, so nothing else can be holding it.
                  <Tooltip label="Restore this workflow to the active library">
                    <button className="btn" disabled={transitioning} onClick={() => void runTransition(async () => {
                      const current = draft.current();
                      if (!current) return;
                      await workflowRequest(`/api/workflows/${current.id}/unarchive`, { method: "POST", body: JSON.stringify({ expectedDraftRevision: current.draftRevision }) });
                      await draft.reload();
                      setAnnouncement(`Restored ${current.name}`);
                    })}>Restore</button>
                  </Tooltip>
                )}
                <Tooltip label={workflow.builtin ? "Built-in workflows ship already published" : validation?.valid === false ? "Fix the validation errors before publishing" : alreadyPublished ? "This draft is already published" : "Publish this draft as a new immutable version"}>
                  <button className="btn" disabled={transitioning || workflowPublishBlocked({ dirty: draft.dirty, saving: draft.saving, conflicted: Boolean(draft.conflict), valid: Boolean(validation?.valid), alreadyPublished, archived: workflow.archivedAt !== null, builtin: workflow.builtin })} ref={tourPublishRef} onClick={() => void draft.publish()}>Publish</button>
                </Tooltip>
              </div>
            </header>
            <WorkflowStateNotice
              builtin={workflow.builtin}
              archived={workflow.archivedAt !== null}
            />
            {mode === "graph" && blockers.length > 0 && (
              <div className="wf-pipeline-blockers" role="status">
                <p>Pipeline view unavailable:</p>
                <ul>{blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>
              </div>
            )}
            {draft.conflict && (
              <div className="workflow-conflict" role="alert"><span>A newer draft revision exists. Autosave is paused.</span><Tooltip label="Download your local draft before deciding how to resolve the conflict"><button onClick={downloadLocalDraft}>Download local draft</button></Tooltip><Tooltip label="Discard your unsaved edits and load the newer revision"><button onClick={() => void draft.reload()}>Reload latest</button></Tooltip><Tooltip label="Keep your edits by copying them into a new workflow"><button onClick={() => void duplicate()}>Duplicate my draft</button></Tooltip></div>
            )}
            {mode === "graph" && connectSource && (
              <form
                className="workflow-connect-dialog"
                role="group"
                aria-labelledby="workflow-connect-title"
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  event.preventDefault();
                  setConnectSource(null);
                  connectTrigger.current?.focus();
                }}
                onSubmit={(event) => {
                  event.preventDefault();
                  finishKeyboardConnect();
                }}
              >
                <h4 id="workflow-connect-title">Connect selected node</h4>
                <label>
                  Source
                  <Tooltip label="Choose the node where this connection starts">
                    <select
                      id="workflow-connect-source"
                      value={connectSource}
                      onChange={(event) => startKeyboardConnect(event.target.value)}
                    >
                      {workflow.draft.nodes.filter((node) => node.kind !== "end").map((node) => (
                        <option key={node.id} value={node.id}>{labelFor(node)}</option>
                      ))}
                    </select>
                  </Tooltip>
                </label>
                <label>
                  Output
                  <Tooltip label="Choose which outcome leaves the source node">
                    <select
                      value={connectSourcePort}
                      onChange={(event) => {
                        const port = event.target.value as WorkflowSourcePort;
                        setConnectSourcePort(port);
                        if (!sourceNode || !targetNode) return;
                        const nextTargetPort = WORKFLOW_NODE_TARGET_PORTS[targetNode.kind][0];
                        if (!nextTargetPort) return;
                        if (!connectionAllowed(sourceNode, port, targetNode, nextTargetPort)) {
                          const nextTarget = workflow.draft.nodes.find((candidate) => {
                            if (candidate.id === sourceNode.id) return false;
                            return WORKFLOW_NODE_TARGET_PORTS[candidate.kind].some((candidatePort) =>
                              connectionAllowed(sourceNode, port, candidate, candidatePort));
                          });
                          setConnectTarget(nextTarget?.id ?? "");
                          setConnectTargetPort(
                            nextTarget
                              ? WORKFLOW_NODE_TARGET_PORTS[nextTarget.kind][0] ?? "activate"
                              : "activate",
                          );
                        }
                      }}
                    >
                      {sourcePortOptions.map((port) => <option key={port} value={port}>{port}</option>)}
                    </select>
                  </Tooltip>
                </label>
                <label>
                  Target
                  <Tooltip label="Choose the node this connection reaches">
                    <select
                      id="workflow-connect-target"
                      value={connectTarget}
                      onChange={(event) => {
                        const id = event.target.value;
                        const target = workflow.draft.nodes.find((node) => node.id === id);
                        setConnectTarget(id);
                        setConnectTargetPort(
                          target ? WORKFLOW_NODE_TARGET_PORTS[target.kind][0] ?? "activate" : "activate",
                        );
                      }}
                    >
                      {connectTargets.map((node) => (
                        <option key={node.id} value={node.id}>{labelFor(node)}</option>
                      ))}
                    </select>
                  </Tooltip>
                </label>
                <label>
                  Input
                  <Tooltip label="Choose which input receives the connection">
                    <select
                      value={connectTargetPort}
                      onChange={(event) => setConnectTargetPort(event.target.value as WorkflowTargetPort)}
                    >
                      {targetPortOptions.map((port) => <option key={port} value={port}>{port}</option>)}
                    </select>
                  </Tooltip>
                </label>
                <Tooltip label="Create this validated workflow connection">
                  <button className="btn" type="submit" disabled={!sourceNode || !targetNode}>
                    Connect
                  </button>
                </Tooltip>
                <Tooltip label="Close the keyboard connection form without changing the graph">
                  <button
                    className="btn btn-ghost"
                    type="button"
                    onClick={() => {
                      setConnectSource(null);
                      connectTrigger.current?.focus();
                    }}
                  >
                    Cancel
                  </button>
                </Tooltip>
              </form>
            )}
            {mode === "pipeline" ? (
              <PipelineEditor
                key={workflow.id}
                graph={workflow.draft}
                personas={personas}
                sessionActions={sessionActions}
                availableCompletions={capabilities.available}
                completionPolicy={workflow.completionPolicy}
                readOnly={transitioning || readOnly}
                onChange={(graph) => draft.update({ draft: graph })}
                onConfirm={setConfirm}
                onAnnounce={setAnnouncement}
              />
            ) : (
              <WorkflowCanvas
                key={workflow.id}
                ref={canvasRef}
                graph={workflow.draft}
                personas={personas}
                sessionActions={sessionActions}
                labelFor={labelFor}
                readOnly={transitioning || readOnly}
                onChange={(graph) => draft.update({ draft: graph })}
                onSelection={setSelection}
                onDropNode={(spec, position) => addNode(spec, position)}
                onDeleteSelection={removeCanvasSelection}
                onKeyboardConnect={startKeyboardConnect}
                onAnnounce={setAnnouncement}
              />
            )}
            <p className="sr-only" aria-live="polite">{announcement}</p>
            <p className="sr-only" aria-live="assertive">{assertiveAnnouncement}</p>
          </>
        )}
      </div>

      {workflow && validation && (
        <div className={`workflow-builder-right${mobileDrawer === "properties" ? " mobile-open" : ""}`}>
          {mode === "pipeline" ? (
            <WorkflowPipelineProperties
              workflow={workflow}
              diagnostics={validation.diagnostics}
              stageCount={pipeline?.stages.length ?? 0}
              readOnly={transitioning || readOnly}
              onUpdate={draft.update}
            />
          ) : (
            <WorkflowProperties
              workflow={workflow}
              personas={personas}
              sessionActions={sessionActions}
              availableCompletions={capabilities.available}
              diagnostics={validation.diagnostics}
              selection={selection}
              readOnly={transitioning || readOnly}
              onUpdate={draft.update}
              onConfirm={setConfirm}
            />
          )}
          <WorkflowVersionHistory
            workflowId={workflow.id}
            versions={draft.versions}
            personas={personas}
            sessionActions={sessionActions}
            builtin={workflow.builtin}
            onBindVersion={workflow.archivedAt === null ? onBindVersion : undefined}
          />
          {/* Archived is checked here as well as on the version-history binding above,
              because these are two independent doors into the same bind flow and the server
              refuses both. Offering one of them would start a flow whose only ending is a
              409 the operator did not ask for.

              `currentVersionId` is the same rule for the same reason, and it is not
              hypothetical: a brand-new workflow is the stage-expressible session+end graph, so
              it opens in Pipeline mode before its first publish. There is no immutable version
              to bind, and a dialog handed a workflow with none falls through to answering a
              DIFFERENT question - what is the target session already bound to - and opens
              unlocked on that unrelated binding, one click from reattaching it. Publish first,
              then bind. */}
          {mode === "pipeline"
            && onBindWorkflow
            && workflow.archivedAt === null
            && workflow.currentVersionId !== null && (
            <section className="wf-pipeline-bind">
              <Tooltip label={`Pick a session to run ${workflow.name} against`}>
                <button className="btn" ref={tourBindRef} onClick={() => onBindWorkflow(workflow)}>
                  Bind to a session…
                </button>
              </Tooltip>
            </section>
          )}
        </div>
      )}
      {confirm && (
        <WorkflowConfirmModal request={confirm} onClose={() => setConfirm(null)} />
      )}
    </section>
  );
}
