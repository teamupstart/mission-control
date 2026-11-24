import { useEffect, useId, useRef, useState } from "react";
import { AgentEnvironmentConfigSchema } from "@shared/protocol.ts";
import { api, fetchAgentEnvironment } from "../lib/api.ts";
import { Tooltip } from "./Tooltip.tsx";

export function AgentEnvironmentSettings() {
  const [settings, setSettings] = useState<Awaited<ReturnType<typeof fetchAgentEnvironment>>>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [readAttempt, setReadAttempt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const inputId = useId();
  useEffect(() => {
    let current = true;
    setError("");
    void fetchAgentEnvironment().then((result) => {
      if (!current) return;
      setSettings(result);
      if (!result) setError("Could not read agent environment settings.");
    });
    return () => { current = false; };
  }, [readAttempt]);

  async function save(names: string[]) {
    if (!settings || saving) return false;
    setError("");
    setSaving(true);
    const result = await api.setAgentEnvironment(names, settings.revision);
    if (result.status === 409) {
      const current = await fetchAgentEnvironment();
      setSettings(current);
      setError(current ? "Another save changed the variable names. Showing the current settings." : "Could not read agent environment settings.");
    } else if (result.ok && result.variables && result.names && result.revision) {
      setSettings({ variables: result.variables, names: result.names, revision: result.revision });
      setSaving(false);
      input.current?.focus();
      return true;
    } else {
      setError("Could not save agent environment settings.");
    }
    setSaving(false);
    return false;
  }

  async function add() {
    if (!settings || saving) return;
    const name = draft.trim();
    if (!name) return;
    if (settings.names.includes(name)) {
      setError("This variable is already in the list.");
      return;
    }
    if (!AgentEnvironmentConfigSchema.safeParse({ names: [name] }).success) {
      setError("Enter one valid variable name. Assignments and reserved names are unavailable.");
      return;
    }
    const names = [...settings.names, name];
    if (!AgentEnvironmentConfigSchema.safeParse({ names }).success) {
      setError("You can add up to 32 variable names.");
      return;
    }
    if (await save(names)) setDraft("");
  }

  return (
    <section className="agent-environment-settings" aria-label="Agent environment" data-anchor="harnesses/agent-environment">
      <h4>Agent environment</h4>
      <p className="settings-hint">New sessions on this machine read each name from the daemon, then the login shell. Residents use their own secrets.</p>
      <form onSubmit={(event) => { event.preventDefault(); void add(); }}>
        <label className="kb-row-label" htmlFor={inputId}>Variable name</label>
        <div className="agent-environment-entry">
          <input id={inputId} ref={input} className="field-input" type="text" placeholder="MY_TOKEN" autoComplete="off"
            autoCapitalize="none" spellCheck={false} disabled={!settings} readOnly={saving} value={draft}
            onPaste={(event) => {
              if (/[\r\n]/.test(event.clipboardData.getData("text").trim())) {
                event.preventDefault();
                setError("Add one variable name at a time.");
              }
            }}
            onChange={(event) => { setDraft(event.target.value); setError(""); }} />
          <Tooltip label="Add this variable to future agent launches">
            <button className="btn" type="submit" disabled={!settings || saving || !draft.trim()}>Add variable</button>
          </Tooltip>
        </div>
      </form>
      {error && <p role="alert" className="settings-error">{error}</p>}
      {error && !settings && (
        <Tooltip label="Reload the saved variable names and their status">
          <button className="btn" type="button" onClick={() => setReadAttempt((attempt) => attempt + 1)}>Retry loading variable names</button>
        </Tooltip>
      )}
      {settings && (settings.variables.length ? (
        <ul aria-label="Configured variables">{settings.variables.map(({ name, source }) => (
          <li key={name}>
            <code>{name}</code>
            <span>{source === "daemon" ? "Present (daemon)" : source === "loginShell" ? "Present (login shell)" : "Absent"}</span>
            <Tooltip label={`Remove ${name} from future agent launches`}>
              <button type="button" className="btn btn-ghost btn-danger-ghost" aria-label={`Delete ${name}`}
                disabled={saving} onClick={() => void save(settings.names.filter((item) => item !== name))}>Delete</button>
            </Tooltip>
          </li>
        ))}</ul>
      ) : <p className="settings-hint">No variables configured.</p>)}
    </section>
  );
}
