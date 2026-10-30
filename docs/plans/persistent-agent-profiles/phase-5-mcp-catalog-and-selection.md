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
- A daemon-private, immutable MCP snapshot per run, taken at launch and used on every resume.
- A typed `residentMcp` launch field beside Mission's own descriptor, and a scoped launcher that
  delivers each secret only to its own server.
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
- Child environments are built in `src/server/agent-subprocess-env.ts`. Whatever enters the
  agent's environment is inherited by its shells and tools, and Codex's environment-reference
  fields (`env_vars`, `bearer_token_env_var`, `env_http_headers`) read that same environment.
- `SdkLaunchOptions.mcp` (`src/server/harness/types.ts`) is `MissionMcpDescriptor | null`,
  Mission's single descriptor, rendered by both drivers. `codexMissionMcpArgs()` interpolates
  `mcp_servers.<serverName>` into dotted `-c` paths, which is safe only for Mission's fixed name.
- Credential precedent: the managed Pipeline caller credential in `src/server/mission-mcp.ts` is
  written to an owner-only file, created with the exclusive `wx` flag and holding the credential
  and its expiry, and only the file's path is handed to the MCP server.
- Inherited: Phase 1 registries; Phase 4 `SdkLaunchOptions` extension and capability pattern.

## Implementation steps

1. **Probe, then build what passes**, with the same rules as Phase 4.
   - Claude, selected only: the SDK's strict MCP option. Fallback: `--strict-mcp-config` (present
     in Claude Code 2.1.310) through the SDK's extra-arguments option.
   - Codex, pinning the run's set, whether inherit is on or off: an isolated per-run
     configuration, built from Phase 4's launch-scoped `CODEX_HOME` overlay, whose generated
     `config.toml` takes its MCP servers only from the snapshot (step 6). Another mechanism may
     replace it only if it passes the same probe. The probe is an exact-set check on a real
     installation:
     - native fixture servers are placed in every configuration source Codex would otherwise
       load: the user configuration, project configuration in the run's working directory, and
       any system or managed configuration;
     - one fixture is added after launch, and one snapshot server's native entry later gains an
       argument, an environment variable and a header;
     - each fixture server is a stdio command that records when it starts, so the check
       observes loading itself rather than a reported list;
     - the check passes only if, at launch and on resume, the app-server starts exactly the
       snapshot servers plus Mission's own, each with exactly its snapshot definition;
     - the overlay must also keep authentication, user instructions, every non-MCP setting and
       the session files Mission Control reads, as Phase 4's probe requires.
     If any source can still add a server or a field, the check fails and the operator gate
     below applies. Until the check passes, no Codex MCP selection or pinning ships, and the
     editor offers none.
   - Secrets, both harnesses: a secret value reaches only the MCP server process it belongs to,
     never the agent's environment. The candidate is Mission's scoped launcher (step 6).
     - Native environment references (Codex `env_vars`, `bearer_token_env_var` and
       `env_http_headers`, Claude `${VAR}` expansion) read the agent's own environment, so they
       do not qualify.
     - Literal values in a native server entry would put the secret in a configuration file
       or on a command line, so they do not qualify either.
     - The probe uses a fixture server that reports its own environment and headers. Each
       secret must reach its own server, stdio or HTTP. It must not reach the agent process's
       environment, a shell command the agent runs, an unrelated MCP server, any process
       argument, any generated configuration file, the logs or the transcript. A sentinel
       launch ticket is checked the same way, and may appear only in its credential file.
     - If the launcher fails for a harness, the operator gate below applies before any
       secret-bearing server is offered for that harness. There is no broad-environment
       fallback.
   Record an `McpSelectionSpec` in `HARNESS_CAPABILITIES`. **If both fail for a cell, stop before
   building it** and ask the operator with `request_input`, as in Phase 4.
