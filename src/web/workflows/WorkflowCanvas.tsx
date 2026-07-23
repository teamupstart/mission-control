import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type ReactFlowInstance,
} from "@xyflow/react";
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
import { WORKFLOW_NODE_TYPES, type WorkflowCanvasNode } from "./WorkflowNode.tsx";

export type WorkflowSelection = { kind: "node" | "edge"; id: string } | null;

function isPublishedPersona(node: WorkflowDraftNode | PublishedWorkflowNode): node is Extract<PublishedWorkflowNode, { kind: "persona" }> {
  return node.kind === "persona" && "persona" in node;
}

function canvasNodes(
  graph: WorkflowDraftGraph | PublishedWorkflowGraph,
  personas: readonly PersonaView[],
  readOnly: boolean,
  nodeStatuses: Readonly<Record<string, string>>,
): WorkflowCanvasNode[] {
  const personaMap = new Map(personas.map((persona) => [persona.id, persona]));
  const incoming = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    const predecessors = incoming.get(edge.target) ?? new Set<string>();
    predecessors.add(edge.source);
    incoming.set(edge.target, predecessors);
  }
  return graph.nodes.map((node) => {
    let label = "Session";
    let subtitle = "Submission and repair boundary";
    if (node.kind === "persona") {
      const snapshot = isPublishedPersona(node) ? node.persona : null;
      const live = snapshot ? null : personaMap.get((node as Extract<WorkflowDraftNode, { kind: "persona" }>).personaId);
      label = snapshot?.name ?? live?.name ?? "Missing Persona";
      subtitle = snapshot
        ? `Snapshot revision ${snapshot.sourceRevision}`
        : live ? `${live.execution.runner.id} · ${live.execution.model.id}` : "Select an active Persona";
    } else if (node.kind === "all_pass") {
      label = "All pass";
      subtitle = `${incoming.get(node.id)?.size ?? 0} predecessor${incoming.get(node.id)?.size === 1 ? "" : "s"}`;
    } else if (node.kind === "end") {
      label = node.outcome;
      subtitle = "Terminal outcome";
    }
    return {
      id: node.id,
      type: node.kind,
      position: node.position,
      deletable: !readOnly && node.kind !== "session",
      draggable: !readOnly,
      selectable: true,
      className: nodeStatuses[node.id] ? `workflow-runtime-${nodeStatuses[node.id]}` : undefined,
      data: { kind: node.kind, label, subtitle, readOnly, runtimeStatus: nodeStatuses[node.id] ?? null },
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

export function WorkflowCanvas({
  graph,
  personas,
  readOnly = false,
  onChange,
  onSelection,
  onDropNode,
  nodeStatuses = {},
}: {
  graph: WorkflowDraftGraph | PublishedWorkflowGraph;
  personas: PersonaView[];
  readOnly?: boolean;
  onChange?: (graph: WorkflowDraftGraph) => void;
  onSelection?: (selection: WorkflowSelection) => void;
  onDropNode?: (kind: "persona" | "all_pass" | "end", personaId: string | null, position: { x: number; y: number }) => void;
  nodeStatuses?: Readonly<Record<string, string>>;
}): React.JSX.Element {
  const projectedNodes = useMemo(
    () => canvasNodes(graph, personas, readOnly, nodeStatuses),
    [graph, personas, readOnly, nodeStatuses],
  );
  const [nodes, setNodes] = useState(projectedNodes);
  const edges = useMemo(() => canvasEdges(graph.edges, readOnly), [graph.edges, readOnly]);
  const draft = graph as WorkflowDraftGraph;
  const instance = useRef<ReactFlowInstance<WorkflowCanvasNode, Edge> | null>(null);

  useEffect(() => {
    setNodes((current) => reconcileCanvasNodes(current, projectedNodes));
  }, [projectedNodes]);

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

  const changeNodes = (changes: NodeChange<WorkflowCanvasNode>[]): void => {
    const next = applyNodeChanges(changes, nodes);
    setNodes(next);
    if (readOnly || !onChange) return;
    const byId = new Map(next.map((node) => [node.id, node]));
    const kept = draft.nodes
      .filter((node) => byId.has(node.id) || node.kind === "session")
      .map((node) => ({ ...node, position: byId.get(node.id)?.position ?? node.position })) as WorkflowDraftNode[];
    const keptIds = new Set(kept.map((node) => node.id));
    onChange({ nodes: kept, edges: draft.edges.filter((edge) => keptIds.has(edge.source) && keptIds.has(edge.target)) });
  };

  const changeEdges = (changes: EdgeChange[]): void => {
    if (readOnly || !onChange) return;
    const next = applyEdgeChanges(changes, edges);
    const kept = new Set(next.map((edge) => edge.id));
    onChange({ ...draft, edges: draft.edges.filter((edge) => kept.has(edge.id)) });
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

  return (
    <div className={`workflow-canvas${readOnly ? " is-readonly" : ""}`} aria-label={readOnly ? "Published workflow graph" : "Workflow graph editor"}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={WORKFLOW_NODE_TYPES}
        onNodesChange={changeNodes}
        onEdgesChange={changeEdges}
        onConnect={connect}
        isValidConnection={validConnection}
        onSelectionChange={({ nodes: selectedNodes, edges: selectedEdges }) => {
          onSelection?.(selectedNodes[0]
            ? { kind: "node", id: selectedNodes[0].id }
            : selectedEdges[0] ? { kind: "edge", id: selectedEdges[0].id } : null);
        }}
        nodesConnectable={!readOnly}
        elementsSelectable
        fitView
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
          try {
            const dropped = JSON.parse(event.dataTransfer.getData("application/mission-workflow-node")) as { kind?: string; personaId?: string };
            if (dropped.kind !== "persona" && dropped.kind !== "all_pass" && dropped.kind !== "end") return;
            onDropNode(
              dropped.kind,
              dropped.kind === "persona" ? dropped.personaId ?? null : null,
              instance.current.screenToFlowPosition({ x: event.clientX, y: event.clientY }),
            );
          } catch {}
        }}
      >
        <Background gap={18} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
