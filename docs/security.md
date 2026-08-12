# Security

The daemon binds to loopback only, and every data endpoint (`/api/*`, `/events`)
additionally requires a loopback `Host` header so a web page you visit can't reach
it via DNS-rebinding - a defense that matters now that dispatch can launch agents
(effectively RCE) and reads leak task prompts, repo paths, and transcripts. Hook,
statusLine, OTLP metrics (`/v1/metrics`) and MCP ingress are authenticated with a
per-machine token in `~/.mission-control/token` so other local processes can't spoof
session, task, or cost-estimate state. Cost datapoints arrive carrying `user.email`,
`user.account_uuid`, `user.account_id` and `organization.id`; the ingest reads four
attributes and discards the rest before anything is written, so none of it reaches the
database. Session and task
actions (send / rename / focus / kill, dispatch / cancel / complete) are localhost-only.

Two subsystems act outside this machine, and both are off until you separately arm them
and name the repositories they may act in: the [Inspector](inspector-and-shipping.md#inspector-automated-pr-review),
which comments on pull requests under your GitHub account, and
[YOLO mode](inspector-and-shipping.md#shipping-yolo-mode), which merges them. Their allowlists are deliberately
separate - trusting an automated reviewer to comment in a repo is not the same act as
letting it push to that repo's base branch.

[Scout archives](scout-archives.md) are local files under `~/.mission-control/scouts`, and
Mission Control never sends one anywhere. Three properties keep them from becoming a way in.
A bundle copied into the library is untrusted input: its manifest is validated for version,
generated identity, path containment, size limits, and digests before a row is written, and
nothing in it may authorize a path - the daemon generates every path it opens from an archive
key it decoded itself, and re-verifies containment on every read. An archived report may not
execute or fetch: a non-executing HTML parser - run with scripting disabled, so `<noscript>`
content is checked as the markup a JavaScript-off browser would act on - refuses scripts,
event handlers, forms, frames, embeds, meta refresh, SVG animation that could rewrite a
checked attribute, external and protocol-relative URLs in every URL-bearing attribute and
inside stylesheets, and any relative link that leaves the report directory. It also refuses
anything that would re-root relative resolution - `<base>` and `xml:base` - because a
contained-looking reference under a moved base is a request the containment check cannot
see.
Artifact bodies are served as attachments with `nosniff` and a `default-src 'none'; sandbox`
policy rather than rendered on the daemon's origin, streamed from the handle the containment
check opened rather than reopened by name. And a
producer label in a foreign manifest is a descriptive claim, never an authenticated identity;
there is no signing and no trust badge.

What that does not cover is the content itself. Mission Control does not encrypt the scout
library, an archive can hold whatever the investigation touched, and a synchronised folder
takes its contents wherever it goes. Deletion is explicit and local.
