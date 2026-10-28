# Pi telemetry setup

In **Settings > Setup > Agent CLIs**, the optional **Pi OpenTelemetry extension** item follows
Pi. It links to these instructions and checks installation when you press **Re-check**. Mission
Control never installs this private package, changes Pi settings, or enables its exporter on
your behalf. Pi works without it. This is separate from the [Mission Control Pi integration](pi-extension.md)
that provides tools and lifecycle reporting.

## Before installing

The separately maintained [`@upstart/pi-router-otel`](https://github.com/nigel-upstart/pi-buildout/tree/main/packages/pi-router-otel)
package loads both the Pi router and the same vendored OTel extension used in `pi-buildout`;
it is not telemetry-only. It is **not** a Mission Control npm dependency or part of the app bundle. Pi discovers it from its own agent
home, including when Mission Control embeds Pi's SDK. Install it only in the Pi home the daemon
will actually use (`PI_CODING_AGENT_DIR`, or Pi's default home), after reviewing the package's
full-content capture default and removing any separately installed `npm:pi-otel` to avoid
duplicate instrumentation.

Use the AWS CLI with a read-only CodeArtifact profile; UMT is not required. The subshell below
removes its temporary npm configuration and credentials when it finishes, including on failure.
Only `@upstart` is routed to CodeArtifact; public npm resolution is unchanged:

```sh
(
  set -eu
  export AWS_PROFILE=YOUR_CODEARTIFACT_READONLY_PROFILE
  CODEARTIFACT_AUTH_TOKEN="$(aws codeartifact get-authorization-token \
    --domain code-artifacts-prod --domain-owner 801997600626 --region us-east-1 \
    --query authorizationToken --output text)"
  NPM_CONFIG_USERCONFIG="$(mktemp)"
  export CODEARTIFACT_AUTH_TOKEN NPM_CONFIG_USERCONFIG
  trap 'rm -f "$NPM_CONFIG_USERCONFIG"' EXIT
  chmod 600 "$NPM_CONFIG_USERCONFIG"
  printf '%s\n' \
    '@upstart:registry=https://code-artifacts-prod-801997600626.d.codeartifact.us-east-1.amazonaws.com/npm/npm-prod/' \
    '//code-artifacts-prod-801997600626.d.codeartifact.us-east-1.amazonaws.com/npm/npm-prod/:_authToken=${CODEARTIFACT_AUTH_TOKEN}' \
    > "$NPM_CONFIG_USERCONFIG"
  pi install npm:@upstart/pi-router-otel@0.1.1-alpha.4
  pi list
)
```

For isolated validation, set `PI_CODING_AGENT_DIR` to a disposable directory before installing.
If UMT is already installed, `umt artifacts --tools npm` is an alternative authentication
setup; do not combine its persistent npm config with the temporary override above. See the
[Pi package consumer instructions](https://github.com/nigel-upstart/pi-buildout/blob/main/packages/README.md#consumer-setup-read-only).
The package defaults to `https://corp-otel-staging-1.upstart.com` with OTLP HTTP/protobuf and
all three signals enabled. `PI_OTEL_DISABLED=1` disables it; `OTEL_EXPORTER_OTLP_ENDPOINT`
overrides its destination. The staging gateway is VPN/IP restricted, unlike a local sink.

## Verify and opt out

- Press **Re-check** in Setup after installing. The row checks user-level registration, the
  installed package manifest and a readable, nonempty OTel entry in the Pi agent directory.
  It does not execute package code, call a model, contact npm or verify downstream indexing.
- The check uses the daemon's `PI_CODING_AGENT_DIR`, or `~/.pi/agent`. Use that same directory
  for `pi install`; a terminal using another home does not repair the daemon's installation.
- Disabled package autoload, a filtered entry, duplicate declarations, unreadable or truncated settings, an
  unsupported manifest, a non-exact version range/tag or a separate `npm:pi-otel` registration
  reports **Unknown**, not Ready. An installed version that differs from its registered pin
  reports **Needs setup**.
  Custom checkout/git installations and project-only installs are outside this check.
- In a fresh Pi session, run `/otel status` to see effective enablement, signal export health
  and the destination. Project configuration and process environment can override the
  installation's defaults. Restart Mission Control before checking its embedded Pi sessions
  after an install or resource change.
- Set `PI_OTEL_DISABLED=1` in the launching environment or `otel.enabled=false` in Pi settings
  to stop exports. Installation readiness is not a claim that exports are enabled. To remove
  the package, use `pi remove npm:@upstart/pi-router-otel@0.1.1-alpha.4`.

## Build and runtime boundary

This is an explicit runtime install, not a Mission Control npm dependency. Builds and GitHub
Actions do not need CodeArtifact credentials and do not fetch or execute the package. Pi
exports directly through its own extension; Mission Control does not proxy, route or count
those exports.
