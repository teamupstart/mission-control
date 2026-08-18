# Phase 1: reporting core and confirmed agent path

## Outcome

Mission Control can create a structured, text-only public issue in
`mancej/mission-controller-control-issues` through the user's authenticated `gh` binary. An agent
may invoke `report_product_issue` only after the user asked it to report, and every invocation blocks
on an explicit dashboard **Submit public issue** or **Dismiss** decision before the daemon calls
GitHub.

The five-type contract, fixed labels, safe environment body, preflight and retry-safety behavior are
complete. Image attachment fields and anticipated CLI argv are implemented behind an injected test
capability, while production rejects every non-empty attachment list.

## Entry criteria and dependencies

- `docs/plans/product-issue-reporting/plan.md` and this phased plan are merged to the default branch.
- The public repository and eight required labels may be absent during implementation; preflight and
  tests must represent that state. A live public repository is required only for manual verification.
- Direct phase dependency: the planning session only.

## Scope

### In scope

- Shared product-report vocabulary, bounds, schemas, labels and result union.
- Target-repository configuration and safe environment projection.
- A daemon-owned GitHub issue creation service and reusable outcome classifier.
- Read-only preflight plus separate dashboard and token-authenticated MCP preview and mutation routes.
- `report_product_issue` in the bundled Mission MCP server using the existing blocking review
  channel for dashboard confirmation.
- Production-off attachment capability with safe upload re-resolution in capability-enabled tests.
- Focused contract, HTTP, MCP, build-smoke, security and documentation coverage.

### Non-goals

- No direct dashboard Feedback button or modal; Phase 2 owns that consumer.
- No enabled image drop, paste, upload or real `--attach` call.
- No repository creation, label creation, task-source configuration or workflow dispatch.
- No task row, report database table, migration, SSE event, new review kind or GitHub token storage.
- No recurring-mission engine changes. The approved monitor is created operationally after the plan
  artifacts are published.

## Repository findings and inherited contracts

- `ghBin()` in `src/server/config.ts` is the only executable resolver. All subprocess tests use
  `MISSION_GH_BIN` or an injected runner; nothing spells a second `gh` binary.
- `run()` in `src/server/util/exec.ts` supports `input`, so the body uses `--body-file -`. This keeps
  reporter text out of argv and removes temporary-file cleanup.
- `pushResultFrom()` in `src/server/task-sources/github-issues.ts` has the right public-side-effect
  safety but returns a task-source-specific reference. Extract its generic success/refusal/unknown
  reading into a focused GitHub issue-create helper and map it back into the existing push result.
- `resolveImageUpload()` already constrains ids to fresh daemon-issued basenames, regular files and
  the upload directory. Capability-enabled product reporting rechecks file size and image signature
  before argv creation. Existing Dispatch attachment behavior is unchanged.
- The MCP server's `createReview("input", ...)` plus `waitForResolution()` already provides durable
  blocking confirmation. A single decision with one submit option uses the existing DecisionForm's
  separate Dismiss action; no new review persistence or UI component is needed.
- `/api/*` is loopback-guarded. `/mcp/*` mutations additionally check `x-harness-token` and resolve
  the calling session. Use two mutation routes so a caller cannot claim `source:agent` in browser
  JSON.
- `buildApp` is positional and widely instantiated in tests. Append the service as the final optional
  dependency and pass a singleton from `src/server/index.ts`.

## Implementation steps

### 1. Define the browser-safe report contract

Add `src/shared/product-issues.ts` and compose its Zod request schemas from
`src/shared/protocol.ts` where the HTTP boundary expects them.

- Declare the append-only tuple `bug`, `feature-request`, `documentation`, `usability`, `other`.
- Export the exhaustive type-to-label map and fixed `status:needs-triage` label.
- Define `ProductIssueDraft` with trimmed, bounded title and details plus bounded
  `attachmentUploadIds`. Keep the list present and empty by default so Phase 2 and the later release
  task consume one shape.
- Define trusted source values separately from public input. No draft contains source, repository,
  labels, environment, assignee, project or milestone.
