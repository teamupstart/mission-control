# Phase 3: dashboard intake and audit UI

## Outcome

Let a person attach, caption, scope, review, and deliberately reattach screenshots from every dashboard action that captures a workflow submission. Show the same immutable evidence in run history, including honest retained or pruned state, and prove in a built-browser test that pixels cross the fake provider boundary.

## Entry criteria and direct dependencies

- Direct dependency: Phase 2, `phase-2-durable-agent-evidence-lifecycle.md`.
- The default branch provides opaque upload ids, shared staging schemas and limits, submit and resubmit locator handling, staged list/remove and historical restage operations, per-submission run-detail metadata, retained/pruned body responses, and native Persona image delivery.
- The approved source plan and phased index are present on the default branch.

## Scope

- One shared workflow evidence draft and composer for uploads, captions, repository scopes, staged agent items, upload progress, validation, and cleanup.
- Initial bind-and-submit, built-in Ship it, resume or fresh repair, and run-again entry points.
- Submission confirmations that state image count and aggregate bytes.
- Staged evidence display and removal before capture.
- Per-submission evidence history with thumbnail, caption, scope, digest, size, and retained or pruned state.
- Deliberate historical reattachment into a later submission.
- Browser object URL lifecycle and accessible loading, error, empty, and pruned states.
- Static rendering tests, required Playwright coverage, fake Claude and Codex image assertions, product documentation, and correction of the stale repository memory.

## Explicit non-goals

- No change to provider transport, SQLite ownership, filesystem containment, workflow fingerprint semantics, or retention policy from Phases 1 and 2.
- No generic file attachment framework, PDF viewer, video player, OCR, image annotation, or image editor.
- No PR attachment automation and no evidence commit under `docs/images/`.
- No `data-testid` selectors.

## Repository findings and inherited contracts

- `src/web/components/ImageDrop.tsx` already owns image drag, paste, upload progress, object URLs, and `AttachmentStrip`. Reuse its transfer behavior, but do not reuse its current assumption that the returned absolute path is the evidence authority.
- `WorkflowBindingDialog` sends the initial manual Preview after binding. `WorkflowRuns` and `run-actions.ts` own fresh resubmission and run-again actions. Built-in Ship it starts review from session surfaces such as `WorkQueue` and related workflow ladder controls.
- Action request ids are retained by the existing run-action controller for idempotent retries. Evidence drafts must remain stable across the same request retry and clear only after an accepted capture.
- `WorkflowStore.runDetail` already groups submissions, attempts, deliveries, and context. Phase 2 adds ordered image metadata there; this phase renders it rather than making a second fetch model.
- Image bodies come from an authenticated id-based route. The browser receives blobs and owns short-lived object URLs; it never sees Mission Control state paths.
- Every visible UI change requires an `e2e/` Playwright spec against the built dashboard and daemon, with fake agents and role, label, or placeholder selectors.

## Implementation steps

### 1. Build one evidence draft model

1. Add a focused workflow evidence draft module and component near `src/web/workflows/`. Wrap each `PendingAttachment` with stable client item id, required caption, selected issued repository slot or `all`, upload metadata, and validation state.
2. Reuse `useImageDrop`, `AttachmentStrip`, and `uploadImage`. Consume Phase 2's opaque upload id for workflow locators while leaving absolute `Attachment.path` behavior untouched for chat compose surfaces.
3. Fetch or derive only server-issued repository-scope choices. Default a binding action to that binding's repository. For a multi-repository session, label primary and attached slots from the durable manifest and offer `all` only when the backend reports it valid.
4. Merge agent-staged records from Phase 2 into the same ordered composer. Agent records have server-owned thumbnails and can be removed before capture through the owner-checked operation; browser uploads retain their local preview until accepted or removed.
5. Enforce shared count, per-image, aggregate-byte, caption, and JSON bounds client-side for immediate guidance while treating server validation as authoritative.
6. Revoke local and fetched object URLs on removal, successful capture, run change, and unmount. Preserve the draft and its client ids across modal close, a failed request, and an idempotent retry where the existing action controller reuses the request id.

### 2. Wire every capture entry point

1. Add the composer to `WorkflowBindingDialog` before the bind-and-submit or Preview action. The binding may be created first, but graph activation waits for the same submission request carrying its evidence locators.
2. Add it to the built-in Ship it or start-review confirmation used from session surfaces. Do not move or pre-create the later pull-request action.
3. Add it to the fresh resubmission path for `Resume review` and `Preview fresh evidence` in `WorkflowRuns` and `run-actions.ts`.
4. Add it to `Run this review again` and `Preview this review again` so a new run can freeze a new set.
5. Keep the unchanged-evidence confirmation distinct. It revives the already captured submission and shows the exact image count it will reuse; it does not accept a new draft under the same unchanged request.
6. Block confirmation while an upload is pending, any item lacks a caption or valid scope, limits are exceeded, or staged state failed to load. State the number and aggregate bytes that will be frozen.
7. Send only bounded item ids, captions, issued scopes, and opaque upload ids. Never serialize an absolute path into workflow submit or resubmit bodies.
8. On success, clear and revoke browser draft items that the response confirms were captured. On refusal, retain them and render the server's bounded error beside the composer.

### 3. Render immutable evidence history

