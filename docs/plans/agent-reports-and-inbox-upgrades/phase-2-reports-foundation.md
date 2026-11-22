# Phase 2: reports foundation

Part of `docs/plans/agent-reports-and-inbox-upgrades/phased-plan.md`. Source plan: `plan.md`
beside this file. Owns R1 to R4, R6 to R9, R12 and R14.

## 1. Outcome

An agent posts a report with `post_report` and carries on. The operator sees "1 to read" in the
top bar, opens the inbox, reads the report under **Reports**, and presses **Mark read**. A report
that replaces an earlier one takes its place. Nothing about the session turns amber.

## 2. Entry criteria

Phase 1 is merged. May run concurrently with Phase 5.

## 3. Scope and non-goals

In scope: the table, the manager, the MCP tool, the post, opened, read and history routes, the
wire, the fold, the Reports section and card, the to read figure, `replaces`, copying the
document, docs and specs. Not in scope: the conversation entry, reply and follow-up (Phase 3);
the document reader and Publish as scout (Phase 4); notifications (Phase 6); guidance, mute and
Mark all read (Phase 7).

## 4. Repository findings and contracts

- Inherited: `INBOX_FLAG`, `agentDisplayName`, `INBOX_SECTION_ORDER`, `INBOX_ACTIONS`.
- Schema version 40 (`src/server/db.ts:287`). New empty tables are created beside their upgrade
  path: `session_blockers` (`db.ts:4507`), `attention_dismissals` (`db.ts:4906`). The version is
  pinned by `test/managed-plans.test.ts` and `test/telemetry-migration.test.ts`.
- Tool pattern: `registerTool` with the `http()` helper (`src/mcp/server.ts:82`); `request_input`
  at `:969` posts to `/mcp/reviews` (`src/server/routes.ts:5255`), which resolves the session
  with `registry.findSessionByEnv`. A flag-off refusal is a 404 carrying `feature`, which the
  tool turns into a message (`src/mcp/server.ts:476`).
- Tool lists kept by hand: `MISSION_MCP_TOOLS` (`src/server/mission-mcp.ts:62`),
  `test/mission-mcp.test.ts`, `scripts/smoke-bundles.mjs`,
  `docs/observability-action-manifest.md`, `test/request-collection-bounds.test.ts`.
- Wire: the snapshot (`src/shared/types.ts:3769`) is built in `Registry.snapshot()`
  (`src/server/registry.ts:1327`); reviews are the model (`upsertReview`, `registry.ts:7402`;
  `src/web/useEventStream.ts:523`; exhaustiveness guard `:766`).
- Fold and inbox: `total` (`src/web/lib/attention.ts:552`), `SECTION_TITLES`
  (`src/web/components/AttentionInbox.tsx:62`), `PulseStat` (`src/web/components/Topbar.tsx:377`).
  The pulse is pinned by `e2e/specs/topbar-one-row.spec.ts:148`, `test/topbar-ladder.test.ts`,
  `test/topbar-items.test.ts` and `test/tooltip-coverage.test.ts`.
- A session's checkout files are read through `src/server/routes.ts:3614`; reuse its path rules.
- `ReviewManager` orphans reviews on `session_remove` (`src/server/reviews.ts:116`). Reports must
  not.

## 5. Implementation steps

1. **Contracts.** `src/shared/reports.ts`: `ReportItem` (fields in the index), limits (title 200
   characters, body `DECISION_CONTEXT_MAX_CHARS`), the `r-<n>` id helpers, the receipt text and
   the tool's "when to report" paragraph. Request schemas in `src/shared/protocol.ts`. The
   `report_upsert` event and the optional `reports` snapshot field in `src/shared/types.ts`.
2. **Storage.** Create `reports` beside its upgrade path and bump the schema version. Columns
   cover every `ReportItem` field, including `announced_as`, `announced_at` and
   `published_archive_key`, which this phase leaves null.
