# Phase 6: notifications, settings and Away mode

Part of `docs/plans/agent-reports-and-inbox-upgrades/phased-plan.md`. Source plan: `plan.md`
beside this file. Owns R20 to R23.

## 1. Outcome

The operator chooses which kinds of item notify. A report raises "Steve's back: ..." when its
agent has stopped and "Steve posted a report: ..." when it is still working. Clicking it opens
the inbox at that report, or at the report that has replaced it. While away, reports wait and the
return digest names who posted.

## 2. Entry criteria

Phase 2 is merged. May run concurrently with Phases 3, 4 and 5.

## 3. Scope and non-goals

In scope: the five switches, notify classes, the announce stamp, the `report` alert, delivery by
class and Away state, the notification click and the pinned report it opens, the digest, hiding
reports from the inbox, docs and specs. Not in scope: a Settings page panel, mute and guidance
(Phase 7), changes to any other alert kind, reading reports aloud, showing a replaced report's
older version in the inbox.

## 4. Repository findings and contracts

- Inherited: `ReportItem` with null `announcedAs` and `announcedAt`, `supersededBy`, the fold
  item, `toRead`, `openReportId`, `ReportCard`, `agentDisplayName`. The `reports` snapshot field
  carries every unread, latest report whatever the listed-in-inbox setting says.
- Settings: `ui.alerts` is `{ notifications, sound }` (`src/shared/protocol.ts:4390`, `:4555`),
  read through `useAlertSettings` (`src/web/lib/alertSettings.ts:22`) and drawn by `ChannelRow`
  and `AlertPanel` (`src/web/components/AlertBar.tsx:21`, `:76`). Pinned by
  `test/alert-panel-render.test.ts` and `test/tooltip-coverage.test.ts`.
- Delivery: `deliverable` (`src/shared/alerts.ts:116`) is applied at
  `src/web/useNotifier.ts:120`. The two `review` branches are at `alerts.ts:260-286`. A click
  only focuses the window (`useNotifier.ts:29`).
- The browser never reads Away mode; the daemon buffers every alert while away
  (`src/server/away/watcher.ts:204`) and refreshes stalls (`:213`). The dashboard reads Away
  state through `src/web/lib/awayMode.ts`.
- The digest's kinds are `KIND_ORDER` (`src/shared/away-buffer.ts:272`) and its line is
  `rollupLine` (`:291`). `pipeline` is missing from that table today; leave that as it is.
- `e2e/specs/notification-sound.spec.ts` shows how a spec captures notifications.
- The notify switch and the listed-in-inbox switch are independent, so a notification can
  arrive for a report the fold omits. A report can also be read, or replaced, between the
  notification and the click.
- R12: a replacing report takes the earlier one's place, and the inbox shows only the latest of
  a chain. The older version stays in the conversation.

## 5. Implementation steps

1. **Settings.** `ui.alerts` gains `notify { blockingQuestions, filedQuestions, reports, stuck }`
   and `reportsInInbox`, all defaulting to true.
2. **Notify class.** `Alert` gains optional `notify`: `blocking-question` and `filed-question`
   on the two `review` branches, `stuck` on `stuckAlert`, `report` on the new alert. A pure
   `shouldDeliver(alert, settings, away)` replaces the filter in the notifier: a classed alert
   obeys its switch; a `report` alert is also held while away; every other alert is delivered
   exactly as `deliverable` decides today.
3. **Announce stamp.** In the report manager: after a post, the report is stamped `back` if its
   session leaves working within 20 seconds, else `working` when the grace period ends. A
   report still unstamped when the daemon starts is stamped from its session's current state.
   Each stamp emits `report_upsert`.
4. **Report alert.** `AlertScope` gains `reports`. `detectAlerts` raises kind `report` (id
   `report:<id>`, severity `info`, carrying `reportId`) when a report's `announcedAs` goes from
   null to set: "<name>'s back: <title>" or "<name> posted a report: <title>", using the name
   stored on the report. A session that stops without a report raises nothing new.
5. **Click and the pinned report.** A notification carrying `reportId` focuses the window and
   opens the inbox. A pure `reportToShow(reportId, reports, fold)` decides which report opens and
   where, in two steps:
   - **Which report.** The notified report, unless it has been replaced. A replaced report
     resolves, by following `supersededBy`, to the latest report of its chain, and that report
     is the one opened. This is the single rule for a replaced report, and it is the rule in the
     adopted decision and R22. The older version is never drawn in the inbox.
   - **Where.** If the fold lists the report to open, its row is opened in the Reports section,
     as a click on the row would. If the fold does not list it, because reports are unlisted by
     the setting or it has been read, the inbox draws that one `ReportCard`, open, in a band
     above the sections headed "Opened from a notification". An unread report comes from the
     dashboard's `reports` state. One already read, and the resolution of a replaced id the
     dashboard no longer holds, come from a new `GET /api/reports/:id`, which returns the report
     and, when it was replaced, the latest report of its chain.
   `openReportId` is set to the report that opens. That report is recorded as opened and is not
   marked read. The band holds only that card, goes when the inbox closes, and changes neither
   the Reports section nor `toRead`. If the fetch fails, the band says the report could not be
   loaded.
