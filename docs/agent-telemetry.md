# Agent telemetry

Agent telemetry covers the agents' own OpenTelemetry for sessions Mission Control runs on the
SDK runtime: logs, metrics and traces from Claude Code and Codex. When capture allows, it also
includes prompts, tool detail and responses. It is configured in **Settings > Agent telemetry**.
It is a third feature, separate from the two that already existed:

| Feature | Direction | Owner |
|---|---|---|
| Cost | Claude Code reports usage metrics into this daemon (`POST /v1/metrics`) | `src/server/cost.ts`, unchanged |
| Telemetry | Mission Control exports facts about itself | `src/server/telemetry/` |
| Agent telemetry | SDK sessions' own OTLP, relayed through this daemon to a gateway | `src/server/agent-otel/` |

## Design: a tee in the daemon

```text
Claude SDK session  --OTLP http/json, x-harness-token-->        +-----------------+
Codex app-server    --OTLP json, x-mission-otel-relay token-->  | daemon /v1/...  |
                                                                |  local answer   |--> usage ledger (metrics, harness token only)
                                                                |  copy of bytes  |--> bounded queue --> effective upstream /v1/<signal>
                                                                +-----------------+
```

- `POST /v1/metrics` answers exactly as before. A copy of the request bytes is queued first.
  The ledger parse is the same as before: unparseable bodies read as `{}` and the same loose
  schema applies, so the 400 and 200 answers are unchanged. The one addition is a 16 MiB body
  cap (413).
- `POST /v1/logs` and `POST /v1/traces` are new. They are guarded by the same token, answer
  `{}`, and only forward. Nothing local reads logs or traces.
- The forwarder (`agent-otel/relay.ts`) sends the raw bytes with their `content-type` and
  `content-encoding` unchanged. It is bounded: 64 queued exports, 64 MiB, 4 in flight and a
  10 s timeout. It does not follow redirects and does not retry.
- Two credentials can reach these routes:
  - Claude Code carries `x-harness-token`. It travels in env, never argv.
  - Codex carries `x-mission-otel-relay`, a per-process token that can only post OTLP for
    forwarding. Codex takes exporter headers only through `-c`, which is argv and visible to
    other processes, so the daemon token is never put there. A holder can submit arbitrary
    request bodies to these routes; when Settings supplies the destination, the relay attaches
    the operator's stored upstream headers. This capability permits telemetry injection at
    that configured gateway, but never local ledger writes or other daemon operations.
- The relay forwards every export these routes receive while a signal is on. That includes
  Cost-switch metrics from terminal Claude sessions.
- An upstream that targets this daemon is never forwarded to. Signal paths are appended to
  the URL pathname, preserving any query parameters and excluding fragments.

The relay answers locally regardless of what the upstream does. Upstream failures only
increment counters. The only error text recorded is an HTTP status, `timeout`, or an error code
such as `ECONNREFUSED`. Bodies, headers and URLs are never logged.

## Precedence

| Rank | Source | When | Settings |
|---|---|---|---|
| 1 | Device management (macOS) | A managed Claude Code `env` or a Codex `config_toml_base64` configures telemetry | Read-only, shows managed hostnames |
| 2 | Settings | Enabled, with a valid endpoint | Editable |
| 3 | Off | Otherwise (the default) | Editable |

When device management applies, its routing and capture switches become the effective policy.
An enabled Claude Code policy speaks for capture; a disabled one is ignored, and Codex's
capture applies. Codex's policy fills any signal Claude's does not route.
Stored Settings headers are never sent to a managed destination. They also stay with the
origin (scheme, host and port) they were saved for: saving another origin without new headers
removes them, and Settings warns before that save. Only OTLP/HTTP destinations
are reusable by the relay: console exporters and managed gRPC routes do not become HTTP
upstreams.

Every relay destination, from Settings or device management, must use HTTPS unless it is
loopback. This is stricter than Mission Control's own telemetry, which only warns about remote
plaintext, because agent telemetry can carry prompts, tool detail and responses. Settings
refuses to save such an endpoint. A managed remote plaintext route is not used by the relay,
though the managed agent still exports there directly. The relay checks the scheme again
immediately before each send. Managed agents still export directly using their own configured transport. When
no HTTP destination remains, the relay is shown as off even though its policy is managed.
Relay traffic triggers a background policy refresh, so existing sessions notice managed
routing changes without another launch or a Settings visit. An export already in flight
may still use the previous cached policy.

## Per harness

| Harness | Settings case (no MDM) | Own MDM present |
|---|---|---|
| Claude Code | Per-signal `OTEL_EXPORTER_OTLP_{LOGS,METRICS,TRACES}_{ENDPOINT,PROTOCOL,HEADERS}` point at the daemon (`http/json`, `x-harness-token`). Also sets `OTEL_*_EXPORTER=otlp`, `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1` for traces, and each `OTEL_LOG_*` capture switch that is on. | Nothing injected. Exports directly to the managed destination. |
| Codex | `-c otel.{exporter,metrics_exporter,trace_exporter}={otlp-http={endpoint=…,protocol="json",headers={"x-mission-otel-relay"=…}}}` on `codex app-server`, plus `otel.log_user_prompt` and `otel.log_agent_responses` when on. | Nothing injected. Exports directly to the managed destination. |
| Pi | Not plumbed. | Not applicable. |

