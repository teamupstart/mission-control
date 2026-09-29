# Phase 3: Recognize Upstart and manage its lane

Source plan: [plan.md](plan.md). Index: [phased-plan.md](phased-plan.md).

## 1. Outcome and value

On a Mac actively enrolled in Upstart's own Jamf tenant, Mission Control recognizes the
organization. It writes Upstart's managed configuration into the Product analytics destination
(Upstart's telemetry gateway, with the Datadog-ready settings), and makes Settings > Telemetry
**view-only** on that Mac, as the human decided on 2026-09-29.

Sending starts only for **pilot-enrolled** Macs in this phase. On every other Upstart Mac the
Product analytics destination is switched **off**, even if it was on before detection, so
nothing reaches the gateway before enrollment. The rollout is `pilot`, and volunteers enroll
with one documented API call, because Settings has no editing controls on an Upstart Mac.
Phase 6 turns the default on for every Upstart Mac after the pilot passes.

On every other machine, including other companies' Jamf-managed Macs, nothing changes, no
Upstart text appears, and everything stays editable.

Value:
- Upstart gets a consistent, managed lane that the pilot can join.
- Everyone else is untouched.
- Phase 4 gets the organization mechanism and the bounded macOS readers it reuses.

## 2. Entry criteria and dependencies

- Direct phase dependency: **Phase 2**, and through it Phase 1.
  - The preset sets `temporality`, `networkGate`, `lateAfterMs` and `exportShape`.
  - The Upstart block displays the shape's summary.
  - The editable temporality and shape controls from Phases 1 and 2 must be hidden on a managed
    Mac.

## 3. Scope and non-goals

In scope:

- **Detection:**
  - a registered `profiles` executable;
  - a bounded enrollment reader and a bounded plist reader;
  - the detection rule, the guards and the overrides.
- **Organization registry.** One registry entry, `upstart`, with the source plan's preset values
  and `rollout: "pilot"`.
- **The durable record.** `telemetry.organization` stores the prior product destination and
  master switch, pilot enrollment, and the fields Phase 6 needs.
- **Apply, keep in step, withdraw** at daemon start and on Re-check.
- **The managed lock.** The daemon refuses a person's telemetry settings changes while the
  organization is active. Test connection, Try again and Re-check remain.
- **Pilot enrollment.** `POST /api/telemetry/organization/pilot`, available only during the
  `pilot` rollout.
- **Environment.** `deployment.environment.name` is `corp` on an Upstart-managed Mac unless
  `MISSION_TELEMETRY_ENVIRONMENT` is set.
- **Status wire.** `organization` on the telemetry status, and a Re-check route.
- **The view-only "Managed by Upstart" panel.**
- **Docs:** `docs/upstart.md`, `docs/observability.md`, `docs/configuration.md`, and the
  README Configuration section for the new environment variables.

Non-goals:
- turning sending on for every Upstart Mac, and the one-time notice (Phase 6);
- the Cost panel warning (Phase 4);
- the dashboard (Phase 5);
- sending anything to the real gateway;
- a Setup row for the organization;
- locking settings outside Settings > Telemetry.

## 4. Repository findings and inherited contracts

Findings. Line numbers were taken on 2026-09-28.

**Subprocesses.**
- Every subprocess must go through the executable catalog, and
  `test/executable-contracts.test.ts` scans for undeclared commands.
- `plutil` is already registered: `src/server/executables/catalog.ts:118-120`, with the id at
  `src/shared/executables.ts:27` and the override `PLUTIL_BIN`. It is used by
  `src/server/open-targets/browser.ts:88-101` through `run()` in `src/server/util/exec.ts`.
- `run()` never throws, defaults to a 4-second timeout and an 8 MB buffer, and returns
  `RunResult`. Tests stub it with `stubRun`, as in `test/open-target-contract.test.ts`.
- `profiles` is not registered. Registering it follows the change-contracts "Executable and
  child-process changes" list.

**Environment checks.**
- Organization-specific facts live in exactly one file under `src/server/environment/`
  (`index.ts:20-28`).
- The bounded file read is `readText` with a 64 KiB cap (`environment/index.ts:58-96`), and the
  `FileRead` union is in `environment/types.ts`.

**Settings and telemetry.**
- The Setup banner is the precedent for a per-machine record excluded from backups:
  `setup.banner` in `src/shared/app-config-entries.ts:319`, and `src/server/setup/banner.ts`.
- Telemetry entries are `operational` with no backup domain (`app-config-entries.ts:329-357`).
- The daemon's own actor is `SYSTEM_ACTOR` (`kind: "system"`, `origin: "daemon"`,
  `basis: "owner"`, `src/shared/telemetry.ts:99-103`).
