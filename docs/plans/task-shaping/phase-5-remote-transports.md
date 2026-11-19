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
   references, as set or unset. No resolved value is ever logged, stored or returned, and
   failure reasons are scrubbed of them.
2. **Fail closed.** A transport that cannot resolve a reference makes no call and answers
   `unavailable`, naming the reference.
3. **`http`.** `POST` the request as JSON with the resolved headers. HTTPS unless the host is
   loopback. Redirects by hand, same origin only. Read at most 256 KiB. A status outside 2xx is
   `failed`, with the status. The deadline aborts the request.
4. **`mcp`.** Connect, call the configured tool once per repository, close at the end of the
   run. Arguments are `{ task, repo: { name, facts?, summary? }, version? }`. The complete
   collected input always reaches the tool, in one of the two `contextDelivery` modes that
   `plan.md` defines. `folded` (default) appends one fixed block to `task` that states every
   other collected field: title, kind, harness and runtime, after-work step, labels, priority,
   and each attached repository with its role and branch. `argument` sends the whole `context`
   object as a `context` argument. There is no mode that omits it. Render the block with one
   pure function, so a test can pin its text. Read the reply from the
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
  for a transport that is not local. Add a test that pins it for both transports here.
- Nothing company-specific: header names, tool names and URLs are all configuration.

## Tests and verification

- `test/shaping-references.test.ts`: each reference kind, a missing and an empty value, the
  status list, and that no value appears in a reason.
- `test/shaping-transport-http.test.ts`, against a loopback server: success, a non-2xx
  status, a redirect off the origin, the HTTPS rule, the body cap, a timeout, resolved headers,
  and no request when a reference is missing.
- `test/shaping-transport-mcp.test.ts`, against `test/fixtures/fake-guidance-mcp.mjs` (a local
  server with a `get_guidance` tool): the argument shape in both `contextDelivery` modes,
  that every collected field of a two-repository task (title, kind, harness, runtime,
  after-work step, labels, priority, both repositories) reaches the tool in each mode,
  structured and text replies, a tool error, a timeout, a `degraded: true` reply passed
  through, one server process for a run over two repositories, and the same calls over
  streamable HTTP.
- `test/shaping-http.test.ts` gains the `references` field and a dry-run of the fixture
  selector.
- Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` and `npm run smoke`.

## Merge and exit criteria

- Registering the fixture `get_guidance` tool through the API and dry-running it returns its
  guidance, with no code beyond configuration.
- No value of an environment reference appears in any reply, log or record.
- In both `contextDelivery` modes the tool receives the complete collected input, and no
  configuration can reduce it.

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
