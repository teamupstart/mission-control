import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CostSettingsPanel } from "../src/web/components/CostSettingsPanel.tsx";
import type { CostState } from "../src/web/useCost.ts";
import { CostConfigSchema } from "../src/shared/protocol.ts";
import type { CostManagedRedirect, CostTelemetryStatus } from "../src/shared/protocol.ts";

// What Settings > Cost says when an organization's managed Claude Code policy decides where
// Claude Code's metrics go.
//
// The panel used to wait a week of exporter silence and then guess that "a managed policy
// disables telemetry". A policy that REDIRECTS metrics is the common case, and its cause is
// known as soon as the daemon reads it, so the panel now names the host at once. Rendered as
// static markup for `shipping-panel-warnings`' reason: effects never run, so nothing fetches.

const STATUS: CostTelemetryStatus = {
  config: CostConfigSchema.parse({ enabled: true }),
  installed: true,
  receiving: true,
  exporterSilent: false,
  managedRedirect: null,
  sessionIdDisabled: false,
  settingsPath: "/Users/ada/.claude/settings.json",
};

function render(status: Partial<CostTelemetryStatus>): string {
  const state: CostState = { status: { ...STATUS, ...status }, update: async () => {}, error: null };
  return renderToStaticMarkup(createElement(CostSettingsPanel, { state }));
}

/** The text a person reads, with tags removed and whitespace collapsed. */
function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, " ");
}

const REDIRECT: CostManagedRedirect = {
  kind: "redirect",
  host: "corp-otel-staging-1.upstart.com",
  source: "mdm-user",
  organizationLabel: "Upstart",
};

const SILENT_WARNING = /has not exported telemetry to this daemon in the past week/;

test("a redirect on a recognized Mac names the organization and the host", () => {
  const html = render({ managedRedirect: REDIRECT, exporterSilent: true });
  assert.match(
    text(html),
    /Upstart's managed Claude Code policy sends metrics to corp-otel-staging-1\.upstart\.com, so the estimate covers only sessions Mission Control runs\. Sessions you started yourself in a terminal are not counted\./,
  );
  assert.match(html, /<p class="settings-error">[^]*<code>corp-otel-staging-1\.upstart\.com<\/code>/);
  // It replaces the generic warning, which could only guess at the cause - and guessed wrong.
  assert.doesNotMatch(text(html), SILENT_WARNING);
  assert.doesNotMatch(text(html), /disables telemetry/);
});

test("a redirect on any other managed Mac says your organization's", () => {
  const html = text(render({ managedRedirect: { ...REDIRECT, host: "otel.example.com", organizationLabel: null } }));
  assert.match(
    html,
    /Your organization's managed Claude Code policy sends metrics to otel\.example\.com, so the estimate covers only sessions Mission Control runs\./,
  );
});

test("the warning does not wait for a week of silence", () => {
  // `exporterSilent` false is every Mac in its first week: the cause is already known.
  assert.match(text(render({ managedRedirect: REDIRECT, exporterSilent: false })), /sends metrics to/);
});

test("a policy that turns metrics off says so, without a host", () => {
  const html = text(
    render({ managedRedirect: { kind: "disabled", host: null, source: "mdm", organizationLabel: null } }),
  );
  assert.match(
    html,
    /Your organization's managed Claude Code policy turns Claude Code's metrics off, so the estimate covers only sessions Mission Control runs\./,
  );
  assert.doesNotMatch(html, /sends metrics to/);
});

test("the first-run hint does not contradict the policy", () => {
  // "the env block only applies to sessions started after it was written" promises that new
  // sessions will report, which a redirecting policy guarantees they will not.
  const html = text(render({ managedRedirect: REDIRECT, receiving: false }));
  assert.match(html, /sends metrics to/);
  assert.doesNotMatch(html, /No Claude telemetry has reported yet/);
});

test("with Cost switched off, nothing about the policy is shown", () => {
  const html = text(
    render({
      managedRedirect: REDIRECT,
      config: { ...STATUS.config, enabled: false },
      installed: false,
    }),
  );
  assert.doesNotMatch(html, /managed Claude Code policy/);
});

test("with no managed policy, today's wording and gating are unchanged", () => {
  const silent = text(render({ exporterSilent: true }));
  assert.match(silent, SILENT_WARNING);
  assert.match(silent, /check that claude is current and that no managed policy disables telemetry\./);
  assert.doesNotMatch(silent, /managed Claude Code policy/);

  assert.doesNotMatch(text(render({ exporterSilent: false })), SILENT_WARNING);
  assert.match(text(render({ receiving: false })), /No Claude telemetry has reported yet/);
});