- Define a preview result with the exact target, fixed labels, rendered body, allowlisted
  environment, capability state and bounded draft/request identity.
- Define a discriminated result covering success with URL, retry-safe refusal, configuration
  refusal and unknown outcome. A timeout, signal or successful run with no URL is unknown.
- Define limits for report bytes, attachment count and aggregate bytes in one shared location.
- Add request schemas for browser/MCP preview and submit plus preflight responses without importing
  `node:` modules into shared code.

### 2. Centralize GitHub issue-create outcome classification

Create a focused server helper under `src/server/github/` that reads `RunResult` into a generic
issue-create outcome. Preserve the established ordering:

1. `outcomeUnknown` wins over exit code;
2. a process-reported nonzero exit is a retry-safe refusal;
3. exit zero with the last HTTP(S) URL is success;
4. exit zero without a URL is unknown.

Refactor `github-issues.ts` to map that helper back into its existing `PushResult` without changing
task-source argv, URL identity, messages or tests. Add focused helper cases before moving the
existing path.

### 3. Build the daemon product-issue service

Add a focused service, for example `src/server/product-issues.ts`, with injected runner,
attachment capability and clock seams.

- Resolve the target from a config helper that defaults to
  `mancej/mission-controller-control-issues` and validates an optional
  `MISSION_PRODUCT_ISSUES_REPO` as exact `owner/name`.
- Derive type, `status:needs-triage` and exactly one source label on the server.
- Render deterministic Markdown with details, allowlisted Mission Control version, OS family,
  architecture, browser/Electron client and the v1 marker. Accept client mode only as a narrow enum;
  all other environment data comes from the daemon.
- Run `gh issue create` with fixed argv, `--body-file -`, body through `run(..., { input })`, one
  repeated `--label` pair per server-derived label and the fixed `--repo` target.
- Use the extracted outcome helper and expose no blind retry after an unknown result.
- Implement preflight with short timeouts for binary/authentication, repository reachability and
  the exact required label set. Preflight does not create or edit anything.
- Add an in-memory request-id claim for concurrent duplicate submits. A retry-safe refusal releases
  the claim; an unknown outcome remains blocked for the opening that owns it.

Production constructs the service with attachments disabled and no public override. In that mode,
reject a non-empty upload-id list before any GitHub process starts. Under an injected test
capability, re-resolve every id, reject stale/symlink/non-image/oversized inputs, then append the
anticipated repeated `--attach <absolute resolved path>` pairs. Keep this argv construction isolated
so the release-follow-up has one adapter to correct.

### 4. Add HTTP boundaries without accepting caller-owned source

Append the service dependency to `buildApp` and wire its singleton in `src/server/index.ts`.

- `GET /api/product-issues/preflight` returns target, capability state and actionable failures.
- `POST /api/product-issues/preview` validates the draft, assigns `dashboard`, and returns the exact
  target, fixed labels, allowlisted environment, rendered body, and draft/request identity.
- Keep `POST /api/product-issues` unavailable in Phase 1. Phase 2 may add dashboard mutation only
  with proof that its human confirmation completed.
- `POST /mcp/product-issues/preview` checks the daemon token, resolves the agent session, validates
  the draft, assigns `agent`, and returns the same exact preview shape.
- `POST /mcp/product-issues` checks the daemon token, resolves the agent session the same way other
  MCP routes do, validates again, and always calls the service as `agent`.
- Preview output is informative, not authority. Mutation re-derives and revalidates target, labels,
  environment, body, source, capability, and draft identity before invoking `gh`.
- Map invalid configuration and retry-safe refusals to ordinary actionable responses; carry a typed
  unknown outcome and status that the caller cannot mistake for safe retry.
- Demo mode never reaches the runner. Return an explicit inert-mode refusal.

### 5. Register the confirmed MCP tool

Add `report_product_issue` to `src/mcp/server.ts` and `MISSION_MCP_TOOLS`. Do not add it to any task
kind's mandatory preapproved list.

