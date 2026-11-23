import { useState } from "react";
import { AGENT_IDENTITY } from "@shared/agent.ts";
import type {
  CreateResidentMcpServer,
  ResidentMcpCustomServerView,
  ResidentMcpFieldInput,
  ResidentMcpGlobalServer,
} from "@shared/resident-mcp.ts";
import { RESIDENT_AGENTS, type ResidentAgent } from "@shared/residents.ts";
import { Tooltip } from "../components/Tooltip.tsx";
import { createResidentMcpServer, deleteResidentMcpServer, updateResidentMcpServer } from "./api.ts";
import { useResidentMcpCatalog } from "./mcp-catalog.ts";

/** One environment variable, header or query parameter being edited. */
interface FieldDraft {
  key: string;
  name: string;
  value: string;
  secret: boolean;
  /** A secret the server already holds: a blank value keeps it. Never the value itself. */
  stored: boolean;
}

interface ServerDraft {
  id: string | null;
  revision: number | null;
  name: string;
  harnesses: ResidentAgent[];
  type: "stdio" | "http";
  command: string;
  args: string;
  env: FieldDraft[];
  url: string;
  query: FieldDraft[];
  headers: FieldDraft[];
}

let fieldKeys = 0;
const field = (partial: Partial<FieldDraft> = {}): FieldDraft => ({
  key: `field-${fieldKeys++}`,
  name: "",
  value: "",
  secret: false,
  stored: false,
  ...partial,
});

function blankDraft(): ServerDraft {
  return {
    id: null,
    revision: null,
    name: "",
    harnesses: [...RESIDENT_AGENTS],
    type: "stdio",
    command: "",
    args: "",
    env: [],
    url: "",
    query: [],
    headers: [],
  };
}

/** Open a stored server for editing. Secret fields arrive as names and "set", never values. */
function draftFrom(server: ResidentMcpCustomServerView): ServerDraft {
  const fields = (rows: Extract<ResidentMcpCustomServerView["transport"], { type: "stdio" }>["env"]) =>
    rows.map((row) => row.secret
      ? field({ name: row.name, secret: true, stored: row.set })
      : field({ name: row.name, value: row.value }));
  const base = { ...blankDraft(), id: server.id, revision: server.revision, name: server.name, harnesses: [...server.harnesses] };
  return server.transport.type === "stdio"
    ? { ...base, type: "stdio", command: server.transport.command, args: server.transport.args.join("\n"), env: fields(server.transport.env) }
    : {
        ...base,
        type: "http",
        url: server.transport.url,
        query: server.transport.query.map((row) => field({ name: row.name, secret: true, stored: row.set })),
        headers: fields(server.transport.headers),
      };
}

function fieldInputs(rows: readonly FieldDraft[]): ResidentMcpFieldInput[] {
  return rows
    .filter((row) => row.name.trim())
    .map((row) => row.secret
      ? { name: row.name.trim(), secret: true, ...(row.value ? { value: row.value } : {}) }
      : { name: row.name.trim(), secret: false, value: row.value });
}

function draftInput(draft: ServerDraft): CreateResidentMcpServer {
  const transport: CreateResidentMcpServer["transport"] = draft.type === "stdio"
    ? {
        type: "stdio",
        command: draft.command.trim(),
        args: draft.args.split("\n").map((line) => line.trim()).filter(Boolean),
        env: fieldInputs(draft.env),
      }
    : {
        type: "http",
        url: draft.url.trim(),
        query: draft.query.filter((row) => row.name.trim()).map((row) => ({ name: row.name.trim(), ...(row.value ? { value: row.value } : {}) })),
        headers: fieldInputs(draft.headers),
      };
  return { name: draft.name.trim(), harnesses: draft.harnesses, transport };
}

