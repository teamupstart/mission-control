import { useEffect, useMemo, useRef, useState } from "react";
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
  workflowVersionLabel,
} from "@shared/workflow.ts";
import { OVERLAY_IDS, Overlay } from "../components/Overlay.tsx";
import { Tooltip } from "../components/Tooltip.tsx";
import { workflowRequest } from "./workflowApi.ts";

export interface WorkflowBindingTarget {
  sessionId?: string;
  workflowVersionId?: string;
  workflowId?: string;
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
    () =>
      sessions.filter(
        (session) => session.state !== "exited" && session.state !== "stopping",
      ),
    [sessions],
  );
  const publishable = useMemo(
    () => workflows.filter((workflow) => workflow.currentVersionId && workflow.archivedAt === null),
    [workflows],
  );
  const [sessionId, setSessionId] = useState(target.sessionId ?? live[0]?.id ?? "");
  /**
   * Empty until the caller pins a version or this conversation's own binding is known.
   *
   * It used to fall back to `publishable[0]` - the catalog's first entry BY NAME. With one
   * published workflow that is always the right answer, which is why it survived; with two it
   * silently offers whichever sorts first, so an operator opening this on a session already
   * bound to No-Mistakes Review was shown a different workflow, pre-armed, one click from
   * replacing the binding they came here to confirm. There is no defensible guess to make
   * here, so the select opens on "Choose a published version" and the effect below fills in
   * the only answer that is not a guess: what this session is actually bound to.
   */
  const [versionId, setVersionId] = useState(target.workflowVersionId ?? "");
  /**
   * What the selected IMMUTABLE VERSION declares, or null while that is not yet known.
   *
   * Nullable on purpose, and separate from the control values below. This drives one
   * sentence - "This version defaults to …" - which is a claim about the published version
   * and nothing else. It used to be seeded with the application-wide placeholder, so before
   * any version was resolved the dialog asserted `foreman_complete` and `preview` as though
   * it had read them off the version. On a conversation already bound to No-Mistakes Review
   * v8 that produced a flat contradiction: the sentence said "preview" directly above a
   * Delivery field correctly showing Live. Null renders no sentence, which is the honest
   * answer to a question nothing has answered yet.
   */
  const [defaults, setDefaults] = useState<WorkflowBindingDefaults | null>(
    target.bindingDefaults ?? null,
  );
  // The editable values still need something to open on before anything is resolved, and the
  // placeholder is the right seed for THAT - it is a starting position the operator can change,
  // not a claim about a version.
  const seed = target.bindingDefaults ?? DEFAULT_WORKFLOW_BINDING_DEFAULTS;
  const [maxRepairRounds, setMaxRepairRounds] = useState(seed.maxRepairRounds);
  const [triggerMode, setTriggerMode] = useState(seed.triggerMode);
  const [deliveryMode, setDeliveryMode] = useState(seed.deliveryMode);
  const [workflowConfig, setWorkflowConfig] = useState<WorkflowConfig | null>(null);
  const [bindings, setBindings] = useState<WorkflowBinding[]>([]);
  /**
   * Whether the binding fetch has SETTLED, as distinct from having returned rows.
   *
   * The hydration effect below must not mistake "not loaded yet" for "this session is
   * unbound" - it runs once per session, so reading the initial empty array would spend that
   * one chance before the answer existed and leave the dialog permanently blank on a session
   * that is in fact bound. Set on the failure path too: a fetch that failed has also stopped
   * being pending, and re-arming forever on an error would be a spinner with no spinner.
   */
  const [bindingsSettled, setBindingsSettled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const overridesTouchedRef = useRef({
    triggerMode: false,
    deliveryMode: false,
    maxRepairRounds: false,
  });
  const resetTouchedOverrides = (): void => {
    overridesTouchedRef.current = {
      triggerMode: false,
      deliveryMode: false,
      maxRepairRounds: false,
    };
  };
  useEffect(() => {
    void workflowRequest<WorkflowBinding[]>("/api/workflow-bindings")
      .then(setBindings)
      .catch(() => {})
      .finally(() => setBindingsSettled(true));
    void workflowRequest<WorkflowConfig>("/api/workflows/config").then(setWorkflowConfig).catch(() => {});
  }, []);
  const session = live.find((item) => item.id === sessionId) ?? null;
  /**
   * Which session's binding has already been offered to the empty selection, so that answering
   * "what is bound here" happens once per session rather than fighting the operator's own
   * choice on every re-render. Switching the Session select re-arms it deliberately: the
   * question "what is bound" has a new answer, and the stale selection belongs to a
   * conversation no longer on screen.
   */
  const hydratedForSession = useRef<string | null>(null);
  useEffect(() => {
    // A caller that pinned a version asked for that version. Version history's "bind this one"
    // is the case, and overriding it with the active binding would discard the request.
    if (target.workflowVersionId) return;
    if (!bindingsSettled) return;
    if (hydratedForSession.current === sessionId) return;
    hydratedForSession.current = sessionId;
    const active = bindings.find(
      (binding) => binding.state === "active" && binding.sessionId === sessionId,
    );
    if (active) setVersionId(active.workflowVersionId);
  }, [bindings, bindingsSettled, sessionId, target.workflowVersionId]);
  const { existing, conflict } = useMemo(
    () => workflowBindingSelection(bindings, session, versionId),
    [bindings, session, versionId],
  );
  const selectedWorkflowId = publishable.find((item) => item.currentVersionId === versionId)?.id ?? null;
  useEffect(() => {
    if (!versionId) return;
    /*
     * Two different questions, which this effect used to answer with one early return.
     *
     * What the VERSION declares is worth resolving either way - it is the sentence below the
     * controls, and a binding does not change what a published version says. What the CONTROLS
     * should show is a separate question, and there a binding's own overrides win: the effect
     * after this one hydrates them from the binding, so seeding them from the version here
     * would fight it and quietly revert an operator's stored choice.
     *
     * Returning early on `existing` conflated the two, so a conversation that WAS bound - the
     * case this dialog exists to show, and the one hydration now reaches on open - never
     * resolved the version and left the sentence asserting the placeholder.
     */
    const seedControls = !existing;
    const apply = (resolved: WorkflowBindingDefaults): void => {
      setDefaults(resolved);
      if (!seedControls) return;
      if (!overridesTouchedRef.current.maxRepairRounds) setMaxRepairRounds(resolved.maxRepairRounds);
      if (!overridesTouchedRef.current.triggerMode) setTriggerMode(resolved.triggerMode);
      if (!overridesTouchedRef.current.deliveryMode) setDeliveryMode(resolved.deliveryMode);
    };
    if (versionId === target.workflowVersionId && target.bindingDefaults) {
      apply(target.bindingDefaults);
      return;
    }
    if (!selectedWorkflowId) return;
    let current = true;
    void workflowRequest<WorkflowDetail>(`/api/workflows/${selectedWorkflowId}`).then((detail) => {
      if (!current) return;
      const version = detail.versions.find((item) => item.id === versionId);
      if (!version) return;
      apply(version.bindingDefaults);
    }).catch(() => {});
    return () => { current = false; };
  }, [
    existing?.id,
    selectedWorkflowId,
    sessionId,
    target.bindingDefaults,
    target.workflowVersionId,
    versionId,
  ]);
  useEffect(() => {
    if (!existing) return;
    if (!overridesTouchedRef.current.triggerMode) setTriggerMode(existing.triggerMode);
    if (!overridesTouchedRef.current.deliveryMode) setDeliveryMode(existing.deliveryMode);
    if (!overridesTouchedRef.current.maxRepairRounds) setMaxRepairRounds(existing.maxRepairRounds);
  }, [existing?.id, sessionId]);
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
          <select
            value={sessionId}
            disabled={busy || Boolean(target.sessionId)}
            onChange={(event) => {
              resetTouchedOverrides();
              setSessionId(event.target.value);
            }}
          >
            <option value="">Choose a live session</option>
            {live.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.agent}</option>)}
          </select>
        </Tooltip>
      </label>
      <label>
        Published workflow
        <Tooltip label="Which published, immutable workflow version to bind">
          <select
            value={versionId}
            disabled={busy || Boolean(target.workflowVersionId)}
            onChange={(event) => {
              resetTouchedOverrides();
              setVersionId(event.target.value);
            }}
          >
            <option value="">Choose a published version</option>
          {/* The selection is not always in the list below, which offers each workflow's
              CURRENT version only. Version history can pin an older one, and a session bound
              before a new version shipped still holds the version it was bound to - the case
              this dialog exists to show. Naming it keeps that binding readable instead of
              rendering a select with nothing chosen over a conversation that is armed. */}
          {versionId
            && !publishable.some((workflow) => workflow.currentVersionId === versionId) && (
              <option value={versionId}>{workflowVersionLabel(versionId, workflows)}</option>
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
              onChange={(event) => {
                overridesTouchedRef.current.triggerMode = true;
                setTriggerMode(event.target.value as WorkflowBindingDefaults["triggerMode"]);
              }}
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
              onChange={(event) => {
                overridesTouchedRef.current.deliveryMode = true;
                setDeliveryMode(event.target.value as WorkflowBindingDefaults["deliveryMode"]);
              }}
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
            onChange={(event) => {
              overridesTouchedRef.current.maxRepairRounds = true;
              setMaxRepairRounds(Number(event.target.value));
            }}
          />
        </label>
      </div>
      {defaults && (defaults.triggerMode !== "manual" || defaults.deliveryMode !== "preview") && (
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
          {" "}to {workflowVersionLabel(existing.workflowVersionId, workflows)}.
        </p>
      )}
      {conflict && (
        <p className="wf-error" role="alert">
          This conversation is already bound to{" "}
          {workflowVersionLabel(conflict.workflowVersionId, workflows)}.
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
          <div>
            <dt>Workflow</dt>
            <dd>{versionId ? workflowVersionLabel(versionId, workflows) : "none selected"}</dd>
          </div>
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