1. Add an `Evidence images` section to each submission in `WorkflowRuns`. Keep the submission association visible so a screenshot from an earlier round is never mistaken for current evidence.
2. Render thumbnail, caption, repository label, digest prefix, byte size, MIME label, and retained or pruned state. Use semantic lists, buttons, and accessible names.
3. Fetch retained bodies lazily from Phase 2's id-based route, turn them into object URLs, and revoke them when their row leaves the page. A failure becomes a bounded unavailable state, not a broken image icon.
4. For pruned images, render metadata and pruning time without attempting a body fetch. Explain that export is metadata-only and the pixels followed raw-evidence retention.
5. Add a `Use in next review` action only for a retained image and only when the run is eligible for a new submission. It calls Phase 2's historical restage operation with a new client item id, then shows the staged result in the next evidence composer. Never silently carry an old image forward.
6. Ensure pagination, run switching, reset, and SSE refresh do not leak object URLs or associate images with the wrong selected run.

### 4. Prove pixels cross the boundary

1. Extend `e2e/fixtures/fake-codex.mjs` to record and validate ordered `--image` inputs, read the file bytes, and fail the Persona response when the expected digest is absent or metadata arrived without pixels.
2. Extend `e2e/fixtures/fake-claude.mjs` to validate image blocks in the fresh one-shot message with the same byte-level assertion. Keep every route fake so the test spends no model tokens.
3. Add `e2e/specs/workflow-image-evidence.spec.ts` against the built daemon. Use a small real PNG fixture created as test data, not an AI-generated or committed proof artifact.
4. Drive initial dashboard drop, caption, scope, submission, Persona pass, run-detail thumbnail, and accessible metadata.
5. Drive a failed round, attach a replacement image without changing repository bytes, resume, and assert that the new digest opens a fresh round and reaches the fake provider.
6. Exercise deliberate historical restaging and a pruned-state fixture or backend setup path.
7. Capture visual proof into the gitignored `e2e/.artifacts/workflow-image-evidence/` directory. Do not add those screenshots to Git.

### 5. Document the completed behavior

1. Update `docs/workflows.md` with text transcript limits, supported image evidence, staging, capture timing, repository scope, fresh-evidence semantics, citations, retention, and run-history behavior.
2. Update `docs/sessions.md` with the optional `submit_workflow_evidence` tool for workflow-bound sessions and the rule that screenshots remain gitignored evidence.
3. Update `e2e/README.md` with the fake-provider pixel assertion and artifact location if its test-running contract changes.
4. Correct `.agents/memory/review-evidence-needs-the-pr.md` and its index summary: reviewer Personas can read bounded transcript text, but need native attachment transport for pixels. Keep the private PR attachment memory because it still applies to the later PR-publishing stage.

## Data, API, and compatibility details

- Browser draft state is transient. Durable staging and capture remain daemon-owned.
- Existing chat attachment chips and prompt path formatting remain unchanged.
- The same client item id and request id pair must be safe to retry. A new image or caption intentionally uses a new staging generation.
- Staged agent evidence is visible but never editable into a different source path. A human may edit caption or scope only through the bounded server operation that creates a new generation.
- Run export remains metadata-only. The UI must not imply that JSON export backs up image bodies.
- Do not fetch every image on run-detail load. Lazy body fetch preserves bounded network and memory use.

## Tests and verification

Add or extend fast tests for:

- workflow evidence draft validation, stable client ids, upload progress, failed upload, caption and scope bounds, aggregate limits, and retry preservation;
- `WorkflowBindingDialog`, built-in Ship it, resume, run-again, and unchanged-confirmation request bodies;
- evidence history markup, submission grouping, accessible names, retained, unavailable, and pruned states;
- object URL creation and revocation helpers without introducing jsdom;
- run model parsing of Phase 2 metadata and SSE refresh association;
- fake Claude and Codex rejection when only metadata arrives.

Run at minimum:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/workflow-confirm-render.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/workflow-runs-render.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/workflow-bindings-http.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/workflow-completion-http.test.ts
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npx playwright test e2e/specs/workflow-image-evidence.spec.ts
npm run test:e2e
```

On macOS, run the relevant Electron geometry test if the added composer or evidence section changes constrained-height behavior. Follow the repository's required approval path rather than bypassing the Electron preflight.

## Merge and exit criteria

- Every dashboard path that captures a new snapshot offers the same evidence composer and sends no absolute path.
- Pending uploads, missing captions, invalid scopes, and limit violations cannot start capture.
- Agent-staged and dashboard-uploaded images converge on the same server metadata and appear together before submission.
- Run history shows the exact per-submission set and honest retained or pruned state.
- Historical reuse is explicit and creates a new staged item; normal repairs never inherit images silently.
- The Playwright spec proves actual PNG bytes reach both fake provider boundaries and that the retained image is human-inspectable.
- Focused tests, typecheck, lint, full unit suite, build, smoke, focused Playwright, and full E2E pass.
- Product docs and repository memory state the corrected evidence model.

## Downstream handoff

There is no later implementation phase. The final product contract is the approved source plan: both intake surfaces, immutable per-submission pixels, provider-native review, traceable citations, fresh-evidence semantics, auditable history, and retention-safe deletion. Future attachment types must extend the shared bounded evidence model rather than bypass it.

## Cross-phase audit record

- 2026-08-15: Consumed Phase 2's opaque locators, staging ownership, history payload, body route, and restaging operation without creating browser-side authority.
- 2026-08-15: Kept all four human capture entry points on one shared draft so request retries and limits cannot drift between surfaces.
- 2026-08-15: Kept unchanged confirmation separate because it revives one already captured submission instead of accepting fresh evidence.
- 2026-08-15: Assigned final product docs, Playwright proof, and stale-memory correction here because this phase completes the human-visible behavior.