- `setTelemetryConfig` (`src/server/telemetry/config.ts:244-435`) handles `ifRevision`, revision
  bumps on real change, and the policy-epoch and generation side effects in one transaction.
- The person-facing writes are `PUT /api/telemetry/config` and
  `POST /api/telemetry/operation` (`routes.ts`, near 7272-7330). The internal apply path calls
  `setTelemetryConfig` directly, so a route-level lock does not block the daemon's own writes.
- The launch mode is computed at `src/server/index.ts:786`: `desktop`, `daemon` or `dev`.
- The capture resource is built in `src/server/telemetry/capture.ts:95-119`, and
  `environmentName()` reads `MISSION_TELEMETRY_ENVIRONMENT`.

**e2e.** The fixture passes a curated environment to the built daemon
(`e2e/fixtures/daemon.ts:397-560`), and accepts per-spec additions through
`test.use({ daemonEnv })` (`e2e/fixtures/test.ts:18-26`). Its `MISSION_HOME` is a temp directory.

**Measured on an Upstart Mac (2026-09-25).**
- `profiles status -type enrollment` prints `MDM enrollment: Yes (User Approved)` and
  `MDM server: https://upstart.jamfcloud.com/mdm/ServerURL`, needs no admin rights, and takes
  about 30 ms.
- `/Library/Preferences/com.jamfsoftware.jamf.plist` is `root:wheel 0644` and holds `jss_url`.
  **It is not used for detection.** It can outlive an unenrollment, and nothing in it ties it
  to the Mac's current enrollment. On a Mac later enrolled in another organization's MDM, it
  would still name Upstart.

Inherited:

- **Phase 1:**
  - the destination fields `temporality`, `networkGate` and `lateAfterMs`;
  - the waiting state;
  - the waiting-sentence function that takes an optional organization label;
  - the editable "Metric temporality" control.
- **Phase 2:**
  - `exportShape` and `TELEMETRY_EXPORT_SHAPE_IDS`;
  - the shape record's `summary`;
  - `exportedInstruments`;
  - the editable "Export shape" control.

## 5. Implementation steps, in order

1. **Register `profiles`.**
   - Append `profiles` to `EXECUTABLE_IDS` in `src/shared/executables.ts`, which is
     append-only.
   - Add its spec in `src/server/executables/catalog.ts`, modelled on `plutil`: command
     `profiles`, override suffix `PROFILES_BIN`, candidates `["/usr/bin/profiles"]`.
   - Add the locator test and a `docs/configuration.md` row.
2. **Bounded macOS readers (`src/server/environment/macos.ts`, new).** Both are pure over
   injected `run` and file-read dependencies, never throw, and return `null` on any failure:
   - **`readMdmEnrollment(deps)`:**
     - runs `run("profiles", ["status", "-type", "enrollment"], { timeoutMs: 2000, maxBuffer: 16 * 1024 })`;
     - parses `MDM enrollment:` (a `Yes` prefix means enrolled) and `MDM server:` (a URL, or
       absent);
     - returns `{ enrolled: boolean, serverUrl: string | null } | null`.
   - **`readPlistValue(path, keyPath, deps)`:**
     - runs `run("plutil", ["-extract", keyPath, "json", "-o", "-", path], { timeoutMs: 2000, maxBuffer: 64 * 1024 })`,
       then `JSON.parse` inside a try;
     - `-extract` is used rather than `-convert`, so dates or data elsewhere in the plist
       cannot fail the read, and only the requested subtree is loaded.

   Detection uses only `readMdmEnrollment`. `readPlistValue` is built here for Phase 4's
   managed-settings reader, and detection never calls it.
