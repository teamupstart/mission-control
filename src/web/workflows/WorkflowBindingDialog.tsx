import { useEffect, useMemo, useState } from "react";
import type { Session } from "@shared/types.ts";
import { repoAllowlisted } from "@shared/allowlist.ts";
import { HARNESS_CAPABILITIES } from "@shared/harness-capabilities.ts";
import {
  DEFAULT_WORKFLOW_BINDING_DEFAULTS,
  type WorkflowBinding,
  type WorkflowBindingDefaults,
  type WorkflowDetail,
  type WorkflowSummary,
  type WorkflowConfig,
} from "@shared/workflow.ts";
import { OVERLAY_IDS, Overlay } from "../components/Overlay.tsx";
import { Tooltip } from "../components/Tooltip.tsx";
import { workflowRequest } from "./workflowApi.ts";

export interface WorkflowBindingTarget {
  sessionId?: string;
  workflowVersionId?: string;
  workflowId?: string;
  workflowVersion?: number;
  bindingDefaults?: WorkflowBindingDefaults;
}

export function workflowBindingSelection(
  bindings: WorkflowBinding[],
  session: Session | null,
  versionId: string,
): { existing: WorkflowBinding | undefined; conflict: WorkflowBinding | undefined } {
  if (!session) return { existing: undefined, conflict: undefined };
  const compatible = bindings.filter((binding) =>
    binding.state !== "archived"
    && (
      binding.sessionId === session.id
      || (
        binding.state !== "active"
        && binding.sessionAgent === session.agent
        && binding.sessionCwd === session.cwd
        && binding.sessionRepoRoot === session.repoRoot
      )
    ));
  const active = compatible.find((binding) => binding.state === "active");
  if (active) {
    return active.workflowVersionId === versionId
      ? { existing: active, conflict: undefined }
      : { existing: undefined, conflict: active };
  }
  const exact = compatible.find((binding) => binding.workflowVersionId === versionId);
  if (exact) return { existing: exact, conflict: undefined };
  return { existing: undefined, conflict: undefined };
}

