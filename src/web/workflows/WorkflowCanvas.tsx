import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Background,
  ControlButton,
  Controls,
  MiniMap,
  ReactFlow,
  ViewportPortal,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type CoordinateExtent,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type ReactFlowInstance,
  useReactFlow,
  useStore,
} from "@xyflow/react";
import { WORKFLOW_LIMITS } from "@shared/workflow.ts";
import type {
  PersonaView,
  PublishedWorkflowNode,
  PublishedWorkflowGraph,
  WorkflowDraftGraph,
  WorkflowDraftNode,
  WorkflowEdge,
  WorkflowSourcePort,
  WorkflowTargetPort,
} from "@shared/workflow.ts";
import { connectionAllowed } from "@shared/workflow-graph.ts";
import { checkLabel } from "@shared/workflow-stages.ts";
import { Tooltip } from "../components/Tooltip.tsx";
import { WORKFLOW_NODE_TYPES, type WorkflowCanvasNode } from "./WorkflowNode.tsx";
import { NEW_NODE_MIME, parseDroppedNode, type NewWorkflowNode } from "./new-node.ts";

export type WorkflowSelection =
  | { kind: "node" | "edge"; id: string }
  | { kind: "multi"; nodeIds: string[]; edgeIds: string[] }
  | null;

export interface WorkflowCanvasHandle {
  viewportCenter: () => { x: number; y: number };
  fit: () => void;
}

const EMPTY_NODE_STATUSES: Readonly<Record<string, string>> = {};
const GRID_SIZE = 18;
const ALIGNMENT_TOLERANCE = 6;

// These reach `<ReactFlow>` as array props that get synced into its internal store from
// effects keyed on the prop's identity (`snapGrid` / `nodeExtent` via `StoreUpdater`,
// `multiSelectionKeyCode` via `GraphView`). A fresh literal every render makes those effects
// fire every render, and during an interaction that already re-renders on its own - starting
// a connection drag - the churn compounds into "Maximum update depth exceeded" and React
// unmounts the whole tree (the canvas goes black). They are built from module constants, so
// hoisting them to one stable reference removes the churn entirely.
const SNAP_GRID: [number, number] = [GRID_SIZE, GRID_SIZE];
const NODE_EXTENT: CoordinateExtent = [
  [-WORKFLOW_LIMITS.canvasCoordinateAbs, -WORKFLOW_LIMITS.canvasCoordinateAbs],
  [WORKFLOW_LIMITS.canvasCoordinateAbs, WORKFLOW_LIMITS.canvasCoordinateAbs],
];
const MULTI_SELECTION_KEYS = ["Meta", "Control"];

function boundedCoordinate(value: number): number {
  return Math.max(
    -WORKFLOW_LIMITS.canvasCoordinateAbs,
    Math.min(WORKFLOW_LIMITS.canvasCoordinateAbs, value),
  );
}

export function nextRovingNodeId(
  nodeIds: readonly string[],
  currentId: string,
  backwards: boolean,
): string | null {
  const currentIndex = nodeIds.indexOf(currentId);
  if (currentIndex < 0) return null;
  const nextIndex = currentIndex + (backwards ? -1 : 1);
  return nodeIds[nextIndex] ?? null;
}

function fitDuration(): number {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0 : 180;
}

