import {
  DAEMON_PROTOCOL_CAPABILITIES,
  daemonHealthSupports,
  workflowEvidenceNeedsCriterionMappedCapability,
} from "@shared/daemon-protocol.ts";
import type {
  WorkflowEvidenceProofClass,
  WorkflowEvidenceProofRole,
} from "@shared/workflow.ts";

type WorkflowEvidenceToolInput = {
  images?: Array<{
    clientItemId: string;
    path: string;
    caption: string;
    repositoryScope: string;
  }>;
  artifacts?: Array<{
    clientItemId: string;
    path: string;
    caption: string;
    repositoryScope: string;
  }>;
  commandOutputs?: Array<{
    clientItemId: string;
    command: string;
    exitCode: number;
    output: string;
    caption: string;
    repositoryScope: string;
  }>;
  coverage?: Array<{
    clientCriterionId: string;
    criterion: string;
    criterionId?: string;
    proofClass: WorkflowEvidenceProofClass;
    repositoryScope: string;
    links: Array<{ clientItemId: string; role: WorkflowEvidenceProofRole }>;
  }>;
};

type WorkflowEvidenceIdentity = {
  env: unknown;
  sessionId: string | null | undefined;
  cwd: string | null | undefined;
};

export interface WorkflowEvidenceToolResult {
  text: string;
  isError: boolean;
}

export type WorkflowEvidenceRequest = (
  path: string,
  method: string,
  body?: unknown,
) => Promise<Response>;

/**
 * Submit evidence through the independently versioned daemon boundary.
 *
 * Legacy-shaped evidence remains usable with an older daemon. Requests using Phase 1 fields
 * first prove the named wire capability so coverage cannot be silently stripped and signed
 * exit codes cannot be rejected by the older schema.
 */
export async function submitWorkflowEvidenceToDaemon(
  input: WorkflowEvidenceToolInput,
  identity: WorkflowEvidenceIdentity,
  request: WorkflowEvidenceRequest,
): Promise<WorkflowEvidenceToolResult> {
  const { images, artifacts, commandOutputs, coverage } = input;
  try {
    if (workflowEvidenceNeedsCriterionMappedCapability({ coverage, commandOutputs })) {
      const health = await request("/api/health", "GET");
      const supported = health.ok && daemonHealthSupports(
        await health.json() as unknown,
        DAEMON_PROTOCOL_CAPABILITIES.criterionMappedWorkflowEvidence,
      );
      if (!supported) {
        return {
          text: "Mission Control's running daemon does not support criterion-mapped workflow evidence. "
            + "Restart Mission Control so the daemon and agent evidence tool use the same build.",
          isError: true,
        };
      }
    }

    const res = await request("/mcp/workflow-evidence", "POST", {
      ...identity,
      images: (images ?? []).map((image) => ({ kind: "agent" as const, ...image })),
      artifacts: (artifacts ?? []).map((artifact) => ({ kind: "text" as const, ...artifact })),
      commandOutputs: (commandOutputs ?? []).map((artifact) => ({
        kind: "command" as const,
        ...artifact,
      })),
      coverage: coverage ?? [],
    });
    if (!res.ok) {
      return {
        text: `Mission Control refused the workflow evidence (${res.status}): ${await res.text()}`,
        isError: true,
      };
    }
    const body = (await res.json()) as {
      images?: unknown[];
      artifacts?: unknown[];
      coverage?: unknown[];
      generation?: number;
    };
    return {
      text: `Registered ${body.images?.length ?? images?.length ?? 0} image(s), `
        + `${body.artifacts?.length ?? ((artifacts?.length ?? 0) + (commandOutputs?.length ?? 0))} `
        + `text artifact(s), and ${body.coverage?.length ?? coverage?.length ?? 0} coverage claim(s) at `
        + `generation ${body.generation ?? 0}.`,
      isError: false,
    };
  } catch (error) {
    return { text: `Could not reach Mission Control: ${String(error)}`, isError: true };
  }
}