Why Claude Code uses per-signal keys: the Cost switch writes the generic `OTEL_EXPORTER_OTLP_*`
keys into `~/.claude/settings.json`, and Claude Code applies settings `env` over the env it was
launched with. The per-signal keys are not overwritten and beat the generic ones. Both point at
the same daemon, so the two features agree.

Why Pi is not plumbed: Pi's SDK runs inside the daemon process. Its OTel extension reads
`~/.pi/agent/settings.json`, the project's `.pi/settings.json` and the daemon's `process.env`,
and keeps one OTel runtime per process. There is no per-session input. Mutating the daemon
environment or the operator's settings file would change every Pi session at once, so Pi keeps
whatever its installed extension is configured to do.

## When a managed policy wins

This is accepted behavior, and Mission Control does not work around it. Both agents apply their
managed policy above anything a launcher passes. This was checked against the shipped binaries:

- **Claude Code** (bundled CLI 0.3.310) applies `policySettings.env` after user, project and
  local settings. It then runs `enforceManagedOtelFamilyDominance`, which drops
  lower-precedence OTEL keys in any family the policy claims. This was tested empirically on
  Linux with `/etc/claude-code/managed-settings.d` routing to the gateway: per-signal endpoints
  passed in the launch env reached a local sink only when the managed directory was masked out.
- **Codex** (0.161.0) layers its configuration in this order: system, user, project, then
  session flags (`-c`), then the legacy managed file, then legacy managed MDM
  (`config_toml_base64`). Managed MDM sits above `-c`. This was tested empirically on Linux by
  adding `/etc/codex/managed_config.toml` through an overlay mount. Its exporter endpoints
  received the export and the `-c` endpoints did not, and without the file the `-c` endpoints
  received it. MDM ranks above that managed file.

Consequences:

- A managed agent exports straight to its managed destination, so the daemon's tee gets no copy.
- For Claude Code this also means the local cost loop (`/v1/metrics` into the usage ledger)
  receives nothing from those sessions. SDK sessions still record their own spend through the
  driver. Terminal sessions lose their cost data, and the existing Cost panel "redirect"
  warning already names the managed host for that case.
- Mission Control injects nothing for a managed agent. An injected value would be ignored at
  best, and Mission Control does not fight managed policy.

## Reading the managed policies

`agent-otel/managed.ts` reads both agents' policies. Both readers fail open: any read or parse
failure means "no managed policy", and launches are never blocked.

- **Claude Code**: reuses the Cost reader's precedence walk (`readManagedClaudeEnvKeys` in
  `environment/claude-managed.ts`). The locations are the per-user profile, the machine profile,
  then `managed-settings.json`. It keeps only routing and capture keys. `*_HEADERS` is never read. Routing includes the transport protocol, so an explicitly
  configured gRPC endpoint is not reused for the HTTP relay.
- **Codex**: `/Library/Managed Preferences/[<user>/]com.openai.codex.plist`, key
  `config_toml_base64`, decoded and read by a subset reader. The reader looks only inside
  `[otel…]` tables and skips everything else unread. If it cannot read an `otel` line, the
  answer is "no policy".
- **Off macOS**: both readers answer none without spawning `plutil`. The only exception is a
  fixture root named by `MISSION_MANAGED_SETTINGS_ROOT`, which tests use. Linux managed
  locations such as `/etc/claude-code` are not read. On such a machine Settings can report
  Claude as relayed while its own managed policy still wins.

## Operator-set OTEL environment

Mission Control does not scrub inherited `OTEL_*` variables. When relaying is off, SDK sessions
inherit them exactly as before. When relaying is on, the per-signal keys listed above are set
over the inherited values for Claude Code sessions. Settings lists the inherited variable names
so this override is visible. Capture switches are only ever turned on. An operator's own
`OTEL_LOG_*=1` is never turned off.

## Storage

- `app_config.agentTelemetry` stores enabled, endpoint, signals and capture. It is
  `operational` with no backup domain, because it is consent to send content off the machine.
- Headers live in the `agent_telemetry_headers` table. Only their names are ever returned. The
  relay reads the values when it sends.

## Verifying by hand

On a Mac with MDM:

1. Run `plutil -p "/Library/Managed Preferences/com.anthropic.claudecode.plist"` and check
   that the OTEL keys are present.
2. Open Settings > Agent telemetry. It should read "Managed by your organization", with Claude
   Code shown as Managed.
3. Start an SDK session and confirm the gateway receives its telemetry.
4. Local cost rows for that session come from the driver, not from `/v1/metrics`.

On Linux, or with no MDM:

1. Run a local sink, for example:
   `node -e 'require("http").createServer((q,s)=>{q.resume();q.on("end",()=>{console.log(q.url,q.headers["content-type"]);s.end("{}")})}).listen(4318)'`.
2. In Settings, set the endpoint to `http://127.0.0.1:4318`, then enable and save.
3. Start a Claude or Codex SDK session. The sink should print `/v1/logs`, `/v1/metrics` and
   `/v1/traces`, and the Cost estimate should keep updating.