function WorkflowControls(): React.JSX.Element {
  const { fitView, setViewport, zoomIn, zoomOut } = useReactFlow();
  const zoom = useStore((state) => state.transform[2]);
  const minZoom = useStore((state) => state.minZoom);
  const maxZoom = useStore((state) => state.maxZoom);
  const minZoomReached = zoom <= minZoom;
  const maxZoomReached = zoom >= maxZoom;
  return (
    <Controls showZoom={false} showFitView={false} showInteractive={false}>
      <Tooltip label={maxZoomReached ? "Already at maximum zoom" : "Zoom in"}>
        <ControlButton
          aria-label="Zoom in"
          disabled={maxZoomReached}
          onClick={() => {
            if (!maxZoomReached) void zoomIn();
          }}
        >
          <span aria-hidden>＋</span>
        </ControlButton>
      </Tooltip>
      <Tooltip label={minZoomReached ? "Already at minimum zoom" : "Zoom out"}>
        <ControlButton
          aria-label="Zoom out"
          disabled={minZoomReached}
          onClick={() => {
            if (!minZoomReached) void zoomOut();
          }}
        >
          <span aria-hidden>−</span>
        </ControlButton>
      </Tooltip>
      <Tooltip label="Fit the graph to view">
        <ControlButton aria-label="Fit the graph to view" onClick={() => void fitView()}>
          <span aria-hidden>□</span>
        </ControlButton>
      </Tooltip>
      <Tooltip label="Reset the canvas to 100% zoom">
        <ControlButton
          aria-label="Reset canvas zoom"
          onClick={() => void setViewport({ x: 0, y: 0, zoom: 1 })}
        >
          <span aria-hidden>1:1</span>
        </ControlButton>
      </Tooltip>
    </Controls>
  );
}

function isPublishedPersona(node: WorkflowDraftNode | PublishedWorkflowNode): node is Extract<PublishedWorkflowNode, { kind: "persona" }> {
  return node.kind === "persona" && "persona" in node;
}

/**
 * How each node kind is SAID, for screen readers. The wire kinds (`all_pass`, `end`) are
 * storage spellings, not words an operator uses.
 */
const NODE_KIND_WORDS: Record<WorkflowDraftNode["kind"], string> = {
  session: "Session",
  persona: "Reviewer",
  all_pass: "All-pass join",
  check: "Check",
  end: "End",
};

function canvasNodes(
  graph: WorkflowDraftGraph | PublishedWorkflowGraph,
  personas: readonly PersonaView[],
  readOnly: boolean,
  nodeStatuses: Readonly<Record<string, string>>,
  focusNodeId: string | null,
  labelFor: ((node: WorkflowDraftNode | PublishedWorkflowNode) => string) | null,
): WorkflowCanvasNode[] {
  const personaMap = new Map(personas.map((persona) => [persona.id, persona]));
  const incoming = new Map<string, Set<string>>();
  const outgoing = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    const predecessors = incoming.get(edge.target) ?? new Set<string>();
    predecessors.add(edge.source);
    incoming.set(edge.target, predecessors);
    const successors = outgoing.get(edge.source) ?? new Set<string>();
    successors.add(edge.target);
    outgoing.set(edge.source, successors);
  }
  return graph.nodes.map((node) => {
    // The subtitle stays derived here: it is the `runner · model` line and the snapshot
    // revision, which are canvas presentation and not part of the shared name vocabulary.
    // The LABEL is - `labelFor` is how a caller hands it the one human name every other
    // surface prints, so a join reads as its stage rather than as "All pass" twice over.
    let fallbackLabel = "Session";
    let subtitle = "Submission and repair boundary";
    if (node.kind === "persona") {
      const snapshot = isPublishedPersona(node) ? node.persona : null;
      const live = snapshot ? null : personaMap.get((node as Extract<WorkflowDraftNode, { kind: "persona" }>).personaId);
      fallbackLabel = snapshot?.name ?? live?.name ?? "Missing Persona";
      subtitle = snapshot
        ? `Snapshot revision ${snapshot.sourceRevision}`
        : live ? `${live.execution.runner.id} · ${live.execution.model.id}` : "Select an active Persona";
    } else if (node.kind === "all_pass") {
      fallbackLabel = "All pass";
      subtitle = `${incoming.get(node.id)?.size ?? 0} predecessor${incoming.get(node.id)?.size === 1 ? "" : "s"}`;
    } else if (node.kind === "check") {
      // The slot, never a command: the node names the gate and the machine names what runs.
      // A subtitle quoting the operator's configured argv would put a machine-local fact on
      // a canvas that also draws published versions, where it is not part of the version.
      fallbackLabel = checkLabel(node.slot);
      subtitle = "Configured in Settings › Workflows";
    } else if (node.kind === "end") {
      fallbackLabel = node.outcome;
      subtitle = "Terminal outcome";
    }
    const label = labelFor?.(node) ?? fallbackLabel;
    return {
      id: node.id,
      type: node.kind,
      position: node.position,
      deletable: !readOnly && node.kind !== "session",
      draggable: !readOnly,
      selectable: true,
      focusable: node.id === focusNodeId,
      ariaLabel: `${NODE_KIND_WORDS[node.kind]} node, ${label}, ${incoming.get(node.id)?.size ?? 0} incoming connections, ${outgoing.get(node.id)?.size ?? 0} outgoing connections`,
      className: nodeStatuses[node.id] ? `workflow-runtime-${nodeStatuses[node.id]}` : undefined,
      data: {
        kind: node.kind,
        label,
        subtitle,
        readOnly,
        runtimeStatus: nodeStatuses[node.id] ?? null,
        incomingCount: incoming.get(node.id)?.size ?? 0,
        outgoingCount: outgoing.get(node.id)?.size ?? 0,
      },
    };
  });
}