3. **Organization registry.**
   - **Shared, browser-safe (`src/shared/organizations.ts`):** `ORGANIZATION_IDS = ["upstart"] as const`,
     which is append-only, and the wire type `TelemetryOrganizationStatus`.
   - **Server (`src/server/environment/organizations.ts`):** the `upstart` entry, and the only
     place Upstart is named in code. It holds:
     - `label: "Upstart"`;
     - `mdmHosts: ["upstart.jamfcloud.com"]`;
     - `evidence(host)`, which returns "This Mac is enrolled in Upstart's device management
       (upstart.jamfcloud.com).";
     - `preset: { endpoint: "https://corp-otel-staging-1.upstart.com", temporality: "delta", networkGate: "cloudflare-edge", lateAfterMs: 3_600_000, exportShape: "datadog-lean", environment: "corp" }`;
     - `presetVersion: 1`;
     - `rollout: "pilot"`.

     `lateAfterMs` is Datadog's one-hour ingestion limit, recorded in
     [phased-plan.md](phased-plan.md).
4. **Detection: `detectOrganization(deps)`.**
   - **The rule.** The Mac matches only when both of these hold:
     - macOS reports `MDM enrollment: Yes`;
     - the server URL parses with scheme `https` and no userinfo, and its hostname, lowercased
       with a trailing dot stripped, is in an entry's `mdmHosts`.

     There is no suffix, substring, vendor or app matching.
   - **The URL's source.** The URL comes **only** from the `MDM server` line of the same
     `profiles status` output that reported `MDM enrollment: Yes`. Both facts therefore
     describe the current enrollment.
     - A missing, empty or unparseable `MDM server` line means no organization. It fails
       closed.
     - No file, including Jamf's `jss_url`, is consulted as a fallback.
   - **Other platforms.** Detection returns `null` without running anything on any platform
     other than `darwin`.
   - **Guards.** Detection only runs, and its result only counts, when all of these hold:
     - the launch mode is `desktop` or `daemon`;
     - `NODE_TEST_CONTEXT` and `MISSION_TEST_STATE` are absent;
     - the state home does not resolve inside `os.tmpdir()`, checked through `realpath`.
   - **Overrides.** Both are read with `envVar`.
     - `MISSION_ORGANIZATION=none` turns detection off everywhere. It is a diagnostic override,
       not a Settings control.
     - `MISSION_ORGANIZATION=upstart` forces the organization, bypassing detection and the
       guards, **only if** `MISSION_ORGANIZATION_ENDPOINT` is a loopback URL. That URL then
       replaces the preset endpoint. Otherwise the force is ignored and logged.
   - **Caching.** The result is computed once at start and again on Re-check, and cached in
     memory as `currentOrganization()`.
5. **The record.**
   - Add `telemetryOrganization: wholeEntry("telemetry.organization", TelemetryOrganizationRecordSchema, "operational", null)`
     to `APP_CONFIG_ENTRIES`, with a doc comment in the style of its neighbours.
   - Its schema holds:
     - `organization` and `presetVersion`;
     - `previous: { product: TelemetryDestination, enabled: boolean }`, the product destination
       and master switch as they were before first application;
     - `pilotEnrolledAt: number | null`;
     - `enabledByDefault: boolean`, always false in this phase;
     - `noticeAcknowledgedAt: number | null`, which Phase 6 uses;
     - `appliedAt`.
6. **Apply, keep in step, withdraw (`src/server/telemetry/organization.ts`, new).**
   - This runs at start, after the database opens and before `startTelemetry`, and on
     Re-check. Every write goes through `setTelemetryConfig` with `SYSTEM_ACTOR`, so revisions,
     generations, the Phase 1 baseline and the Phase 2 shape reset all apply.
   - **The pilot invariant.** While the rollout is `pilot` and an organization is active,
     `product.enabled` is true **if and only if** `pilotEnrolledAt` is set. Every apply
     re-asserts it, so no path can leave a non-enrolled Mac sending to the gateway.
   - **Detected, no record.** Make the first application **one `setTelemetryConfig` call**, so
     no intermediate state is ever stored or exported:
     - store `previous`: the whole prior product destination, including its `enabled`, and the
       master switch;
     - write every preset field to `product`, replacing whatever was there;
     - set `product.enabled` to **false**, whatever it was. No Mac is enrolled at first
       application, and a destination that was already on must not send to the gateway;
     - leave the master switch as it was. It also governs local collection and the person's own
       backend, and the Product analytics lane cannot send while its own switch is off.

     The endpoint change bumps the generation, which fences batches queued for the previous
     product endpoint, and the switch-off drops them under the existing disable rule. Neither
     path can redirect them to the gateway.
   - **Detected, record present:**
     - write every preset field again when `presetVersion` is newer; nobody on the Mac can
       have changed them;
     - re-assert the pilot invariant;
     - the master switch is on while enrolled, and otherwise is whatever it was at first
       application, which is `previous.enabled`. The lock means nobody on the Mac can have
       changed it.
   - **Not detected, record present:**
     - restore `previous.product`, including its own `enabled`, and `previous.enabled`, in one
       `setTelemetryConfig` call;
     - then delete the record.

     A destination that was on before detection is on again, sending to its original endpoint
     under a new consent epoch per the existing rules. Nothing already sent to the gateway is
     recalled.
   - **Environment.** `environmentName()` returns `MISSION_TELEMETRY_ENVIRONMENT` if set, then
     the active organization's `preset.environment`, then `local`.
