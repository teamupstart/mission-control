# Phase 1: the flag, one name everywhere and the card seams

Part of `docs/plans/agent-reports-and-inbox-upgrades/phased-plan.md`. Source plan: `plan.md`
beside this file. Owns R18, R19, R24 (the order rule), R25 and R27.

## 1. Outcome

A new `inbox` preview flag exists in Settings. With it on, alert titles, inbox row headers, the
review modal header and question cards name an agent by one rule, and a resident's name is drawn
in its board colour. Later phases get a section-order rule and a place to declare card actions
with their spoken forms.

## 2. Entry criteria

The planning pull request is merged. No phase dependency.

## 3. Scope and non-goals

In scope: the flag, the resolver, its use on existing surfaces, the order constant, the action
and hint seam, docs and specs. Not in scope: call signs and the reference name (voice adds the
fields), the tray (it shows counts only), the cards inside an agent's own conversation, reports
and Stuck rows.

## 4. Repository findings and contracts

- Flags are declared only in `src/shared/feature-flag-registry.ts` (the `async-input` entry is
  at `:74`). An id constant lives beside its feature (`ASYNC_INPUT_FLAG`,
  `src/shared/async-input.ts:13`). Gates: `featureEnabled` (`src/server/feature-flags/index.ts:63`)
  and `useFeatureFlag` (`src/web/useFeatureFlag.ts`). A flag cannot require another.
- Names today: `sessionLabel` is private (`src/shared/alerts.ts:125`); `inboxSubject`
  (`src/web/components/AttentionInbox.tsx:229`) uses `session.name`; so do the review modal
  (`src/web/components/ReviewModal.tsx:98`) and the snoozed row
  (`src/web/components/ReviewSnooze.tsx:284`). `ReviewCard` (`ReviewModal.tsx:133`) shows no
  name and is shared by the modal, the inbox and `src/web/ensembles/EnsembleMembers.tsx`.
- A resident session joins its run by `task.id === run.taskId`. The run carries
  `settings.identity.name` and `settings.board.colorId` (`ResidentRunSummary`,
  `src/shared/residents.ts:605`). The colour style is `residentAccentStyle`
  (`src/web/residents/marker.ts:168`).
- `detectAlerts` runs in the browser (`src/web/useNotifier.ts:120`) and in the daemon's away
  watcher (`src/server/away/watcher.ts:204`). Both must name alike.
- The fold's section order is implicit in push order (`src/web/lib/attention.ts:355`).

## 5. Implementation steps

1. **Flag.** `src/shared/inbox.ts` exports `INBOX_FLAG = "inbox"`. Add the registry entry: label
   "Reports and inbox upgrades", stage `preview`, a description naming reports, Stuck rows and
   the naming rule, and keywords.
2. **Resolver.** `src/shared/display-name.ts`: `agentDisplayName(input)` returns
   `{ name, source, spoken }`, ranking call sign or reference name, resident name, task title,
   session name, then "a session". `spoken` is true only for the first two ranks. A helper builds
   the input from a session and the resident runs.
3. **Alerts.** `AlertScope` gains optional `names` (the resident runs). `sessionLabel` uses the
   resolver when it is present. The browser passes it when the flag is on; the watcher passes it
   when `featureEnabled(INBOX_FLAG)`.
4. **Dashboard surfaces**, behind `useFeatureFlag(INBOX_FLAG)`: `inboxSubject` and the session
   row headers, the snoozed row, the review modal header, and a name line in the `ReviewCard`
   head. A resident's name takes its board colour.
5. **Section order.** Add `INBOX_SECTION_ORDER` listing today's seven kinds in rendered order and
   make the fold emit in that order. Correct the stale six-section comment.
6. **Action seam.** In `src/shared/inbox.ts`: `InboxActionSpec { id, label, spoken }` and an
   `INBOX_ACTIONS` registry, seeded with the question card's forms ("{name}, option B",
   "reply, ..."). In the dashboard: a `SpokenHint` component that reads a voice-hints context,
   default off, and renders nothing. Place it on the question card.
7. **Docs.** `docs/feature-flags.md` (the flag list and the Shipped flags table) and
   `docs/attention-and-alerts.md` (the naming rule).

## 6. Data and compatibility

No storage. With the flag off every name is exactly what it is today, and tests pin both states.

## 7. Tests and verification

- `test/display-name.test.ts`: every rank, the fallbacks, `spoken`.
- `test/alerts.test.ts`: titles with and without `names`.
- `test/attention-inbox.test.ts`: the fold follows `INBOX_SECTION_ORDER`.
- `test/feature-flags.test.ts`: the entry is `preview` and off by default.
- A `renderToStaticMarkup` test for the `ReviewCard` name line.
- `e2e/specs/inbox-flag.spec.ts`, after `e2e/specs/async-input-flag.spec.ts`: the Settings row
  appears off, and toggling it reaches a second window without a reload.
- `e2e/specs/inbox-display-name.spec.ts`: with the flag on, a fake session whose task has a title
  files a question; the inbox row header, the review modal header and the question card all show
  the task title. With the flag off they show the session name. A resident shows its profile
  name with its board colour.
- Run `npm run typecheck`, `npm run lint`, `npm run build` and the two specs.

## 8. Merge and exit criteria

The flag row exists and toggles live. With the flag on, the four surfaces agree on one name; with
it off nothing changed. No new control is visible for the seam.

## 9. Downstream handoff

Later phases rely on `INBOX_FLAG`, `agentDisplayName`, `INBOX_SECTION_ORDER`, `INBOX_ACTIONS`,
`SpokenHint` and `AlertScope.names`, and add to them without changing their shapes. Voice fills
`callSign` and `referenceName` and turns the hints on.

## 10. Cross-phase audit record

- Written first. Phases 2 and 5 each add one kind to `INBOX_SECTION_ORDER` at the position the
  index fixes; neither reorders the existing seven.
- After Phase 2: report rows store the resolver's name at post time, so the resolver must not
  need a live session. Its input is plain values. Confirmed.
- After Phase 6: the report alert takes its name from the report, not from `sessionLabel`.
  No change here.
