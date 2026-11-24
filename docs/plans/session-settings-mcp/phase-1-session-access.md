# Phase 1. Live theme changes and access control

A human can ask a registered session to find the current theme and switch an already-open dashboard to Daylight. An operator can revoke the capability immediately. This vertical slice establishes the tool other settings will use.

## Entry and scope

Repository: Mission Control. Direct prerequisite: publication of the planning session. Phase implementer references include the [approved design](plan.md) and [implementation index](phased-plan.md). Implement the complete production path for ui.skin plus the operator controls. Remaining settings are assigned in the inventory for later phases.

## Implementation order

1. Trace ALL_SETTINGS_CONTROLS and settingsControls in src/web/lib/settings-search.ts against the rendered panels, the category registry, app-config entries and owner routes. Record a durable, test-readable coverage inventory connected to the existing declarations, with explicit phase ownership for pending settings. Inspect dynamic shortcut, harness and feature flag entries, build-hidden controls, and leaves behind grouped anchors. Keep browser bindings and React dependencies out of src/shared. Reuse theme/skin aliases and shipped skin IDs.

2. Define a bounded shared request/result contract for mission_settings and expose one fixed MCP definition in src/mcp/server.ts. find returns at most eight stable key/label/access matches and a continuation. get accepts an exact key and optional choiceCursor. With the cursor omitted, the response includes the effective value, relevant constraints, optional version and first bounded page of choices. If more choices remain, nextChoiceCursor is an opaque continuation token. The client passes it unchanged as choiceCursor on get for the same key. Each response carries the next page in stable order and omits nextChoiceCursor when exhausted. Bind the token to the operation, key and choice-list revision. An invalid, mismatched or stale token returns invalid_cursor with a hint to restart get without a cursor. set accepts only an exact key, a bounded JSON value and optional expected version. Reject invalid operation/argument combinations, unknown keys, ambiguous targeting and invalid values. Bound depths, sizes and error text. Preserve false, null and zero when valid. Never return a truncated value as a writable replacement.

3. Register the rollout flag at default-on, the feature-specific exception approved by the operator. Add the separate durable Allow sessions to access Mission Control settings preference, default true for fresh and legacy records, with an accessible dashboard toggle and persisted false. Keep the access decision out of generic writes, bulk flag edits and restoration via MCP. The dashboard retains the ability to re-enable access. Preserve an explicit opt-out across flag promotion/retirement. Use existing config ownership and migration conventions.

4. Add an authenticated daemon entry point using the machine-token middleware and the signed live caller pattern of awaitingCaller in src/server/routes.ts. Resolve the real session in Registry for terminal and SDK entry paths. Enforce both the rollout flag and durable access preference on every operation before discovery or value access, and again at the write boundary after asynchronous preparation. Keep identifiers and values out of failure logs where sensitive. Provide actionable, bounded errors and fail closed on unavailable owner/caller.

5. Use getUiConfig, the public patch validation and setUiConfig from the UI owner for ui.skin. Validate strictly against the shipped skin IDs on writes, while preserving existing compatibility fallback on reads. Share mutation and notification with PUT /api/ui/config. Use existing SSE ownership or add a typed bounded domain invalidation after successful persistence. Update the shared event union, snapshot/reconnect and src/web/useEventStream.ts consumer in the same change. Reconcile src/web/lib/uiConfig.ts in generation order, including in-flight optimistic writes and voice’s independent revisions. Keep src/web/lib/skin.ts as the only dashboard skin applier and retain native background persistence.

6. Update the user guidance for this first slice and its rollout exception. Exercise Claude, Codex and Pi launch paths with fixtures. Follow the real MCP client pattern in test/mcp-schedules.test.ts and the Pi discover-and-forward bridge. Grant checks must use live session provenance across supported runtimes.

## Verification and exit

Run focused node:test cases with node --test --import ./test/setup-state.mjs --import tsx followed by the new MCP settings spec and test/ui-config-store.test.ts, test/session-awaiting.test.ts, test/skins.test.ts and applicable Pi bridge tests. Test a choice list spanning multiple pages through get, including complete ordered traversal without duplicates, absence of nextChoiceCursor on the final page, rejection of a find cursor, a different key or changed choices, and revocation between pages. Test tools/list, unknown and disabled access, fresh and upgraded defaults, durable opt-out, spoofed and expired callers, refusal with no returned settings, repeat writes, distinct windows and out-of-order refresh. Verify the same running client loses access after revocation.

Build before browser tests. Use a Playwright fixture session to find theme, read it and set daylight, verify the radio and applied skin in two live pages, reload/restart for persistence, edit via UI and read via MCP, then disable and retry all three operations. Use role/label selectors. Run npm run typecheck, npm run lint, npm run build, npm run smoke, npm test and npm run test:e2e under repository prerequisites. Capture evidence for the live update and denial.

Merge when the feature works end to end for the published key and the inventory accounts for further work. The first release is default-on. Any interim documentation must accurately describe available settings.

## Handoff and cross-phase audit

Phase 2 inherits the generic wire shape, deny-by-default dispatch, stable ui.skin key, operator-only controls, live notification semantics and inventory ownership. Phase 3 consumes these transitively. Comparison with the root plan found that the browser store has no general peer-edit polling and backup classification alone does not establish access. Both are handled here. No dependency on a later phase is required for theme changes or revocation.
