# actions/

**Not GitHub Actions.** This repository's CI lives in
[`.github/workflows/`](../.github/workflows/). The name here means a *Mission Control session
action*: a reusable instruction a workflow stage sends into the session it is bound to.

Every document in this directory is the authored source of one session action that ships with
the application.

## How they reach the running app

They are **compiled into the build**. `npm run session-actions` embeds their exact bytes in
`src/server/workflows/builtin-session-actions.generated.ts`, which is the only copy that
survives bundling and packaging. Edit the Markdown here and run the generator; never
hand-edit the generated module.

Exactness is the whole point. The prompt is typed into an operator's conversation verbatim
and a published workflow version freezes a copy of it, so nothing between this file and the
session trims it, re-wraps it, or normalizes its newlines.

Each document's first level-one heading becomes the action's name and the paragraph under it
becomes the description.

## What is not in the document

A session action also carries a **required skill** and a **completion** - what Mission Control
must observe before the stages below it run. Those two are contracts the daemon enforces
rather than prose, so they live in a table keyed by slug in
`src/server/workflows/builtin-session-actions.ts`, not in this Markdown. A typo in
frontmatter would otherwise ship an action that never sends or completes under the wrong
proof.

## Filenames are durable ids

A filename slug is the durable half of its `builtin:<slug>` id, and published workflow
versions and operator drafts reference those ids. Renaming a document repoints an id that is
already in use. Add and remove freely; rename only with a migration.

`scripts/builtin-session-actions.ts` globs `actions/*.md` and excludes this README by name
(`NON_SESSION_ACTION_DOCUMENTS`). Anything else added to this directory becomes a built-in
session action, so keep other prose out of it.