2. **Global catalog** in `src/server/residents/mcp-catalog.ts`: Claude user-scope `mcpServers`
   from `~/.claude.json`, Codex `codex mcp list --json` through `ExecutableLocator`; hide
   `mission-control`; cached with an explicit refresh; `GET /api/residents/mcp-catalog`. The
   catalog projects each global server to allowlisted metadata only: name, transport, the
   command's basename or the URL's origin, and the names, never the values, of its environment
   variables and headers. At launch the daemon copies the kept global definitions and values
   from the harness's own configuration into the run's snapshot (step 5). They never reach a
   browser payload, a log or a process argument.
3. **Custom servers**: tables with a revision counter; transports `stdio` (command, args, env)
   and `http` (url, headers); applicable harnesses; name unique and never `mission-control`.
   A custom server's name may not equal a global server's name on any applicable harness.
   The check runs at save, and again at launch (step 5).
   Fields marked secret are stored only in `resident_mcp_secrets`, accepted on write, never
   returned (reads show "set" or "not set"). CRUD routes with `parseBody`. Backup domain for
   definitions only.
4. **Profile section** `mcp` and `ResidentMcpSection`: picker grouped by global and custom,
   inherit switch offered exactly where step 1 recorded a working mechanism, harness mismatch
   refused at save.
5. **Run snapshot**: at launch the `mcp` contributor resolves the run's effective MCP set once,
   keyed by (`source`, `name`). The source is either the harness's global configuration or
   Mission's custom servers.
   - The set holds every inherited global server when inherit is on, each selected global
     server, and each selected custom server.
   - A selected global server that is also inherited appears once.
   - A custom and a global server with the same runtime name refuse the launch with the
     reason, and so does the name `mission-control`. Nothing is renamed.
   - These checks run before the snapshot is written and before any secret is bound, so each
     secret is bound to its (`source`, `name`), never to a bare name.
   - Mission's own server is excluded, because it is attached fresh at every start.
   - Definitions go to `resident_run_mcp_servers` (`run_id`, source, server name, transport and
     the non-secret definition). Every secret value goes to `resident_run_mcp_secrets`
     (`run_id`, source, server, field, value), a daemon-private table with the same rules as
     `resident_mcp_secrets`: never returned by a route, published over SSE, captured by a
     settings backup, written to a log, or placed in a process argument.
   - Global values come from the harness's own configuration at launch, custom values from
     `resident_mcp_secrets`. Both are copied, so the run no longer depends on either source.
     Every environment and header value of a global server is treated as a secret, because
     native configuration does not mark which ones are.
   - Every launch and every resume takes MCP definitions, values and secrets from the snapshot
     alone, through the mechanism step 1 recorded, and never from native MCP configuration.
   - Inherit on means the snapshot holds every global server present at launch. A global server
     added later never joins the run, whether inherit is on or off.
   - Where step 1 recorded no working mechanism for a harness, that harness's set cannot be
     pinned, and the step 1 operator gate decides before it ships.
   - Editing a profile, adding, editing or deleting a global or custom server, or changing a
     secret, never touches an existing snapshot. The next launch, or **Restart on new
     profile**, resolves a new one.
   - The snapshot rows are removed when the run ends, through the same path that removes the
     Phase 4 skill snapshot.
