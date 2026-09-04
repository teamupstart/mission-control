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
  workflowIdForVersion,
  workflowVersionLabel,
} from "@shared/workflow.ts";
import { OVERLAY_IDS, Overlay } from "../components/Overlay.tsx";
import { Tooltip } from "../components/Tooltip.tsx";
import { workflowRequest } from "./workflowApi.ts";
import {
  WorkflowEvidenceComposer,
  type WorkflowEvidenceDraftController,
  useWorkflowEvidenceDraft,
  workflowEvidenceScopes,
  workflowEvidenceSubmission,
  workflowSessionEvidenceOwner,
} from "./WorkflowEvidenceComposer.tsx";

export interface WorkflowBindingTarget {
  sessionId?: string;
  workflowVersionId?: string;
  workflowId?: string;
  bindingDefaults?: WorkflowBindingDefaults;
}

interface WorkflowBindingDialogSharedProps {
  sessions: Session[];
  workflows: WorkflowSummary[];
  onClose: () => void;
  onRun: (id: string) => void;
  foremanEnabled?: boolean;
  promptedWrapupEnabled?: boolean;
}

/**
 * Keep the session-owned browser draft above the transient overlay. The host stays mounted
 * when the dialog closes, so an accidental close preserves uploads, captions, scopes, and
 * their object URLs until the daemon accepts them or the selected session changes.
 */
export function WorkflowBindingDialogHost({
  target,
  sessions,
  workflows,
  onClose,
  onRun,
  foremanEnabled = false,
  promptedWrapupEnabled = false,
}: WorkflowBindingDialogSharedProps & {
  target: WorkflowBindingTarget | null;
}): React.JSX.Element | null {
  const live = useMemo(
    () => sessions.filter((session) => session.state !== "exited" && session.state !== "stopping"),
    [sessions],
  );
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const selectionStillAvailable = selectedSessionId === ""
    || live.some((session) => session.id === selectedSessionId);
  const sessionId = target?.sessionId
    ?? (selectionStillAvailable ? selectedSessionId! : live[0]?.id ?? "");
  const ownerSessionId = target ? sessionId : selectionStillAvailable ? selectedSessionId : null;
  const session = live.find((item) => item.id === ownerSessionId) ?? null;
  const evidenceScopeSet = useMemo(() => workflowEvidenceScopes(session), [session]);
  const evidenceDraft = useWorkflowEvidenceDraft(
    workflowSessionEvidenceOwner(ownerSessionId),
    evidenceScopeSet.defaultScope,
  );

  useEffect(() => {
    if (target && selectedSessionId !== sessionId) setSelectedSessionId(sessionId);
  }, [selectedSessionId, sessionId, target]);

  if (!target) return null;
  return (
    <WorkflowBindingDialog
      target={target}
      sessions={sessions}
      workflows={workflows}
      sessionId={sessionId}
      onSessionIdChange={setSelectedSessionId}
      evidenceDraft={evidenceDraft}
      onClose={onClose}
      onRun={onRun}
      foremanEnabled={foremanEnabled}
      promptedWrapupEnabled={promptedWrapupEnabled}
    />
  );
}

