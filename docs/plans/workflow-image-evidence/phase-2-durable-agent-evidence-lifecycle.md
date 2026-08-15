# Phase 2: durable agent evidence lifecycle

## Outcome

Let a workflow-bound agent stage gitignored screenshots before completion, freeze the applicable images into each immutable workflow submission, deliver the pixels to every Persona, accept traceable image citations, and preserve an auditable retained or pruned history. This is the first complete end-to-end image evidence path.

## Entry criteria and direct dependencies

- Direct dependency: Phase 1, `phase-1-multimodal-runner-foundation.md`.
- The default branch exposes the provider-neutral image descriptor, fail-closed validator, ordered Claude and Codex transport, and final conservative image limits.
- The approved source plan and phased index are present on the default branch.

## Scope

- Browser-safe workflow image metadata, staging input, limits, context, verdict, run-detail, export, and status contracts.
- Additive SQLite schema and strict storage APIs for staged items, submission images, and recoverable filesystem cleanup.
- Session-attributed `submit_workflow_evidence` Mission MCP tool and authenticated daemon route.
- Opaque upload ids plus submit and resubmit locator handling for the Phase 3 browser client.
- Secure repository-slot resolution and immutable image capture inside the workflow capture boundary.
- Evidence fingerprint and automatic resumption semantics.
- Persona manifest, native runner inputs, image citations, and request-byte accounting.
- Authenticated id-based image retrieval for later UI use.
- Retention, reset, cancellation, restart recovery, run-family deletion, diagnostics, and focused backend tests.
- Backend and agent-side documentation.

## Explicit non-goals

- No dashboard drop zone, caption editor, repository-scope picker, thumbnail component, or historical reattach control. Phase 3 owns browser behavior.
- No PDF, video, OCR, arbitrary binary attachment, or image generation.
- No PR upload or PR comment automation.
- No committed evidence artifacts and no change to the authored pull-request stage order.
- No filesystem tool grant for Personas.

## Repository findings and inherited contracts

- `workflow_submissions` persists immutable `context_json` and `evidence_json`; `WorkflowManager.captureAndActivate` is the only place that makes captured evidence runnable.
- Initial submission can fan out one conversation into one run per changed repository. Evidence scope must therefore be expressed as an issued repository slot, not a caller-provided root.
- `readWorkflowEvidenceProbe` intentionally ignores transcript growth. The new staged-image generation joins this cheap probe without making transcript text a fresh-evidence signal.
- The current upload route returns an absolute path for chat attachment compatibility. New workflow inputs need an additive opaque upload id; changing or removing the existing path would break unrelated compose surfaces.
- `MISSION_MCP_TOOLS` and launch requirements live in `src/server/mission-mcp.ts`, the bundled tool implementation lives in `src/mcp/server.ts`, and `/mcp/*` routes use the existing token and session attribution boundary.
- Run detail is assembled by `WorkflowStore.runDetail`; export is a separate route and must not include binary bodies.
- Raw evidence pruning is currently a database transaction. Image files require a recoverable cross-disk protocol that keeps row state honest through crashes.
- Phase 1's descriptor and limits are fixed inputs. Do not introduce a parallel provider or MIME contract here.

## Data and wire contracts

### Shared metadata

Add a bounded `WorkflowEvidenceImage` record in `src/shared/workflow.ts` and matching Zod schemas in `src/shared/protocol.ts` with:

- stable image id and ordinal;
- sanitized display name and required caption;
- issued repository slot or `all` scope;
- sniffed MIME type, byte count, and SHA-256;
- retained or pruned availability plus pruning timestamp where applicable;
- no absolute storage or source path.

Add ordered `images` and the applicable staged-image generation to `WorkflowContextSnapshot.evidence`. Default missing arrays and generation values so historical snapshots still parse. Extend pruned retention metadata with image count and bytes.

Append `image` to `EVIDENCE_REF_KINDS` and update both the model-facing and strict verdict schemas. For image citations, `path` is the stable image id and `quote` is the bounded visual observation. Reject citations to an id outside the current immutable image manifest.

### Intake locators

Define one discriminated, JSON-bounded staging shape:

- agent source: checkout-relative path, client item id, caption, and repository slot or `all`;
- browser source reserved for Phase 3: opaque upload id, client item id, caption, and repository slot or `all`.

Repository slots use the task's stable ordered manifest, with slot 0 as primary. The server maps the slot to the live session's issued roots. Neither path accepts an absolute repository name from the caller.

### Persistence

Add fresh-schema declarations and additive migrations together for:

- `workflow_evidence_staging`, owned by durable conversation identity, repository scope, client item id, source kind, bounded source locator, generation, state, reservation, and timestamps;
- `workflow_submission_images`, owned by submission id, with immutable display metadata, scope, MIME, bytes, digest, storage-relative path, availability, and timestamps;
- any small cleanup or trash ledger required by the chosen crash-safe filesystem protocol.

Indexes must be created after their migrated columns exist. Add strict row decoders, uniqueness for idempotent client item ids in their owner scope, and ordering indexes used by capture and run detail.