6. **Rendering**: the `mcp` contributor fills a new optional `residentMcp` field on
   `SdkLaunchOptions` from the run's snapshot alone, at launch and on every resume, whether
   inherit is on or off. The existing `mcp` field keeps its meaning, Mission's single
   `MissionMcpDescriptor`, and is never overwritten or reused.
   - `residentMcp` is a typed list in `src/server/harness/types.ts`. Each entry has a runtime
     name and one of three shapes:
     - `stdio`: command, arguments and non-secret environment;
     - `http`: URL and non-secret headers;
     - `launcher`: a secret-bearing server, started through the scoped launcher below.
     No entry carries a secret value.
   - Each driver composes Mission's descriptor, through its existing path, with every
     `residentMcp` entry. The two never share a name, because step 5 refuses
     `mission-control`.
   - **Scoped launcher.** A `launcher` entry runs Mission's own runtime. Its arguments, and the
     generated configuration, carry only non-secret identifiers: the run id, the server's
     runtime name and the path of a credential file.
     - For each app-server start, the daemon writes one credential file per launcher entry in
       the run's private directory, following the credential precedent above. The file is
       owner-only, created with `wx`, and holds a single-use ticket and its expiry. The ticket
       is bound to that run, that server and that start, and expires within seconds.
     - The launcher reads the file, removes it, and redeems the ticket over the daemon's
       private authenticated channel. The daemon marks the ticket spent and answers with that
       server's secret values alone.
     - For a stdio server, the launcher starts it with the values in that server's
       environment only. For an HTTP server, it acts as a stdio bridge that adds the secret
       headers itself.
     - A missing, spent or expired ticket starts nothing. Every start writes new files. The
       daemon removes any unredeemed file once its ticket expires, and again at startup.
     - Ticket bytes never enter the agent's environment, a process argument, the generated MCP
       configuration, a log or the transcript.
   - Claude adds Mission's server and every `residentMcp` entry to `options.mcpServers` and sets
     `strictMcpConfig`, so the native configuration is never read for the run.
   - Codex starts every resident app-server with `CODEX_HOME` set to the run's overlay. Each
     start generates the overlay's `config.toml` from the operator's configuration, keeping
     every setting except MCP servers and the skill configuration Phase 4 replaces. The native
     MCP table is discarded, never copied, rendered or logged.
   - The overlay's MCP table is written from `residentMcp` through a TOML serializer, never by
     string interpolation, with every server name as a quoted key, so a name such as `foo.bar`
     stays one server. The file holds no secret value and no launch ticket, because
     secret-bearing servers appear only as launcher entries naming a credential file. It is
     written owner-only and removed with the run, and startup removes any overlay left by a run
     that has ended.
   - The complete MCP set is therefore fixed in the configuration Codex reads before any server
     loads. No server outside the snapshot can start, including one added after launch, and no
     native field merges into a snapshot server. This holds only as far as the step 1
     exact-set check measured it.
   - Mission's own server is always attached.
   - The boundary is what the agent is handed: its environment, arguments, configuration files
     and transcript. A credential file's path is metadata, not a secret. Mission Control does
     not claim an operating-system sandbox against a process that runs as the same user as the
     daemon, which could read an owner-only file.
7. **Rail**: a **Custom MCP servers** entry on `#/residents` with an editor whose secret fields are
   write-only.
8. **Documentation**: `docs/residents.md` and `docs/security.md` (secret storage, run snapshots
   and the argv rule).

## Tests and verification

- Unit: catalog parsing for both harnesses, a catalog payload containing no environment or
  header value from either harness's fixture configuration, custom server validation, secret
  write-only reads, backup excludes secrets, and rendering per harness.
- Effective-set tests:
  - a global server that is both inherited and selected appears once in the snapshot;
  - a custom server named like a global server of an applicable harness is refused at save.
    It is refused again at launch when the global server appeared after the save. A server
    named `mission-control` is refused;
  - when a custom and a global server both have a secret under the same field name, each
    secret stays bound to its own (`source`, `name`).
- Launch-contract tests: at launch and on resume, `residentMcp` and Mission's `mcp` descriptor
  compose into exactly Mission's server plus the snapshot servers, for each harness. Mission's
  descriptor is never replaced. A dotted name such as `foo.bar` renders as one server for both
  harnesses.
- Secret-scope tests, for a stdio and an HTTP server on each harness, with sentinel values for
  both the MCP secrets and the launch tickets:
  - each MCP secret reaches only its own server;
  - neither kind of sentinel appears in the agent process's environment, a shell command the
    agent runs, an unrelated MCP server's environment, any process argument, the generated
    configuration, the logs or the transcript;
  - a ticket sentinel appears only in its credential file. The file is owner-only, removed by
    the launcher when read, and removed by the daemon once expired and at startup if never
    redeemed;
  - a missing, spent or expired ticket starts nothing.
