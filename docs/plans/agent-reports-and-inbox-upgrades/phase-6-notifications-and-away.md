# Phase 6: notifications, settings and Away mode

Part of `docs/plans/agent-reports-and-inbox-upgrades/phased-plan.md`. Source plan: `plan.md`
beside this file. Owns R20 to R23.

## 1. Outcome

The operator chooses which kinds of item notify. A report raises "Steve's back: ..." when its
agent has stopped and "Steve posted a report: ..." when it is still working, and clicking it
opens the inbox at that report. While away, reports wait and the return digest names who posted.

## 2. Entry criteria

Phase 2 is merged. May run concurrently with Phases 3, 4 and 5.

## 3. Scope and non-goals

In scope: the five switches, notify classes, the announce stamp, the `report` alert, delivery by
class and Away state, the notification click, the digest, hiding reports from the inbox, docs
and specs. Not in scope: a Settings page panel, mute and guidance (Phase 7), changes to any other
alert kind, reading reports aloud.

## 4. Repository findings and contracts

- Inherited: `ReportItem` with null `announcedAs` and `announcedAt`, the fold item, `toRead`,
  `openReportId`, `agentDisplayName`.
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
5. **Click.** A notification carrying `reportId` focuses the window and opens the inbox with
   that report open, which records it as opened.
6. **Away.** The watcher's scope includes reports, so they are buffered. `KIND_ORDER` gains
   `report`, and the rollup reads "N reports waiting: A, B and K others" from the buffered
   events' names. Stuck alerts still break through.
7. **Popover.** A **What notifies you** group of five switches under "How you're reached", shown
   when the flag is on.
8. **Listed in the inbox.** With `reportsInInbox` off, the fold omits `agent_reports` and
   `toRead` is zero. Conversations are unaffected.
9. **Docs.** The Alerts and Away mode parts of `docs/attention-and-alerts.md`.

## 6. Data and compatibility

No migration. The new settings default to today's behaviour for every existing alert. With the
flag off no report alert exists, the switches are hidden, and `shouldDeliver` reduces to
`deliverable`.

## 7. Tests and verification

- `test/alerts.test.ts`: classes on the right alerts; the report alert fires once, on the stamp,
  with both wordings; a matrix for `shouldDeliver`.
- Report manager tests with a fake clock: both stamps, and the restart case.
- `test/away-buffer.test.ts`: the reports rollup with one, two and many names.
- `test/alert-panel-render.test.ts`: the group, on and off the flag.
- `e2e/specs/inbox-notifications.spec.ts`: a fake agent posts and stops, and the captured
  notification reads "<name>'s back: <title>"; one that keeps working gives "<name> posted a
  report: <title>"; clicking opens the inbox at the report. With "Agent reports notify" off there
  is no notification and the row is listed. With "listed in the inbox" off there is no Reports
  section or figure, and `GET /api/sessions/:id/reports` still returns the report. With Away on
  there is no notification and the digest names the agent.
- Run `npm run typecheck`, `npm run lint`, `npm run build` and the spec.

## 8. Merge and exit criteria

Each switch stops only its own notification. Report notifications are worded by the stamp, held
while away and summarised on return. Every pre-existing alert behaves as before.

## 9. Downstream handoff

Phase 7 filters muted authors inside `shouldDeliver`, the fold and the watcher's scope; it must
not add a second delivery path. Voice reuses the report alert unchanged.

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
