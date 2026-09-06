# Security

The daemon binds to loopback only, and every data endpoint (`/api/*`, `/events`)
additionally requires a loopback `Host` header so a web page you visit can't reach
it via DNS-rebinding - a defense that matters now that dispatch can launch agents
(effectively RCE) and reads leak task prompts, repo paths, and transcripts. Hook,
statusLine, OTLP metrics (`/v1/metrics`), pipeline events (`/ingest/conductor`) and MCP
ingress are authenticated with a
per-machine token in `~/.mission-control/token` so other local processes can't spoof
session, task, or cost-estimate state. Pipeline ingest carries a second gate on top of the
token, because its producer is a plugin running inside another program: a pushed event
naming a repository the operator has not switched on in Settings is counted and dropped
rather than stored, so the push path cannot start observing a checkout that consent did not
already cover. Within a consented repository it may only address runs that exist: a pushed
`slug` is checked against the worktrees the engine is actually driving, because the event
ledger is bounded by retiring rows with the runs a pass enumerates, and rows filed under a
slug no pass can produce are rows nothing would retire. See
[Pipelines](pipelines.md#the-route). Cost datapoints arrive carrying `user.email`,
`user.account_uuid`, `user.account_id` and `organization.id`; the ingest reads four
attributes and discards the rest before anything is written, so none of it reaches the
database. Session and task
actions (send / rename / focus / kill, dispatch / cancel / complete) are localhost-only.

Two subsystems act outside this machine, and both are off until you separately arm them
and name the repositories they may act in: the [GitHub Inspector](inspector-and-shipping.md#inspector-automated-pr-review),
which comments on pull requests under your GitHub account, and
[YOLO mode](inspector-and-shipping.md#shipping-yolo-mode), which merges them. Their allowlists are deliberately
separate - trusting an automated reviewer to comment in a repo is not the same act as
letting it push to that repo's base branch.

## Public product issue reporting

Product reports are public GitHub issues, not private support messages. The agent tool is defined
for use only after the user explicitly requests a report, shows the daemon-derived public content in an
`input` review, and calls the mutation route only after a human selects **Submit public issue**.
Dismissed, orphaned, free-form, malformed, and non-human review answers publish nothing.

The dashboard's [Feedback form](ui.md#report-product-feedback) publishes from one **Report
publicly** press. The daemon keeps preview and mutation separate internally: previewing never
returns a publish token, while the Report press requests a short-lived grant for the exact rendered
derivation and immediately spends it. The grant is pinned to one report opening and exact derived
content, valid for two minutes, and single-use. Re-deriving target, labels, source, environment and
body at submission prevents a configuration change between preview and publication from sending
content the form did not show. The request id and submission claim prevent double-clicks and
replays from creating duplicate issues.

The dashboard route is loopback-only but not authenticated. A process running as the operator can
reproduce the same confirm-and-submit requests as the dashboard, so the one-click flow is not human
attestation. Its blast radius is bounded by the fixed configured target, daemon-owned labels and
body generation, strict request limits, `gh` authentication, and the duplicate guards above. No
dashboard request can choose another repository or inject labels, environment data, or local
filesystem paths.

The agent path is separate and stricter - it is token-guarded, neither preview mints a grant, there
is no MCP confirming route at all, and its authorization is the human-submitted `input` review.

Screenshots use daemon-issued upload locators, never caller-supplied filesystem paths. The daemon
resolves every locator again immediately before publication, refuses symlinks and paths outside
its upload store, re-sniffs the bytes, and enforces five-image, 10 MB per-image, and 25 MB aggregate
limits before constructing one repeated `--attach <absolute path>` pair per image. The shipped
adapter accepts PNG, JPEG, GIF, and WebP only, even though GitHub CLI also supports video and SVG.

The daemon owns the destination, the fixed type and triage labels, and the dashboard or agent
source label. Requests cannot supply routing metadata. The destination defaults to
`mancej-cyc/mission-control-issues`; the optional environment override accepts only one exact
`owner/name` value and cannot be changed per report. The issue body contains only reporter-authored
details plus an allowlisted Mission Control version, OS family, architecture, browser or Electron
client value, and a versioned marker. Mission Control does not collect logs, paths, session text,
tokens, account data, or other process environment for a report.

Issue creation uses the installed `gh` binary and its existing authentication. Mission Control
stores no GitHub token and sends the body on standard input instead of the process argument list.
Screenshot publication requires stable GitHub CLI 2.99.0 or newer. Older versions keep text-only
reports available and cannot receive attachment arguments. A non-zero CLI result without an issue
URL is safe to retry after correction for a text-only report. Released GitHub CLI 2.99 was verified
to return non-zero after a partial upload while printing the created issue URL on stdout and the
upload error on stderr. Mission Control accepts that URL only when its issue path matches the fixed
target repository, reports the issue as created with a warning, and never invites a duplicate
retry. A timeout, signal, attachment failure without a matching target issue URL, or success
response without that URL is reported as unknown and blocks another submission for that opening.

Reporting a product issue creates no repository, labels, schedule, or task source. Those remain
operator setup steps. The upstream attachment monitor remains enabled until this implementation's
pull request has merged; only a later checker may then archive its history.

[Archives](archives.md) are local files under `~/.mission-control/archives`, and
Mission Control never sends one anywhere. Three properties keep them from becoming a way in.
A bundle copied into the library is untrusted input: its manifest is validated for version,
generated identity, path containment, size limits, and digests before a row is written, and
nothing in it may authorize a path - the daemon generates every path it opens from an archive
key it decoded itself, and re-verifies containment on every read. An archived report may not
execute or fetch: a non-executing HTML parser - run with scripting disabled, so `<noscript>`
content is checked as the markup a JavaScript-off browser would act on - refuses scripts,
event handlers, forms, frames, embeds, meta refresh, SVG animation that could rewrite a
checked attribute, protocol-relative URLs, every URL scheme in every slot the browser fetches
on its own (including `ping` and everything inside stylesheets), and any relative link that
leaves the report directory. It also refuses anything that would re-root relative resolution -
`<base>` and `xml:base` - because a contained-looking reference under a moved base is a
request the containment check cannot see. What it does allow is an `http(s)` link a person
CLICKS, because that is the boundary the rest of this paragraph is drawn on: opening an
archive somebody sent you must not make a request, and a link makes none until you follow it,
in your own browser, to an address it shows you.
Artifact bodies are served as attachments with `nosniff` and a `default-src 'none'; sandbox`
policy rather than rendered on the daemon's origin, streamed from the handle the containment
check opened rather than reopened by name. And a
producer label in a foreign manifest is a descriptive claim, never an authenticated identity;
there is no signing and no trust badge.

What that does not cover is the content itself. Mission Control does not encrypt the scout
library, an archive can hold whatever the investigation touched, and a synchronised folder
takes its contents wherever it goes. Deletion is explicit and local.
