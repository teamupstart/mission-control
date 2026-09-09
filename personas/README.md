# personas/

Every persona document Mission Control ships, in one directory. Two kinds live here, and
they reach the running app by different routes.

## The eight workflow persona sources

`code-design-reviewer.md`, `code-quality-judge.md`, `code-risk-reviewer.md`,
`documentation-steward.md`, `intent-conformance-judge.md`, `slop-filter.md`, and
`test-coverage-judge.md` and `test-evidence-auditor.md` are the built-in review roles. They are
**compiled into the build**:
`npm run personas` embeds their exact bytes in `src/server/workflows/builtin-personas.generated.ts`,
which is the only copy that survives bundling and packaging. Edit the Markdown here and run the
generator; never hand-edit the generated module.

Each document's first level-one heading becomes the Persona's name and the paragraph under
it becomes the description.

## The two operator briefs

`FOREMAN.md` and `INSPECTOR.md` are read **as files at runtime**, not compiled in, because
the point of them being Markdown is that they can be read and edited without a rebuild.

- `FOREMAN.md` is the seed for Foreman's standing instructions. The daemon resolves it
  through `foremanInstructionsPath()` in `src/server/config.ts`, which finds it at the repo
  root in dev and at the app root in a packaged build; `electron-builder.yml` ships this one
  file for that reason. Operators edit the exact document in
  **Library → Personas → Foreman** (`#/library/personas/foreman`). Once an operator saves
  custom text, the stored value wins and this file is only what **Reset to built-in default**
  restores. Clearing and saving is an intentional no-guidance state, not a reset.
- `INSPECTOR.md` is this repository's brief for the GitHub Inspector. The GitHub Inspector resolves the
  brief against the *reviewed* repository, preferring `personas/INSPECTOR.md` and falling
  back to a root `INSPECTOR.md`, so this copy is what Mission Control's own pull requests
  are reviewed against.

## Filenames are durable ids

A workflow persona's filename slug is the durable half of its `builtin:<slug>` id, and
published workflow versions reference those ids. Renaming one of the eight documents strands
them. Add and remove freely; rename only with a migration.

`scripts/builtin-personas.ts` therefore globs `personas/*.md` and excludes the two briefs
and this README by name (`NON_PERSONA_DOCUMENTS`). Anything else added to this directory
becomes a built-in Persona, so keep non-persona prose out of it.