The tool accepts the five-type enum, title, details and the empty-by-default upload-id list. Its
description says the issue will be public, screenshots are unavailable until stable CLI support,
and it may be called only after an explicit user request.

On invocation:

1. call token-authenticated `/mcp/product-issues/preview` with the bounded draft;
2. create an `input` review whose full body is that server-derived public-content preview and whose
   one selectable option is **Submit public issue**;
3. block on the existing review long-poll;
4. return typed cancellation on Dismiss or orphan without calling the mutation route;
5. on the exact submit selection, call token-authenticated `/mcp/product-issues` with the original
   bounded draft;
6. return the URL or retry-safety result in plain agent-readable text.

Do not trust the review's free-form response as report content and do not accept an arbitrary route
target or label from the agent.

### 6. Document and test the core

Update configuration, security and MCP/tool documentation. State that reports are public, `gh` owns
credentials, generated environment data is allowlisted, attachments are disabled, and the target
override cannot be supplied per request.

Add or extend focused tests for:

- tuple/schema bounds and exhaustive label mapping;
- deterministic body and source derivation;
- stdin body transport and fixed argv;
- every outcome classification branch and unchanged task-source behavior;
- target override validation and all preflight failures;
- dashboard preview source derivation, unavailable dashboard mutation, and MCP source/token
  enforcement;
- demo-mode inertness and concurrent request claims;
- production rejection of non-empty attachment lists before runner invocation;
- injected-capability resolution, byte sniffing, count/aggregate bounds and anticipated argv;
- MCP submit, dismiss and orphan behavior plus tool-vocabulary and bundle-smoke agreement.

## Compatibility and data details

- No persisted enum or database schema changes.
- The report-type tuple and body marker are append-only from their first release.
- Existing task-source pushes retain their exact external result and messages after classifier
  extraction.
- Existing upload storage and TTL remain unchanged; the disabled feature does not create uploads.
- Browser and MCP use the same draft shape, but separate routes establish trusted source.
- A missing target repository or label is a refusal, never a best-effort unlabeled issue.

## Verification

Run focused files while iterating with the required preload, for example:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/product-issues.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/product-issues-http.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/mission-mcp.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/github-issues-map.test.ts
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
```

No real GitHub mutation is required for the phase test suite. If the public repository exists,
manual verification may create and close one disposable text-only issue after checking the preview.

## Merge and exit criteria

- The five-type daemon service creates a correctly labeled text issue through fake `gh` and returns
  the exact issue URL.
- The MCP tool cannot call GitHub before dashboard submit, and Dismiss/orphan provably call nothing.
- The production service cannot execute anticipated attachment argv.
- Existing GitHub task-source push tests remain unchanged in behavior.
- Focused tests, typecheck, lint, full unit suite, build and bundle smoke pass.
- Documentation identifies the public side effect, target, CLI authentication and disabled image
  state.
- The pull request is reviewable and green before merge.

## Downstream handoff

Phase 2 may rely on the shared draft, preview, preflight and result contracts, the dashboard preview
route, the daemon service, the production attachment capability being false and the fixed
labels/body behavior. It must add a confirmation-bound dashboard mutation route and must not
reimplement label mapping, body construction, source derivation, preflight or retry-safety logic in
the browser.

The future release-follow-up may change only the isolated attachment adapter, capability detection,
related schemas/copy and tests needed by the stable CLI. It must not weaken public confirmation or
enable caller-chosen repositories and labels.

## Cross-phase audit record

- Initial audit: all source-plan server, MCP, safety and dormant-attachment requirements are owned
  here. The direct UI remains wholly in Phase 2.
- Compatibility reconciliation: dashboard confirmation reuses `input` reviews rather than adding a
  persisted review kind, so no migration or ReviewModal branch becomes a Phase 2 prerequisite.
- Review reconciliation: the unauthenticated dashboard mutation route is deferred to Phase 2 so a
  local caller cannot publish after preview without proof of completed human confirmation.
- Contract reconciliation: `attachmentUploadIds` is present from Phase 1 but production accepts only
  empty lists, which lets Phase 2 render disabled state without inventing a different draft.
