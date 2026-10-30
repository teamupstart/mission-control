# Phase 5: MCP catalog and per-profile MCP servers

Part of [the phased plan](phased-plan.md) for [Residents](plan.md).

## Outcome

A resident profile chooses MCP servers from its harness's global servers and from custom servers
defined in Mission Control, and can either add them to the harness defaults or use only its
selection. Custom-server secrets are write-only and never reach the browser, backups or a command
line.

## Entry criteria and dependencies

- Phase 4 merged (the launch-option extension and capability pattern).

## Scope

- Global MCP catalog read per harness.
- Custom MCP servers: `resident_mcp_servers` and write-only `resident_mcp_secrets`, routes and a
  backup domain without secrets.
- Profile section `mcp`: `inheritDefaults` (default on) and `selected` server refs.
- Per-harness MCP rendering and measured isolation capability.
- Custom MCP servers UI on the resident page rail and the MCP picker in the editor.

### Non-goals

Writing to `~/.claude.json` or Codex configuration; Pi (no MCP client).

## Repository findings and inherited contracts

- Launches attach only Mission Control's server: `options.mcpServers` in
  `src/server/harness/claude/sdk.ts`, `codexMissionMcpArgs()` in `src/server/mission-mcp.ts`;
  `strictMcpConfig` is never passed. Only Mission's own entry is read today
  (`src/main/migration-integration-config.ts`).
- Secrets precedent: `telemetry_secrets` (`src/server/telemetry/store.ts`), excluded from
  `app_config` and backups (`src/shared/app-config-entries.ts`).
- Child environments are built in `src/server/agent-subprocess-env.ts`.
- Inherited: Phase 1 registries; Phase 4 `SdkLaunchOptions` extension and capability pattern.

## Implementation steps

1. **Probe, then build what passes**, with the same rules as Phase 4.
   - Claude, selected only: the SDK's strict MCP option. Fallback: `--strict-mcp-config` (present
     in Claude Code 2.1.310) through the SDK's extra-arguments option.
   - Codex, selected only: a per-server disable override through `-c` for each unselected global
     server. Fallback: Phase 4's launch-scoped `CODEX_HOME` overlay, whose generated
     `config.toml` lists only the selected servers.
   - Codex secrets, all present in Codex 0.160.0: `env_vars` forwards stdio environment values,
     `bearer_token_env_var` carries a bearer token, and `env_http_headers` carries any other
     secret header from an environment variable. Literal `http_headers` carry only non-secret
     headers. A secret field with no environment-backed mapping is refused at save, and no
     secret value is ever placed in `-c` or another process argument.
   - Claude secrets: MCP server environment and header values written as `${VAR}` references
     and expanded from the child environment, so the MCP configuration the SDK serializes for
     the CLI never carries a value.
   Record an `McpSelectionSpec` in `HARNESS_CAPABILITIES`. **If both fail for a cell, stop before
   building it** and ask the operator with `request_input`, as in Phase 4.
2. **Global catalog** in `src/server/residents/mcp-catalog.ts`: Claude user-scope `mcpServers`
   from `~/.claude.json`, Codex `codex mcp list --json` through `ExecutableLocator`; hide
   `mission-control`; cached with an explicit refresh; `GET /api/residents/mcp-catalog`. The
   catalog projects each global server to allowlisted metadata only: name, transport, the
   command's basename or the URL's origin, and the names, never the values, of its environment
   variables and headers. At launch the daemon reads kept global values from the harness's own
   configuration straight into the child environment; they never reach a browser payload, a
   log or a process argument.
3. **Custom servers**: tables with a revision counter; transports `stdio` (command, args, env)
   and `http` (url, headers); applicable harnesses; name unique and never `mission-control`.
   Fields marked secret are stored only in `resident_mcp_secrets`, accepted on write, never
   returned (reads show "set" or "not set"). CRUD routes with `parseBody`. Backup domain for
   definitions only.
4. **Profile section** `mcp` and `ResidentMcpSection`: picker grouped by global and custom,
   inherit switch offered exactly where step 1 recorded a working mechanism, harness mismatch
   refused at save.
5. **Rendering**: an `mcp` contributor and an optional `mcp` field on `SdkLaunchOptions`:
   Claude adds entries to `options.mcpServers` whose secret values are `${VAR}` references, with
   the values in the child environment, and with inherit off sets
   `strictMcpConfig` and copies kept global servers in; Codex renders `-c mcp_servers.<name>.*`
   with secrets supplied as child environment variables referenced by name, and with inherit
   off disables unselected global servers (or uses the overlay). Mission's own server is always
   attached. Rendering reads the run's pinned revision at launch and again on resume.
6. **Rail**: a **Custom MCP servers** entry on `#/residents` with an editor whose secret fields are
   write-only.
7. **Documentation**: `docs/residents.md` and `docs/security.md` (secret storage and argv rule).

## Tests and verification

- Unit: catalog parsing for both harnesses, a catalog payload containing no environment or
  header value from either harness's fixture configuration, custom server validation, secret
  write-only reads, a secret header rendered through `env_http_headers` for Codex and a `${VAR}`
  reference for Claude, a secret field without an environment-backed mapping refused at save,
  backup excludes secrets, rendering per harness, and a test that inspects the composed argv and
  fails if any secret value appears in it.
- Harness tests against real installations for every capability recorded as supported.
- Playwright `e2e/specs/residents-mcp.spec.ts`: define a custom server with a secret, confirm the
  secret is never shown again, select it on a profile, and see it in the launch summary;
  `expectContentClearsBorder` for the server editor if it is a modal.
- `npm run typecheck`, `npm run lint`, `npm run build`, `npm run test:e2e`.

## Exit criteria

Selected MCP servers are attached to launched residents per the measured capabilities, and no
secret appears in a browser payload, backup or process argument.

## Downstream handoff

The catalog, custom-server store and secret rules are stable for any later consumer.

## Cross-phase audit record

- Depends on Phase 4 to keep driver-renderer edits serial; concurrent with Phases 2, 3, 6 and 7.
- Phase 3's Codex compaction override and this phase's MCP overrides are separate contributors.
- Repair round 1: selected-only uses a probed primary or fallback mechanism with an operator gate,
  and rendering on resume reads the pinned revision.
- Pull request review (CodeRabbit): the global catalog is redacted to allowlisted metadata, and
  secret headers use `env_http_headers` for Codex and `${VAR}` references for Claude.