export function workflowBindingSelection(
  bindings: WorkflowBinding[],
  session: Session | null,
  versionId: string,
): { existing: WorkflowBinding | undefined; conflict: WorkflowBinding | undefined } {
  if (!session) return { existing: undefined, conflict: undefined };
  /*
   * An empty selection is not a conflict. Every comparison below is against `versionId`, and
   * `active.workflowVersionId === ""` is false for any real binding, so clearing the select on
   * an already-bound session reported the binding as a CONFLICT and told the operator to
   * "Archive that binding before selecting another version". They had not selected another
   * one; they had selected nothing, and the way forward is to pick a version, not to archive
   * anything. Answering "no opinion" for an empty selection keeps the notices about versions
   * the operator actually chose.
   */
  if (!versionId) return { existing: undefined, conflict: undefined };
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
  sessionId,
  onSessionIdChange,
  evidenceDraft,
  onClose,
  onRun,
  foremanEnabled = false,
  promptedWrapupEnabled = false,
}: WorkflowBindingDialogSharedProps & {
  target: WorkflowBindingTarget;
  sessionId: string;
  onSessionIdChange: (sessionId: string) => void;
  evidenceDraft: WorkflowEvidenceDraftController;
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
  /**
   * Whether the operator has picked a version BY HAND for the session now on screen.
   *
   * The version select's counterpart to `overridesTouchedRef`, which guards the other three
   * editable fields against exactly this: an async seed landing on top of a manual edit. The
   * version had no such guard, and its seed is the slowest of them - it waits on
   * `GET /api/workflow-bindings` - while the select is live the whole time that request is in
   * flight. A pick inside that window was reverted to whatever was actually bound, silently,
   * which is the same wrong-selection failure this dialog was changed to end.
   *
   * A separate ref rather than a fourth key on `overridesTouchedRef`, because that one is
   * CLEARED by the version select's own `onChange` - a new version re-seeds trigger, delivery
   * and repair rounds from its published defaults. Folding this in would have the pick clear
   * the very flag that records it.
   *
   * Cleared when the SESSION changes, on the same reasoning `hydratedForSession` re-arms
   * there: "what is bound" has a new answer, and a pick made about a conversation no longer on
   * screen should not suppress it.
   */
  const versionPickedByHand = useRef(false);
  useEffect(() => {
    /*
     * A caller that named WHAT TO BIND asked for that, and hydration answers a different
     * question: what is this session already bound to. Overriding a named request with the
     * session's own binding is how the Library's "Bind to a session…" could open on an
     * unrelated workflow and sit one click from reattaching it.
     *
     * Both fields are checked, not just the version. A caller with a published workflow pins
     * `workflowVersionId`, but one naming only `workflowId` has still named a workflow, and
     * treating that as "no request" is what made the field decorative. Whether such a caller
     * can produce a bindable selection is a separate question the surrounding UI answers -
     * the Library no longer offers the button for an unpublished draft - and it is not a
     * reason to overwrite what was asked for.
     */
    if (target.workflowVersionId || target.workflowId) return;
    // Deliberately before the latch below, and not latching: a hand-picked version means this
    // effect has nothing left to say about this session, so there is no state to record.
    if (versionPickedByHand.current) return;
    if (!bindingsSettled) return;
    if (hydratedForSession.current === sessionId) return;
    hydratedForSession.current = sessionId;
    const active = bindings.find(
      (binding) => binding.state === "active" && binding.sessionId === sessionId,
    );
    /*
     * Assigned unconditionally, empty included. Only setting it when a binding was FOUND left
     * the previous session's answer standing over the new one: open the dialog with no session
     * pinned, let it settle on a bound session, then switch to an unbound one, and the
     * Published workflow select still showed the first session's workflow - with no existing or
     * conflict notice to flag it, because the new session genuinely has no binding to conflict
     * with. Binding from there attached a workflow the operator never chose for that
     * conversation, which is the failure this dialog was changed to end.
     *
     * "What is this session bound to" has an answer for an unbound session too, and it is
     * nothing. Saying nothing is what the empty selection means.
     */
    setVersionId(active?.workflowVersionId ?? "");
  }, [bindings, bindingsSettled, sessionId, target.workflowId, target.workflowVersionId]);
  const { existing, conflict } = useMemo(
    () => workflowBindingSelection(bindings, session, versionId),
    [bindings, session, versionId],
  );
  const evidenceScopeSet = useMemo(() => workflowEvidenceScopes(session), [session]);
  const evidenceSubmission = workflowEvidenceSubmission(evidenceDraft, evidenceScopeSet.options);
  const previewIntent = useRef<{ key: string; requestId: string } | null>(null);
  /*
   * Resolved the same way the version is NAMED, rather than by `currentVersionId` equality.
   *
   * That equality only holds while a version is the newest one, so a session bound to a
   * superseded built-in - `@7` after `@8` ships - resolved to null, the detail fetch below
   * never fired, and "This version defaults to …" silently never rendered for it. Hydration
   * makes that reachable by design: it selects whatever the session is actually bound to,
   * superseded versions included, and the select already renders an option for exactly that
   * case. Naming and lookup have to recognise the same set of versions.
   */
  const selectedWorkflowId = workflowIdForVersion(versionId, publishable);
  useEffect(() => {
    /*
     * No version selected, no claim to make about one. Returning early instead left `defaults`
     * describing whatever was selected before, so the sentence outlived its subject: pick a
     * bound session, read "This version defaults to foreman complete and live", switch to an
     * unbound one, and the Published workflow field correctly empties while that sentence
     * keeps asserting the defaults of a workflow no longer on screen.
     *
     * Cleared HERE rather than beside the `setVersionId` that empties it, because this effect
     * owns `defaults` and this covers every route to an empty selection - hydration landing on
     * an unbound session, and an operator choosing "Choose a published version" by hand. A
     * reset at one call site would have fixed the route that was reported and left the other.
     */
    if (!versionId) {
      setDefaults(null);
      return;
    }
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
    if (preview && !evidenceSubmission.ready) return;
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
          body: JSON.stringify({
            requestId: (() => {
              const key = `${sessionId}:${versionId}:${triggerMode}:${deliveryMode}:${maxRepairRounds}`;
              if (previewIntent.current?.key !== key) {
                previewIntent.current = { key, requestId: crypto.randomUUID() };
              }
              return previewIntent.current.requestId;
            })(),
            evidence: evidenceSubmission.locators,
          }),
        },
      );
      evidenceDraft.clear();
      previewIntent.current = null;
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
              // A different conversation has a different answer to "what is bound here", so the
              // previous session's hand-pick stops standing in the way of hydrating this one.
              versionPickedByHand.current = false;
              onSessionIdChange(event.target.value);
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
              // Recorded before the state write, so a binding fetch settling on the very next
              // tick finds the pick already registered rather than racing it.
              versionPickedByHand.current = true;
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
      <WorkflowEvidenceComposer
        controller={evidenceDraft}
        scopes={evidenceScopeSet.options}
        disabled={busy}
      />
      {error && <p className="wf-error" role="alert">{error}</p>}
      <footer className="modal-foot">
        <Tooltip label="Attach the workflow to this session without starting a run">
          <button className="btn btn-ghost" disabled={busy || !canSubmit} onClick={() => void perform(false)}>
            {existing?.state === "active" ? "Update binding" : existing ? "Reattach only" : "Bind only"}
          </button>
        </Tooltip>
        <Tooltip label="Attach the workflow and take an evidence snapshot to review now">
          <button
            className="btn"
            disabled={busy || !canSubmit || !evidenceSubmission.ready}
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
