# Phase 6: Pass the pilot gate, then turn the Upstart default on

Source plan: [plan.md](plan.md), sections "Datadog cost" (pilot gate), "Managed on Upstart Macs"
and "The one-time notice". Index: [phased-plan.md](phased-plan.md).

## 1. Outcome and value

Once a real pilot has shown that the lean lane costs what the plan says, Mission Control turns
Upstart's managed lane **on by default** on every Upstart-managed Mac. It then tells each person
once, in the dashboard, what is being sent and that Upstart manages it.

This is the release gate the source plan requires: default-on never ships on an estimate.

## 2. Entry criteria and dependencies

- **Phase dependency:** Phase 3. This phase changes that phase's rollout and apply rules;
  Phases 1 and 2 arrive through it.
- **Human-run pilot.** 5 to 10 Upstart volunteers have enrolled their Macs with
  `POST /api/telemetry/organization/pilot` and run a Phase 3 build for at least seven days.
- **If the pilot has not happened** when this task starts, **stop before changing code**. Report
  the unmet criteria with Mission Control's input request and wait. Do not flip the default to
  make progress.
- **Rollout prerequisites answered.** The gateway owners and the budget owner have been told
  (source plan items 1 and 2). The gateway's second-destination copy and the host approach are
  agreed.

## 3. Scope and non-goals

In scope:
- **Verify the pilot** with read-only Datadog queries, and ask a person for the checks only a
  person can run.
- **Flip the rollout** to `default-on`, bump `presetVersion`, and implement the default-on apply
  rule.
- **Retire pilot enrollment.**
- **The one-time notice**, with its acknowledgement route.
- **Docs** for default-on.

Non-goals:
- changing the lean shape's contents, unless the pilot fails (step 2);
- changing the managed lock;
- applying the Datadog dashboard, which is a separate rollout step.

## 4. Repository findings and inherited contracts

Findings:
- **Summary channel.** Every browser holds the settings-status channel, and
  `TelemetrySettingsSummary` already rides it. Every leaf must be compared in
  `sameTelemetrySummary` (`src/server/registry.ts:708-746`) and enumerated in
  `test/settings-status.test.ts`.
- **Notice precedent.** The dashboard's dismissible per-machine notice is the Setup banner:
  - `src/web/components/SetupBanner.tsx`;
  - `src/server/setup/banner.ts`;
  - `setup.banner` in `src/shared/app-config-entries.ts:319`;
  - `e2e/specs/setup-banner-and-tour.spec.ts`.

  Follow its shape, and keep the dismissal in the daemon, not in browser storage.
- **Routes.** Adding a route updates `test/fixtures/route-surface.json`, and the route is
  either classified in `src/shared/telemetry-sources/action-exclusions.ts` or mapped to a
  primary action.

Inherited:
- **Phase 3:**
  - the `telemetry.organization` record, with `previous`, `pilotEnrolledAt`,
    `enabledByDefault` and `noticeAcknowledgedAt`;
  - `rollout`;
  - the rule that a newer preset version rewrites every preset field;
  - the pilot invariant: while the rollout is `pilot`, `product.enabled` is true exactly when
    `pilotEnrolledAt` is set, so before this phase no non-enrolled Upstart Mac sends;
  - the managed lock;
  - `currentOrganization()`;
  - the forced-organization e2e setup.
- **Phase 2:** the `datadog.host.name` attribute, which this phase verifies, and the shape
  record, which this phase may trim only if the pilot fails.
- **Phase 1:** `latePointsSent` and the waiting state, which the pilot report reads.

## 5. Implementation steps, in order

