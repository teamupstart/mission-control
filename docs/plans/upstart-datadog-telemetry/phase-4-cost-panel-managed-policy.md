# Phase 4: Name the managed-policy redirect in the Cost panel

Source plan: [plan.md](plan.md), section "Adjacent finding: Cost telemetry is silent at
Upstart". Index: [phased-plan.md](phased-plan.md).

## 1. Outcome and value

When an organization's managed Claude Code policy redirects Claude Code's metrics somewhere
other than this daemon, Settings > Cost says so, names the host, and explains that the estimate
covers only sessions Mission Control runs. Today the panel waits a week, then blames "a
managed policy [that] disables telemetry", which is wrong: the policy redirects telemetry.

This is generic and works for any organization. On an Upstart-managed Mac the wording uses
the organization's label.

## 2. Entry criteria and dependencies

- Direct phase dependency: **Phase 3**. This phase uses `readPlistValue` from
  `src/server/environment/macos.ts` and the detected organization's label from
  `currentOrganization()`.
- It can run concurrently with Phases 5 and 6. It touches none of their files except
  `e2e/fixtures/daemon.ts`, where it adds one environment pin that the others do not edit.

## 3. Scope and non-goals

In scope:

- **Reader.** A bounded, fail-closed reader of Claude Code's managed settings, from three
  locations.
- **Classification.** The effective metrics destination is classified as redirected, disabled,
  or not managed.
- **Status.** A `managedRedirect` field on `CostTelemetryStatus`, computed without slowing the
  4-second poll.
- **Panel copy.** The Cost panel copy for redirect and disabled, and today's copy otherwise.
- **Tests.** A test path override and an e2e fixture pin, so no test reads the developer's
  real policy.

Non-goals:
- changing, overriding or writing any managed setting;
- changing the Cost switch's own `~/.claude/settings.json` block;
- Claude Code's Linux managed path (`/etc/claude-code/managed-settings.json`);
- telemetry export.

## 4. Repository findings and inherited contracts

Findings. Line numbers were taken on 2026-09-28.

**Server.**
- `costTelemetryStatus()` (`src/server/cost.ts:185-202`) is synchronous and called on every
  `GET /api/cost/config` (`routes.ts:7245`).
- The dashboard polls that route every 4 seconds while open (`src/web/useCost.ts:16`; owned in
  `App.tsx:393`).
- Unit tests call it synchronously (`test/cost-telemetry-status.test.ts`,
  `test/cost-telemetry-enable.test.ts`). **It must stay synchronous.**
- `CostTelemetryStatus` is a plain interface at `src/shared/protocol.ts:3675-3727`, and
  `exporterSilent` is at 3698-3718.
- `src/shared/claude-settings.ts` is imported by the Electron main bundle
  (`src/main/integrations.ts:29`) and must stay "node builtins and jsonc-parser". **Do not add
  the reader there.**
- `targetsThisDaemon(endpoint)` (`src/server/telemetry/config.ts:476-485`) and `isLoopbackHost`
  (`src/shared/telemetry-endpoint.ts:34-40`) already decide whether an endpoint is this daemon.

**Panel.**
- The silent warning is in `src/web/components/CostSettingsPanel.tsx:52-73`.
- No unit test renders the panel. The render-test template is
  `test/shipping-panel-warnings.test.ts`.
- The e2e coverage is `e2e/specs/session-spend.spec.ts:194-260`, which asserts today's wording.

**Measured on an Upstart Mac.**
- Both `/Library/Managed Preferences/com.anthropic.claudecode.plist` and the per-user
  `/Library/Managed Preferences/<user>/com.anthropic.claudecode.plist` exist. Both are binary
  plists with an `env` dictionary that sets `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` to the
  gateway.
- `/Library/Application Support/ClaudeCode/managed-settings.json` does not exist on this Mac.
- The `env` block also carries other keys that are none of Mission Control's business. **Never
  log or echo the env block.** Extract only the keys named below.

Inherited from Phase 3:
- `readPlistValue(path, keyPath, deps)`;
- `currentOrganization()` and its `label`.

## 5. Implementation steps, in order

1. **Path root override.**
   - `MISSION_MANAGED_SETTINGS_ROOT`, default `/`, prefixes the three absolute paths:
     - `Library/Managed Preferences/<user>/com.anthropic.claudecode.plist`;
     - `Library/Managed Preferences/com.anthropic.claudecode.plist`;
     - `Library/Application Support/ClaudeCode/managed-settings.json`.
   - Add it to `docs/configuration.md` and the README Configuration section.
2. **Reader (`src/server/environment/claude-managed.ts`, new).**
   - Read the locations in the order above. The first that yields an `env` object wins.
   - Plists are read with `readPlistValue(path, "env", deps)`. The JSON file is read with the
     bounded `readText` (64 KiB) and parsed with `jsonc-parser`, then its `env` key is taken.
   - Keep only these keys, as strings:
     - `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`;
     - `OTEL_EXPORTER_OTLP_ENDPOINT`;
     - `OTEL_METRICS_EXPORTER`;
     - `CLAUDE_CODE_ENABLE_TELEMETRY`.
   - Return `{ source: "mdm-user" | "mdm" | "managed-settings", env }` or `null`. Any failure,
     oversize, or parse error returns `null`, which is fail closed.