## Implementation steps

### 1. Centralize limits and schemas

1. Import Phase 1's provider-compatible image limits into the workflow contract and add caption, display-name, item-count, and JSON-byte bounds.
2. Add metadata, staging input, context defaults, run-detail, export, retention count, and `image` citation schemas.
3. Keep `src/shared/` browser-safe. Put path resolution, file descriptors, hashing, and filesystem state in a focused server workflow image module.

### 2. Build secure staging

1. Add `submit_workflow_evidence` to `src/mcp/server.ts` with the exact shared schema mirrored at the MCP boundary, following the existing drift tests for bundled Mission tools.
2. Send the existing terminal environment, agent session id, cwd, item ids, relative paths, captions, and repository slots to a token-authenticated `/mcp/workflow-evidence` route.
3. Resolve the active session and its durable task repository manifest server-side. Refuse a missing, exited, or mismatched session and any slot it was not issued.
4. Resolve each relative path under the selected issued root. Refuse absolute paths, `..`, control characters, symlinked components or leaf, non-regular files, missing files, unsupported signatures, duplicate ids, per-item overflow, count overflow, and aggregate overflow.
5. Persist an idempotent staged record and increment the applicable staged-image generation only when the staged evidence set materially changes. Keep the source mutable only until submission reservation.
6. Add bounded list and remove operations behind the same owner checks so Phase 3 can display and correct staged items without inventing another store.
7. Extend `POST /api/uploads` additively with an opaque upload id while preserving its existing absolute `path` and `name` fields for chat. Resolve browser locators only through server-issued upload records under the uploads root, re-sniff them, and refuse expired or mismatched ids.
8. Accept bounded browser locators on submit and resubmit and stage or reserve them through the same service as agent items. Add an owner-checked operation that stages a retained historical image as a new item with a new client id and generation for Phase 3's deliberate reattach control.

### 3. Make the tool available only where useful

1. Register the append-only name in `MISSION_MCP_TOOLS` and update the source-to-bundle drift tests.
2. Extend the launch requirement calculation from task kind alone to the task's resolved workflow selection. A workflow-bound ship task whose immutable graph can run Personas receives and preapproves the evidence tool; an unrelated ship, scout, or plan task keeps its current launch unchanged except for its existing kind requirements.
3. Add one concise workflow-aware dispatch contract explaining that visual claims may be supported by a gitignored screenshot registered before completion. Keep registration optional and do not teach an agent to commit the file.
4. Verify the running bundle before dispatch when this new requirement is present, using the same fail-closed bundle capability check that required scout and plan tools use. Do not strand a launched workflow task with a prompt naming an unavailable tool.

### 4. Reserve and capture submission-owned bytes

1. In the same durable operation that creates each initial, repair, external, or continuation submission, reserve the staged records whose owner and repository scope apply. An `all` item is cloned or referenced into every sibling repository submission produced by the same completion boundary.
2. Enter the existing per-conversation capture lock. Open each reserved source without following symlinks, read it once, sniff and bound it again, hash it, and write a temporary file under a workflow-evidence state directory.
3. Atomically rename each completed copy to a submission-owned relative storage path. Persist the image rows and context metadata before activation. Never let a Persona read the mutable staging source.
4. On any image failure, fail the whole capture before model spend, leave no partial runnable set, and block the run in a typed image-evidence capture phase with bounded diagnostics. Retrying the same reserved submission reuses its reservation rather than consuming a different staged set.
5. Include ordered image id, digest, caption, scope, and staging generation in `workflowContextFingerprint`. Add the same generation to `readWorkflowEvidenceProbe` so a new screenshot or caption can wake an otherwise Git-unchanged automatic repair.
6. A normal repair consumes only newly staged applicable items and does not silently inherit a prior round's images. The existing unchanged-confirmation path revives the same already captured submission and therefore reuses that submission's exact set.
7. Keep external exact-artifact capture and SessionAction continuation guards intact. An evidence image may accompany them only when its staged owner and repository slot match the exact captured submission.

### 5. Deliver pixels and validate citations

1. Add an untrusted ordered image manifest to `buildPersonaPrompt` after the workflow metadata. Include stable id, caption, display name, scope, MIME, bytes, and digest, but no local path.
2. Resolve retained image rows to Phase 1 descriptors immediately before `runner.run`. If any declared image is unavailable or changed, record a Persona infrastructure failure rather than asking the model to judge incomplete evidence.
3. Pass the same ordered image list to every Persona attempt for that submission. Context compaction remains text-only.
4. Count prompt bytes plus raw attached image bytes in `workflow_llm_calls.input_bytes`; keep provider token and cost reporting unchanged.
5. Extend verdict normalization so `kind: "image"` citations must name a current image id. Update the immutable Persona contract and Test Evidence Auditor guidance to distinguish visual observations from textual quotations.

### 6. Expose audit history without paths