7. **The managed lock (`src/server/routes.ts`).**
   - While `currentOrganization()` is non-null, `PUT /api/telemetry/config` and the `purge`
     and `reset_identity` operations answer **403**:
     `{ error: "Telemetry settings on this Mac are managed by Upstart", managedBy: "upstart" }`.
   - `probe` (Test connection) and `retry` (Try again) keep working, because they change no
     setting.
   - Nothing else in Mission Control is locked.
8. **Pilot enrollment.**
   - `POST /api/telemetry/organization/pilot` with body `{ enrolled: boolean }`.
   - It answers 409 unless an organization is active and its rollout is `pilot`.
   - Enrolling sets `pilotEnrolledAt`, and turns `product.enabled` and the master switch on
     through the apply path.
   - Leaving the pilot clears `pilotEnrolledAt`, turns `product.enabled` off, and restores the
     master switch to `previous.enabled`.
   - Document it in `docs/upstart.md` for volunteers.
9. **Status wire and routes.**
   - Add `organization: TelemetryOrganizationStatus | null` to `TelemetryStatus`, which
     `GET /api/telemetry/config` returns. It is `null` unless an organization is detected or
     validly forced. It holds:
     - `id`, `label` and `evidence`;
     - `rollout`;
     - `managed: true`;
     - `pilotEnrolled`;
     - the effective configuration.
   - Add `POST /api/telemetry/organization/recheck`, which re-runs detection and apply, then
     returns the status.
   - Update `test/fixtures/route-surface.json` and `test/route-surface-oracle.test.ts` for both
     new routes and the changed body.
   - Classify each route in `src/shared/telemetry-sources/action-exclusions.ts`, or map it to a
     primary action, following how the existing telemetry routes are classified.
10. **Settings > Telemetry, view-only on a managed Mac.**
    - When `organization` is non-null, render a **Managed by Upstart** block at the top with:
      - the label and the evidence;
      - a state line: "Sending to Upstart's Datadog", "Waiting for the Upstart network", or
        "Not enrolled in the pilot on this Mac";
      - the effective configuration, read-only: destination, endpoint, temporality, export
        shape with its `summary`, environment and network gate.
    - Render no editing controls anywhere in the panel: no switches, fields, Save, credential,
      purge, identity reset, or the Phase 1 and 2 temporality and shape selects.
    - Keep Test connection, Try again when paused, and Re-check.
    - Pass the organization label to the Phase 1 waiting sentence.
    - When `organization` is null, render exactly what Phases 1 and 2 render, fully editable.
11. **e2e fixture.** Set `MISSION_ORGANIZATION: "none"` in the fixture's default daemon
    environment. A spec opts in through `daemonEnv`.
12. **Docs.**
    - `docs/upstart.md`, a "Telemetry to Upstart's Datadog" section:
      - what is detected, and why other Jamf customers are unaffected;
      - that the setting is managed and view-only on Upstart Macs;
      - what is sent and never sent, including that the gateway copies metrics to a second
        destination its owners run;
      - how pilot volunteers enroll and leave.
    - `docs/observability.md`, an "Organization defaults" section: apply, keep in step,
      withdraw, and the lock.
    - `docs/configuration.md` and the README: `MISSION_ORGANIZATION`,
      `MISSION_ORGANIZATION_ENDPOINT` and `MISSION_PROFILES_BIN`.

