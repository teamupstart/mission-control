import { useEffect, useRef, useState } from "react";
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
import { capacityGeometry, type CapacityGeometry } from "../lib/worktree-capacity.ts";
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

/**
 * The pane's one new primitive, and the only place its boldness is spent.
 *
 * The track's width is the pool's configured maximum, so the hatched remainder reads as
 * room to grow and lowering `Default maximum` visibly reflows every bar. All of the
 * arithmetic lives in `capacityGeometry`; this only paints it.
 *
 * Nothing here is carried by colour, or by the absence of it. Every lifecycle count is
 * restated as text in the legend beneath the bar - zeroes included, since a state the
 * track cannot paint is still a state the operator asked about - and the bar itself is a
 * `role="img"` with a composed label naming all four counts and the maximum. Over capacity
 * is spelled out in words; the amber hatching is a second cue, never the only one.
 *
 * The track is the configured maximum and nothing else, so 100% of it is `maxSlots` on
 * every bar and lowering `Default maximum` rewidths every segment drawn against it. An
 * over-capacity pool therefore fills its ceiling and spills: the excess cannot be laid out
 * inside a track that by definition has no room for it, so it is carried by the hatched cap
 * pinned to the track's end, by `N over the maximum` in the legend, and by the sentence and
 * right-size preview below. The cap is a fixed width because it marks that there IS spill,
 * not how much - the count says how much.
 */
function CapacityBar({ geometry }: { geometry: CapacityGeometry }): React.JSX.Element {
  return (
    <div className="wt-bar" role="img" aria-label={geometry.label}>
      {geometry.segments.map((segment) => (
        <span
          key={segment.key}
          className={`wt-bar-seg wt-bar-${segment.key}`}
          style={{ width: `${segment.percent}%` }}
        />
      ))}
      {geometry.overflow && <span className="wt-bar-over" />}
    </div>
  );
}

/**
 * Reads `geometry.legend`, never `geometry.segments`: the track drops a zero-count state
 * because it has no width, but "0 available" is precisely what an operator asking "do I
 * have room" needs told. All four lifecycle counts appear here in every state.
 */