1. **Verify the pilot, before any code change.** Use the Datadog MCP read tools only.
   - **Installations:** distinct `service.instance.id` on
     `mission.telemetry.health.observed_at`, with `env:corp`, over the last 7 days. There
     must be at least 5.
   - **Cost gate:** `datadog.estimated_usage.metrics.custom.by_metric{metric_name:mission.*}`,
     averaged over the last 7 days and divided by the installation count. **It must be 150 or
     fewer.**
   - **Host:** `mission.*` series carry `host:mission-control` only, and the billable
     infrastructure hosts shown in usage do not increase because of them.
   - **Traces:** record APM ingested span volume for `service:mission-control` in the pull
     request, with its estimated cost.
   - **Checks only a person can run.** Ask for these with Mission Control's input request, and
     record the answers:
     - **Delta accuracy:** a pilot installation's daemon health counts match its Datadog
       counts for one day.
     - **Off-VPN fingerprint:** with the VPN off, the gateway's response is a Cloudflare 403
       that Phase 1's gate recognizes, and health reads "Waiting for the Upstart network".
       This phase is the only one that checks this against the real gateway. If the real
       response differs from the documented fingerprint Phase 1 built to, correct the
       fingerprint in `delivery.ts` in this phase, with a test, and record it in Phase 1's
       audit record.
     - **Replay:** a deliberately re-sent delta batch either overwrites or adds. This phase is
       the only one that measures it against the real gateway. Record which, and state the
       consequence in `docs/observability.md`.
   - **Hourly ceiling across transitions and backlog.** Run these with a person's help:
     - on one pilot installation, change the export shape mid-hour after series have been sent,
       and confirm from `datadog.estimated_usage.metrics.custom.by_metric{metric_name:mission.*}`
       for that installation and hour that it stays within 1,500. Record `hourly_cap_deferred`;
     - deliver a multi-hour offline backlog, and record how Datadog counts it in the hour it
       arrives;
     - if either exceeds the ceiling, stop and report, as for the cost gate.
   - **Late points:** record `latePointsSent` across the pilot, and whether Datadog's admins
     enabled Historical Metrics Ingestion for `mission.*`.
2. **If the gate fails** (more than 150 per installation, or a host is billed):
   - stop and report the measured numbers;
   - propose a trim to the `datadog-lean` record in `src/shared/telemetry-export-shapes.ts`,
     or, for billing, removing `resourceAttributes`;
   - make that change only with a person's agreement, recording it in Phase 2's audit record.

   Do not flip the default in the same pull request as a trim, because a trim needs another
   pilot week.
3. **Default-on apply rule (`src/server/telemetry/organization.ts`).** With the preset at
   `rollout: "default-on"`, every detected Mac, with or without a record, gets the preset
   written and `product.enabled` and the master switch turned on, and `enabledByDefault: true`
   is set.
   - This replaces Phase 3's pilot invariant only once the rollout is `default-on`. It is the
     one transition that turns Product analytics on without enrollment, and it ships only after
     the gate in step 1 passes.
   - `previous` is still stored at first application, so withdrawal restores the Mac's own
     settings.
   - There is no person's choice to preserve, because the lane is managed (the 2026-09-29
     decision).
   - Identity is minted here, through the existing consent path, when capture first turns on.
4. **Flip the preset and retire the pilot.**
   - In `src/server/environment/organizations.ts`, set `rollout: "default-on"` and bump
     `presetVersion` to 2.
   - `POST /api/telemetry/organization/pilot` now answers 409, because the rollout is not
     `pilot`. `pilotEnrolledAt` is kept for the record and ignored.
5. **The notice.**
   - Add `organizationNotice: { label: string } | null` to `TelemetrySettingsSummary`. It is
     non-null only when all of these hold:
     - an organization is active;
     - the record has `enabledByDefault: true`;
     - `noticeAcknowledgedAt` is null;
     - product is currently exporting.

     Add it to `sameTelemetrySummary` and `test/settings-status.test.ts`.
   - Add `POST /api/telemetry/organization/notice`. It sets `noticeAcknowledgedAt` and
     republishes settings status. Add it to the route surface and classify it.
   - Build an in-page notice component, not a modal, on the dashboard, beside the Setup
     banner's slot and following its structure. Its content is the source plan's "The one-time
     notice" text:
     - that the telemetry goes to Upstart's Datadog through Upstart's telemetry gateway,
       because this Mac is enrolled;
     - that Upstart manages the setting;
     - what travels and what never does, including the gateway's second-destination copy;
     - a link to Settings > Telemetry, and a Dismiss button.