6. **Away.** The watcher's scope includes reports, so they are buffered. `KIND_ORDER` gains
   `report`, and the rollup reads "N reports waiting: A, B and K others" from the buffered
   events' names. Stuck alerts still break through.
7. **Popover.** A **What notifies you** group of five switches under "How you're reached", shown
   when the flag is on.
8. **Listed in the inbox.** With `reportsInInbox` off, the fold omits `agent_reports` and
   `toRead` is zero. Conversations are unaffected, and a report notification still opens a
   report through the band in step 5.
9. **Docs.** The Alerts and Away mode parts of `docs/attention-and-alerts.md`, including what a
   notification opens when reports are unlisted and when its report was replaced.

## 6. Data and compatibility

No migration. The new settings default to today's behaviour for every existing alert. With the
flag off no report alert exists, the switches are hidden, the new route refuses, and
`shouldDeliver` reduces to `deliverable`.

## 7. Tests and verification

- `test/alerts.test.ts`: classes on the right alerts; the report alert fires once, on the stamp,
  with both wordings; a matrix for `shouldDeliver`.
- Report manager tests with a fake clock: both stamps, and the restart case.
- A unit test for `reportToShow`: listed; unlisted by the setting; already read; an unknown id;
  and replaced, in three forms: replaced once, replaced twice (the latest of the chain opens,
  not the middle one), and replaced with the replacement already read (the replacement opens in
  the band).
- An HTTP test for `GET /api/reports/:id`: a read report, a replaced report returning its
  chain's latest, an unknown id, flag off.
- `test/away-buffer.test.ts`: the reports rollup with one, two and many names.
- `test/alert-panel-render.test.ts`: the group, on and off the flag.
- `e2e/specs/inbox-notifications.spec.ts`: a fake agent posts and stops, and the captured
  notification reads "<name>'s back: <title>"; one that keeps working gives "<name> posted a
  report: <title>"; clicking opens the inbox with that report's row open. With "Agent reports
  notify" off there is no notification and the row is listed. With "Agent reports notify" on and
  "listed in the inbox" off, the notification still arrives; there is no Reports section and no
  to read figure; clicking it opens the inbox with that report's card under "Opened from a
  notification", its body readable and Mark read working; closing and reopening the inbox shows
  no band. Mark a report read, then click its earlier notification: the band shows it. Post a
  report, replace it, then click the first report's notification: the inbox opens the
  replacement's row, showing the replacement's title, and the first report's text is not shown.
  With Away on there is no notification and the digest names the agent.
- Run `npm run typecheck`, `npm run lint`, `npm run build` and the spec.

## 8. Merge and exit criteria

Each switch stops only its own notification. Report notifications are worded by the stamp, held
while away and summarised on return. A click on a report notification always shows a report, in
every combination of the two report switches and whether or not it has been read: the notified
report, or the report that replaced it when it was replaced. Every pre-existing alert behaves as
before.

## 9. Downstream handoff

Phase 7 filters muted authors inside `shouldDeliver`, the fold and the watcher's scope; it must
not add a second delivery path. A muted author raises no notification, so the band is never
reached for one. Voice reuses the report alert unchanged.

## 10. Cross-phase audit record

- The announce columns were created in Phase 2 so this phase adds no migration.
- The spec says report alerts are "delivered at the desk and buffered in Away mode"; plan finding
  4 is why the browser now reads Away state.
- This phase's spec reads report history through the Phase 2 route, not the Phase 3 conversation
  entry, so the two can merge in either order.
- Plan validation round 1: this phase adds no card control. The popover switches are settings,
  not inbox actions, so the action registry is untouched here.
- Plan validation round 2: hiding reports with `reportsInInbox` unlists them without marking
  them read, as R9 and the index now state. A notification click opens a report and does not
  clear it.
- Plan validation round 3: the click used to assume the fold lists the report. It now pins the
  report above the sections when the fold does not, which covers reports unlisted by the setting
  or already read. The band reuses `ReportCard`, so it adds no new control, and it works whether
  or not Phase 3 has merged.
- Plan validation round 4: the root plan said the click opens "that report" while this phase
  opened a replaced report's successor. The successor is the adopted rule, now written into the
  adopted decision, R22 and the design section, and step 5 states it first, before where the
  report is drawn. It follows R12: the inbox shows only the latest of a chain.
- Plan validation round 5: the band in step 5 is drawn above every section and is not a fold
  kind, so it is outside `INBOX_SECTION_ORDER` and does not move the Reports section, which
  stays immediately before Snoozed.
