# Phase 4: report documents

Part of `docs/plans/agent-reports-and-inbox-upgrades/phased-plan.md`. Source plan: `plan.md`
beside this file. Owns R13.

## 1. Outcome

**Open report** shows the document an agent attached, from the copy Mission Control stored, even
after the worktree is gone. **Publish as scout** saves that document to the scout archive when
the operator asks, and never otherwise.

## 2. Entry criteria

Phase 3 is merged. May run concurrently with Phases 5 and 7.

## 3. Scope and non-goals

In scope: the document route, the reader, the Open report control on the inbox card and the
conversation entry, the archive capture path, the publish route and control, docs and specs. Not
in scope: publishing a report that has no document, editing or deleting stored documents, any
automatic publication, accepting page content from the browser.

## 4. Repository findings and contracts

- Inherited: the stored copy at `<state home>/reports/<id>/`, `ReportItem.document`,
  `publishedArchiveKey`, `ReportCard`, `ReportEntryCard`, `InboxActionButton`.
- The Files viewer reads only a session's checkout (`src/server/routes.ts:3596`, `:3614`).
  State-home files are served by the managed-plan routes (`routes.ts:5787`), read in
  `src/web/components/ManagedPlanReader.tsx`, and by the archive artifact route
  (`routes.ts:4111`), read in `src/web/components/scouts/ScoutReader.tsx`. Both sandbox what
  they serve.
- Archive kinds are `scout` and `plan` (`src/shared/archives.ts:56`). A scout bundle is produced
  only by `ArchiveManager.submit` under a scout task's authority
  (`src/server/archives/manager.ts:254`); a plan bundle by the capture in
  `src/server/archives/plan.ts`. The page must pass the static checker in
  `src/server/archives/html.ts`. `docs/archives.md` describes a bundle.
- The daemon has no Markdown renderer today. `react-markdown` and `remark-gfm` are runtime
  dependencies in `package.json`, and the test suite already renders React to static markup in
  Node.
- A new modal follows the inset rule in `AGENTS.md`.

## 5. Implementation steps

1. **Document route.** `GET /api/reports/:id/document` serves the stored file with a sandbox
   content security policy and `nosniff`, as the plan and archive routes do. A missing file is a
   404 the reader can explain.
2. **Reader.** A `ReportDocumentReader` overlay: an HTML document in a sandboxed frame, a
   Markdown document through the dashboard's Markdown component. **Open report** appears on
   `ReportCard` and `ReportEntryCard` when the report has a document, and posts opened. Opening
   a document does not mark the report read.
3. **Page builder.** A daemon function builds the page to publish from the stored file and
   nothing else. An HTML document is its stored bytes. A Markdown document is rendered by the
   daemon to a static page, using one shared Markdown configuration that the reader also uses.
   If the daemon bundle cannot carry that renderer, the daemon instead wraps the escaped Markdown
   text in a static page; either way the daemon, not the browser, produces the page.
4. **Capture path.** Add an operator-initiated capture to the archive manager that writes a
   `scout` bundle whose `report/report.html` is the built page, after the checker passes it. Its
   title is the report's title; it has no prompt trail and no `artifacts/` half. It is keyed by
   the report id, so a repeated publish returns the same archive.
5. **Publish route and control.** `POST /api/reports/:id/publish` takes no body fields beyond
   the id in its path; its schema is strict, so a request that supplies a page or a path is
   refused. It runs the capture, stores `publishedArchiveKey` and emits. The card shows
   **Publish as scout**, then "Published" with **Open archive** (`#/scouts/<key>`). A page the
   checker refuses shows its problems on the card and publishes nothing. Publishing does not
   mark the report read.
6. **Actions.** Declare `open-report` and `publish-scout` with the forms in the index table and
   `open-archive` as click-only navigation. Draw all three with `InboxActionButton`.
7. **Docs.** `docs/archives.md` gains "How a report produces one"; `docs/sessions.md`.

## 6. Data and compatibility

No migration: the column exists from Phase 2. The archive format is unchanged, so an older reader
opens a published report as a scout archive. With the flag off both routes refuse.

## 7. Tests and verification

- `test/reports-document-http.test.ts`: headers, a missing file, flag off.
- `test/reports-publish.test.ts`: an HTML document publishes once and is idempotent; the archived
  page's digest equals the digest of the stored file, for HTML, and of the daemon's render of the
  stored file, for Markdown; a request carrying a substitute page is refused and archives
  nothing; changing the checkout file after posting does not change what is published; a page
  with a script is refused with its problems; nothing is archived without the call; neither
  opening nor publishing sets `readAt`.
- `test/inbox-actions.test.ts` covers the three actions.
- `e2e/specs/reports-document.spec.ts`: post a report with an HTML file, delete the checkout
  file, press Open report and read the document's text in the reader; call
  `expectContentClearsBorder` on the reader; press Publish as scout and find the report on the
  Scouts page. Before the click, the Scouts page does not list it.
- Run `npm run typecheck`, `npm run lint`, `npm run build`, `npm run smoke` and the spec.

## 8. Merge and exit criteria

The stored copy opens without its checkout. Publication happens only on the operator's click,
once per report, always from the stored copy, and a refused page explains itself. Neither action
clears the report.

## 9. Downstream handoff

Nothing later depends on this phase. Voice does not publish by itself; it calls the declared
actions.

## 10. Cross-phase audit record

- This phase is last in the report chain so the archive work cannot delay replies or
  notifications.
- Phase 2 already validates the file's extension and size at post time, so the reader and the
  capture path trust only the two kinds it stores.
- Phase 7's Mark all read and mute do not touch documents; a published archive stays published.
- Plan validation round 1: an earlier draft had the dashboard render Markdown and send the page.
  That left the published content unbound to the stored document, so the daemon now builds the
  page and the route accepts none.
- Plan validation round 2: stated that Open report and Publish as scout are not among the ways
  R9 clears a report.
- Plan validation round 3: no change here. The document and publish routes read a report by id,
  so they work for a report the inbox pins from a notification.
