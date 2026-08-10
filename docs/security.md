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