const canvasEdges = (edges: readonly WorkflowEdge[], readOnly: boolean): Edge[] => edges.map((edge) => ({
  id: edge.id,
  source: edge.source,
  sourceHandle: edge.sourcePort,
  target: edge.target,
  targetHandle: edge.targetPort,
  deletable: !readOnly,
  label: edge.sourcePort,
  className: edge.sourcePort === "fail" ? "workflow-edge-fail" : "workflow-edge-pass",
}));

export function reconcileCanvasNodes(
  current: readonly WorkflowCanvasNode[],
  projected: readonly WorkflowCanvasNode[],
): WorkflowCanvasNode[] {
  const currentById = new Map(current.map((node) => [node.id, node]));
  return projected.map((node) => {
    const previous = currentById.get(node.id);
    return previous ? {
      ...node,
      measured: previous.measured,
      selected: previous.selected,
      dragging: previous.dragging,
      resizing: previous.resizing,
    } : node;
  });
}

export function reconcileCanvasEdges(
  current: readonly Edge[],
  projected: readonly Edge[],
): Edge[] {
  const currentById = new Map(current.map((edge) => [edge.id, edge]));
  return projected.map((edge) => {
    const previous = currentById.get(edge.id);
    return previous ? { ...edge, selected: previous.selected } : edge;
  });
}

/** Deterministic visual-only layout. Node and edge identities and semantics stay unchanged. */
export function autoLayoutWorkflow(graph: WorkflowDraftGraph): WorkflowDraftGraph {
  const layer = new Map<string, number>();
  const incoming = new Map(graph.nodes.map((node) => [node.id, 0]));
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  // A fail edge back to the one Session node is a repair loop, not a forward layout
  // dependency. Counting it made Kahn's walk revisit Session and place it after its
  // reviewers in every valid workflow.
  const layoutEdges = graph.edges.filter((edge) => byId.get(edge.target)?.kind !== "session");
  for (const edge of layoutEdges) {
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
  }
  const ready = graph.nodes.filter((node) => (incoming.get(node.id) ?? 0) === 0).map((node) => node.id);
  for (const node of graph.nodes) if (node.kind === "session" && !ready.includes(node.id)) ready.unshift(node.id);
  const outgoing = new Map<string, WorkflowEdge[]>();
  for (const edge of layoutEdges) {
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge]);
  }
  while (ready.length > 0) {
    const id = ready.shift()!;
    const currentLayer = layer.get(id) ?? 0;
    layer.set(id, currentLayer);
    for (const edge of outgoing.get(id) ?? []) {
      layer.set(edge.target, Math.max(layer.get(edge.target) ?? 0, currentLayer + 1));
      incoming.set(edge.target, (incoming.get(edge.target) ?? 1) - 1);
      if (incoming.get(edge.target) === 0) ready.push(edge.target);
    }
  }
  const fallbackLayer = Math.max(0, ...layer.values()) + 1;
  const rows = new Map<number, number>();
  return {
    ...graph,
    nodes: graph.nodes.map((node) => {
      const column = layer.get(node.id) ?? fallbackLayer;
      const row = rows.get(column) ?? 0;
      rows.set(column, row + 1);
      return {
        ...node,
        position: { x: 60 + column * 280, y: 60 + row * 170 },
      };
    }),
  };
}