## 6. Data, API and compatibility

- **Undetected machines.** A machine that is not detected keeps its stored config untouched and
  gets no record.
- **Detected machines.** The product destination is replaced by the preset and switched off,
  and its previous value, including its switch, is kept in the record for withdrawal. The
  master switch does not move until pilot enrollment. Product analytics stays off until
  enrollment.
- **API:**
  - `organization` on the status, which is additive;
  - two new routes;
  - a 403 on person-facing settings writes, only while an organization is active.
- **Identity.** An identity is minted only when a pilot enrollment starts capture, through the
  existing consent path.
- **Persisted ids.** `ORGANIZATION_IDS` is append-only: add it to the persisted-identifier list.
- **Public repository.** The Upstart gateway hostname and Jamf tenant now appear in code, as the
  source plan's decision accepted. That is rollout prerequisite 3; confirm it with Upstart
  before merging.

## 7. Tests and verification

Unit tests:

- **`test/organization-detection.test.ts`, with injected `run` and file reads:**
  - should match: Upstart enrolled, and the uppercase and trailing-dot forms of the host;
  - must fail:
    - `MDM enrollment: No` while the Jamf plist names Upstart;
    - `acme.jamfcloud.com`, self-hosted Jamf, Kandji and Intune;
    - the lookalikes `notupstart.jamfcloud.com`, `upstart-sandbox.jamfcloud.com`,
      `upstart.jamfcloud.com.example.com`, `http://upstart.jamfcloud.com` and
      `https://user@upstart.jamfcloud.com`;
  - a missing `MDM server` line, which must fail, including when the injected file reader
    would return a Jamf plist naming Upstart. The test also asserts that detection never calls
    the file reader;
  - active enrollment in another organization's MDM (`MDM enrollment: Yes`), with no
    `MDM server` line and a stale Upstart `jss_url` plist present, which must fail;
  - active enrollment in another organization's MDM with its own `MDM server` line, and the
    same stale plist, which must fail;
  - malformed output, a non-zero exit, a timeout and an overflow;
  - a non-darwin platform, which must not call `run`.
- **Guards and overrides:**
  - each guard refuses;
  - `none` wins;
  - a force without a loopback endpoint is ignored;
  - a force with one is honoured.
- **`test/telemetry-organization.test.ts`:**
  - first application stores `previous` and writes the preset, in one `setTelemetryConfig`
    call;
  - **starting from an enabled configuration.** Take a Mac whose product destination
    (pointing at a fake collector) and master switch were both on, with batches queued. After
    first application:
    - `product` holds the preset and `product.enabled` is false;
    - the master switch is unchanged;
    - the queued batches are fenced or dropped;
    - a delivery pass sends nothing to the gateway's fake collector, and nothing more to the
      original collector.
  - enrolling turns Product analytics and the master switch on, and the gateway collector
    receives data;
  - leaving turns Product analytics off and restores the master switch;
  - a newer preset version rewrites every preset field and re-asserts the pilot invariant for
    both enrolled and non-enrolled records;
  - withdrawal restores `previous`, including a product switch that was on, so the original
    collector receives data again, and deletes the record;
  - `environmentName()` precedence.
- **The lock.**
  - While active: `PUT /api/telemetry/config` and the `purge` and `reset_identity` operations
    answer 403, and `probe` and `retry` succeed.
  - After withdrawal, the same `PUT` succeeds.
- **Executables.** `test/executable-contracts.test.ts` passes with `profiles` registered, and
  its locator test passes.
- **Existing suites.** Every existing default-off telemetry test passes unchanged.

E2E:

- **`e2e/specs/telemetry-organization.spec.ts`**, with `MISSION_ORGANIZATION=upstart` and
  `MISSION_ORGANIZATION_ENDPOINT` pointing at a local fake collector the spec starts. It
  covers:
  - the Managed by Upstart block and its evidence;
  - the effective configuration shown read-only;
  - no editable control anywhere on the page, asserted by role: no enabled checkbox, textbox
    or Save button in the panel;
  - a direct `PUT` answered 403 with the managed message;
  - after pilot enrollment through the API, the state reads "Sending to Upstart's Datadog",
    and the collector receives a delta metrics request whose resource carries
    `datadog.host.name: mission-control` and no `mission.analytics.v1.*` metrics;
  - a Cloudflare-shaped 403 from the collector, which shows "Waiting for the Upstart network";
  - Re-check.
