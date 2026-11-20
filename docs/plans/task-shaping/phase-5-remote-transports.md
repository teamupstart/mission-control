# Task shaping - Phase 5: Remote transports

## Outcome

A shaper can be a tool on an MCP server or an HTTP endpoint. Registering a `get_guidance` tool
as a selector is configuration only, with no adapter code. Header references resolve when the
call is made, fail closed when one is missing, and never expose a value.

## Entry criteria and dependencies

- Phase 1 is merged. It can be built at the same time as phases 2, 3, 4 and 6.

## Scope

- `src/server/shaping/references.ts`: resolution and the set or not set status.
- `transports/mcp.ts`, over a local process and over streamable HTTP.
- `transports/http.ts`, and the egress rules both share.
- The `references` field of `GET /api/shaping`.

Not here: any dashboard change (Phase 3 renders the status from that field), verified
identity, stored secrets.

## Repository findings

- **SDK.** `@modelcontextprotocol/sdk` provides `Client`, `StdioClientTransport` and
  `StreamableHTTPClientTransport`. The last is already used in
  `src/server/residents/mcp-launcher.ts`. In SDK 1.32, `StdioClientTransport` takes a
  `maxBufferSize` (10 MiB by default) and reports an overflow through `onerror`.
  `StreamableHTTPClientTransport` has no size limit, and takes a `fetch` option.
- **Egress.** That file exports `fetchOnOrigin`, which follows redirects by hand and refuses to
  leave the origin. `plaintextCredentialProblem` and `residentMcpLoopbackHost` in
  `src/shared/resident-mcp.ts` state the rule: HTTPS, except plain HTTP to loopback. Reuse
  them. Move a helper to a shared module if importing it from the launcher is awkward.
- **Processes.** A local MCP server is a child process the SDK starts. Resolve its command
  through `ExecutableLocator` first, pass the absolute path and the scrubbed environment, and
  check what `test/executable-contracts.test.ts` expects for it.
- **Timeouts.** `src/server/task-sources/jira.ts` combines a caller's signal with
  `AbortSignal.timeout`. Phase 1's transport `ctx` carries the deadline, a signal, and a
  per-run scope for reusing one connection.

## Steps

1. **References.** `resolveReferences(text, ctx)` replaces `{caller.user}`, `{caller.agent}`,
   `{caller.conversation}` and `{env:NAME}`, and reports the names it could not resolve. An
   empty value counts as unresolved. `referenceStatus` lists every environment name any shaper
   references, as set or unset. No resolved value is ever logged, stored or returned.
   - **Scrubbing.** `scrubResolved` enforces that for whatever a shaper sends back. Before a
     transport hands anything to the engine, it replaces every whole occurrence of a value it
     resolved for an `{env:NAME}` reference with `[NAME redacted]`, in every string value of
     a successful reply (entry paths, titles and bodies, `repo.summary`, fact values,
     `notes`, `version`) and in a failure reason. Keys the result schema defines are never
     changed, so a value that happens to appear in a field name such as `guidance` cannot
     invalidate a reply. Two kinds of string are identities, not text: a fact name and an
     entry `id`. One that contains a resolved value is dropped with its fact or entry and a
     note, never renamed, so redaction cannot make two facts or two entries collide and
     silently merge. Unknown fields are stripped by the result schema and are not kept. Follow
     `redactClaimValues` in `src/server/worktrees/claim.ts`: find every match in the original
     text first, so a value inside or overlapping another is still covered.
   - **Mark.** A reply that was changed is returned with `redacted: true`, whether it is a
     data reply or a failure whose reason was scrubbed, and the engine records it on that
     shaper. The outcome does not change, and the rest of a data reply is used.
   - **Scope.** Only values resolved for `{env:NAME}` references are scrubbed. `{caller.*}`
     values are not secrets. A variable a local server receives through `env` pass-through is
     not a reference, and that server's output is not scrubbed of it.
2. **Fail closed.** A transport that cannot resolve a reference makes no call and answers
   `unavailable`, naming the reference.
3. **`http`.** `POST` the request as JSON with the resolved headers. HTTPS unless the host is
   loopback, decided by `plaintextCredentialProblem` before anything is sent: a plain HTTP URL
   to another host gets no request and answers `unavailable`. This is the rule resident MCP
   servers follow, and both transports here apply it unchanged. A credential header may
   therefore travel over plain HTTP to loopback, where the request never leaves the machine,
   and never to another host. Redirects by hand, same origin only. Read at most 256 KiB. A status outside 2xx is
   `failed`, with the status. The deadline aborts the request.
