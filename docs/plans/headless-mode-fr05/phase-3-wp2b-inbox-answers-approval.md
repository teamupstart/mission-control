# Phase 3 (WP2b): inbox, answers, approval

## Outcome
The daemon serves a repo-scoped inbox, accepts answers with receipts, gates plan and review approvals, and exposes the config view (F4, F5).

## Entry and dependencies
Phase 1.

## Scope and non-goals
Spec 7.7 (inbox), 7.8, 7.9 (approval). Owns `inbox.ts, answers.ts, approval.ts, config.ts`, `src/shared/home-dispatch-inbox.ts`, and the `home-approval:` changes in `loadHumanResolvedReviews` and plan publication. Non-goals: check-in lists and forms (phase 4), MCP tools.

## Repository findings
`reviews.resolved_by` persisted values `home:{sessionId}`, `home-approval:{sessionId}`, `mctl` are new and never renamed (2.4).

## Steps
Inbox state rules, answer routes with safe retries (L17), approval requires card shown, approval word in the current message, exact revision, whole-sentence negation check and questions never approve (L13, D9); Q1 position: gated, fail closed.

## Tests and verification
`home-dispatch-inbox`, `-answers-http`, `-approval` tests, every 400, 403, 404, 409; flag-off 404s; suite, typecheck, lint.

## Merge and exit
Workers and `mctl` cannot answer what they must not; no behavior change with the flag off.

## Downstream handoff
Phases 6, 7, 8 consume inbox and answer routes.

## Cross-phase audit
Check-ins stay in phase 4; both read the shared inbox types owned here.
