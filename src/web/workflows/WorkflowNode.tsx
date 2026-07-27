import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";

export type WorkflowCanvasNodeData = {
  kind: "session" | "persona" | "all_pass" | "check" | "end";
  label: string;
  subtitle: string;
  readOnly: boolean;
  runtimeStatus?: string | null;
  incomingCount?: number;
  outgoingCount?: number;
} & Record<string, unknown>;

export type WorkflowCanvasNode = Node<WorkflowCanvasNodeData>;

/**
 * The port each kind receives on, and the word printed under it.
 *
 * Lookups rather than the chained ternaries these replaced. Those ended in `: "terminal"`,
 * so every kind that was not one of the three named ones was labelled as the End node's
 * port - a fourth kind would have rendered an `activate` handle over the word "terminal".
 */
const INPUT_PORT_LABELS: Record<WorkflowCanvasNodeData["kind"], string> = {
  session: "return for changes",
  persona: "activate",
  all_pass: "result",
  check: "activate",
  end: "terminal",
};

/** The kind as it is printed on the node's own chip. */
const KIND_WORDS: Record<WorkflowCanvasNodeData["kind"], string> = {
  session: "session",
  persona: "persona",
  all_pass: "All-pass Join",
  check: "check",
  end: "end",
};

/** The one shared custom leaf for every workflow node kind. */
export function WorkflowNode({ data }: NodeProps<WorkflowCanvasNode>): React.JSX.Element {
  return (
    <article
      className={`workflow-node workflow-node-${data.kind}`}
      data-node-kind={data.kind}
      aria-description={`${data.incomingCount ?? 0} incoming and ${data.outgoingCount ?? 0} outgoing connections`}
    >
      {data.kind === "session" && <Handle aria-label="Return for changes input" type="target" id="return_for_changes" position={Position.Left} isConnectable={!data.readOnly} />}
      {(data.kind === "persona" || data.kind === "check") && <Handle aria-label="Activate input" type="target" id="activate" position={Position.Left} isConnectable={!data.readOnly} />}
      {data.kind === "all_pass" && <Handle aria-label="Result input" type="target" id="result" position={Position.Left} isConnectable={!data.readOnly} />}
      {data.kind === "end" && <Handle aria-label="Terminal input" type="target" id="terminal" position={Position.Left} isConnectable={!data.readOnly} />}
      <span className="workflow-port-label workflow-port-input">
        {INPUT_PORT_LABELS[data.kind]}
      </span>
      <span className="workflow-node-kind">{KIND_WORDS[data.kind]}</span>
      <strong>{data.label}</strong>
      <small>{data.subtitle}</small>
      {data.runtimeStatus && (
        <span className={`workflow-node-runtime wnr-${data.runtimeStatus}`}>
          {data.runtimeStatus.replaceAll("_", " ")}
        </span>
      )}
      {data.kind === "session" && (
        <>
          <Handle aria-label="Submitted output" type="source" id="submitted" position={Position.Right} isConnectable={!data.readOnly} />
          <span className="workflow-port-label workflow-port-submitted">submitted</span>
        </>
      )}
      {(data.kind === "persona" || data.kind === "all_pass" || data.kind === "check") && (
        <>
          <Handle aria-label="Pass output" type="source" id="pass" position={Position.Right} style={{ top: "38%" }} isConnectable={!data.readOnly} />
          <Handle aria-label="Fail output" type="source" id="fail" position={Position.Right} style={{ top: "72%" }} isConnectable={!data.readOnly} />
          <span className="workflow-port-label workflow-port-pass">pass</span>
          <span className="workflow-port-label workflow-port-fail">fail</span>
        </>
      )}
    </article>
  );
}

export const WORKFLOW_NODE_TYPES: Record<WorkflowCanvasNodeData["kind"], typeof WorkflowNode> = {
  session: WorkflowNode,
  persona: WorkflowNode,
  all_pass: WorkflowNode,
  check: WorkflowNode,
  end: WorkflowNode,
};