4. **`mcp`.** Connect, call the configured tool once per repository, close at the end of the
   run. The arguments depend on `contextDelivery`, as `plan.md` defines. Either way the
   complete collected input reaches the tool, and there is no mode that omits it.
   - `folded` (default): exactly three arguments,
     `{ task, repo: { name, facts?, summary? }, version? }`, the FR-02 `get_guidance` input.
     `task` is the prompt followed by one fixed block that states every field of the
     request's `context` except local paths: the task id, title, kind, harness and runtime,
     the after-work step with its workflow id, labels, priority, the caller, and each
     attached repository with its role, branch and base commit.
   - `argument`: four arguments,
     `{ task, repo: { name, facts?, summary? }, version?, context }`. `task` is the prompt
     alone, and `context` is the request's whole `context` object.

   Render the folded block from the `context` object with one pure function, so a test can
   pin its text, and a second test that walks the context schema fails when a field has no
   line in the block. Read the reply from the structured content when it is an object, otherwise from the first text content parsed as
   JSON. A tool error is `failed`, with its text, bounded.

   **Size cap.** Every message from the server is capped at 256 KiB while it is received,
   the cap an `http` body has. On stdio, pass `maxBufferSize` of 256 KiB to
   `StdioClientTransport`. Over streamable HTTP, hand it a `fetch` that stops reading a
   response body, or one event of an event stream, at the cap and aborts the request.
   Either way the overflow reaches `onerror`, and the call answers `failed` at once, with a
   reason that names the cap, instead of waiting for the deadline. The server is closed, and
   nothing over the cap is parsed.
5. **Trace context.** With `ctx.trace` set every call carries it, and with none nothing is
   added. `http` sends `traceparent`, and `tracestate` when present, as request headers.
   `mcp` over streamable HTTP sends them on every request of the call, through the
   transport's `requestInit` headers, created once per run with the run's context. `mcp`
   over stdio starts the server with `TRACEPARENT` and `TRACESTATE` in its environment,
   through `withAgentTraceContext`. For both server types each `tools/call` also carries the
   two values in `params._meta`. They replace a configured header of the same name, compared
   without case. They are not references: `resolveReferences` and `referenceStatus` never
   see them, `scrubResolved` never redacts them, and a reply that echoes one keeps it.
6. **Reply field.** `GET /api/shaping` returns `references` from `referenceStatus`.
7. **Docs.** Fill "Remote shapers" in `docs/task-shaping.md`, with a worked example that
   registers a `get_guidance` tool under placeholder names. Add references and the daemon's
   environment to `docs/configuration.md`, and the egress rules to `docs/security.md`.

## Data, API and compatibility

- No schema change. The `mcp` and `http` config shapes were declared in Phase 1.
  `contextDelivery` has exactly two values, `folded` and `argument`.
- A local path is never sent to a remote shaper. Phase 1's request builder already omits paths
  for a transport that is not local. An `mcp` tool's `repo` argument never carries a path. In
  `argument` mode a server started as a local process receives worktree paths in
  `context.repositories`, and a remote server does not. Add a test that pins this for both
  transports here.
- Nothing company-specific: header names, tool names and URLs are all configuration.

## Tests and verification

- `test/shaping-references.test.ts`: each reference kind, a missing and an empty value, the
  status list, that no value appears in a reason, and `scrubResolved` over a reply: a value
  in an entry body, a title, the summary, a fact value and a note, which is redacted; a fact
  name and an entry id that contain it, which are dropped with a note; two fact names that
  differ only in their credential value, which are both dropped while every other fact is
  kept; a value that is part of a schema key such as `guidance`, which leaves the keys
  unchanged and the reply valid; one value inside another; and a reply with no value, which
  comes back unchanged and unmarked.
- `test/shaping-transport-http.test.ts`, against a loopback server: success, a non-2xx
  status, a redirect off the origin, the HTTPS rule (a plain HTTP URL to a host that is not
  loopback gets no request, with or without a credential header, and a loopback one is
  called), the body cap, a timeout, resolved headers,
  a reply that echoes a resolved header value, which comes back redacted and marked, and no
  request when a reference is missing.
- `test/shaping-transport-mcp.test.ts`, against `test/fixtures/fake-guidance-mcp.mjs` (a local
  server with a `get_guidance` tool): exactly three arguments in `folded` mode and exactly four, the fourth being `context`, in
  `argument` mode,
  that every collected field of a two-repository task (task id, title, kind, harness,
  runtime, the after-work step and its workflow id, labels, priority, the caller, and both
  repositories on the same branch name with different base commits, so a test can tell
  them apart) reaches the tool in each mode,
  structured and text replies, a tool error, a timeout, a reply over 256 KiB on each server
  type, which comes back `failed` at once without being parsed, a `degraded: true` reply passed
  through, one server process for a run over two repositories, and the same calls over
  streamable HTTP. Over streamable HTTP the fixture also has an echo mode that returns a
  header value it received inside a guidance body, and the transport redacts and marks it. A tool
  error whose text echoes that value comes back `failed`, with the reason scrubbed and the
  reply marked.