3. **Manager.** `src/server/reports.ts`: `post` resolves the author (key and display name),
   validates `replaces` (it must be an unread, unsuperseded report with the same author key;
   otherwise refuse with that author's open report ids and titles), copies an attached `.html`
   or `.md` file from inside the session's checkout to `<state home>/reports/<id>/` under a size
   cap, inserts, marks the replaced row superseded, and emits. `markOpened` and `markRead` are
   idempotent. It does not subscribe to `session_remove`.
4. **Routes.** `POST /mcp/reports` (404 with `feature` when the flag is off),
   `POST /api/reports/:id/opened`, `POST /api/reports/:id/read`, `GET /api/sessions/:id/reports`
   (every version, read or not).
5. **Tool.** Register `post_report` in `src/mcp/server.ts` with the fields in R1 and the
   description in R2. Its result is the receipt naming the id and saying not to wait for a
   reply. Update every hand-kept list.
6. **Dashboard state and fold.** Handle the snapshot field and `report_upsert`. Fold unread,
   unsuperseded reports into `agent_reports` items grouped by author key, groups ordered by
   their oldest `rootCreatedAt`. Add `toRead`. Reports never add to `total` or `represented`.
7. **Inbox.** Section title "Reports". A `ReportCard` collapsed to title, author name and age;
   opening it shows the body, the link, "updated N times" when `version > 1`, and Mark read, and
   posts opened once. `openReportId` lives in `src/web/App.tsx`. Declare the `mark-read` action
   and place its `SpokenHint`. Update the inbox subtitle.
8. **Top bar.** A neutral "to read" `PulseStat` that opens the inbox, fitted into the one-row
   ladder.
9. **Docs.** `docs/sessions.md`, `docs/attention-and-alerts.md`, `docs/event-stream.md`,
   `docs/database-and-migrations.md`, the action manifest.

## 6. Data and compatibility

An older database gains the empty table on its next open. With the flag off the route refuses,
the snapshot omits `reports` and stored rows are kept. A session on an older MCP bundle has no
tool.

## 7. Tests and verification

- `test/reports.test.ts`: post, the chain and its refusal, opened and read, a report surviving
  `session_remove`, and no change to `pendingReviews` or the completion hold.
- `test/reports-http.test.ts`: routes, flag off, a path outside the checkout, an oversized file.
- A migration test for a version-40 database; `test/mission-mcp.test.ts`; `npm run smoke`.
- `test/attention-inbox.test.ts`: grouping, order, `toRead`, `total` untouched.
- `e2e/specs/reports-inbox.spec.ts`: post on the tool's own channel (`/mcp/reports` with the
  daemon token, as `e2e/specs/async-input-ask-and-continue.spec.ts` does for questions). Assert
  "1 to read", the Reports row, the body on open, the state after a reload, Mark read clearing
  the row and the figure, a replacing report showing one row with "updated 1 time", the session
  not amber, and nothing shown with the flag off.
- Update `e2e/specs/topbar-one-row.spec.ts` for the fifth segment.
- Run `npm run typecheck`, `npm run lint`, `npm run build`, `npm run smoke` and the specs.

## 8. Merge and exit criteria

A posted report is durable across a daemon restart and a session eviction, is listed and counted
only as to read, and leaves only through Mark read. Foreman's inputs are unchanged.

## 9. Downstream handoff

Phases 3, 4, 6 and 7 rely on the table, `ReportItem`, the author key, the routes, the fold item,
`toRead`, `openReportId` and the stored document path. They add routes and write their own
columns; they do not change the id format or how a chain keeps its queue place.

## 10. Cross-phase audit record

- After Phase 3: the reply and follow-up routes mark a report read with their own `readBy`
  value. `readBy` is declared here with all five values (`mark-read`, `reply`, `follow-up`,
  `mark-all`, null).
- After Phase 4: `document.kind` is `html` or `markdown`; the reader needs nothing else stored.
- After Phase 6: the announce columns exist here and stay null until Phase 6 writes them.
- After Phase 7: mutes are a separate table keyed by the author key defined here.
