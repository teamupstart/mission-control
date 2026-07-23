import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";

export type WorkflowCanvasNodeData = {
  kind: "session" | "persona" | "all_pass" | "end";
  label: string;
  subtitle: string;
  readOnly: boolean;
  runtimeStatus?: string | null;
} & Record<string, unknown>;

export type WorkflowCanvasNode = Node<WorkflowCanvasNodeData>;

/** The one shared custom leaf for every workflow node kind. */
export function WorkflowNode({ data }: NodeProps<WorkflowCanvasNode>): React.JSX.Element {
  return (
    <article className={`workflow-node workflow-node-${data.kind}`} data-node-kind={data.kind}>
      {data.kind === "session" && <Handle type="target" id="return_for_changes" position={Position.Left} isConnectable={!data.readOnly} />}
      {data.kind === "persona" && <Handle type="target" id="activate" position={Position.Left} isConnectable={!data.readOnly} />}
      {data.kind === "all_pass" && <Handle type="target" id="result" position={Position.Left} isConnectable={!data.readOnly} />}
      {data.kind === "end" && <Handle type="target" id="terminal" position={Position.Left} isConnectable={!data.readOnly} />}
      <span className="workflow-node-kind">{data.kind === "all_pass" ? "All-pass Join" : data.kind}</span>
      <strong>{data.label}</strong>
      <small>{data.subtitle}</small>
      {data.runtimeStatus && (
        <span className={`workflow-node-runtime wnr-${data.runtimeStatus}`}>
          {data.runtimeStatus.replaceAll("_", " ")}
        </span>
      )}
      {data.kind === "session" && <Handle type="source" id="submitted" position={Position.Right} isConnectable={!data.readOnly} />}
      {(data.kind === "persona" || data.kind === "all_pass") && (
        <>
          <Handle type="source" id="pass" position={Position.Right} style={{ top: "38%" }} isConnectable={!data.readOnly} />
          <Handle type="source" id="fail" position={Position.Right} style={{ top: "72%" }} isConnectable={!data.readOnly} />
          <span className="workflow-port-label workflow-port-pass">pass</span>
          <span className="workflow-port-label workflow-port-fail">fail</span>
        </>
      )}
    </article>
  );
}

export const WORKFLOW_NODE_TYPES = {
  session: WorkflowNode,
  persona: WorkflowNode,
  all_pass: WorkflowNode,
  end: WorkflowNode,
};
