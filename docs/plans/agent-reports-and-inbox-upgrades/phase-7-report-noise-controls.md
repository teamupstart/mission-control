# Phase 7: report noise controls

Part of `docs/plans/agent-reports-and-inbox-upgrades/phased-plan.md`. Source plan: `plan.md`
beside this file. Owns R28, R29 and R30.

## 1. Outcome

When reports get chatty the operator has three controls: edit the guidance that tells agents
when to post, mute one agent's reports, and mark every listed report read at once.

## 2. Entry criteria

Phase 6 is merged. May run concurrently with Phases 4 and 5.

## 3. Scope and non-goals

In scope: the guidance setting and its delivery to the tool, mutes and their filtering, Mark all
read, a Reports panel in Settings, docs and specs. Not in scope: refusing a muted agent's posts,
a per-agent Mark all read (the operator declined it), rate limits, deleting reports.

## 4. Repository findings and contracts

- Inherited: the author key and `ReportCard` (Phase 2); `shouldDeliver`, the report alert and the
  watcher's report scope (Phase 6).
- A Settings category can carry a flag: `task-shaping` does at
  `src/web/lib/settings-registry.ts:189-200`. `test/settings-sidebar-render.test.ts` checks the
  anchors.
- Settings entries are declared in `src/shared/app-config-entries.ts`.
- The MCP child builds each tool's description when it registers it and connects at
  `src/mcp/server.ts:1903`. It can call the daemon first with the `http()` helper
  (`server.ts:82`).
- Phase 2 keeps the default "when to report" paragraph in `src/shared/reports.ts`.

## 5. Implementation steps

1. **Guidance setting.** A `reports` settings entry `{ guidance: string | null }`, at most 2,000
   characters; null means the default paragraph. Routes to read and write it for the dashboard.
2. **Guidance delivery.** `GET /mcp/reports/guidance` returns the effective paragraph. The MCP
   child reads it once before registering `post_report`, with a short timeout, and falls back to
   the default. The rest of the description (progress goes to `report_status`, decisions are
   questions) is fixed. A change reaches sessions started afterwards.
3. **Mutes.** A `report_mutes` table (`author_key` primary key, `author_name`, `muted_at`) with a
   schema bump. `POST` and `DELETE /api/reports/mutes`. The dashboard receives the list in the
   snapshot and through one event, handled exhaustively in `src/web/useEventStream.ts`.
4. **Filtering.** A muted author's reports are left out of the fold and `toRead`, raise no
   notification in `shouldDeliver`, and are left out of the watcher's report scope so the digest
   does not count them. Posting is never refused and conversation entries are untouched.
5. **Mute controls.** `ReportCard` offers "Mute <name>'s reports". Because a muted agent's rows
   leave the inbox, Unmute lives in Settings.
6. **Mark all read.** `POST /api/reports/read-all { ids }` marks the listed ids read with
   `readBy: "mark-all"`. A **Mark all read** button on the Reports section heading sends the ids
   it is showing, so a report that arrives after the click is not cleared.
7. **Settings panel.** A "Reports" category gated on the flag: the guidance text box with Save
   and Reset to default, and the muted agents list with Unmute.
8. **Docs.** `docs/attention-and-alerts.md`, `docs/sessions.md`, `docs/skills-and-settings.md`.

## 6. Data and compatibility

One new empty table and one settings entry with a null default. With the flag off the routes
refuse, the panel is hidden, and stored mutes and guidance are kept. A session already running
keeps the guidance it started with.

## 7. Tests and verification

- HTTP tests for guidance (default, custom, too long), mutes and read-all.
- An MCP test: the built child's `post_report` description contains custom guidance, and the
  default when the daemon does not answer.
- Fold, `shouldDeliver` and away-buffer tests for a muted author.
- A migration test; `test/settings-sidebar-render.test.ts`.
- `e2e/specs/reports-noise-controls.spec.ts`: save custom guidance in Settings and read it back
  through the guidance route; mute an agent from its card and see its row and the to read count
  go, a further report from it raise no notification and stay unlisted, and Settings list it;
  Unmute and see the row return; with reports from two agents press Mark all read and see the
  section and the figure gone.
- Run `npm run typecheck`, `npm run lint`, `npm run build`, `npm run smoke` and the spec.

## 8. Merge and exit criteria

Guidance edits reach new sessions. A mute silences and unlists one agent without losing its
reports. Mark all read clears exactly what was listed.

## 9. Downstream handoff

Nothing later depends on this phase. Voice's mark read rule is unaffected: a muted agent's
reports are not unread in the inbox, so they are never a mark read target.

## 10. Cross-phase audit record

- Mute means no notification and not listed, with the conversation unchanged. That is this
  plan's reading of "a per-agent mute"; the operator approved it with the final bundle.
- The operator chose "none until a report is open" for spoken mark read, so this phase adds only
  the section-wide button and no per-agent one.
- Phase 2's `readBy` already includes `mark-all`.
- Phase 6 owns the only delivery path; mutes filter inside it.
