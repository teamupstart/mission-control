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
automatic publication.

## 4. Repository findings and contracts

- Inherited: the stored copy at `<state home>/reports/<id>/`, `ReportItem.document`,
  `publishedArchiveKey`, `ReportCard`, `ReportEntryCard`.
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
- The daemon has no Markdown renderer. The dashboard renders Markdown with `react-markdown`.
- A new modal follows the inset rule in `AGENTS.md`.

## 5. Implementation steps

1. **Document route.** `GET /api/reports/:id/document` serves the stored file with a sandbox
   content security policy and `nosniff`, as the plan and archive routes do. A missing file is a
   404 the reader can explain.
2. **Reader.** A `ReportDocumentReader` overlay: an HTML document in a sandboxed frame, a
   Markdown document through the dashboard's Markdown component. **Open report** appears on
   `ReportCard` and `ReportEntryCard` when the report has a document, and posts opened.
3. **Capture path.** Add an operator-initiated capture to the archive manager that writes a
   `scout` bundle whose `report/report.html` is the report's document. Its title is the report's
   title; it has no prompt trail and no `artifacts/` half. It is keyed by the report id, so a
   repeated publish returns the same archive.
4. **Markdown documents.** The dashboard renders the Markdown to a static page and sends it with
   the publish request. The daemon treats it as untrusted and runs the same checker. If the
   implementer finds a safe daemon-side renderer, prefer it and record why in the pull request.
5. **Publish route and control.** `POST /api/reports/:id/publish` runs the capture, stores
   `publishedArchiveKey` and emits. The card shows **Publish as scout**, then "Published" with
   **Open archive** (`#/scouts/<key>`). A page the checker refuses shows its problems on the
   card and publishes nothing.
6. **Docs.** `docs/archives.md` gains "How a report produces one"; `docs/sessions.md`.

## 6. Data and compatibility

No migration: the column exists from Phase 2. The archive format is unchanged, so an older reader
opens a published report as a scout archive. With the flag off both routes refuse.

## 7. Tests and verification

- `test/reports-document-http.test.ts`: headers, a missing file, flag off.
- `test/reports-publish.test.ts`: an HTML document publishes once and is idempotent; a page with
  a script is refused with its problems; a Markdown document publishes as a static page; nothing
  is archived without the call.
- `e2e/specs/reports-document.spec.ts`: post a report with an HTML file, delete the checkout
  file, press Open report and read the document's text in the reader; call
  `expectContentClearsBorder` on the reader; press Publish as scout and find the report on the
  Scouts page. Before the click, the Scouts page does not list it.
- Run `npm run typecheck`, `npm run lint`, `npm run build`, `npm run smoke` and the spec.

## 8. Merge and exit criteria

The stored copy opens without its checkout. Publication happens only on the operator's click,
once per report, and a refused page explains itself.

## 9. Downstream handoff

Nothing later depends on this phase. Voice does not publish.

## 10. Cross-phase audit record

- This phase is last in the report chain so the archive work cannot delay replies or
  notifications.
- Phase 2 already validates the file's extension and size at post time, so the reader and the
  capture path trust only the two kinds it stores.
- Phase 7's Mark all read and mute do not touch documents; a published archive stays published.