1. Extend `WorkflowStore.runDetail` and run export with ordered image metadata per submission. Export digests and captions, never base64 or storage paths.
2. Add an id-based authenticated route under the workflow run or submission owner that verifies the row, retained state, owning run, and contained storage path before opening with no-follow semantics.
3. Return the sniffed content type and bounded bytes. Refuse pruned, missing, or mismatched files with typed responses that Phase 3 can render.
4. Extend workflow status diagnostics with retained image count, retained bytes, pruned image count, and orphan or pending-cleanup count without enumerating paths.

### 7. Retain, prune, delete, and recover

1. Extend raw-evidence compaction to retain metadata while marking image bodies pruned and recording count and bytes.
2. Use an atomic trash rename plus durable state, or an equivalent retryable cleanup ledger. A crash before the database transition must allow restore; a crash after it must allow deletion to finish. Never mark bytes retained when neither the retained file nor a recoverable trash file exists.
3. Full run-family deletion, binding/session reset, and cancellation cleanup follow the existing workflow owners. Active, blocked, failed, and delivery-uncertain runs keep raw image bytes under the same eligibility rules as text evidence.
4. Startup reconciliation removes abandoned capture temporaries, completes or restores interrupted trash operations, identifies bounded orphan counts, and never deletes a file referenced by a retained row.

## Compatibility and migration details

- Historical context defaults to `images: []`, zero image generation, and prior retention counts.
- Fresh schema and migration paths are both required. Test a database created before these tables and indexes existed.
- Existing `/api/uploads` chat behavior remains byte compatible. If the upload module gains an opaque id, its absolute `path` response stays available to existing compose callers while workflow routes ignore that path.
- Existing workflow submissions without image rows remain valid. No backfill fabricates images.
- Every new durable enum or evidence kind is append-only.
- No image bytes enter context JSON, evidence JSON, event payloads, SSE frames, transcript, or logs.

## Tests and verification

Add or extend focused tests for:

- workflow and protocol schema defaults, bounds, retention metadata, and strict `image` citation validation;
- old-database migration, fresh schema parity, strict staged/submission image row reads, idempotency, and index ordering;
- agent session attribution, repository slots, `all` fan-out, multi-repository isolation, and Mission MCP source/bundle drift;
- opaque upload id issuance and expiry, chat response compatibility, submit/resubmit browser locators, and historical reattachment ownership;
- traversal, absolute path, symlink component and leaf, swapped leaf, non-file, MIME spoof, missing source, control characters, duplicates, count, per-item, and aggregate limits;
- initial, manual repair, Foreman completion, external, continuation, unchanged confirmation, cancellation, reset, restart, prune, and full-delete lifecycles;
- fingerprint and probe behavior for new digest, changed caption, removed evidence, unchanged staging generation, and transcript-only growth;
- prompt manifest and runner order, image-byte accounting, invalid current-image citation, and retained-file infrastructure failures;
- export metadata without bodies and authenticated retained/pruned body responses;
- crash-recovery fixtures for capture temporaries and both sides of the trash/database transition.

Run focused commands selected from the changed files, including at minimum:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/workflow-contracts.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/workflow-db.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/workflow-context.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/workflow-security.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/workflow-recovery.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/workflow-retention.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/workflow-export.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/workflow-engine.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/mission-mcp.test.ts
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
```

## Merge and exit criteria

- A workflow-bound Codex or Claude session can register a contained gitignored screenshot without committing it.
- Capture owns immutable bytes before any Persona attempt can be claimed.
- Every Persona receives actual pixels and can emit a validated `image` citation.
- New image evidence can trigger a Git-unchanged repair; transcript-only growth still cannot.
- Multi-repository scope, migrations, restart recovery, retention, reset, deletion, export, and authenticated retrieval pass focused tests.
- Unrelated task launches, text-only reviews, chat uploads, and workflows with no images retain their former behavior.
- Required tests, typecheck, lint, full unit suite, build, and smoke pass.

## Downstream handoff

Phase 3 may rely on the shared staging schema, opaque upload id, staged list/remove service, submit and resubmit evidence locators, per-submission run-detail metadata, authenticated image body route, explicit historical reattach operation, and retained/pruned responses. It must not accept browser paths, duplicate staging ownership, or create a second image store.

## Cross-phase audit record

- 2026-08-15: Consumed Phase 1's single descriptor and provider limits without changing its provider contract.
- 2026-08-15: Added a staged-evidence table because agent registration must survive the gap before an automatic completion claim; submission rows alone cannot represent that state.
- 2026-08-15: Chose repository slots rather than roots so agent and browser callers cannot assert filesystem authority.
- 2026-08-15: Preserved the existing absolute upload path response only for unrelated chat attachments; workflow evidence uses an additive opaque id.
- 2026-08-15: Reconciled Phase 3's browser handoff by assigning opaque locator resolution and historical restaging to this backend phase, while leaving their controls to Phase 3.
- 2026-08-15: Kept full agent intake, capture, Persona delivery, audit API, and retention in one phase so it merges as an operable vertical slice.