- **`e2e/specs/telemetry-no-organization.spec.ts`**, under the default fixture:
  - no "Upstart" text anywhere in Settings > Telemetry;
  - every control is editable, including the temporality and shape selects.

Suite:

```sh
npm run typecheck
npm run lint
npm test
npm run build && npm run smoke
npm run test:e2e
```

## 8. Merge and exit criteria

- On a non-Upstart machine, behaviour, stored config and the rendered, editable panel are
  identical to Phase 2.
- On an Upstart Mac with a built app:
  - the product destination holds the preset;
  - the panel is view-only;
  - direct writes are refused;
  - pilot enrollment starts sending.
- Upstart has confirmed that the hostname may be published in the public repository.
- The docs, e2e and suite are green.

## 9. Downstream handoff

Later phases may rely on these:

- **Readers.** `readPlistValue` and `readMdmEnrollment` in `src/server/environment/macos.ts`.
  Phase 4 uses `readPlistValue`.
- **Detection.** `currentOrganization()` and its `label`. Phase 4 uses the label.
- **The record.** `telemetry.organization`, including `previous`, `pilotEnrolledAt`,
  `enabledByDefault` and `noticeAcknowledgedAt`. Phase 6 sets the last two.
- **Rollout and lock.**
  - the preset's `rollout`, and the rule that a newer preset version rewrites every preset
    field;
  - the pilot invariant: `product.enabled` is true exactly when `pilotEnrolledAt` is set;
  - the managed lock.

  Phase 6 changes `rollout` to `default-on`, bumps `presetVersion`, and retires pilot
  enrollment.
- **Test fixture.** `MISSION_ORGANIZATION=none` in the e2e fixture, and
  `MISSION_ORGANIZATION_ENDPOINT` for forced specs.

Must not change without an audit entry:
- the detection rule and guards, which are the approved uniqueness contract;
- the managed lock, which is the approved 2026-09-29 decision.

## 10. Cross-phase audit record

- **2026-09-28**, written after Phases 1 and 2. It consumes their fields without changing them.
  A pre-default-on rollout stage keeps the default from going on before the pilot gate; Phase 6
  owns the flip.
- **2026-09-28:** the bounded macOS readers are placed here rather than in Phase 4, because
  detection needs them first.
- **2026-09-29, repair round 1:**
  - Rewritten for the human decision that Upstart users do not edit the Upstart configuration.
  - The `offered` rollout is replaced by `pilot` with API enrollment, because a person can no
    longer switch Share on in Settings.
  - Removed: the "Upstart default" tags, Reset to Upstart default, user-override preservation,
    and `shareTurnedOffByUser`. A person on an Upstart Mac can no longer turn the lane off, so
    there is nothing to remember.
  - Added: the managed lock, and `previous` for restoring on withdrawal.
  - Phase 6 was reconciled in the same round.
- **2026-09-29, repair round 2:** the human recorded the editing decision in the Mission
  Control dashboard as "No: view-only for Upstart users; only non-Upstart users edit settings",
  confirming the view-only design above. Nothing in this phase changed.
- **2026-09-29, repair round 7:**
  - Removed the Jamf `jss_url` fallback. A Mac that left Upstart kept the file, and was then
    enrolled in another organization's MDM, would have passed "active enrollment" plus a stale
    Upstart plist whenever the `MDM server` line was missing.
  - The server URL now comes only from the same `profiles` output as the enrollment, and a
    missing line fails closed.
  - Added tests for another MDM with a stale Upstart plist, with and without an `MDM server`
    line, and one asserting detection never reads a file.
  - `readPlistValue` stays, for Phase 4.
- **2026-09-29, repair round 4:**
  - The first-application rule left `product.enabled` "as it was". A Mac whose Product
    analytics destination was already on would then have sent to the gateway before
    enrollment.
  - Replaced with the pilot invariant: Product analytics is on exactly when enrolled. First
    application is one transaction that switches it off, and withdrawal restores it.
  - Added a test that starts from an enabled configuration.
  - Phase 6 consumes the invariant and is updated in the same round.
