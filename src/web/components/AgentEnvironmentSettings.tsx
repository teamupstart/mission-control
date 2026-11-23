import { useEffect, useState } from "react";
import { AgentEnvironmentConfigSchema } from "@shared/protocol.ts";
import type { WorktreeClaimVariableView } from "@shared/worktrees.ts";
import { api, fetchAgentEnvironment } from "../lib/api.ts";

export function AgentEnvironmentSettings() {
  const [variables, setVariables] = useState<WorktreeClaimVariableView[] | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    void fetchAgentEnvironment().then((result) => {
      if (!current) return;
      if (!result) { setError("Could not read agent environment settings."); return; }
      setVariables(result.variables);
      setDraft(result.variables.map((v) => v.name).join("\n"));
    });
    return () => { current = false; };
  }, []);

  async function save() {
    const config = AgentEnvironmentConfigSchema.safeParse({ names: draft.split(/\s+/).filter(Boolean) });
    if (!config.success) {
      setError("Enter up to 32 unique variable names. Assignments and reserved names are unavailable.");
      return;
    }
    setError("");
    setSaving(true);
    const result = await api.setAgentEnvironment(config.data.names);
    setSaving(false);
    if (result.ok && result.variables) setVariables(result.variables);
    else setError("Could not save agent environment settings.");
  }

  return (
    <section className="agent-environment-settings" aria-label="Agent environment" data-anchor="harnesses/agent-environment">
      <h4>Agent environment</h4>
      <p className="settings-hint">New sessions on this machine read each name from the daemon, then the login shell. Residents use their own secrets.</p>
      <label className="kb-row-label">Variable names (one per line)
        <textarea className="si-textarea" disabled={!variables || saving} value={draft} rows={3} spellCheck={false}
          onChange={(event) => setDraft(event.target.value)} />
      </label>
      <div className="si-actions"><button className="btn" type="button" disabled={!variables || saving} onClick={() => void save()}>
        {saving ? "Saving…" : "Save variable names"}
      </button></div>
      {error && <p role="alert" className="settings-error">{error}</p>}
      {!!variables?.length && <ul aria-label="Variable status">{variables.map(({ name, source }) => (
        <li key={name}><code>{name}</code> <span>{source === "daemon" ? "Present (daemon)" : source === "loginShell" ? "Present (login shell)" : "Absent"}</span></li>
      ))}</ul>}
    </section>
  );
}