- Trace context, in both transport tests. With a trace set: `http` sends a well-formed
  `traceparent` header, and `tracestate` only when the context has one; streamable-HTTP `mcp`
  sends it on every request of a call; stdio `mcp` starts the server with `TRACEPARENT`, and
  each `tools/call` carries `params._meta.traceparent`. With none, no call carries either
  value. A configured `traceparent` header is replaced, and a reply that echoes the trace
  value comes back unredacted and unmarked.
- `test/shaping-http.test.ts` gains the `references` field and a dry-run of the fixture
  selector, including one in echo mode whose reply carries `[NAME redacted]` and never the
  value.
- Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` and `npm run smoke`.

## Merge and exit criteria

- Registering the fixture `get_guidance` tool through the API and dry-running it returns its
  guidance, with no code beyond configuration.
- Neither transport sends a request over plain HTTP to a host that is not loopback.
- No MCP message over 256 KiB is parsed, on either server type, and such a reply is
  `failed`.
- With a trace context set every `http` and `mcp` call carries a well-formed `traceparent`,
  and with none no call carries one.
- No value of an environment reference appears in any reply, log or record. That includes a
  successful reply that echoes one: the fixture's echoed value is absent from the engine's
  section and summary and from the dry-run reply, and the shaper is marked `redacted`.
- In both `contextDelivery` modes the tool receives the complete collected input, and no
  configuration can reduce it.
- In `folded` mode the fixture `get_guidance` tool is called with exactly its three FR-02
  arguments.

## Handoff

The FR-06 promotion registry (D10) may reuse `references.ts` and the egress helpers. Keep them
free of shaping-specific assumptions where that is cheap.

## Cross-phase audit

- Phase 1: uses the transport reply's `unavailable`, the `ctx` scope and the declared config
  shapes. Owns the `mcp` and `http` parts of D2 and the resolution half of D6.
- Phase 3: renders `references` and lists environment names at import. This phase supplies
  the data only.
- Phase 4: a discovered manifest with an `mcp` or `http` transport works with no change here.
- Plan validation repair, 2026-11-19: the mode that sent no context was removed, and `folded`
  now carries the whole collected input instead of three fields. An `mcp` shaper can no
  longer be configured to receive less than constraint C2 requires. Phase 1's schema was
  changed to match.
- Plan validation repair 3, 2026-11-19: step 4 gave one three-argument shape and then a mode
  that adds a fourth. Each mode now states its own shape: three in `folded`, four in
  `argument`. `plan.md` and `phased-plan.md` say the same.
- Review of the plan pull request, 2026-11-19, the operator's choice: step 1 scrubbed failure
  reasons only, so a shaper that echoed a resolved value in a valid reply could have put it in
  a worker's prompt, in the stored text and in a dry-run reply. Every reply is now scrubbed
  before it reaches the engine, and the shaper is marked `redacted`. Phase 1's transport
  reply and summary carry that mark, and Phase 2's viewer shows it.
- Review of the plan pull request, round 2, 2026-11-19: a failure reply can carry the mark
  too, so a scrubbed tool error is reported like a scrubbed data reply.
- Review of the plan pull request, round 3, 2026-11-19, the operator's direction: `plan.md`
  said a credential header is never sent over plain HTTP, while this phase reused the
  resident MCP helpers, which allow plain HTTP to loopback. The operator chose the resident
  rule. `plan.md` now states it, and step 3, the HTTP test and an exit criterion pin it.
- Review of the plan pull request, round 4, 2026-11-19: the `folded` block listed some
  fields of `context` and left out others, such as each repository's base commit and the
  after-work workflow id. It now renders every field except local paths, a schema-walking
  test keeps it complete, and the MCP test tells apart two repositories on one branch name.
- Review of the plan pull request, round 5, 2026-11-19: the `http` body had a 256 KiB cap and
  MCP messages had none. Step 4 now caps every MCP message while it is received, on both
  server types, and an oversized reply is `failed`.
- Review of the plan pull request, round 6, 2026-11-19: scrubbing every key could rename a
  schema field, or make two fact names identical and drop one silently. Schema keys are now
  never changed, and a fact name or entry id that contains a value is dropped, not renamed.
- Trace context, 2026-11-19, the operator's choice: step 5 carries the launch's W3C trace
  context on every `http` and `mcp` call, so a server such as a `get_guidance` tool can
  join the session's trace. It is not a credential and never redacted.