function FieldRows({
  label,
  rows,
  onChange,
  alwaysSecret = false,
  namePlaceholder,
  disabled,
}: {
  label: string;
  rows: readonly FieldDraft[];
  onChange: (rows: FieldDraft[]) => void;
  alwaysSecret?: boolean;
  namePlaceholder: string;
  disabled: boolean;
}): React.JSX.Element {
  const set = (index: number, patch: Partial<FieldDraft>): void =>
    onChange(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  return (
    <fieldset className="resident-mcp-fields">
      <legend className="field-label">{label}</legend>
      {rows.map((row, index) => {
        const secret = alwaysSecret || row.secret;
        return (
          <div className="resident-mcp-field-row" key={row.key}>
            <input
              className="field-input"
              aria-label={`${label} ${index + 1} name`}
              value={row.name}
              placeholder={namePlaceholder}
              disabled={disabled}
              onChange={(event) => set(index, { name: event.target.value, stored: false })}
            />
            <Tooltip label={secret ? "Write-only: once saved it is never shown again; leave blank to keep a value already set" : "Stored and backed up as written"}>
              <input
                className="field-input"
                aria-label={`${label} ${index + 1} value`}
                type={secret ? "password" : "text"}
                autoComplete="off"
                value={row.value}
                disabled={disabled}
                placeholder={secret ? (row.stored ? "Set - leave blank to keep" : "Not set") : "value"}
                onChange={(event) => set(index, { value: event.target.value })}
              />
            </Tooltip>
            {!alwaysSecret && (
              <label className="alert-row resident-mcp-secret">
                <Tooltip label="Write-only: stored on this machine, never shown again, never in a backup or on a command line">
                  <input
                    type="checkbox"
                    aria-label={`${label} ${index + 1} secret`}
                    checked={row.secret}
                    disabled={disabled}
                    onChange={(event) => set(index, { secret: event.target.checked, stored: false, value: "" })}
                  />
                </Tooltip>
                <span>Secret</span>
              </label>
            )}
            <Tooltip label={`Remove this ${label.toLowerCase()} entry`}>
              <button
                type="button"
                className="btn btn-quiet"
                aria-label={`Remove ${label} ${index + 1}`}
                disabled={disabled}
                onClick={() => onChange(rows.filter((_, at) => at !== index))}
              >
                Remove
              </button>
            </Tooltip>
          </div>
        );
      })}
      <Tooltip label={`Add another ${label.toLowerCase()} entry`}>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={disabled}
          onClick={() => onChange([...rows, field({ secret: alwaysSecret })])}
        >
          Add {label.toLowerCase()}
        </button>
      </Tooltip>
    </fieldset>
  );
}

function ServerEditor({
  initial,
  busy,
  onSave,
  onCancel,
}: {
  initial: ServerDraft;
  busy: boolean;
  onSave: (draft: ServerDraft) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(initial);
  const patch = (next: Partial<ServerDraft>): void => setDraft((current) => ({ ...current, ...next }));
  return (
    <form
      className="resident-mcp-editor"
      aria-label={initial.id ? `Edit ${initial.name}` : "New custom MCP server"}
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) onSave(draft);
      }}
    >
      <label className="field">
        <span className="field-label">Server name</span>
        <input
          className="field-input"
          value={draft.name}
          disabled={busy}
          placeholder="linear"
          onChange={(event) => patch({ name: event.target.value })}
        />
      </label>
      <fieldset className="resident-mcp-harnesses">
        <legend className="field-label">Applies to</legend>
        {RESIDENT_AGENTS.map((agent) => (
          <label key={agent} className="alert-row">
            <Tooltip label={`Offer this server to ${AGENT_IDENTITY[agent].label} residents`}>
              <input
                type="checkbox"
                checked={draft.harnesses.includes(agent)}
                disabled={busy}
                onChange={(event) => patch({
                  harnesses: event.target.checked
                    ? RESIDENT_AGENTS.filter((id) => id === agent || draft.harnesses.includes(id))
                    : draft.harnesses.filter((id) => id !== agent),
                })}
              />
            </Tooltip>
            <span>{AGENT_IDENTITY[agent].label}</span>
          </label>
        ))}
      </fieldset>
      <label className="field">
        <span className="field-label">Transport</span>
        <Tooltip label="A command Mission Control starts, or an HTTP URL it connects to">
          <select
            className="field-input"
            value={draft.type}
            disabled={busy || initial.id !== null}
            onChange={(event) => patch({ type: event.target.value as ServerDraft["type"] })}
          >
            <option value="stdio">stdio command</option>
            <option value="http">HTTP URL</option>
          </select>
        </Tooltip>
      </label>
      {draft.type === "stdio" ? (
        <>
          <label className="field">
            <span className="field-label">Command</span>
            <input
              className="field-input"
              value={draft.command}
              disabled={busy}
              placeholder="npx"
              onChange={(event) => patch({ command: event.target.value })}
            />
          </label>
          <label className="field">
            <span className="field-label">
              Arguments <span className="field-hint">one per line, stored and backed up as written</span>
            </span>
            <textarea
              className="field-input field-textarea resident-mcp-args"
              value={draft.args}
              disabled={busy}
              placeholder="-y&#10;@acme/mcp-server"
              onChange={(event) => patch({ args: event.target.value })}
            />
          </label>
          <FieldRows
            label="Environment variable"
            rows={draft.env}
            namePlaceholder="API_TOKEN"
            disabled={busy}
            onChange={(env) => patch({ env })}
          />
        </>
      ) : (
        <>
          <label className="field">
            <span className="field-label">
              URL <span className="field-hint">a query is stored as secret parameters below</span>
            </span>
            <input
              className="field-input"
              value={draft.url}
              disabled={busy}
              placeholder="https://mcp.example.com/mcp"
              onChange={(event) => patch({ url: event.target.value })}
            />
          </label>
          <FieldRows
            label="Query parameter"
            rows={draft.query}
            alwaysSecret
            namePlaceholder="key"
            disabled={busy}
            onChange={(query) => patch({ query })}
          />
          <FieldRows
            label="Header"
            rows={draft.headers}
            namePlaceholder="Authorization"
            disabled={busy}
            onChange={(headers) => patch({ headers })}
          />
        </>
      )}
      <p className="field-hint">
        Secret values are write-only. They stay on this machine, are never shown again, and never
        reach a backup, a command line or the agent: only this server's own process receives them.
      </p>
      <div className="resident-editor-actions">
        <Tooltip label="Discard these changes">
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={onCancel}>Cancel</button>
        </Tooltip>
        <Tooltip label="Save this custom MCP server">
          <button type="submit" className="btn" disabled={busy}>Save server</button>
        </Tooltip>
      </div>
    </form>
  );
}

