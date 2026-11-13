import { Overlay, OVERLAY_IDS } from "../components/Overlay.tsx";
import { Tooltip } from "../components/Tooltip.tsx";

/**
 * Confirm giving a resident's pinned MCP set up for everything its harness loads natively.
 *
 * Asked once, when the operator turns the option on, because it is the one MCP choice that widens
 * what an autonomous, looping agent can reach: every connector's account-level access, outside
 * the snapshot, the connect check and the scoped launcher. Turning it off needs no confirmation.
 */
export function McpAllSourcesConfirm({
  harness,
  sources,
  onConfirm,
  onClose,
}: {
  /** The harness's display name, such as Claude Code. */
  harness: string;
  /** What the harness loads on its own (`AllNativeMcpSourcesSpec.sources`). */
  sources: string;
  onConfirm: () => void;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <Overlay
      id={OVERLAY_IDS.residentMcpAllSources}
      onClose={onClose}
      className="modal resident-mcp-all-confirm"
      role="dialog"
      ariaLabel="Import all native MCP sources"
      ariaModal
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onConfirm();
        }}
      >
        <header className="modal-head">
          <h2 tabIndex={-1} autoFocus>Import all native MCP sources</h2>
          <Tooltip label="Keep the pinned set and close (Escape)">
            <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
              ✕
            </button>
          </Tooltip>
        </header>
        <div className="modal-body resident-mcp-all-body">
          <p>
            This resident will start with everything {harness} loads on its own: its {sources}, beside
            Mission Control's server and any custom server you select. The set is no longer pinned.
          </p>
          <ul>
            <li>
              <strong>Not frozen.</strong> A server or connector added, changed or removed natively
              reaches the resident at its next start or resume.
            </li>
            <li>
              <strong>Not checked.</strong> Only Mission Control's server and your custom servers must
              connect before it starts. A native server that fails or needs a login does not stop it.
            </li>
            <li>
              <strong>Broader reach.</strong> An autonomous, looping resident can use every connector's
              account-level access, such as sending Slack messages as you.
            </li>
            <li>
              <strong>Not isolated.</strong> Native servers and connectors use {harness}'s own
              configuration and stored logins, not Mission Control's scoped launcher.
            </li>
          </ul>
        </div>
        <footer className="modal-foot">
          <span className="actions-spacer" />
          <Tooltip label="Keep the pinned MCP set">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Cancel
            </button>
          </Tooltip>
          <Tooltip label={`Start this resident on everything ${harness} loads natively`}>
            <button type="submit" className="btn btn-primary">
              Import all sources
            </button>
          </Tooltip>
        </footer>
      </form>
    </Overlay>
  );
}
