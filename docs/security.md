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

Managed Pi project trust uses this same local control boundary. The shared answer flow
refuses trust answers attributed to Foreman; its `by` field records the cooperating caller,
not an authenticated human identity. It does not isolate trust from other code running as
the operator's OS user, which can also modify Pi's own trust store directly. Pi remains the
sole owner of that store.

Two subsystems act outside this machine, and both are off until you separately arm them
and name the repositories they may act in: the [GitHub Inspector](inspector-and-shipping.md#inspector-automated-pr-review),
which comments on pull requests under your GitHub account, and
[YOLO mode](inspector-and-shipping.md#shipping-yolo-mode), which merges them. Their allowlists are deliberately
separate - trusting an automated reviewer to comment in a repo is not the same act as
letting it push to that repo's base branch.

A configured [task source](dispatch-and-backlog.md#task-sources-pulling-work-into-the-backlog)
may also **write to its own upstream**, and it is off on the same terms. Its three
[write-back](dispatch-and-backlog.md#writing-back-to-the-source) switches ship off per
source, are re-read at delivery as well as when the work is observed, and reach only the
items that source itself swept. Nothing about writing relaxes a rule that governs reading:
the same credential the sweep uses does the write, no new token or host is introduced, and
every egress guard the read path applies applies here unchanged.

## Public product issue reporting

Product reports are public GitHub issues, not private support messages. The agent tool is defined
for use only after the user explicitly requests a report, shows the daemon-derived public content in an
`input` review, and calls the mutation route only after a human selects **Submit public issue**.
Dismissed, orphaned, free-form, malformed, and non-human review answers publish nothing.

The dashboard's [Feedback form](ui.md#report-product-feedback) publishes from one **Report
publicly** press. The context-isolated Electron preload captures the trusted click on that exact
control through a capability claimed once as the authorization module loads and retained only in
that module's closure, outside the React hot-refresh boundary. The owned control requires a
trusted native click before it uses the capability with the current preview's request id and
draft identity. Synthetic clicks, implicit form submits,
and page scripts without that capability cannot arm a report. The shell accepts the request only
from the main
dashboard web contents, with the preload requiring a trusted click still in dispatch.
A held press remains valid even if Chromium's transient user activation expires before release;
synthetic clicks and calls after dispatch ends remain refused. It shows no
second dialog. The daemon then asks
the shell to consume that exact request id and draft identity over the private utility-process
port. An authorization is short-lived and single-use, so another loopback process can preview and
call the confirmation route but cannot produce the private reply that mints a grant.

The daemon keeps preview and mutation separate internally. Previewing never returns a publish
token. After the shell authorizes the Report click, the daemon mints a grant pinned to one report
opening and exact derived content, valid for two minutes, and single-use. Re-deriving target,
labels, source, environment and body at submission prevents a configuration change between
preview and publication from sending content the form did not show. The request id and submission
claim prevent double-clicks and replays from creating duplicate issues.

**Dashboard reporting outside the desktop shell publishes nothing.** A standalone browser or adopted daemon
has no private utility-process channel, so preflight reports that the report must be opened in the
desktop app. It never falls back to an HTTP value that another local process could reproduce.

The agent path is separate and token-guarded, and requires an active session. After an explicit
user request, `report_product_issue` previews through MCP and waits for a human-submitted `input`
review before it publishes. There is no MCP path that publishes without that review. The preview
does not mint a dashboard grant.

Screenshots use daemon-issued upload locators, never caller-supplied filesystem paths. The daemon
resolves every locator again immediately before publication, refuses symlinks and paths outside
its upload store, re-sniffs the bytes, and enforces five-image, 10 MB per-image, and 25 MB aggregate
limits before constructing one repeated `--attach <absolute path>` pair per image. The shipped
adapter accepts PNG, JPEG, GIF, and WebP only, even though GitHub CLI also supports video and SVG.

The daemon owns the destination, the fixed type and triage labels, and the dashboard or agent
source label. Requests cannot supply routing metadata. The destination defaults to
`teamupstart/mission-control`; the optional environment override accepts only one exact
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


## Delegated session control

The per-session **Control other sessions** grant is opt-in and held by the Registry for the
current daemon run. Its identity includes the process, native conversation id, working
directory, work episode and task. Exactly two things create a grant, and both are a trusted
click in the desktop dashboard: the session's own control menu, and the **Launch** click for a
resident profile whose pinned revision turns **Control other sessions** on (see
[Resident launch grants](#resident-launch-grants)). Dispatch defaults, a launch from any other
surface and session-control tools cannot create one. Resetting or replacing that identity
revokes it.

The MCP read/action endpoints require both the machine token and the existing signed
Registry session credential. A public session id, working directory, task credential, or
machine token alone cannot select a controller. The daemon checks the current grant and
live credential binding on every request, then translates a closed set of typed operations
into the same handlers the dashboard uses. It verifies review ownership before resolution,
retains item ownership and revision guards, and stamps the controller's identity itself.
Delegated review and prompt attribution is attached to the exact in-process request after
verification, never accepted from HTTP headers or a `by: "session:..."` body. Direct answer
routes retain their human/Foreman grammar. Delegated single-option selections require the
request id returned by the target read, so an identical option on a replacement prompt does
not accept a stale answer. Message routes likewise reject a caller-supplied `origin: "session"`;
only the verified internal request receives the delegated message label.
Changing the grant requires a trusted click on the desktop dashboard's session-control menu. A private
preload capability arms the exact session id, desired setting and one-use request id in the
Electron shell. The daemon consumes that authorization over its private utility-process
channel and rechecks the conversation identity before applying it. Authorizations expire
after 15 seconds and cannot be replayed. Headerless local HTTP, forged browser headers,
the shared machine token and signed agent credentials cannot create a grant.

The standalone browser dashboard cannot change this setting. A desktop app that adopted
an independently launched daemon also refuses changes, because it has no private channel
to that daemon. Stop the standalone daemon and reopen the app to use the menu.

### Resident launch grants

A resident profile's **Control other sessions** setting is off by default and grants nothing on
its own. It lets one thing give a resident run the grant above: the operator's **Launch** click
in the desktop app.

- **The click.** Inside the click, before the launch request is sent, the dashboard arms a
  single-use authorization bound to that launch's request id, the profile id and the profile
  revision. It uses the same private preload capability and trusted-click check as the session
  menu, through its own channel registered with `serveDashboardClick`. It expires after 15
  seconds and is cleared when the daemon is replaced.
- **The consumption.** Only the resident launch route asks the shell for it, over the private
  utility-process channel. It asks once, for the request that reserved the run, when the run's
  pinned revision turns control on, and for the revision the run pinned. A request carrying the
  machine token, a signed agent credential, an agent actor header or a non-loopback origin never
  consumes a click. A replay is answered from the run row and asks for nothing.
- **The grant.** The daemon records on the run (`resident_runs`) when the click was consumed. It
  then applies the existing Registry grant to the run's session once that session has a full
  identity bound to the run's task, and records the conversation, working directory and work
  episode it applied to before it writes the grant's audit event. If the grant cannot be
  applied, or its identity cannot be recorded, the live grant is taken back and the run's record
  is cleared, so the launch reports that it started without control. A launch that answers
  before the session has a full identity reports the grant as not granted yet; if the daemon
  restarts before it is applied, the consumed click is cleared and the run stays ungranted.
- **After a restart.** This is the one grant that survives a daemon restart, and only for the
  same conversation. After SDK restore it is applied again only when all four recorded fields are
  set and the restored session's conversation, working directory, work episode and task all
  match them. The process id is the only part of the identity a restart changes, and the only
  part not compared. A clear, a new conversation, a changed working directory, a replacement work
  episode or a launch on a new profile revision needs a new click. A grant that no longer matches
  is forgotten, and runs from before these records existed stay ungranted.
- **Revocation.** Turning control off from the session's menu revokes the grant and clears the
  record, so a restart cannot restore it.

A launch from the standalone browser, from a desktop app that adopted a standalone daemon, or
from any caller other than that click starts without control. Dispatch, the Residents dock and
the Console band say so, and the session's menu stays the only way to grant control afterwards.

Workflow MCP tools use the same live signed caller identity. Self workflow reads and actions
are available without the grant; cross-session access requires **Control other sessions** on
the caller. The daemon checks binding session and conversation identity, filters ownership
before list pagination, and checks both ends of reattachment plus delivery packet destinations.
Unknown or historical targets require delegation. The shared machine token alone grants no
workflow MCP access. Existing manager checks still enforce submission/run matching, replay keys,
round budgets, confirmation phrases, and evidence policy.

This is an authorization boundary for Mission Control tools within the existing single-user
local trust model. It is not a sandbox against arbitrary shell code running as the operator,
which already has access to other local dashboard actions and operator-owned files. The
private click boundary specifically prevents local HTTP from self-granting this capability;
it does not protect against OS-level UI automation or a compromised desktop process. Revocation
refuses new requests; it does not undo an action already accepted by a runtime.

## Resident MCP secrets

A custom MCP server's secret values - environment variables and headers marked **Secret**, and
every URL query value - are write-only. They are accepted on a save and never returned: every
route answers with the field's name and whether it is set. They are kept apart from the
definition, which lives in `app_config` (`residents.mcpServers`) and travels with settings
snapshots, in the `resident_mcp_secrets` table, which no route, SSE frame, settings snapshot or
log reads.

A global server's configuration does not say which of its parts are credentials, so all of it is
treated as private: the catalog the dashboard sees carries only its name, transport, command
basename or URL origin, and the names of its environment variables and headers.

At launch a run copies its servers' definitions and values once, into `resident_run_mcp_servers`
and `resident_run_mcp_secrets`. Both are daemon-private like the secrets table, read again only by
that run's starts, and removed when the run ends.

**No secret on a command line, in a configuration file or in the agent's environment.** Each
harness's MCP configuration is passed as process arguments (Claude Code's `--mcp-config`) or
written to a file (the Codex overlay's `config.toml`), and whatever enters the agent's
environment is inherited by every shell and tool it runs. So a global server, and a custom server
with any secret, is rendered as an entry for Mission's scoped launcher, whose arguments name only
the run, the server's name and a credential file:

- For each process start the daemon writes one credential file per launcher entry in the run's
  private directory: owner-only, created exclusively, holding a single-use ticket bound to that
  run, that server and that start, which expires 30 seconds later. The daemon removes any file left
  unredeemed once its ticket expires, and every such file at startup.
- The launcher reads its file, removes it, and redeems the ticket over the loopback API
  (`POST /api/residents/mcp/redeem`). The ticket is the whole credential and is spent on first
  presentation, whatever the outcome. The answer is that one server's definition and values.
- A stdio server is started with its values in its own environment only. For an HTTP server the
  launcher is a stdio bridge that adds the headers and query values to every request itself.
- A missing, spent or expired ticket, or a run that has ended, starts nothing.

Native environment references - Codex's `env_vars`, `bearer_token_env_var` and
`env_http_headers`, and a Claude Code `${VAR}` that names a set variable - read the environment
the agent itself inherits, so a global server that uses one is not available to residents: its
value would already be readable by the agent's shells. So is a global server with a credential-shaped argument, or one whose
authentication the harness holds (an OAuth login). A custom server's argument in a credential
form is refused when it is saved; detection is a guard rather than a proof, which is why the
editor says arguments are stored and backed up as written.

**Backups.** Settings snapshots carry custom server definitions without their values. A
full-database recovery point is scrubbed of both secret tables before it is published, and every
global server's definition in a run snapshot is redacted in place, with the freed pages
overwritten. A restored database shows those secrets as not set, and a restored run whose snapshot
lost a secret or a definition refuses to start that server rather than start it without it.

This boundary is what the agent is handed - its environment, arguments, configuration and
transcript - and it was measured on real Claude Code and Codex installations
(`scripts/probe-resident-mcp.ts`). A credential file's path is metadata, not a secret. Mission
Control does not claim an operating-system sandbox against a process running as the same user as
the daemon, which could read an owner-only file before the launcher does.