function CapacityLegend({ geometry }: { geometry: CapacityGeometry }): React.JSX.Element {
  return (
    <ul className="wt-legend">
      {geometry.legend.map((entry) => (
        <li key={entry.key} className={`wt-legend-item wt-legend-${entry.key}${entry.count === 0 ? " wt-legend-zero" : ""}`}>
          <span className="wt-swatch" aria-hidden />
          {entry.label}
        </li>
      ))}
      {geometry.overflow && (
        <li className="wt-legend-item wt-legend-over">
          <span className="wt-swatch" aria-hidden />
          {geometry.overflow.label}
        </li>
      )}
    </ul>
  );
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

/**
 * One pool, one full-width row: the bar needs the width a card grid cannot give it.
 *
 * The disclosure below the bar keeps the per-pool overrides, the maintenance actions, and
 * the bounded slot detail exactly as they were. Only the right-size preview is promoted
 * out of it, onto the over-capacity line, because that line is where the operator learns
 * they need it - and it is rendered exactly once either way.
 */
function PoolRow({
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
  const geometry = capacityGeometry(repo.counts, repo.policy.maxSlots);

  function repoPatch(value: NonNullable<WorktreesConfigPatch["repositories"]>[string]): WorktreesConfigPatch {
    return { repositories: { [repo.commonDirectory]: value } };
  }

  return (
    <article className={`wt-pool wt-pool-${tone}`}>
      <header className="wt-pool-head">
        <Tooltip label={open ? `Hide ${repo.name} worktree policy and inventory` : `Show ${repo.name} worktree policy and inventory`}>
          <button type="button" className="wt-disclosure" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
            <span className="wt-caret" aria-hidden>{open ? "▾" : "▸"}</span>
            <span className="wt-pool-name">
              <strong><span className={`wt-dot wt-dot-${tone}`} aria-hidden />{repo.name}</strong>
              <code>{repo.root}</code>
            </span>
          </button>
        </Tooltip>
        <div className="wt-pool-state">
          <span className="wt-pool-summary">{geometry.summary}</span>
          <StateChip label={overridden ? "override" : "inherited"} />
          <StateChip label={repo.status} tone={tone} />
        </div>
      </header>
      <CapacityBar geometry={geometry} />
      <CapacityLegend geometry={geometry} />
      {repo.status === "unavailable" && (
        <p className="wt-diagnostic">This pool&rsquo;s state could not be observed. The counts above are the last reading Mission Control took.</p>
      )}
      {geometry.overflow && (
        <div className="wt-over">
          <p><strong>{geometry.overflow.count}</strong> {geometry.overflow.count === 1 ? "slot is" : "slots are"} over the maximum of {geometry.maxSlots}. Nothing was pruned to say so.</p>
          <Tooltip label="Preview removing safe unused slots until this pool meets its configured maximum">
            <button className="btn btn-ghost" type="button" onClick={(event) => onAction({ action: "prune", poolId: repo.id, mode: "rightSize" }, event.currentTarget)}>Preview right-size</button>
          </Tooltip>
        </div>
      )}
      {repo.reconciliationError && <p className="wt-diagnostic">{repo.reconciliationError}</p>}
      {open && (
        <div className="wt-pool-detail">
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

/** A name-width block and a track-width block per row, so the group has shape while it loads. */
function PoolSkeleton(): React.JSX.Element {
  return (
    <div className="wt-skeletons" aria-hidden>
      {[0, 1].map((row) => (
        <div className="wt-skeleton" key={row}>
          <span className="wt-skeleton-name" />
          <span className="wt-skeleton-bar" />
        </div>
      ))}
    </div>
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
  const acknowledgementSignature = preview.requiredAcknowledgements.join(",");
  useEffect(() => {
    setAcks(new Set());
  }, [preview.token, acknowledgementSignature]);
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
  const currentAcks = [...acks].filter((key) => preview.requiredAcknowledgements.includes(key));
  const acknowledged = preview.requiredAcknowledgements.every((key) => acks.has(key));
  return (
    <Overlay id={OVERLAY_IDS.worktreeAction} onClose={onClose} className="modal wt-action-modal" role="dialog" ariaLabel={`${preview.request.action} worktree preview`} closable={!busy}>
      <div ref={dialog}>
        <header className="modal-head">
          <div><span className="wt-eyebrow">Preview first</span><h3>{preview.request.action === "legacyReturn" ? "Return legacy worktree" : `${preview.request.action[0]!.toUpperCase()}${preview.request.action.slice(1)} worktree`}</h3></div>
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
        <footer className="modal-actions"><Tooltip label="Cancel without changing the worktree"><button className="btn btn-ghost" type="button" onClick={onClose} disabled={busy}>Cancel</button></Tooltip><Tooltip label="Execute this exact preview after every safety check passes"><button className="btn btn-danger" type="button" disabled={busy || changed || !preview.allowed || !acknowledged} onClick={() => onExecute(currentAcks)}>{busy ? "Executing…" : "Execute"}</button></Tooltip></footer>
      </div>
    </Overlay>
  );
}

const LEGACY_KINDS = ["ownedExact", "identityUnverifiable", "foreign", "unreadable"] as const;

export function WorktreeSettingsPanel({ state }: { state: WorktreesState }): React.JSX.Element {
  const { inventory, loading, error, preview, previewError, previewChanged, busy } = state;
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  const [lastRequest, setLastRequest] = useState<WorktreeActionRequest | null>(null);
  const config = inventory?.config;
  const exactLegacy = inventory?.legacy.items.filter((item) => item.classification === "ownedExact") ?? [];
  const legacyBlocked = inventory?.legacy.items.filter((item) => item.classification !== "ownedExact") ?? [];
  const legacyTotal = LEGACY_KINDS.reduce((sum, kind) => sum + (inventory?.legacy.totals[kind] ?? 0), 0);

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
      <p className="settings-hint settings-blurb">
        Mission Control owns these checkouts, and only these. Every cleanup is{" "}
        <strong>previewed and rechecked</strong> against task, check, manual lease, Git, and
        process ownership before it can mutate a path.
      </p>

      {inventory && error && <p className="settings-error">{error}</p>}

      <section className="wt-group" data-anchor="worktrees/native-pools">
        <div className="settings-section-head wt-group-head">
          <div>
            <h4>Pools</h4>
            <p className="wt-group-note">One track per repository. The track&rsquo;s full width is that pool&rsquo;s configured maximum.</p>
          </div>
          <Tooltip label="Reobserve Git, filesystem, process, and durable ownership state">
            <button type="button" className="btn btn-ghost" onClick={() => void state.refresh()} disabled={loading}>Refresh</button>
          </Tooltip>
        </div>
        {!inventory && error && (
          <div className="wt-state wt-state-unavailable">
            <p><strong>Pool capacity could not be observed.</strong> {error}</p>
            <p>This is an outage, not an empty machine - existing pools and their slots are untouched. Refresh above to observe again.</p>
          </div>
        )}
        {!inventory && !error && (
          <>
            <PoolSkeleton />
            <p className="settings-hint">Observing Git, process, and provider state…</p>
          </>
        )}
        {inventory && inventory.repositories.length === 0 && (
          <div className="wt-state">
            <p><strong>No pools yet.</strong> Mission Control creates one the first time something needs a checkout in a repository.</p>
          </div>
        )}
        <div className="wt-pools">{inventory?.repositories.map((repo) => <PoolRow key={repo.id} repo={repo} overridden={Boolean(inventory.config.repositories[repo.commonDirectory])} updateConfig={state.updateConfig} onAction={request} />)}</div>
      </section>

      <section className="wt-group" data-anchor="worktrees/policy">
        <div className="settings-section-head wt-group-head">
          <div>
            <h4>Defaults</h4>
            <p className="wt-group-note">Affects future acquisitions only.</p>
          </div>
        </div>
        <div className="kb-row">
          <div className="kb-row-text">
            <span className="kb-row-label">Use native worktrees</span>
            <span className="kb-row-desc">Repositories without an override acquire native Git worktrees. Disable to send future acquisitions to their isolated fallback; existing slots are preserved either way.</span>
          </div>
          <div className="kb-row-controls">
            <Tooltip label="Set whether repositories without an override use native worktrees for future acquisitions">
              <label className="skill-switch">
                <input
                  type="checkbox"
                  aria-label="Use native worktrees by default"
                  checked={config?.enabled ?? true}
                  disabled={!config}
                  onChange={(event) => void state.updateConfig({ enabled: event.target.checked })}
                />
              </label>
            </Tooltip>
          </div>
        </div>
        <div className="kb-row">
          <div className="kb-row-text">
            <span className="kb-row-label">Default maximum slots</span>
            <span className="kb-row-desc">Every bar above whose pool has not set its own maximum is drawn against this number, and reflows when it changes. Lowering it marks the difference <strong>over the maximum</strong> and offers a right-size preview; it never prunes as a side effect.</span>
          </div>
          <div className="kb-row-controls">
            <input
              className="wt-number"
              aria-label="Default maximum native slots"
              type="number"
              min={1}
              max={128}
              disabled={!config}
              value={config?.maxSlots ?? 16}
              onChange={(event) => void state.updateConfig({ maxSlots: Number(event.target.value) })}
            />
          </div>
        </div>
        <p className="settings-hint">A repository with its own override ignores both of these. Open its pool above to see or clear that override.</p>
      </section>

      <section className="wt-group" data-anchor="worktrees/legacy-drain">
        <div className="settings-section-head wt-group-head">
          <div>
            <h4>Treehouse</h4>
            <p className="wt-group-note">Historical leases only. New work never acquires Treehouse resources.</p>
          </div>
          <StateChip label={inventory?.legacy.capability.kind ?? "unknown"} tone={inventory?.legacy.capability.kind === "conditional-json" ? "ready" : "attention"} />
        </div>
        {inventory?.legacy.capability.diagnostic && <p className="settings-hint wt-group-diagnostic">{inventory.legacy.capability.diagnostic}</p>}
        {legacyTotal > 0 && (
          <ul className="wt-legacy-totals">
            {LEGACY_KINDS.map((kind) => <li key={kind}><b>{inventory?.legacy.totals[kind] ?? 0}</b> {kind}</li>)}
          </ul>
        )}
        <div className="wt-legacy-list">
          {exactLegacy.map((item) => <article className="wt-legacy-row" key={item.id}><div><StateChip label="exact owner" tone="ready" /><code>{item.path}</code><p>{item.owner ? `${item.owner.kind} ${item.owner.id}` : "durable owner unavailable"}</p></div>{item.owner && item.canReturn && <Tooltip label="Preview returning this exact historical lease through its owning task or check"><button className="btn btn-ghost" type="button" onClick={(event) => request({ action: "legacyReturn", owner: item.owner! }, event.currentTarget)}>Return legacy lease</button></Tooltip>}</article>)}
          {legacyBlocked.map((item) => <article className="wt-legacy-row wt-legacy-blocked" key={item.id}><div><StateChip label={item.classification} tone="attention" /><code>{item.path}</code><p>{item.diagnostic ?? "Mission Control has no exact authority over this Treehouse resource."}</p></div></article>)}
          {inventory && inventory.legacy.items.length === 0 && (
            <p className="settings-hint">Nothing left to drain. All historical leases have been returned, and new work never acquires Treehouse resources.</p>
          )}
        </div>
      </section>

      {preview && <ActionDialog preview={preview} error={previewError} changed={previewChanged} busy={busy} onClose={close} onExecute={(acks) => void state.executePreview(acks).then((ok) => { if (ok) { trigger?.focus(); setTrigger(null); } })} onRefresh={() => { if (lastRequest) void state.requestPreview(lastRequest); }} />}
      {!preview && busy && <p className="wt-preview-loading" role="status">Building a fresh safety preview…</p>}
      {!preview && previewError && <p className="settings-error">{previewError}</p>}
    </section>
  );
}