export const WorkflowCanvas = forwardRef<WorkflowCanvasHandle, {
  graph: WorkflowDraftGraph | PublishedWorkflowGraph;
  personas: PersonaView[];
  readOnly?: boolean;
  onChange?: (graph: WorkflowDraftGraph) => void;
  onSelection?: (selection: WorkflowSelection) => void;
  onDropNode?: (spec: NewWorkflowNode, position: { x: number; y: number }) => void;
  onDeleteSelection?: (nodeIds: string[], edgeIds: string[]) => void;
  onKeyboardConnect?: (sourceNodeId: string) => void;
  onAnnounce?: (message: string) => void;
  nodeStatuses?: Readonly<Record<string, string>>;
  /**
   * The human name for a node. Supplied by the caller (which already holds the graph and the
   * Persona list) so the canvas prints the same word the pipeline, the rails and the
   * announcements do, rather than re-deriving a second vocabulary here.
   */
  labelFor?: (node: WorkflowDraftNode | PublishedWorkflowNode) => string;
}>(function WorkflowCanvas({
  graph,
  personas,
  readOnly = false,
  onChange,
  onSelection,
  onDropNode,
  onDeleteSelection,
  onKeyboardConnect,
  onAnnounce,
  nodeStatuses = EMPTY_NODE_STATUSES,
  labelFor,
}, forwardedRef): React.JSX.Element {
  const [focusNodeId, setFocusNodeId] = useState<string | null>(graph.nodes[0]?.id ?? null);
  const projectedNodes = useMemo(
    () => canvasNodes(graph, personas, readOnly, nodeStatuses, focusNodeId, labelFor ?? null),
    [graph, personas, readOnly, nodeStatuses, focusNodeId, labelFor],
  );
  const [nodes, setNodes] = useState(projectedNodes);
  const projectedEdges = useMemo(() => canvasEdges(graph.edges, readOnly), [graph.edges, readOnly]);
  const [edges, setEdges] = useState(projectedEdges);
  const [alignmentGuide, setAlignmentGuide] = useState<{ x: number | null; y: number | null }>({
    x: null,
    y: null,
  });
  const draft = graph as WorkflowDraftGraph;
  const instance = useRef<ReactFlowInstance<WorkflowCanvasNode, Edge> | null>(null);
  const canvas = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setNodes((current) => reconcileCanvasNodes(current, projectedNodes));
  }, [projectedNodes]);
  useEffect(() => {
    setEdges((current) => reconcileCanvasEdges(current, projectedEdges));
  }, [projectedEdges]);
  useEffect(() => {
    if (!graph.nodes.some((node) => node.id === focusNodeId)) {
      setFocusNodeId(graph.nodes[0]?.id ?? null);
    }
  }, [focusNodeId, graph.nodes]);

  useImperativeHandle(forwardedRef, () => ({
    viewportCenter: () => {
      const flow = instance.current;
      const bounds = canvas.current?.getBoundingClientRect();
      if (!flow || !bounds) return { x: 240, y: 140 };
      return flow.screenToFlowPosition({
        x: bounds.left + bounds.width / 2,
        y: bounds.top + bounds.height / 2,
      });
    },
    fit: () => { void instance.current?.fitView({ duration: fitDuration() }); },
  }), []);

  const validConnection = useCallback((connection: Edge | Connection): boolean => {
    const source = draft.nodes.find((node) => node.id === connection.source);
    const target = draft.nodes.find((node) => node.id === connection.target);
    return Boolean(source && target && connection.sourceHandle && connection.targetHandle && connectionAllowed(
      source,
      connection.sourceHandle as WorkflowSourcePort,
      target,
      connection.targetHandle as WorkflowTargetPort,
    ));
  }, [draft.nodes]);

  const commitNodePositions = (next: readonly WorkflowCanvasNode[]): void => {
    if (readOnly || !onChange) return;
    const byId = new Map(next.map((node) => [node.id, node]));
    const kept = draft.nodes
      .filter((node) => byId.has(node.id) || node.kind === "session")
      .map((node) => ({
        ...node,
        position: {
          x: boundedCoordinate(byId.get(node.id)?.position.x ?? node.position.x),
          y: boundedCoordinate(byId.get(node.id)?.position.y ?? node.position.y),
        },
      })) as WorkflowDraftNode[];
    const keptIds = new Set(kept.map((node) => node.id));
    onChange({
      nodes: kept,
      edges: draft.edges.filter((edge) => keptIds.has(edge.source) && keptIds.has(edge.target)),
    });
  };

  const changeNodes = (changes: NodeChange<WorkflowCanvasNode>[]): void => {
    const next = applyNodeChanges(changes, nodes);
    setNodes(next);
    // Selection, measurement and each intermediate pointer frame are local canvas
    // state. Commit one history entry at drag stop, or immediately for a removal.
    if (changes.some((change) => change.type === "remove")) commitNodePositions(next);
  };

  const changeEdges = (changes: EdgeChange[]): void => {
    const next = applyEdgeChanges(changes, edges);
    setEdges(next);
    if (readOnly || !onChange) return;
    if (!changes.some((change) => change.type === "remove")) return;
    const kept = new Set(next.map((edge) => edge.id));
    onChange({ ...draft, edges: draft.edges.filter((edge) => kept.has(edge.id)) });
  };

  const alignedPosition = (
    id: string,
    position: { x: number; y: number },
  ): { position: { x: number; y: number }; x: number | null; y: number | null } => {
    const peers = nodes.filter((node) => node.id !== id);
    const alignedX = peers.find((node) =>
      Math.abs(node.position.x - position.x) <= ALIGNMENT_TOLERANCE)?.position.x ?? null;
    const alignedY = peers.find((node) =>
      Math.abs(node.position.y - position.y) <= ALIGNMENT_TOLERANCE)?.position.y ?? null;
    return {
      position: {
        x: boundedCoordinate(alignedX ?? position.x),
        y: boundedCoordinate(alignedY ?? position.y),
      },
      x: alignedX,
      y: alignedY,
    };
  };

  const connect = (connection: Connection): void => {
    if (readOnly || !onChange || !validConnection(connection) || !connection.sourceHandle || !connection.targetHandle) return;
    onChange({
      ...draft,
      edges: [...draft.edges, {
        id: crypto.randomUUID(),
        source: connection.source,
        sourcePort: connection.sourceHandle as WorkflowSourcePort,
        target: connection.target,
        targetPort: connection.targetHandle as WorkflowTargetPort,
      }],
    });
  };

  const nodeDrag = (node: WorkflowCanvasNode): void => {
    const aligned = alignedPosition(node.id, node.position);
    setAlignmentGuide({ x: aligned.x, y: aligned.y });
  };

  const nodeDragStop = (node: WorkflowCanvasNode): void => {
    const aligned = alignedPosition(node.id, node.position);
    const next = nodes.map((candidate) => candidate.id === node.id
      ? { ...candidate, position: aligned.position }
      : candidate);
    setNodes(next);
    setAlignmentGuide({ x: null, y: null });
    commitNodePositions(next);
  };

  // Every prop `<ReactFlow>` forwards to its StoreUpdater is tracked by identity: its sync
  // effect lists each as a dependency and calls `store.setState` inside. A handler recreated
  // inline on each render makes that effect fire on every render, and a connection drag - which
  // already re-renders the canvas each pointer move - compounds with it into React's "Maximum
  // update depth exceeded", which unmounts the tree and blanks the whole screen. So each handler
  // gets ONE identity for the life of the canvas, calling through a ref that always holds this
  // render's closure - ReactFlow sees no churn while the logic stays current. The `snapGrid` /
  // `nodeExtent` / `multiSelectionKeyCode` constants above are the array half of the same rule.
  const handlersRef = useRef({ changeNodes, changeEdges, connect, nodeDrag, nodeDragStop });
  handlersRef.current = { changeNodes, changeEdges, connect, nodeDrag, nodeDragStop };
  const onNodesChange = useCallback(
    (changes: NodeChange<WorkflowCanvasNode>[]) => handlersRef.current.changeNodes(changes), []);
  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => handlersRef.current.changeEdges(changes), []);
  const onConnect = useCallback((connection: Connection) => handlersRef.current.connect(connection), []);
  const onNodeDrag = useCallback(
    (_event: unknown, node: WorkflowCanvasNode) => handlersRef.current.nodeDrag(node), []);
  const onNodeDragStop = useCallback(
    (_event: unknown, node: WorkflowCanvasNode) => handlersRef.current.nodeDragStop(node), []);

  return (
    <div
      ref={canvas}
      className={`workflow-canvas${readOnly ? " is-readonly" : ""}`}
      aria-label={readOnly ? "Published workflow graph" : "Workflow graph editor"}
      onFocusCapture={(event) => {
        const target = event.target instanceof Element
          ? event.target.closest<HTMLElement>(".react-flow__node[data-id]")
          : null;
        const id = target?.dataset.id;
        if (!id || !graph.nodes.some((node) => node.id === id)) return;
        setFocusNodeId(id);
        setNodes((current) => {
          const alreadySelected = current.every((node) => Boolean(node.selected) === (node.id === id));
          return alreadySelected
            ? current
            : current.map((node) => ({ ...node, selected: node.id === id }));
        });
        onSelection?.({ kind: "node", id });
      }}
      onKeyDown={(event) => {
        if (event.key === "Tab" && !event.altKey && !event.ctrlKey && !event.metaKey) {
          const activeNode = event.target instanceof Element
            ? event.target.closest<HTMLElement>(".react-flow__node[data-id]")
            : null;
          const currentId = activeNode?.dataset.id;
          const nextId = currentId
            ? nextRovingNodeId(graph.nodes.map((node) => node.id), currentId, event.shiftKey)
            : null;
          if (nextId) {
            event.preventDefault();
            setFocusNodeId(nextId);
            const focusNext = (): void => {
              const nextElement = [...(canvas.current?.querySelectorAll<HTMLElement>(".react-flow__node[data-id]") ?? [])]
                .find((node) => node.dataset.id === nextId);
              if (!nextElement) return;
              // React Flow applies the persisted roving tab stop on the next render.
              // Make this synchronous so the same Tab press can transfer focus now.
              nextElement.tabIndex = 0;
              nextElement.focus();
            };
            focusNext();
            // Selection changes can make React Flow replace the focused wrapper.
            // Restore focus to the persisted roving target after that render.
            window.requestAnimationFrame(focusNext);
          }
          return;
        }
        if (readOnly || !onChange) return;
        const selectedNodes = nodes.filter((node) => node.selected);
        const selectedEdges = edges.filter((edge) => edge.selected);
        if (
          (event.key === "Delete" || event.key === "Backspace")
          && (selectedNodes.length > 0 || selectedEdges.length > 0)
        ) {
          event.preventDefault();
          onDeleteSelection?.(
            selectedNodes.map((node) => node.id),
            selectedEdges.map((edge) => edge.id),
          );
          return;
        }
        if (event.key.toLowerCase() === "c" && selectedNodes.length === 1) {
          event.preventDefault();
          onKeyboardConnect?.(selectedNodes[0]!.id);
          return;
        }
        const movement = {
          ArrowLeft: { x: -1, y: 0 },
          ArrowRight: { x: 1, y: 0 },
          ArrowUp: { x: 0, y: -1 },
          ArrowDown: { x: 0, y: 1 },
        }[event.key];
        if (!movement || selectedNodes.length === 0) return;
        event.preventDefault();
        const gridUnits = event.shiftKey ? 10 : 1;
        const amount = GRID_SIZE * gridUnits;
        const selectedIds = new Set(selectedNodes.map((node) => node.id));
        const nextGraph: WorkflowDraftGraph = {
          ...draft,
          nodes: draft.nodes.map((node) => selectedIds.has(node.id)
            ? {
                ...node,
                position: {
                  x: boundedCoordinate(node.position.x + movement.x * amount),
                  y: boundedCoordinate(node.position.y + movement.y * amount),
                },
              }
            : node),
        };
        onChange(nextGraph);
        onAnnounce?.(`Moved ${selectedNodes.length} node${selectedNodes.length === 1 ? "" : "s"} ${event.key.replace("Arrow", "").toLowerCase()} ${gridUnits} grid unit${gridUnits === 1 ? "" : "s"}`);
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={WORKFLOW_NODE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        isValidConnection={validConnection}
        onSelectionChange={({ nodes: selectedNodes, edges: selectedEdges }) => {
          const selection = selectedNodes.length + selectedEdges.length > 1
            ? {
                kind: "multi" as const,
                nodeIds: selectedNodes.map((node) => node.id),
                edgeIds: selectedEdges.map((edge) => edge.id),
              }
            : selectedNodes[0]
              ? { kind: "node" as const, id: selectedNodes[0].id }
              : selectedEdges[0]
                ? { kind: "edge" as const, id: selectedEdges[0].id }
                : null;
          onSelection?.(selection);
          if (selection?.kind === "node") {
            setFocusNodeId(selection.id);
            const selectedNode = nodes.find((node) => node.id === selection.id);
            if (selectedNode) onAnnounce?.(selectedNode.ariaLabel ?? `${selectedNode.data.label} node selected`);
          } else if (selection?.kind === "multi") {
            setFocusNodeId(selection.nodeIds[0] ?? focusNodeId);
            onAnnounce?.(`${selection.nodeIds.length} nodes and ${selection.edgeIds.length} edges selected`);
          }
        }}
        nodesConnectable={!readOnly}
        elementsSelectable
        fitView
        snapToGrid={!readOnly}
        snapGrid={SNAP_GRID}
        nodeExtent={NODE_EXTENT}
        deleteKeyCode={null}
        multiSelectionKeyCode={MULTI_SELECTION_KEYS}
        minZoom={0.2}
        maxZoom={2}
        onInit={(flow) => { instance.current = flow; }}
        onDragOver={(event) => {
          if (!readOnly && onDropNode) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
          }
        }}
        onDrop={(event) => {
          if (readOnly || !onDropNode || !instance.current) return;
          event.preventDefault();
          const dropped = parseDroppedNode(event.dataTransfer.getData(NEW_NODE_MIME));
          if (!dropped) return;
          onDropNode(
            dropped,
            instance.current.screenToFlowPosition({ x: event.clientX, y: event.clientY }),
          );
        }}
      >
        {/* React Flow's free-tier license requires its generated attribution link. */}
        <Background gap={18} size={1} />
        <ViewportPortal>
          {alignmentGuide.x !== null && (
            <span
              className="workflow-alignment-guide is-vertical"
              style={{ left: alignmentGuide.x }}
              aria-hidden
            />
          )}
          {alignmentGuide.y !== null && (
            <span
              className="workflow-alignment-guide is-horizontal"
              style={{ top: alignmentGuide.y }}
              aria-hidden
            />
          )}
        </ViewportPortal>
        <WorkflowControls />
        <MiniMap
          pannable
          zoomable
          ariaLabel="Workflow minimap"
          nodeColor={(node) => node.className?.includes("fail") ? "#d34f4f" : "#76849b"}
        />
      </ReactFlow>
    </div>
  );
});