3. **Classification.**
   - `disabled` when `CLAUDE_CODE_ENABLE_TELEMETRY` is `0` or `false`, or when
     `OTEL_METRICS_EXPORTER` is `none`.
   - Otherwise take the metrics-specific endpoint, else the generic one. When one is set, it
     parses as a URL, and `targetsThisDaemon` is false, the result is
     `{ kind: "redirect", host: url.hostname }`: **the host only**, with no scheme, port, path,
     query or userinfo.
   - Anything else is `null`.
4. **A non-blocking cache.**
   - Keep the last classification in memory, keyed on each path's `stat` modification time and
     size.
   - `costTelemetryStatus()` reads the cache synchronously. A refresh is started asynchronously
     when the key changed or 60 seconds have passed, and the next poll sees its result.
   - The first poll after start returns `null` until the first refresh completes. Start one
     refresh at daemon boot so this window is short.
5. **Status field.**
   - Add to `CostTelemetryStatus`, after `exporterSilent`, with a doc comment in the same style:

     ```ts
     managedRedirect:
       | { kind: "redirect" | "disabled"; host: string | null; source: ...; organizationLabel: string | null }
       | null
     ```

   - `organizationLabel` comes from `currentOrganization()?.label ?? null`.
   - Populate it in `costTelemetryStatus()`.
6. **Panel copy (`CostSettingsPanel.tsx`).** Whenever Cost is on and `managedRedirect` is
   non-null, render a `settings-error` paragraph instead of the generic silent paragraph,
   without waiting for the week of silence:
   - **Redirect:** "{Upstart's | Your organization's} managed Claude Code policy sends metrics
     to {host}, so the estimate covers only sessions Mission Control runs. Sessions you started
     yourself in a terminal are not counted."
   - **Disabled:** "{Upstart's | Your organization's} managed Claude Code policy turns Claude
     Code's metrics off, so the estimate covers only sessions Mission Control runs."
   - When `managedRedirect` is null, today's paragraph and gating are unchanged.
7. **e2e fixture pin.** Set `MISSION_MANAGED_SETTINGS_ROOT` in `e2e/fixtures/daemon.ts` to a
   directory inside the temp `MISSION_HOME` that holds no policy, so no spec reads the
   developer's real policy.
8. **Unit-test isolation.** The cost tests set `MISSION_MANAGED_SETTINGS_ROOT` in their file
   preamble, above the imports, as `AGENTS.md` prescribes for state homes.
9. **Docs.** In `docs/sessions.md`, the cost telemetry section, and `docs/upstart.md`: why a
   managed policy wins, what the panel says, and that Mission Control never overrides it.

## 6. Data, API and compatibility

- **API.** `CostTelemetryStatus` gains `managedRedirect`, which is additive. The web hook
  already spreads the previous status, so no hook change is needed.
- **Unmanaged machines** see no behaviour change, and the Cost panel reads exactly as today.
- **Privacy.** Only one host string ever leaves the reader. No path, query, credential or other
  env key is stored, logged or sent.

## 7. Tests and verification

Unit tests:

- **`test/claude-managed-settings.test.ts`, with injected `run` and file reads:**
  - per-user plist beats machine plist, which beats the JSON file;
  - the metrics-specific endpoint beats the generic one;
  - `disabled` from `CLAUDE_CODE_ENABLE_TELEMETRY=0` and from `OTEL_METRICS_EXPORTER=none`;
  - a daemon-targeting endpoint gives null;
  - an unparseable URL gives null;
  - the host only, from a URL with userinfo, port, path and query;
  - an oversized JSON file, a malformed plist, and a timeout from `plutil`;
  - the reader never returns another env key.
- **`test/cost-telemetry-status.test.ts`:**
  - `managedRedirect` is populated from the cache and stays synchronous;
  - it refreshes after the key changes.
- **`test/cost-settings-panel.test.ts` (new, `renderToStaticMarkup`):**
  - the redirect copy with the Upstart label;
  - the redirect copy with "Your organization's";
  - the disabled copy;
  - today's copy when null.

E2E:

- Extend `e2e/specs/session-spend.spec.ts`, or add `e2e/specs/cost-managed-policy.spec.ts`, with
  `daemonEnv` pointing `MISSION_MANAGED_SETTINGS_ROOT` at a fixture directory containing
  `Library/Application Support/ClaudeCode/managed-settings.json` that redirects metrics to
  `otel.example.com`.
  - Assert the redirect copy names `otel.example.com`.
  - The JSON source is used so the spec runs on Linux CI, where `plutil` does not exist.
- The existing wording assertion at `session-spend.spec.ts:231` still passes under the default
  pin.

Suite:

```sh
npm run typecheck
npm run lint
npm test
npm run build && npm run smoke
npm run test:e2e
```

## 8. Merge and exit criteria

- On an unmanaged machine, the Cost panel is unchanged.
- With a fixture policy, the panel names the host with the correct label.
- No test on any machine reads the real `/Library` policy.
- The suite and docs are green.

## 9. Downstream handoff

- `managedRedirect` on `CostTelemetryStatus`, and the reader
  `src/server/environment/claude-managed.ts`. No later phase depends on them.
- `MISSION_MANAGED_SETTINGS_ROOT` in the e2e fixture. Phases 5 and 6 must keep it when they edit
  the fixture.

## 10. Cross-phase audit record

- 2026-09-28, written after Phase 3:
  - consumes `readPlistValue` and `currentOrganization()` unchanged;
  - adds the per-user plist, which the source plan did not name, because it exists on
    Upstart Macs and Claude Code reads it;
  - broadens the trigger from "after a week of silence" to "whenever Cost is on and a policy
    redirects". The source plan asks for the cause to be named, and waiting a week to name a
    known cause helps nobody.