6. **Docs.**
   - In `docs/upstart.md` and `docs/observability.md`, say that the lane is on by default and
     managed on Upstart Macs, how the notice behaves, and that pilot enrollment has ended.
   - Update the source plan's status line with the pilot result and the flip.

## 6. Data, API and compatibility

- **The record** is unchanged in shape. This phase writes `enabledByDefault` and
  `noticeAcknowledgedAt`.
- **Summary and routes.** `TelemetrySettingsSummary` gains `organizationNotice`, which is
  additive, and one route is added. The pilot route changes to 409.
- **Non-Upstart machines** are unchanged in every respect, and stay fully editable.

## 7. Tests and verification

Unit tests:

- **`test/telemetry-organization.test.ts`:**
  - default-on on a fresh config;
  - default-on on a Mac with a Phase 3 record, whether it was pilot-enrolled or not;
  - `previous` preserved;
  - `enabledByDefault` set;
  - the pilot route answers 409.
- **Notice summary:**
  - `organizationNotice` appears only under its four conditions;
  - acknowledgement clears it.

E2E: `e2e/specs/telemetry-organization-notice.spec.ts`, with a forced organization and a fake
collector:
- the notice appears once after the default turns sending on;
- dismissing it survives a reload;
- there is no notice without the organization override;
- Settings > Telemetry reads "Sending to Upstart's Datadog" and is still view-only.

Suite:

```sh
npm run typecheck
npm run lint
npm test
npm run build && npm run smoke
npm run test:e2e
```

## 8. Merge and exit criteria

- **The pilot report is in the pull request:**
  - installations;
  - custom metrics per installation;
  - host billing;
  - span volume;
  - each person-run check's answer.
- **The gate passed:** 150 or fewer per installation, and no host billing.
- **The work is complete.** The flip, the notice and the docs are done, and the suite is green.

## 9. Downstream handoff

This is the final phase. It leaves:

- the preset at `default-on`, version 2;
- the managed lane on across Upstart Macs;
- the notice and its acknowledgement route;
- a recorded pilot baseline that later changes to the lean shape are measured against.

## 10. Cross-phase audit record

- **2026-09-28:** written last. It consumes Phase 3's record and rollout without changing their
  meaning.
- **2026-09-28:** the real-gateway checks the source plan lists under Testing are owned here,
  because they need a person and a running pilot. Phase 1's gate is built to the documented
  Cloudflare fingerprint and verified here.
- **2026-09-29, repair round 1:** rewritten for the decision that Upstart users do not edit the
  Upstart configuration.
  - Default-on now applies to every Upstart Mac.
  - `shareTurnedOffByUser` and its upgrade conditions are removed.
  - Pilot enrollment through the API replaces the Settings switch, and is retired at the flip.
  - The notice says the setting is managed instead of telling people how to turn it off.
- **2026-09-29, repair round 8:** added the measured check of the hourly ceiling across a
  mid-hour shape change and a late backlog, which Phase 2's export ledger cannot fully control.
- **2026-09-29, repair round 5:** stated this phase as the sole owner of the real-gateway replay
  measurement and the real off-VPN capture, including any fingerprint correction. The root plan
  and Phase 1 now say the same.
- **2026-09-29, repair round 4:** consumes Phase 3's new pilot invariant. Until this phase's
  flip, a non-enrolled Upstart Mac never sends, even if its Product analytics destination was on
  before detection. The default-on rule is now stated as the only transition that replaces the
  invariant.