export function WorkflowBindingDialog({
  target,
  sessions,
  workflows,
  onClose,
  onRun,
  foremanEnabled = false,
  promptedWrapupEnabled = false,
}: {
  target: WorkflowBindingTarget;
  sessions: Session[];
  workflows: WorkflowSummary[];
  onClose: () => void;
  onRun: (id: string) => void;
  foremanEnabled?: boolean;
  promptedWrapupEnabled?: boolean;
}): React.JSX.Element {
  const live = useMemo(
    () => sessions.filter((session) => session.state !== "exited"),
    [sessions],
  );
  const publishable = useMemo(
    () => workflows.filter((workflow) => workflow.currentVersionId && workflow.archivedAt === null),
    [workflows],
  );
  const [sessionId, setSessionId] = useState(target.sessionId ?? live[0]?.id ?? "");
  const [versionId, setVersionId] = useState(target.workflowVersionId ?? publishable[0]?.currentVersionId ?? "");
  const [defaults, setDefaults] = useState<WorkflowBindingDefaults>(
    target.bindingDefaults ?? DEFAULT_WORKFLOW_BINDING_DEFAULTS,
  );
  const [versionNumber, setVersionNumber] = useState<number | null>(target.workflowVersion ?? null);
  const [maxRepairRounds, setMaxRepairRounds] = useState(defaults.maxRepairRounds);
  const [triggerMode, setTriggerMode] = useState(defaults.triggerMode);
  const [deliveryMode, setDeliveryMode] = useState(defaults.deliveryMode);
  const [workflowConfig, setWorkflowConfig] = useState<WorkflowConfig | null>(null);
  const [bindings, setBindings] = useState<WorkflowBinding[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void workflowRequest<WorkflowBinding[]>("/api/workflow-bindings").then(setBindings).catch(() => {});
    void workflowRequest<WorkflowConfig>("/api/workflows/config").then(setWorkflowConfig).catch(() => {});
  }, []);
  useEffect(() => {
    if (!versionId) return;
    if (versionId === target.workflowVersionId && target.bindingDefaults) {
      setDefaults(target.bindingDefaults);
      setMaxRepairRounds(target.bindingDefaults.maxRepairRounds);
      setTriggerMode(target.bindingDefaults.triggerMode);
      setDeliveryMode(target.bindingDefaults.deliveryMode);
      setVersionNumber(target.workflowVersion ?? null);
      return;
    }
    const workflow = publishable.find((item) => item.currentVersionId === versionId);
    if (!workflow) return;
    let current = true;
    void workflowRequest<WorkflowDetail>(`/api/workflows/${workflow.id}`).then((detail) => {
      if (!current) return;
      const version = detail.versions.find((item) => item.id === versionId);
      if (!version) return;
      setDefaults(version.bindingDefaults);
      setMaxRepairRounds(version.bindingDefaults.maxRepairRounds);
      setTriggerMode(version.bindingDefaults.triggerMode);
      setDeliveryMode(version.bindingDefaults.deliveryMode);
      setVersionNumber(version.version);
    }).catch(() => {});
    return () => { current = false; };
  }, [
    publishable,
    target.bindingDefaults,
    target.workflowVersion,
    target.workflowVersionId,
    versionId,
  ]);
  const session = live.find((item) => item.id === sessionId) ?? null;
  const { existing, conflict } = useMemo(
    () => workflowBindingSelection(bindings, session, versionId),
    [bindings, session, versionId],
  );
  useEffect(() => {
    if (!existing) return;
    setTriggerMode(existing.triggerMode);
    setDeliveryMode(existing.deliveryMode);
    setMaxRepairRounds(existing.maxRepairRounds);
  }, [existing?.id]);
  const liveAllowed = Boolean(
    session
    && workflowConfig?.liveEnabled
    && repoAllowlisted(session.cwd, session.repoRoot, workflowConfig.repoAllowlist),
  );
  const harness = session ? HARNESS_CAPABILITIES[session.agent] : null;
  const foremanAllowed = Boolean(
    session
    && foremanEnabled
    && harness?.workQueue,
  );
  const canSubmit = Boolean(
    sessionId
    && (versionId || existing)
    && !conflict
    && Number.isInteger(maxRepairRounds)
    && maxRepairRounds >= 1
    && maxRepairRounds <= 20
    && (deliveryMode !== "live" || liveAllowed)
    && (triggerMode !== "foreman_complete" || foremanAllowed),
  );

  const create = async (): Promise<WorkflowBinding | null> => {
    if (conflict) throw new Error("This conversation is bound to a different immutable workflow version");
    let bound = existing ?? null;
    if (existing) {
      if (existing.state !== "active") {
        bound = await workflowRequest<WorkflowBinding>(`/api/workflow-bindings/${existing.id}/reattach`, {
          method: "POST",
          body: JSON.stringify({ sessionId }),
        });
      }
      if (
        bound
        && (
          bound.triggerMode !== triggerMode
          || bound.deliveryMode !== deliveryMode
          || bound.maxRepairRounds !== maxRepairRounds
        )
      ) {
        bound = await workflowRequest<WorkflowBinding>(`/api/workflow-bindings/${bound.id}`, {
          method: "PATCH",
          body: JSON.stringify({ triggerMode, deliveryMode, maxRepairRounds }),
        });
      }
      if (bound) {
        setBindings((current) => current.map((binding) =>
          binding.id === bound!.id ? bound! : binding));
      }
      return bound;
    }
    if (!sessionId || !versionId) return null;
    const binding = await workflowRequest<WorkflowBinding>("/api/workflow-bindings", {
      method: "POST",
      body: JSON.stringify({
        workflowVersionId: versionId,
        sessionId,
        triggerMode,
        deliveryMode,
        maxRepairRounds,
      }),
    });
    setBindings((current) => [...current, binding]);
    return binding;
  };

  const perform = async (preview: boolean): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const binding = await create();
      if (!binding) throw new Error("Choose a published version and live session");
      if (!preview) {
        onClose();
        return;
      }
      const result = await workflowRequest<{ run: { id: string } }>(
        `/api/workflow-bindings/${binding.id}/submit`,
        {
          method: "POST",
          body: JSON.stringify({ requestId: crypto.randomUUID() }),
        },
      );
      onClose();
      onRun(result.run.id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create workflow binding");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Overlay
      id={OVERLAY_IDS.workflowBinding}
      onClose={onClose}
      className="modal workflow-binding-dialog"
      role="dialog"
      ariaLabel="Bind workflow"
      closable={!busy}
    >
      <header className="modal-head">
        <div><p className="workflow-eyebrow">Immutable version binding</p><h2>Bind workflow</h2></div>
        <Tooltip label="Close without binding (Escape)">
          <button className="icon-btn" onClick={onClose} disabled={busy} aria-label="Close">×</button>
        </Tooltip>
      </header>
      <p>
        Preview reviews one immutable evidence snapshot without terminal writes. Live can send
        one deterministic repair packet after a failed review.
      </p>
      <label>
        Session
        <Tooltip label="Which live session this workflow will review">
          <select value={sessionId} disabled={busy || Boolean(target.sessionId)} onChange={(event) => setSessionId(event.target.value)}>
            <option value="">Choose a live session</option>
            {live.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.agent}</option>)}
          </select>
        </Tooltip>
      </label>
      <label>
        Published workflow
        <Tooltip label="Which published, immutable workflow version to bind">
          <select value={versionId} disabled={busy || Boolean(target.workflowVersionId)} onChange={(event) => setVersionId(event.target.value)}>
            <option value="">Choose a published version</option>
          {target.workflowVersionId &&
            !publishable.some((workflow) => workflow.currentVersionId === target.workflowVersionId) && (
              <option value={target.workflowVersionId}>
                Published version {target.workflowVersionId.slice(0, 8)}
              </option>
            )}
            {publishable.map((workflow) => (
              <option key={workflow.currentVersionId!} value={workflow.currentVersionId!}>
                {workflow.name} · v{workflow.publishedVersion}
              </option>
            ))}
          </select>
        </Tooltip>
      </label>
      <div className="workflow-binding-modes">
        <label>
          Trigger
          <Tooltip label="Choose whether runs start manually or when Foreman proves completion">
            <select
              value={triggerMode}
              disabled={busy}
              onChange={(event) => setTriggerMode(event.target.value as WorkflowBindingDefaults["triggerMode"])}
            >
              <option value="manual">Manual</option>
              <option value="foreman_complete" disabled={!foremanAllowed}>Foreman complete</option>
            </select>
          </Tooltip>
        </label>
        <label>
          Delivery
          <Tooltip label="Preview reports a verdict; Live can send a deterministic repair packet">
            <select
              value={deliveryMode}
              disabled={busy}
              onChange={(event) => setDeliveryMode(event.target.value as WorkflowBindingDefaults["deliveryMode"])}
            >
              <option value="preview">Preview</option>
              <option value="live" disabled={!liveAllowed}>Live</option>
            </select>
          </Tooltip>
        </label>
        <label>
          Maximum repair rounds
          <input
            type="number"
            min={1}
            max={20}
            value={maxRepairRounds}
            disabled={busy}
            onChange={(event) => setMaxRepairRounds(Number(event.target.value))}
          />
        </label>
      </div>
      {(defaults.triggerMode !== "manual" || defaults.deliveryMode !== "preview") && (
        <p className="workflow-binding-existing">
          This version defaults to {defaults.triggerMode.replaceAll("_", " ")} and {defaults.deliveryMode}.
        </p>
      )}
      {deliveryMode === "live" && !liveAllowed && (
        <p className="wf-error" role="alert">
          Live delivery requires Workflow Live mode and this session's repository in the Workflow allowlist.
        </p>
      )}
      {triggerMode === "foreman_complete" && !foremanAllowed && (
        <p className="wf-error" role="alert">
          Foreman Complete requires Foreman and a session harness with measured work-queue support.
        </p>
      )}
      {triggerMode === "foreman_complete" && session?.queue === null && !promptedWrapupEnabled && (
        <p className="workflow-binding-existing">
          Foreman's prompted trigger is off. Itemless first and later completions require Manual Submit.
        </p>
      )}
      {existing && (
        <p className="workflow-binding-existing">
          {existing.state === "active" ? "Already bound" : `Ready to reattach (${existing.state})`}
          {" "}to version {existing.workflowVersionId.slice(0, 8)}.
        </p>
      )}
      {conflict && (
        <p className="wf-error" role="alert">
          This conversation is already bound to immutable version {conflict.workflowVersionId.slice(0, 8)}.
          Archive that binding before selecting another version.
        </p>
      )}
      {session && (
        <dl className="workflow-binding-session">
          <div><dt>Session</dt><dd>{session.name}</dd></div>
          <div><dt>Harness</dt><dd>{session.agent}</dd></div>
          <div><dt>Checkout</dt><dd>{session.cwd ?? "unavailable"}</dd></div>
          <div><dt>Branch</dt><dd>{session.gitBranch ?? "unavailable"}</dd></div>
          <div><dt>Conversation</dt><dd>{session.agentSessionId ?? session.id}</dd></div>
          <div><dt>Version</dt><dd>{versionNumber === null ? versionId.slice(0, 8) : `v${versionNumber}`}</dd></div>
        </dl>
      )}
      {error && <p className="wf-error" role="alert">{error}</p>}
      <footer className="modal-actions">
        <Tooltip label="Attach the workflow to this session without starting a run">
          <button className="btn btn-ghost" disabled={busy || !canSubmit} onClick={() => void perform(false)}>
            {existing?.state === "active" ? "Update binding" : existing ? "Reattach only" : "Bind only"}
          </button>
        </Tooltip>
        <Tooltip label="Attach the workflow and take an evidence snapshot to review now">
          <button
            className="btn"
            disabled={busy || !canSubmit}
            onClick={() => void perform(true)}
          >
          {busy
            ? "Capturing…"
            : existing
              ? existing.state === "active" ? "Submit bound version" : "Reattach and submit"
              : "Bind and submit"}
          </button>
        </Tooltip>
      </footer>
    </Overlay>
  );
}
