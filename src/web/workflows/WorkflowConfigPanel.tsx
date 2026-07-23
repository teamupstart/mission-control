import { useEffect, useRef, useState } from "react";
import type { WorkflowConfig } from "@shared/workflow.ts";
import { resolveRepo } from "../lib/api.ts";
import { Tooltip } from "../components/Tooltip.tsx";
import { workflowRequest } from "./workflowApi.ts";

export function WorkflowConfigPanel(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [config, setConfig] = useState<WorkflowConfig | null>(null);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const configRef = useRef(config);
  configRef.current = config;

  useEffect(() => {
    void workflowRequest<WorkflowConfig>("/api/workflows/config")
      .then(setConfig)
      .catch((caught) => setError(caught instanceof Error ? caught.message : "Could not load Workflow settings"));
  }, []);

  const save = async (next: WorkflowConfig): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setConfig(await workflowRequest<WorkflowConfig>("/api/workflows/config", {
        method: "PUT",
        body: JSON.stringify(next),
      }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save Workflow settings");
    } finally {
      setBusy(false);
    }
  };

  const add = async (): Promise<void> => {
    const current = configRef.current;
    if (!current || !path.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const resolved = await resolveRepo(path.trim());
      if (!resolved.ok) {
        setError(resolved.error);
        return;
      }
      if (current.repoAllowlist.includes(resolved.repoRoot)) {
        setError(`${resolved.repoRoot} is already allowlisted`);
        return;
      }
      setPath("");
      await save({ ...current, repoAllowlist: [...current.repoAllowlist, resolved.repoRoot] });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not resolve repository");
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className={`workflow-config-drawer${open ? " open" : ""}`}>
      <Tooltip label="Configure Live workflow delivery and its repository allowlist">
        <button className="btn btn-ghost" onClick={() => setOpen((value) => !value)}>
          {open ? "Close Workflow settings" : "Workflow settings"}
        </button>
      </Tooltip>
      {open && (
        <div className="workflow-config-panel">
          <h3>Live workflow delivery</h3>
          <p>
            Live mode can paste deterministic Persona repair instructions into allowlisted
            agent sessions. Preview remains read-only.
          </p>
          {!config ? <p>Loading settings…</p> : (
            <>
              <label>
                <Tooltip label="Globally allow Live delivery for repositories listed below">
                  <input
                    type="checkbox"
                    checked={config.liveEnabled}
                    disabled={busy}
                    onChange={(event) => {
                      const enabled = event.target.checked;
                      if (
                        enabled
                        && !window.confirm(
                          "Enable Live workflow delivery? Mission Control may paste repair prompts into sessions in the repositories below.",
                        )
                      ) return;
                      void save({ ...config, liveEnabled: enabled });
                    }}
                  />
                </Tooltip>
                Enable Live workflow delivery
              </label>
              <h4>Allowed repositories</h4>
              {config.repoAllowlist.length === 0
                ? <p>No repositories are allowed.</p>
                : (
                  <ul>
                    {config.repoAllowlist.map((repo) => (
                      <li key={repo}>
                        <code>{repo}</code>
                        <Tooltip label="Remove this repository from the Live delivery allowlist">
                          <button
                            className="btn btn-ghost"
                            disabled={busy}
                            onClick={() => void save({
                              ...config,
                              repoAllowlist: config.repoAllowlist.filter((item) => item !== repo),
                            })}
                          >
                            Remove
                          </button>
                        </Tooltip>
                      </li>
                    ))}
                  </ul>
                )}
              <div>
                <input
                  value={path}
                  disabled={busy}
                  placeholder="/path/to/repository"
                  onChange={(event) => setPath(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void add();
                  }}
                />
                <Tooltip label="Resolve this path and allow its repository to receive Live repairs">
                  <button className="btn" disabled={busy || !path.trim()} onClick={() => void add()}>
                    Add repository
                  </button>
                </Tooltip>
              </div>
            </>
          )}
          {error && <p className="persona-error" role="alert">{error}</p>}
        </div>
      )}
    </aside>
  );
}
