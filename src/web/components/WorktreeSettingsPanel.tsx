import { useEffect, useMemo, useRef, useState } from "react";
import type { WorktreesConfigPatch } from "@shared/protocol.ts";
import type { TerminalBackendId } from "@shared/terminal.ts";
import type {
  NativeWorktreeSlotView,
  WorktreeActionPreview,
  WorktreeActionRequest,
  WorktreeRepositoryView,
  WorktreeRiskKey,
} from "@shared/worktrees.ts";
import type { WorktreesState } from "../useWorktrees.ts";
import { COPY_FEEDBACK_LABEL, useCopyFeedback } from "../lib/clipboard.ts";
import { openWorktreeTerminal } from "../lib/api.ts";
import { useTerminalTargets } from "../lib/terminalTargets.ts";
import { Overlay, OVERLAY_IDS } from "./Overlay.tsx";
import { Tooltip } from "./Tooltip.tsx";

function bytes(value: number | null): string {
  if (value === null) return "size unknown";
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KiB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MiB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GiB`;
}

function shortSha(value: string | null): string {
  return value?.slice(0, 9) ?? "unknown";
}

function StateChip({ label, tone = "neutral" }: { label: string; tone?: string }): React.JSX.Element {
  return <span className={`wt-chip wt-chip-${tone}`}>{label}</span>;
}

function SlotCard({
  slot,
  onAction,
}: {
  slot: NativeWorktreeSlotView;
  onAction: (request: WorktreeActionRequest, trigger: HTMLButtonElement) => void;
}): React.JSX.Element {
  const copy = useCopyFeedback({ resetOn: slot.path });
  const terminals = useTerminalTargets();
  const [openError, setOpenError] = useState<string | null>(null);
  const [terminalId, setTerminalId] = useState<TerminalBackendId | null>(null);
  const terminal = terminals.targets?.find((target) => target.id === terminalId && target.unavailable === null)
    ?? terminals.targets?.find((target) => target.unavailable === null)
    ?? null;
  useEffect(() => {
    if (terminal && terminal.id !== terminalId) setTerminalId(terminal.id);
  }, [terminal, terminalId]);
  const tone = slot.state === "available"
    ? "ready"
    : slot.state === "quarantined"
      ? "danger"
      : slot.state === "leased"
        ? "working"
        : "attention";

  async function openTerminal(): Promise<void> {
    if (!terminal) return;
    setOpenError(null);
    const result = await openWorktreeTerminal(slot.id, terminal.id);
    if (!result.ok) setOpenError(result.error);
  }

  return (
    <article className={`wt-slot wt-slot-${tone}`} aria-label={`Slot ${slot.ordinal}`}>
      <div className="wt-slot-head">
        <strong>Slot {slot.ordinal}</strong>
        <StateChip label={slot.state} tone={tone} />
        {slot.dirty === true && <StateChip label="dirty" tone="danger" />}
        {slot.defaultRelation === "unmerged" && <StateChip label="unlanded" tone="attention" />}
        {slot.processes.state === "unknown" && <StateChip label="processes unknown" tone="danger" />}
      </div>
      <Tooltip label={slot.path}>
        <code className="wt-path">{slot.path}</code>
      </Tooltip>
      <dl className="wt-facts">
        <div><dt>HEAD</dt><dd><code>{shortSha(slot.head)}</code></dd></div>
        <div><dt>Default</dt><dd>{slot.defaultRelation}</dd></div>
        <div><dt>Processes</dt><dd>{slot.processes.count ?? "unknown"}</dd></div>
        <div><dt>Disk</dt><dd>{bytes(slot.diskBytes)}</dd></div>
      </dl>
      {slot.owner && <p className="wt-owner"><span>{slot.owner.kind}</span> {slot.owner.label}</p>}
      {(slot.quarantineReason || slot.diagnostic || slot.processes.reason) && (
        <p className="wt-diagnostic">{slot.quarantineReason ?? slot.diagnostic ?? slot.processes.reason}</p>
      )}
      <div className="wt-slot-actions">
        <Tooltip label={copy.copied ? COPY_FEEDBACK_LABEL : "Copy exact worktree path"}>
          <button className="btn btn-ghost" type="button" onClick={() => void copy.copy(slot.path)}>
            {copy.copied ? "Copied" : "Copy path"}
          </button>
        </Tooltip>
        <Tooltip label="Choose the terminal application that opens this exact worktree path">
          <select
            aria-label={`Terminal backend for slot ${slot.ordinal}`}
            value={terminal?.id ?? ""}
            disabled={!terminals.targets}
            onChange={(event) => setTerminalId(event.target.value as TerminalBackendId)}
          >
            {!terminals.targets && <option value="">Checking terminals…</option>}
            {terminals.targets?.map((target) => <option key={target.id} value={target.id} disabled={target.unavailable !== null}>{target.label}{target.unavailable ? `: ${target.unavailable}` : ""}</option>)}
          </select>
        </Tooltip>
        <Tooltip label={terminal?.blurb ?? "No terminal backend is currently available"}>
          <button className="btn btn-ghost" type="button" disabled={!terminal} onClick={() => void openTerminal()}>Open terminal</button>
        </Tooltip>
        {slot.actions.includes("return") && (
          <Tooltip label="Preview returning this slot through its current task, check, or manual lease owner">
            <button className="btn btn-ghost" type="button" onClick={(event) => onAction({ action: "return", slotId: slot.id }, event.currentTarget)}>
              Return
            </button>
          </Tooltip>
        )}
        {slot.actions.includes("destroy") && (
          <Tooltip label="Preview permanently removing this manager-owned slot">
            <button className="btn btn-danger" type="button" onClick={(event) => onAction({ action: "destroy", target: { kind: "slot", slotId: slot.id } }, event.currentTarget)}>
              Destroy
            </button>
          </Tooltip>
        )}
      </div>
      {(copy.error || openError) && <p className="settings-error">{copy.error ?? openError}</p>}
    </article>
  );
}

function RepositoryCard({
  repo,
  overridden,
  updateConfig,
  onAction,
}: {
  repo: WorktreeRepositoryView;
  overridden: boolean;
  updateConfig: (patch: WorktreesConfigPatch) => Promise<void>;
  onAction: (request: WorktreeActionRequest, trigger: HTMLButtonElement) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(repo.status !== "ready");
  const [setup, setSetup] = useState(repo.policy.setupArgv ?? []);
  const [slotLimit, setSlotLimit] = useState(12);
  useEffect(() => setSetup(repo.policy.setupArgv ?? []), [repo.policy.setupArgv]);
  const tone = repo.status === "ready" ? "ready" : repo.status === "attention" ? "attention" : "danger";

  function repoPatch(value: NonNullable<WorktreesConfigPatch["repositories"]>[string]): WorktreesConfigPatch {
    return { repositories: { [repo.commonDirectory]: value } };
  }

  return (
    <article className={`wt-repo wt-repo-${tone}`}>
      <header className="wt-repo-head">
        <Tooltip label={open ? `Hide ${repo.name} worktree policy and inventory` : `Show ${repo.name} worktree policy and inventory`}>
          <button type="button" className="wt-disclosure" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
            <span aria-hidden>{open ? "▾" : "▸"}</span>
            <span><strong>{repo.name}</strong><code>{repo.root}</code></span>
          </button>
        </Tooltip>
        <div className="wt-repo-state"><StateChip label={overridden ? "override" : "inherited"} /><StateChip label={repo.status} tone={tone} /></div>
      </header>
      <div className="wt-ledger" aria-label={`${repo.name} lifecycle counts`}>
        <span><b>{repo.counts.available}</b> available</span>
        <span><b>{repo.counts.leased}</b> leased</span>
        <span><b>{repo.counts.quarantined}</b> quarantined</span>
        <span><b>{repo.counts.overCapacity}</b> over capacity</span>
        <span><b>{bytes(repo.diskBytes)}</b> total</span>
      </div>
      {repo.reconciliationError && <p className="wt-diagnostic">{repo.reconciliationError}</p>}
      {open && (
        <div className="wt-repo-detail">
          <div className="wt-policy-grid">
            <Tooltip label="Allow future native worktree acquisitions for this repository">
              <label>
                Repository enabled
                <input
                  type="checkbox"
                  checked={repo.policy.enabled}
                  onChange={(event) => void updateConfig(repoPatch({ enabled: event.target.checked }))}
                />
              </label>
            </Tooltip>
            <label>
              Maximum warm slots
              <input
                type="number"
                min={1}
                max={128}
                value={repo.policy.maxSlots}
                onChange={(event) => void updateConfig(repoPatch({ maxSlots: Number(event.target.value) }))}
              />
            </label>
          </div>
          <Tooltip label="Remove this repository override so future acquisitions use global policy">
            <button className="btn btn-ghost" type="button" disabled={!overridden} onClick={() => void updateConfig({ repositories: { [repo.commonDirectory]: null } })}>Use global defaults</button>
          </Tooltip>
          <fieldset className="wt-argv">
            <legend>Setup argv for newly created slots</legend>
            {setup.map((arg, index) => (
              <div className="wt-argv-row" key={index}>
                <label htmlFor={`wt-setup-${repo.id}-${index}`}>Argument {index + 1}</label>
                <input
                  id={`wt-setup-${repo.id}-${index}`}
                  value={arg}
                  onChange={(event) => setSetup((current) => current.map((value, at) => at === index ? event.target.value : value))}
                />
                <Tooltip label={`Remove setup argument ${index + 1} from this draft`}>
                  <button type="button" className="btn btn-ghost" aria-label={`Remove setup argument ${index + 1}`} onClick={() => setSetup((current) => current.filter((_, at) => at !== index))}>Remove</button>
                </Tooltip>
              </div>
            ))}
            <div className="wt-argv-actions">
              <Tooltip label="Add one setup command argument">
                <button type="button" className="btn btn-ghost" disabled={setup.length >= 32} onClick={() => setSetup((current) => [...current, ""])}>Add argument</button>
              </Tooltip>
              <Tooltip label="Save this exact setup argument vector for future slots">
                <button type="button" className="btn btn-secondary" disabled={setup.some((arg) => !arg)} onClick={() => void updateConfig(repoPatch({ setupArgv: setup.length ? setup : null }))}>Save argv</button>
              </Tooltip>
            </div>
          </fieldset>
          <div className="wt-maintenance-actions">
            <Tooltip label="Preview reconciling durable slot records with Git and filesystem state">
              <button className="btn btn-ghost" type="button" onClick={(event) => onAction({ action: "reconcile", poolId: repo.id }, event.currentTarget)}>Reconcile</button>
            </Tooltip>
            <Tooltip label="Preview removing only safe, unused native slots">
              <button className="btn btn-ghost" type="button" onClick={(event) => onAction({ action: "prune", poolId: repo.id, mode: "safe" }, event.currentTarget)}>Preview safe prune</button>
            </Tooltip>
            {repo.counts.overCapacity > 0 && (
              <Tooltip label="Preview removing safe unused slots until this pool meets its configured maximum">
                <button className="btn btn-ghost" type="button" onClick={(event) => onAction({ action: "prune", poolId: repo.id, mode: "rightSize" }, event.currentTarget)}>Preview right-size</button>
              </Tooltip>
            )}
            {repo.slots.length > 0 && (
              <Tooltip label="Preview destroying the fixed set of slots currently in this pool">
                <button className="btn btn-danger" type="button" onClick={(event) => onAction({ action: "destroy", target: { kind: "pool", poolId: repo.id } }, event.currentTarget)}>Destroy fixed pool set</button>
              </Tooltip>
            )}
          </div>
          <div className="wt-slot-scroll" role="region" aria-label={`${repo.name} native slot details`} tabIndex={0}>
            <div className="wt-slots">
              {repo.slots.slice(0, slotLimit).map((slot) => <SlotCard key={slot.id} slot={slot} onAction={onAction} />)}
            </div>
          </div>
          {repo.slots.length > slotLimit && (
            <Tooltip label="Render the next twelve slots in this bounded inventory">
              <button className="btn btn-ghost" type="button" onClick={() => setSlotLimit((current) => Math.min(current + 12, repo.slots.length))}>Show more slots ({repo.slots.length - slotLimit} remaining)</button>
            </Tooltip>
          )}
        </div>
      )}
    </article>
  );
}

function ActionDialog({
  preview,
  error,
  changed,
  busy,
  onClose,
  onExecute,
  onRefresh,
}: {
  preview: WorktreeActionPreview;
  error: string | null;
  changed: boolean;
  busy: boolean;
  onClose: () => void;
  onExecute: (acks: WorktreeRiskKey[]) => void;
  onRefresh: () => void;
}): React.JSX.Element {
  const dialog = useRef<HTMLDivElement>(null);
  const [acks, setAcks] = useState<Set<WorktreeRiskKey>>(new Set());
  useEffect(() => {
    const root = dialog.current;
    if (!root) return;
    const focusable = () => [...root.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex="0"]')];
    focusable()[0]?.focus();
    function trap(event: KeyboardEvent): void {
      if (event.key !== "Tab") return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    root.addEventListener("keydown", trap);
    return () => root.removeEventListener("keydown", trap);
  }, []);
  const acknowledged = preview.requiredAcknowledgements.every((key) => acks.has(key));
  return (
    <Overlay id={OVERLAY_IDS.worktreeAction} onClose={onClose} className="modal wt-action-modal" role="dialog" ariaLabel={`${preview.request.action} worktree preview`} closable={!busy}>
      <div ref={dialog}>
        <header className="modal-head">
          <div><span className="wt-kicker">Preview first</span><h3>{preview.request.action === "legacyReturn" ? "Return legacy worktree" : `${preview.request.action[0]!.toUpperCase()}${preview.request.action.slice(1)} worktree`}</h3></div>
          <Tooltip label="Close this action preview without changing the worktree">
            <button className="btn btn-ghost" type="button" onClick={onClose} disabled={busy}>Close</button>
          </Tooltip>
        </header>
        <div className="modal-body wt-action-body">
          {changed && <div className="wt-changed"><strong>State changed after this preview.</strong><p>{error}</p><Tooltip label="Discard the stale token and build a new safety preview"><button className="btn btn-secondary" type="button" onClick={onRefresh}>Refresh preview</button></Tooltip></div>}
          {!changed && error && <p className="settings-error">{error}</p>}
          <section><h4>Affected paths</h4><ul className="wt-affected">{preview.affected.map((item) => <li key={`${item.provider}:${item.id}`}><code>{item.path}</code><span>{item.owner?.label ?? item.provider} · {bytes(item.diskBytes)}</span></li>)}</ul></section>
          {preview.blockers.length > 0 && <section className="wt-blockers"><h4>Cannot execute</h4><ul>{preview.blockers.map((item) => <li key={item}>{item}</li>)}</ul></section>}
          {preview.consequences.length > 0 && <section><h4>What happens</h4><ul>{preview.consequences.map((item) => <li key={item}>{item}</li>)}</ul></section>}
          {preview.requiredAcknowledgements.length > 0 && <fieldset className="wt-acknowledgements"><legend>Required acknowledgements</legend>{preview.risks.filter((item) => item.acknowledgeable).map((item) => <Tooltip key={item.key} label={`Acknowledge this previewed risk: ${item.label}`}><label><input type="checkbox" checked={acks.has(item.key)} onChange={(event) => setAcks((current) => { const next = new Set(current); if (event.target.checked) next.add(item.key); else next.delete(item.key); return next; })} />I understand: {item.label}</label></Tooltip>)}</fieldset>}
        </div>
        <footer className="modal-actions"><Tooltip label="Cancel without changing the worktree"><button className="btn btn-ghost" type="button" onClick={onClose} disabled={busy}>Cancel</button></Tooltip><Tooltip label="Execute this exact preview after every safety check passes"><button className="btn btn-danger" type="button" disabled={busy || changed || !preview.allowed || !acknowledged} onClick={() => onExecute([...acks])}>{busy ? "Executing…" : "Execute"}</button></Tooltip></footer>
      </div>
    </Overlay>
  );
}

export function WorktreeSettingsPanel({ state }: { state: WorktreesState }): React.JSX.Element {
  const { inventory, loading, error, preview, previewError, previewChanged, busy } = state;
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  const [lastRequest, setLastRequest] = useState<WorktreeActionRequest | null>(null);
  const config = inventory?.config;
  const exactLegacy = inventory?.legacy.items.filter((item) => item.classification === "ownedExact") ?? [];
  const legacyBlocked = inventory?.legacy.items.filter((item) => item.classification !== "ownedExact") ?? [];
  const repoCount = inventory?.repositories.length ?? 0;
  const slotCount = useMemo(() => inventory?.repositories.reduce((sum, repo) => sum + repo.counts.total, 0) ?? 0, [inventory]);

  function request(request: WorktreeActionRequest, source: HTMLButtonElement): void {
    setTrigger(source);
    setLastRequest(request);
    void state.requestPreview(request);
  }

  function close(): void {
    state.discardPreview();
    trigger?.focus();
    setTrigger(null);
  }

  return (
    <section className="settings-section wt-settings">
      <div className="wt-intro">
        <p className="wt-kicker">Manager-owned paths only</p>
        <p>Policy changes affect future leases. Every cleanup is previewed and rechecked against task, check, manual lease, Git, and process ownership before it can mutate a path.</p>
        <div className="wt-overview"><span><b>{repoCount}</b> native pools</span><span><b>{slotCount}</b> native slots</span><span><b>{inventory?.legacy.items.length ?? 0}</b> legacy rows</span></div>
      </div>
      {error && <p className="settings-error">{error}</p>}
      {loading && !inventory && <p className="settings-hint">Observing Git, process, and provider state…</p>}
      <section className="wt-section" data-anchor="worktrees/policy">
        <div className="settings-section-head"><div><p className="wt-kicker">01 · Policy</p><h4>Future capacity</h4></div></div>
        <div className="wt-global-policy">
          <Tooltip label="Set whether repositories without an override use native worktrees for future acquisitions">
            <label className="wt-policy-toggle"><span><strong>Native worktrees by default</strong><small>Disable to make future acquisitions use their isolated fallback. Existing slots are preserved.</small></span><input type="checkbox" checked={config?.enabled ?? true} disabled={!config} onChange={(event) => void state.updateConfig({ enabled: event.target.checked })} /></label>
          </Tooltip>
          <label><span><strong>Default maximum</strong><small>Lowering this number marks pools over capacity; it never prunes as a side effect.</small></span><input aria-label="Default maximum native slots" type="number" min={1} max={128} disabled={!config} value={config?.maxSlots ?? 16} onChange={(event) => void state.updateConfig({ maxSlots: Number(event.target.value) })} /></label>
        </div>
      </section>
      <section className="wt-section" data-anchor="worktrees/native-pools">
        <div className="settings-section-head"><div><p className="wt-kicker">02 · Native inventory</p><h4>Pool ledger</h4></div><Tooltip label="Reobserve Git, filesystem, process, and durable ownership state"><button type="button" className="btn btn-ghost" onClick={() => void state.refresh()} disabled={loading}>Refresh</button></Tooltip></div>
        {inventory?.repositories.length === 0 && <p className="settings-hint">No native pool exists yet. Pools are created lazily on first acquisition.</p>}
        <div className="wt-repositories">{inventory?.repositories.map((repo) => <RepositoryCard key={repo.id} repo={repo} overridden={Boolean(inventory.config.repositories[repo.commonDirectory])} updateConfig={state.updateConfig} onAction={request} />)}</div>
      </section>
      <section className="wt-section" data-anchor="worktrees/legacy-drain">
        <div className="settings-section-head"><div><p className="wt-kicker">03 · Legacy drain</p><h4>Treehouse compatibility</h4></div><StateChip label={inventory?.legacy.capability.kind ?? "unknown"} tone={inventory?.legacy.capability.kind === "conditional-json" ? "ready" : "attention"} /></div>
        <p className="settings-hint">{inventory?.legacy.capability.diagnostic ?? "Exact historical leases can be returned. New work never acquires Treehouse resources."}</p>
        <div className="wt-legacy-counts">{(["ownedExact", "identityUnverifiable", "foreign", "unreadable"] as const).map((kind) => <span key={kind}><b>{inventory?.legacy.totals[kind] ?? 0}</b>{kind}</span>)}</div>
        <div className="wt-legacy-list">
          {exactLegacy.map((item) => <article className="wt-legacy-row" key={item.id}><div><StateChip label="exact owner" tone="ready" /><code>{item.path}</code><p>{item.owner ? `${item.owner.kind} ${item.owner.id}` : "durable owner unavailable"}</p></div>{item.owner && item.canReturn && <Tooltip label="Preview returning this exact historical lease through its owning task or check"><button className="btn btn-ghost" type="button" onClick={(event) => request({ action: "legacyReturn", owner: item.owner! }, event.currentTarget)}>Return legacy lease</button></Tooltip>}</article>)}
          {legacyBlocked.map((item) => <article className="wt-legacy-row wt-legacy-blocked" key={item.id}><div><StateChip label={item.classification} tone="attention" /><code>{item.path}</code><p>{item.diagnostic ?? "Mission Control has no exact authority over this Treehouse resource."}</p></div></article>)}
          {inventory && inventory.legacy.items.length === 0 && <p className="settings-hint">No durable legacy worktree rows remain.</p>}
        </div>
      </section>
      {preview && <ActionDialog preview={preview} error={previewError} changed={previewChanged} busy={busy} onClose={close} onExecute={(acks) => void state.executePreview(acks).then((ok) => { if (ok) { trigger?.focus(); setTrigger(null); } })} onRefresh={() => { if (lastRequest) void state.requestPreview(lastRequest); }} />}
      {!preview && busy && <p className="wt-preview-loading" role="status">Building a fresh safety preview…</p>}
      {!preview && previewError && <p className="settings-error">{previewError}</p>}
    </section>
  );
}
