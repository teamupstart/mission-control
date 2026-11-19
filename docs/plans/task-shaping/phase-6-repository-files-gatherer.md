# Task shaping - Phase 6: Repository-files gatherer

## Outcome

Without writing a program, an operator can have files they name from each of a task's
repositories added as context, and a summary and facts handed to the selectors. This is the
one gatherer that ships inside Mission Control, and it reads only what its config lists.

## Entry criteria and dependencies

- Phase 1 is merged. It can be built at the same time as phases 2, 3, 4 and 5.

## Scope

- `src/server/shaping/transports/builtin.ts`: dispatch by built-in id.
- `src/server/shaping/builtin/repository-files.ts`.
- Its section of the guide.

Not here: any other built-in, a facts format other than flat JSON, the FR-06 lessons selector.

## Repository findings

- **Declared already.** Phase 1 put `repository-files` in `SHAPING_BUILTINS` with its stage,
  and its options in `ShaperSchema`: `include` (paths with a byte cap each), `summary` (one
  path) and `facts` (one path).
- **Reading rules.** FR-05 section 7.15 states the rules this follows. If its reader
  (`src/server/instructions/repo-task-skill.ts`) has merged, share the file-reading helper
  instead of writing a second one.
- **Byte handling.** `src/server/util/utf8.ts` has `utf8Bytes` and `clipUtf8Bytes`.
- **In-process.** A built-in shares the daemon's event loop, so it must be bounded by
  construction: `stat` before every read, fixed limits, and the `ctx` signal checked between
  files.

## Steps

1. **`builtin.ts`.** An exhaustive `Record` from built-in id to implementation. A shaper whose
   built-in does not serve its stage answers `unavailable`.
2. **Read one file.** Resolve the path inside `repo.path`. It must be a regular file whose real
   path stays inside the worktree, and at most 4 MiB by `stat`. Replace invalid UTF-8, drop a
   byte order mark, and cut at the last line boundary within the cap. A skip has one reason:
   `missing`, `outside-worktree`, `not-a-regular-file`, `too-large`, `unreadable` or `empty`.
3. **`include`.** At most 16 paths. Each readable file becomes one entry whose id and title are
   its path, with `truncated` set when it was cut. The per-file cap is its `maxBytes`, at most
   16 KiB.
4. **`summary`.** One path, read the same way and cut to 4 KiB, returned as `repo.summary`.
5. **`facts`.** One path to a JSON object whose values are strings or lists of strings, at most
   64 names. Anything else is skipped with a note, and no facts are returned.
6. **Notes.** Every skip becomes a sentence in `notes`. A skip is not a failure: the result is
   not `degraded`, and the launch is never affected.
7. **Docs.** Fill "The built-in gatherer" in `docs/task-shaping.md` with a manifest example
   and the reading rules.

## Data, API and compatibility

- No schema, route or database change.
- The facts file format a setup skill writes is owned by FR-03 and is not published. Flat JSON
  is what this phase reads. A different format is a later change to step 5 only.

## Tests and verification

- `test/shaping-builtin-repository-files.test.ts`, in a temporary worktree: every skip reason
  (including a symlink that leaves the worktree and a directory), the line-boundary cut, the
  summary cut, a valid and an invalid facts file, the limits, and a signal that stops the run
  between files.
- An engine test: the facts and summary this gatherer returns reach a selector's request.
- `test/shaping-http.test.ts` gains a dry-run of a registered `repository-files` gatherer.
- Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` and `npm run smoke`.

## Merge and exit criteria

- A registered `repository-files` gatherer dry-runs against a repository and returns the
  entries, summary and facts its options name.
- No path outside the worktree is ever read.

## Handoff

A later built-in, such as the FR-06 lessons selector, is one appended id in `SHAPING_BUILTINS`
and one entry in the `Record`. It shares the context budget through the allocator.

## Cross-phase audit

- Phase 1: uses the declared id, options and transport reply. Owns the `builtin` part of D2.
- Phase 4: a discovered manifest may use this built-in.
- Phases 2, 3 and 5: no shared files.