- Generated-configuration tests: the overlay's `config.toml`, generated from a snapshot whose
  servers carry secrets, contains none of their values and no launch ticket, and is owner-only.
  It is removed when the run ends, and an overlay left by a run that ended during a crash is
  removed at startup.
- Run snapshot tests, each followed by a daemon restart and resume:
  - editing, and separately deleting, a selected custom server;
  - editing, and separately removing, an inherited or selected global server in the harness's
    native configuration;
  - adding a new global server to the harness's native configuration after launch, for an
    inherit-on run and for a selected-only run. The new server is never started;
  - adding an argument, an environment variable and a header to the native entry of a server
    in the snapshot. The run renders exactly its snapshot definition, with none of the new
    fields;
  - changing a custom server's secret, and a global server's environment or header value;
  - editing the profile's MCP selection.
  Each leaves the run's rendered MCP set and secret values identical to launch, and never makes
  restore fail. The next launch adopts every change. Snapshot definitions and secret values
  never appear in a browser payload, SSE event, settings backup, log line or process argument.
  A generated Codex `config.toml` is checked against a native fixture whose servers carry
  secret values: none of them reaches the overlay, the argv, a log or a payload.
- Harness tests against real installations for every capability recorded as supported,
  including the step 1 Codex exact-set check and secret-scope check, saved as fixtures.
- Playwright `e2e/specs/residents-mcp.spec.ts`: define a custom server with a secret, confirm the
  secret is never shown again, select it on a profile, and see it in the launch summary;
  `expectContentClearsBorder` for the server editor if it is a modal.
- `npm run typecheck`, `npm run lint`, `npm run build`, `npm run test:e2e`.

## Exit criteria

Selected MCP servers are attached to launched residents per the measured capabilities. No
secret appears in a browser payload, backup, process argument, configuration file or the
agent's environment, and each secret reaches only its own server.

## Downstream handoff

The catalog, custom-server store and secret rules are stable for any later consumer.

## Cross-phase audit record

- Depends on Phase 4 to keep driver-renderer edits serial; concurrent with Phases 2, 3, 6 and 7.
- Phase 3's Codex compaction override and this phase's MCP overrides are separate contributors.
- Repair round 1: selected-only uses a probed primary or fallback mechanism with an operator gate,
  and rendering on resume reads the pinned revision.
- Pull request review (CodeRabbit): the global catalog is redacted to allowlisted metadata, and
  secret headers use `env_http_headers` for Codex and `${VAR}` references for Claude.
- Pull request review (Inspector, round 2): each run renders from a daemon-private MCP snapshot
  of its resolved servers and secrets, taken at launch, so later edits, deletions and secret
  changes never alter or break a live run.
- Pull request review (Inspector, round 4): a global server added after launch never joins a
  live run. Codex runs use an isolated per-run configuration whose MCP set comes only from the
  snapshot. The set is advertised as pinned only once an exact-set check, which observes which
  servers actually start across every Codex configuration source, passes on a real
  installation; otherwise the operator gate applies. Tests cover a server added after launch
  and a native entry that gains fields.
- Pull request review (CodeRabbit, third batch):
  - the effective set is keyed by (`source`, `name`), with duplicates collapsed and name
    collisions refused before any secret is bound;
  - a typed `residentMcp` field composes with Mission's unchanged `mcp` descriptor;
  - secrets reach only their own server through a probed scoped launcher, replacing the
    environment-reference route, which exposed them to the agent's environment. The
    launcher's single-use ticket travels in an owner-only credential file, never in arguments,
    configuration, the environment, logs or the transcript;
  - the overlay is serialized with quoted keys and holds no secret value.
