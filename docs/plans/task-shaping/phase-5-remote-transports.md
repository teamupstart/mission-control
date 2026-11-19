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
  `src/server/residents/mcp-launcher.ts`.
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
     resolved for an `{env:NAME}` reference with `[NAME redacted]`. That covers every string
     in a successful reply, keys included (entry ids, paths, titles and bodies,
     `repo.summary`, `repo.facts`, `notes`, `version`), and a failure reason. Follow
     `redactClaimValues` in `src/server/worktrees/claim.ts`: find every match in the original
     text first, so a value inside or overlapping another is still covered.
   - **Mark.** A reply that was changed is returned with `redacted: true`, which the engine
     records on that shaper. The outcome does not change, and the rest of the reply is used.
   - **Scope.** Only values resolved for `{env:NAME}` references are scrubbed. `{caller.*}`
     values are not secrets. A variable a local server receives through `env` pass-through is
     not a reference, and that server's output is not scrubbed of it.
2. **Fail closed.** A transport that cannot resolve a reference makes no call and answers
   `unavailable`, naming the reference.
3. **`http`.** `POST` the request as JSON with the resolved headers. HTTPS unless the host is
   loopback. Redirects by hand, same origin only. Read at most 256 KiB. A status outside 2xx is
   `failed`, with the status. The deadline aborts the request.
4. **`mcp`.** Connect, call the configured tool once per repository, close at the end of the
   run. The arguments depend on `contextDelivery`, as `plan.md` defines. Either way the
   complete collected input reaches the tool, and there is no mode that omits it.
   - `folded` (default): exactly three arguments,
     `{ task, repo: { name, facts?, summary? }, version? }`, the FR-02 `get_guidance` input.
     `task` is the prompt followed by one fixed block that states every other collected
     field: title, kind, harness and runtime, after-work step, labels, priority, and each
     attached repository with its role and branch.
   - `argument`: four arguments,
     `{ task, repo: { name, facts?, summary? }, version?, context }`. `task` is the prompt
     alone, and `context` is the request's whole `context` object.

   Render the folded block with one pure function, so a test can pin its text. Read the reply from the
   structured content when it is an object, otherwise from the first text content parsed as
   JSON. A tool error is `failed`, with its text, bounded.
5. **Reply field.** `GET /api/shaping` returns `references` from `referenceStatus`.
6. **Docs.** Fill "Remote shapers" in `docs/task-shaping.md`, with a worked example that
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
  in an entry body, a title, the summary, a fact name, a fact value and a note, one value
  inside another, and a reply with no value, which comes back unchanged and unmarked.
- `test/shaping-transport-http.test.ts`, against a loopback server: success, a non-2xx
  status, a redirect off the origin, the HTTPS rule, the body cap, a timeout, resolved headers,
  a reply that echoes a resolved header value, which comes back redacted and marked, and no
  request when a reference is missing.
- `test/shaping-transport-mcp.test.ts`, against `test/fixtures/fake-guidance-mcp.mjs` (a local
  server with a `get_guidance` tool): exactly three arguments in `folded` mode and exactly four, the fourth being `context`, in
  `argument` mode,
  that every collected field of a two-repository task (title, kind, harness, runtime,
  after-work step, labels, priority, both repositories) reaches the tool in each mode,
  structured and text replies, a tool error, a timeout, a `degraded: true` reply passed
  through, one server process for a run over two repositories, and the same calls over
  streamable HTTP. Over streamable HTTP the fixture also has an echo mode that returns a
  header value it received inside a guidance body, and the transport redacts and marks it.
- `test/shaping-http.test.ts` gains the `references` field and a dry-run of the fixture
  selector, including one in echo mode whose reply carries `[NAME redacted]` and never the
  value.
- Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` and `npm run smoke`.

## Merge and exit criteria

- Registering the fixture `get_guidance` tool through the API and dry-running it returns its
  guidance, with no code beyond configuration.
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
