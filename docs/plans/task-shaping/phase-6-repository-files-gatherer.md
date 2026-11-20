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

Not here: any other built-in, or a facts format other than flat JSON. FR-06 lesson selection
is not a built-in at all (see Handoff).

## Repository findings

- **Declared already.** Phase 1 put `repository-files` in `SHAPING_BUILTINS` with its stage,
  and its options in `ShaperSchema`: `include` (paths with a byte cap each), `summary` (one
  path) and `facts` (one path).
- **Reading rules.** FR-05 section 7.15 states the rules this follows. If its reader
  (`src/server/instructions/repo-task-skill.ts`) has merged, share the file-reading helper
  instead of writing a second one, provided it reads through an opened and verified handle as
  step 2 requires. `readFileWithinCap` in `src/server/session-files.ts` already reads from a
  handle and stops at a byte limit.
- **Byte handling.** `src/server/util/utf8.ts` has `utf8Bytes` and `clipUtf8Bytes`.
- **In-process.** A built-in shares the daemon's event loop, so it must be bounded by
  construction: an open that cannot block, `fstat` on the opened handle before every read, a
  read that stops at its limit, fixed limits, and the `ctx` signal checked between files.

## Steps

1. **`builtin.ts`.** An exhaustive `Record` from built-in id to implementation. A shaper whose
   built-in does not serve its stage answers `unavailable`.
2. **Read one file.** Every check is made on the file that is read, never on a path that is
   read afterwards, because a worktree file can be replaced while shaping runs.
   - **Path.** Refuse a configured path that is absolute or has a `..` segment. Resolve its
     real path, which must lie inside the worktree's real path. `lstat` it, and skip anything
     that is not a regular file without opening it.
   - **Open.** Open that real path with `O_NOFOLLOW` and `O_NONBLOCK`. The open then returns
     at once for a named pipe with no writer or for a device, instead of waiting past the
     deadline where no abort check could release it.
   - **Identity.** Verify the handle, which is the file that will be read. `fstat` must
     report a regular file of at most 4 MiB. Then look the real path up again: it must still
     be free of symbolic links and inside the worktree, and it must name the same device and
     inode as the handle. This is an identity check, not a second path check. If a directory
     on the way was swapped while the open ran, the handle is some other file, its inode
     differs from the one inside the worktree, and the read is refused. The two can agree
     only when the handle is the file that sits inside the worktree. Node has no `openat`,
     so this is how containment is tied to the opened file on every platform, and it is
     stricter than the daemon's other worktree readers. A file that is moved or hard-linked
     into the worktree is a worktree file.
   - **Read.** Read from the handle with a hard limit, so a file that grows meanwhile is
     still cut off. Replace invalid UTF-8, drop a byte order mark, and cut at the last line
     boundary within the cap.

   A skip has one reason: `missing`, `outside-worktree`, `not-a-regular-file`, `too-large`,
   `unreadable` or `empty`.
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
  between files. Three cases drive the helper through a filesystem seam it takes as an argument:
  a file swapped for a symlink out of the worktree after its path was resolved, and a
  directory on the way to it swapped for a symlink out of the worktree while the open runs,
  both refused, and a file that grows past the limit while it is read, which is cut off. A
  named pipe with no writer is skipped at once, as `not-a-regular-file`, whether it was there
  from the start or swapped in after the `lstat`.
- An engine test: the facts and summary this gatherer returns reach a selector's request.
- `test/shaping-http.test.ts` gains a dry-run of a registered `repository-files` gatherer.
- Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` and `npm run smoke`.

## Merge and exit criteria

- A registered `repository-files` gatherer dry-runs against a repository and returns the
  entries, summary and facts its options name.
- No file outside the worktree is ever read, and no read exceeds its limit: both are
  verified on the opened file, not on a path checked beforehand.

## Handoff

A later built-in is one appended id in `SHAPING_BUILTINS` and one entry in the `Record`, and
its entries share the context budget like any other shaper's.

FR-06 lesson selection is not one. It is a step of its own after the last shaping stage, as
`plan.md` states under "Lesson selection at dispatch (FR-06)", and it is allocated last from
the same budget. Do not add it to `SHAPING_BUILTINS` or serve it through this transport.

## Cross-phase audit

- Phase 1: uses the declared id, options and transport reply. Owns the `builtin` part of D2.
- Phase 4: a discovered manifest may use this built-in.
- Phases 2, 3 and 5: no shared files.
- Plan validation repair 4, 2026-11-19: the scope line and the handoff named an "FR-06 lessons
  selector" as a later built-in, while `plan.md` also called lesson selection a later stage.
  It has one placement now, a step after the shaping stages that is not a shaper, and this
  file says so.
- Review of the plan pull request, round 2, 2026-11-19, the operator's choice: step 2 checked
  a path's real location and size and then read it by path, so a file swapped in between
  could have been read from outside the worktree or past the limit. The checks now run on the
  opened handle, and the read has a hard limit.
- Review of the plan pull request, round 3, 2026-11-19: opening a named pipe with no writer
  would have waited indefinitely, before `fstat` could reject it. The open is non-blocking.
  The reviewer also kept the containment finding open, because `O_NOFOLLOW` covers only the
  last path component. Step 2 now states that the check after the open is an identity check
  on the handle, which a swapped directory cannot pass, and the tests add that case.
