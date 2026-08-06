# Persona import, provenance and upstream drift

Three frames from the passing browser regression
`e2e/specs/persona-import-provenance.spec.ts`, taken between its own assertions against the
built dashboard. Each capture happens only after the assertions it illustrates have already
held on the same run, so the picture and the measurement cannot drift apart.

The role document is written into the daemon's own isolated `MISSION_HOME` during the run,
which is why the paths in the frames point at a temp directory: "an absolute path on the
daemon's machine" is literal here, and that machine is the test runner.

- `imported.png` - the Persona editor immediately after **Import from path**. The name comes
  from the document's first heading and the description from the paragraph under it, and the
  provenance line under the name states the file it was read from and when. The sidebar row
  carries no badge, because nothing on disk has changed yet. The **Import from path** field
  takes a line of its own with its two buttons under it - on one line in a rail this width the
  field collapses to a slot too narrow to read a path in.
- `upstream-changed.png` - the same Persona after the source file gained a `DON'T` section and
  **Check upstream** was pressed. The sidebar row wears an amber `UPSTREAM CHANGED` tag beside
  where a built-in would wear its own, and the status line states the invariant that makes
  adopting it safe: the stored guidance is unchanged and every published workflow version keeps
  what it was published with. It names the header's **Re-import from source** rather than
  carrying a second copy of that button.
- `library-shelf.png` - the Library's reviewer shelf with the same fact one level up: the card
  is tagged `upstream changed` in the attention tone the shelf already uses for a workflow
  draft, so the badge is visible on the page an operator lands on rather than only in the
  editor they would have to open first.

Regenerate all three with:

```sh
npm run build
env -u NO_COLOR FORCE_COLOR=0 MC_E2E_EVIDENCE=1 npx playwright test \
  --config e2e/playwright.config.ts \
  e2e/specs/persona-import-provenance.spec.ts \
  --workers=1 --reporter=list
```
