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

The dashboard's [Feedback form](ui.md#report-product-feedback) publishes only after a person
answers a native dialog, and the daemon is the one that asks.

Why it has to work that way is the interesting part, because three earlier designs did not. Every
`/api/*` route is loopback-reachable and unauthenticated, so anything the dashboard can send, a
process running as the operator can send too. That defeats any confirmation the caller
**presents**. The first design authorized with the preview's `draftIdentity`, a hash of the
request that anything holding the draft can recompute. The second minted a random token and
returned it in the preview reply - unguessable, but obtainable by calling preview, which is a read
the form issues on every settled keystroke. The third required the per-machine bearer token from
`~/.mission-control/token`, and that failed for the sharpest reason of the three: the token is a
file, a process running as the operator can read it, and **possession is not attestation**.

So the daemon stopped trying to authenticate the caller. `POST /api/product-issues/confirm`
authenticates nobody and grants nothing by itself. It asks the desktop shell to put a system
dialog naming the target repository in front of the operator, over the Electron utility-process
port the daemon was forked on - not a route, not a socket, not a file - and mints a grant only if
the reply says a person clicked publish. A local script may call the route as often as it likes:
every call raises a dialog on somebody's screen, and no click means no grant. The verifier is the
daemon, and what it verifies is an event outside the API rather than a value inside a request.

The grant that comes back is then pinned to one report opening and to the exact content the daemon
derived for it, valid two minutes, and single-use. Three checks run at submission. The grant
establishes that somebody said yes. Its expiry establishes that they said so recently, rather than
an old approval being banked and spent later. Re-deriving target, labels, source, environment and
body and comparing them against what the grant was minted for establishes that the daemon's own
derivation has not moved since - so an operator repointing the target between the moment somebody
reads the preview and the moment they press is refused rather than published into a repository
nobody was shown. The grant is retired once a submission using it reaches a terminal outcome, so a
publish cannot be replayed, while a retry-safe refusal keeps it because nothing was published.

**A daemon nobody can ask publishes nothing.** Started outside the desktop shell - `npm run dev`,
a LaunchAgent, a test - there is no dialog to raise, so preflight reports `consent-unavailable`
and the form says so before anything is typed. It still previews the exact public content, which
is a read and always was safe. The fallback is refusal, never a weaker confirmation the daemon
could satisfy on its own.

**What remains true.** This does not identify who is at the machine: one human at the keyboard is
the unit here, as it is for every other confirmation in this app. Somebody with a session on the
operator's desktop can click the dialog, and nothing software-side changes that. What is gone is
the class of attack the reviews were about - a process that can reach the loopback API, or read a
file, publishing without anybody seeing it. The blast radius is bounded further by the fixed target
repository, which no request can name, and by `gh auth`, which the operator owns.

The agent path is separate and stricter - it is token-guarded, neither preview mints a grant, there
is no MCP confirming route at all, and its authorization is the human-submitted `input` review.

Screenshots stay unavailable in the browser, and the disabled markup is not the boundary - the
server's attachment gate is.

The daemon owns the destination, the fixed type and triage labels, and the dashboard or agent
source label. Requests cannot supply routing metadata. The destination defaults to
`mancej-cyc/mission-control-issues`; the optional environment override accepts only one exact
`owner/name` value and cannot be changed per report. The issue body contains only reporter-authored
details plus an allowlisted Mission Control version, OS family, architecture, browser or Electron
client value, and a versioned marker. Mission Control does not collect logs, paths, session text,
tokens, account data, or other process environment for a report.

Issue creation uses the installed `gh` binary and its existing authentication. Mission Control
stores no GitHub token and sends the body on standard input instead of the process argument list.
The production attachment capability has no operator override and rejects every non-empty upload
list before starting `gh`. The anticipated image adapter exists only behind an injected test
capability until stable first-party CLI attachment support is released and verified. A CLI refusal
is safe to retry after correction; a timeout, signal, or success response without an issue URL is
reported as unknown and blocks another submission for that report opening.

Enabling screenshots is a separate, evidence-gated piece of work and is **not** something a
report submission can bring about. A recurring Mission Control mission checks weekly, at 09:00
Monday `America/New_York`, whether the GitHub CLI has actually shipped attachment support: it
requires a **stable** release plus the official manual documenting the final argument, not merely
a closed upstream issue, and it records its evidence and mutates nothing when any of that fails.
When the checks do pass it files one deterministically-titled follow-up task, treating an already
active task or an open pull request for that title as a no-op so a weekly cadence cannot produce a
weekly duplicate, and it archives itself only after that task completes and its pull request
merges. Reporting a product issue creates none of this - not the public repository, not its eight
labels, not the [task source](dispatch-and-backlog.md#sweeping-the-public-product-feedback-tracker)
that sweeps it, and not this monitor. Each is an operator setup step.

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
