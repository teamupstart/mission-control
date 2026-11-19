import { useEffect, useState } from "react";
import { explicitlyDisabledFeatureFlags, resolveFeatureFlag, type FeatureFlagDefinition, type FeatureFlagIntent, type FeatureFlagsConfig } from "@shared/feature-flags.ts";
import { Overlay, OVERLAY_IDS } from "./Overlay.tsx";
import { Tooltip } from "./Tooltip.tsx";

export function FeatureFlagsView({ definitions, config, pending = null, errors = {}, ready = true, onSet, jumpAnchor }: {
  definitions: readonly FeatureFlagDefinition[];
  config: FeatureFlagsConfig;
  pending?: FeatureFlagIntent | null;
  errors?: Record<string, string>;
  ready?: boolean;
  onSet: (intent: FeatureFlagIntent) => void;
  jumpAnchor?: string;
}): React.JSX.Element {
  const [filter, setFilter] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const query = filter.trim().toLowerCase();
  const matches = (flag: FeatureFlagDefinition) => [flag.id, flag.label, flag.description, ...flag.keywords].some(value => value.toLowerCase().includes(query));
  const previews = definitions.filter(flag => flag.stage === "preview");
  const defaults = definitions.filter(flag => flag.stage === "default-on");
  const visiblePreviews = previews.filter(matches);
  const visibleDefaults = defaults.filter(matches);
  const disabled = explicitlyDisabledFeatureFlags(config, definitions);
  const disabledDefaults = defaults.filter(flag => !resolveFeatureFlag(flag.id, config, definitions)).length;
  useEffect(() => {
    if (definitions.some(flag => flag.stage === "default-on" && jumpAnchor === `feature-flags/${flag.id}`)) setAdvanced(true);
  }, [jumpAnchor, definitions]);
  const showAdvanced = advanced || (!!query && !visiblePreviews.length && !!visibleDefaults.length)
    || defaults.some(flag => jumpAnchor === `feature-flags/${flag.id}`);
  const busy = !ready || pending !== null;
  const enableMaster = (enableDisabled?: boolean) => {
    setConfirm(false);
    onSet({ kind: "master", enabled: true, ...(enableDisabled ? { enableDisabled } : {}) });
  };
  const row = (flag: FeatureFlagDefinition) => {
    const on = resolveFeatureFlag(flag.id, config, definitions);
    return <div className="feature-flag-row" key={flag.id} data-anchor={`feature-flags/${flag.id}`}>
      <div className="feature-flag-copy"><strong>{flag.label}</strong><p>{flag.description}</p>
        {errors[flag.id] && <p role="alert">{errors[flag.id]}</p>}
      </div>
      <Tooltip label={`Switch ${flag.label} ${on ? "off" : "on"} immediately in every window.`}>
      <button type="button" className={`settings-grant ${on ? "is-on" : "is-off"}`} disabled={busy}
        aria-label={`${flag.label}: ${on ? "on" : "off"}`} aria-pressed={on}
        onClick={() => onSet({ kind: "flag", id: flag.id, enabled: !on })}>
        <span className="settings-grant-dot" aria-hidden />{on ? "On" : "Off"}
      </button></Tooltip>
    </div>;
  };
  return <section className="settings-section feature-flags" aria-label="Feature flags">
    <p className="settings-hint">Preview features that are still being finished. Turn one on to try it.</p>
    <div data-anchor="feature-flags/enable-all">
      <Tooltip label="Set the default for current and future previews, preserving individual choices.">
      <label className={`settings-toggle${config.enableAll ? " is-on" : ""}`}>
        <input type="checkbox" checked={config.enableAll} disabled={busy} onChange={event => {
          if (event.target.checked && disabled.length) setConfirm(true);
          else onSet({ kind: "master", enabled: event.target.checked });
        }} />
        <span className="settings-toggle-text"><span className="settings-toggle-label">Enable all feature flags</span>
          <span className="settings-toggle-desc">Turns on every preview feature below, and any that a future update adds. Keeps your individual choices.</span>
        </span>
      </label></Tooltip>
      <p className="settings-hint">Updating to an alpha build does not turn this on, or any flag.</p>
      {errors["enable-all"] && <p role="alert">{errors["enable-all"]}</p>}
    </div>
    <div className="feature-flag-list">
      <div className="settings-pane-head">
        <div className="settings-pane-title-row"><h3 className="settings-pane-title">Preview features</h3><span className="settings-pane-count">{previews.length}</span></div>
        {!!definitions.length && <input className="settings-search" aria-label="Filter feature flags" placeholder="Filter feature flags…" value={filter} onChange={event => setFilter(event.target.value)} />}
      </div>
      {!previews.length && !query && <p className="feature-flag-empty">No preview features right now. New ones appear here.</p>}
      {query && !visiblePreviews.length && !visibleDefaults.length && <p className="feature-flag-empty">No feature flags match your filter.</p>}
      {visiblePreviews.map(row)}
    </div>
    {!!defaults.length && <div className="feature-flag-list">
      <Tooltip label="Show or hide features that are on by default.">
      <button type="button" className="feature-flag-advanced settings-pane-head" aria-expanded={showAdvanced}
        aria-controls="feature-flags-advanced" onClick={() => setAdvanced(!showAdvanced)}>
        <span className="settings-pane-title">{showAdvanced ? "▾" : "▸"} Advanced</span>
        <span className="settings-pane-count">{disabledDefaults} turned off</span>
      </button></Tooltip>
      <div id="feature-flags-advanced" hidden={!showAdvanced}>
        <p className="feature-flag-empty">These features are on by default. You can switch them off here.</p>
        {visibleDefaults.map(row)}
      </div>
    </div>}
    {confirm && <Overlay id={OVERLAY_IDS.featureFlagsConfirm} className="modal" role="dialog" ariaModal ariaLabel="Enable all feature flags" onClose={() => setConfirm(false)}>
      <header className="modal-head"><h3>Keep these features off?</h3></header>
      <div className="modal-body"><p>You switched these features off. Enable all keeps those choices unless you turn them on too.</p>
        <ul>{disabled.map(flag => <li key={flag.id}>{flag.label}</li>)}</ul>
      </div>
      <footer className="modal-foot">
        <Tooltip label="Close without changing any feature flags"><button type="button" className="btn btn-ghost" autoFocus onClick={() => setConfirm(false)}>Cancel</button></Tooltip>
        <Tooltip label="Enable all while preserving every individual choice"><button type="button" className="btn btn-ghost" disabled={busy} onClick={() => enableMaster()}>Keep them off</button></Tooltip>
        <Tooltip label="Enable all and clear the off choices for these features"><button type="button" className="btn" disabled={busy} onClick={() => enableMaster(true)}>Turn them on too</button></Tooltip>
      </footer>
    </Overlay>}
  </section>;
}