function transportSummary(server: ResidentMcpCustomServerView): string {
  if (server.transport.type === "stdio") {
    const secrets = server.transport.env.filter((row) => row.secret).length;
    return `${server.transport.command}${secrets ? ` · ${secrets} secret ${secrets === 1 ? "value" : "values"}` : ""}`;
  }
  const secrets = server.transport.headers.filter((row) => row.secret).length + server.transport.query.length;
  return `${server.transport.url}${secrets ? ` · ${secrets} secret ${secrets === 1 ? "value" : "values"}` : ""}`;
}

function globalDetail(server: ResidentMcpGlobalServer): string {
  const where = server.commandBasename ?? server.urlOrigin ?? "";
  const names = [...server.envNames, ...server.headerNames];
  return [server.transport, where, names.length ? `uses ${names.join(", ")}` : ""].filter(Boolean).join(" · ");
}

/** `#/residents/mcp-servers`: custom servers, their write-only secrets, and the global catalog. */
export function ResidentMcpServersPanel(): React.JSX.Element {
  const { catalog, error: loadError, refresh, reload } = useResidentMcpCatalog();
  const [editing, setEditing] = useState<ServerDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (operation: () => Promise<unknown>, done?: () => void): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await operation();
      done?.();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const save = (draft: ServerDraft): void => {
    const input = draftInput(draft);
    void run(
      () => draft.id && draft.revision !== null
        ? updateResidentMcpServer(draft.id, { ...input, expectedRevision: draft.revision })
        : createResidentMcpServer(input),
      () => setEditing(null),
    );
  };
  return (
    <section className="resident-editor resident-mcp" aria-label="Custom MCP servers">
      <header className="resident-editor-head">
        <div>
          <p className="workflow-eyebrow">Resident resources</p>
          <h3>Custom MCP servers</h3>
          <p className="resident-editor-meta">
            {catalog ? `${catalog.custom.length} custom · ${catalog.harnesses.map((row) => `${row.servers.length} ${AGENT_IDENTITY[row.agent].label} global`).join(" · ")}` : "Loading MCP servers…"}
          </p>
        </div>
        <div className="resident-editor-actions">
          <Tooltip label="Read each harness's global MCP servers again">
            <button type="button" className="btn btn-ghost" disabled={busy || !catalog} onClick={() => { void run(refresh); }}>Refresh</button>
          </Tooltip>
          <Tooltip label="Define an MCP server residents can select">
            <button type="button" className="btn" disabled={busy || editing !== null} onClick={() => setEditing(blankDraft())}>New server</button>
          </Tooltip>
        </div>
      </header>
      <p className="resident-section-blurb">
        Servers Mission Control defines for residents, beside each harness's global servers. A profile
        selects them under MCP servers. Mission Control's own server is always attached.
      </p>
      {(error ?? loadError) && <p role="alert" className="resident-error">{error ?? loadError}</p>}
      {editing && (
        <ServerEditor
          key={editing.id ?? "new"}
          initial={editing}
          busy={busy}
          onSave={save}
          onCancel={() => { setEditing(null); setError(null); }}
        />
      )}
      <ul className="resident-source-list" aria-label="Custom MCP servers list">
        {catalog?.custom.map((server) => (
          <li key={server.id}>
            <div className="resident-source-heading">
              <strong>{server.name}</strong>
              <span className="resident-editor-meta">{server.harnesses.map((agent) => AGENT_IDENTITY[agent].label).join(", ")}</span>
              <Tooltip label={`Edit ${server.name}`}>
                <button type="button" className="btn btn-quiet" disabled={busy || editing !== null} aria-label={`Edit ${server.name}`} onClick={() => setEditing(draftFrom(server))}>Edit</button>
              </Tooltip>
              <Tooltip label={`Delete ${server.name}; running residents keep the copy they launched with`}>
                <button
                  type="button"
                  className="btn btn-quiet"
                  disabled={busy}
                  aria-label={`Delete ${server.name}`}
                  onClick={() => { void run(() => deleteResidentMcpServer(server.id, server.revision)); }}
                >
                  Delete
                </button>
              </Tooltip>
            </div>
            <code>{transportSummary(server)}</code>
          </li>
        ))}
        {catalog && catalog.custom.length === 0 && <li className="resident-section-blurb">No custom MCP servers yet.</li>}
      </ul>
      {catalog?.harnesses.map((row) => (
        <section key={row.agent} className="resident-section" aria-label={`${AGENT_IDENTITY[row.agent].label} global MCP servers`}>
          <h4>{AGENT_IDENTITY[row.agent].label} global servers</h4>
          {!row.selectable && <p className="resident-skill-notice">Residents on {AGENT_IDENTITY[row.agent].label} cannot choose MCP servers.</p>}
          {row.problem && <p role="alert" className="resident-skill-notice">{row.problem}</p>}
          {row.servers.length === 0 && !row.problem && <p className="resident-section-blurb">None configured.</p>}
          <ul className="resident-source-list">
            {row.servers.map((server) => (
              <li key={server.name}>
                <div className="resident-source-heading">
                  <strong>{server.name}</strong>
                  {!server.enabled && <span className="resident-editor-meta">disabled</span>}
                </div>
                <code>{globalDetail(server)}</code>
                {server.unavailable && <p className="resident-mcp-unavailable">Unavailable to residents: {server.unavailable}</p>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}
