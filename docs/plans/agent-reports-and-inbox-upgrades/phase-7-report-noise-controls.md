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
cancelling a notification that arrived before a mute, a per-agent Mark all read (the operator
declined it), rate limits, deleting reports.

## 4. Repository findings and contracts

- Inherited: the author key, `ReportCard`, `markRead` and `InboxActionButton` (Phases 1 and 2);
  `shouldDeliver`, the report alert, the watcher's report scope, and `reportToShow` with the
  band it draws for a report the fold does not list (Phase 6).
- A Settings category can carry a flag: `task-shaping` does at
  `src/web/lib/settings-registry.ts:189-200`. `test/settings-sidebar-render.test.ts` checks the
  anchors.
- Settings entries are declared in `src/shared/app-config-entries.ts`.
- The MCP child builds each tool's description when it registers it and connects at
  `src/mcp/server.ts:1903`. It can call the daemon first with the `http()` helper
  (`server.ts:82`).
- Phase 2 keeps the default "when to report" paragraph in `src/shared/reports.ts`.
- A desktop notification, once shown, stays in the operating system's notification centre. The
  dashboard cannot be relied on to withdraw it, so a notification raised before a mute can be
  clicked after it.

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
4. **Filtering.** From the moment an author is muted, its reports are left out of the fold and
   `toRead`, raise no notification in `shouldDeliver`, and are left out of the watcher's report
   scope so the digest does not count them. The mute is applied in the fold; the dashboard's
   `reports` state still holds the muted author's unread reports. A mute hides reports and does
   not mark them read: unmuting brings the unread ones back. Posting is never refused and
   conversation entries are untouched.
5. **A notification that arrived before the mute.** A mute does not cancel it. Clicking it runs
   Phase 6's `reportToShow` unchanged: the fold no longer lists the report, so the inbox opens
   and draws that report on its own in the "Opened from a notification" band. This phase adds
   no code to that path; it adds the tests in section 7. On that card the `mute` control is not
   drawn, because the author is already muted, and a line says so and that Unmute is in
   Settings.
6. **Mute control.** `ReportCard` offers "Mute <name>'s reports" when its author is not muted.
   Declare it as `mute` in `INBOX_ACTIONS` with the spoken form "{name}, mute reports" and draw
   it with `InboxActionButton`. Because a muted agent's rows leave the inbox, Unmute lives in
   Settings.
7. **Mark all read.** `POST /api/reports/read-all { ids }` calls `markRead(id, "mark-all")` for
   each listed id. A **Mark all read** button on the Reports section heading sends the ids it is
   showing, so a report that arrives after the click is not cleared. Declare it as
   `mark-all-read`, click-only with the reason `section-wide`: it names no agent, and the voice
   spec routes speech only by an agent's name or "reply".
8. **Settings panel.** A "Reports" category gated on the flag: the guidance text box with Save
   and Reset to default, and the muted agents list with Unmute.
9. **Docs.** `docs/attention-and-alerts.md`, `docs/sessions.md`, `docs/skills-and-settings.md`,
   including that a mute stops later notifications and does not cancel an earlier one.

## 6. Data and compatibility

One new empty table and one settings entry with a null default. With the flag off the routes
refuse, the panel is hidden, and stored mutes and guidance are kept. A session already running
keeps the guidance it started with.

## 7. Tests and verification

- HTTP tests for guidance (default, custom, too long), mutes and read-all, including that
  read-all records `readBy` `mark-all` and leaves an id it was not sent unread.
- An MCP test: the built child's `post_report` description contains custom guidance, and the
  default when the daemon does not answer.
- Fold, `shouldDeliver` and away-buffer tests for a muted author; a muted report keeps a null
  `readAt`.
- A unit test that joins the mute to Phase 6's rule: with an author muted, `reportToShow` for
  that author's unread report returns the band, because the fold does not list it; after Unmute
  it returns the report's row.
- A `renderToStaticMarkup` test of `ReportCard` for a muted author: no `mute` control, and the
  line saying the author is muted.
- `test/inbox-actions.test.ts` covers `mute` (a spoken form) and `mark-all-read` (click-only,
  `section-wide`).
- A migration test; `test/settings-sidebar-render.test.ts`.
- `e2e/specs/reports-noise-controls.spec.ts`: save custom guidance in Settings and read it back
  through the guidance route; mute an agent from its card and see its row and the to read count
  go, a further report from it raise no notification and stay unlisted, and Settings list it;
  Unmute and see the row return; with reports from two agents press Mark all read and see the
  section and the figure gone. The mute sequence: an agent posts and its notification is
  captured; mute that agent; click the earlier notification; the inbox opens with that report
  under "Opened from a notification", its body readable, no Mute control on it, no Reports row
  for that agent and the to read figure unchanged by the click.
- Run `npm run typecheck`, `npm run lint`, `npm run build`, `npm run smoke` and the spec.

## 8. Merge and exit criteria

Guidance edits reach new sessions. A mute silences one agent's later notifications and unlists
its reports without losing them or marking them read. A notification that arrived before the
mute still opens its report when clicked. Mark all read clears exactly what was listed.

## 9. Downstream handoff

Nothing later depends on this phase. Voice's mark read rule is unaffected: a muted agent's
reports are not listed in the inbox, so they are never a mark read target unless one is open on
screen in the band.

## 10. Cross-phase audit record

- Mute means no later notification and not listed, with the conversation unchanged. That is this
  plan's reading of "a per-agent mute"; the operator approved it with the final bundle.
- The operator chose "none until a report is open" for spoken mark read, so this phase adds only
  the section-wide button and no per-agent one.
- Phase 2's `readBy` already includes `mark-all`.
- Phase 6 owns the only delivery path; mutes filter inside it.
- Plan validation round 1: Mute and Mark all read are now declared in the action registry, the
  first with a spoken form and the second click-only. The Settings panel's controls are
  settings, not inbox actions.
- Plan validation round 2: Mark all read is one of the four ways R9 clears a report and goes
  through Phase 2's `markRead`. A mute hides without clearing, as the index table states.
- Plan validation round 3: Mark all read sends only the ids the Reports section lists, so it does
  not touch a report shown only in the "Opened from a notification" band.
- Plan validation round 6: an earlier version of this record said Phase 6's band is never
  reached for a muted author. That was wrong, and it contradicted Phase 6's promise that a click
  shows a report. A notification delivered before the mute can be clicked afterwards, and step 5
  now states what happens: the band draws the report. R22, R29, the root plan's design section,
  the index's click table and Phase 6's handoff state the same rule.
