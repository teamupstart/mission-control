# Task shaping - Phase 4: Shaper folder

## Outcome

Dropping a folder with a `shaper.json` into `shapers/` under the state home installs a shaper.
It is enabled as soon as it is discovered (D4a) and takes effect at the next dispatch, with no
restart and no click. Settings lists it as Found on disk with its path, and the operator can
switch it off there. Every launch records which definition ran.

## Entry criteria and dependencies

- Phase 3 is merged, for the list its rows join. Phase 1's contracts are unchanged.

## Scope

- `discoverShapers()`, and its use by the engine, the dry-run route and `GET /api/shaping`.
- The enablement rule, id clashes, invalid and refused manifests, the bounds.
- `./` commands that resolve inside the shaper's own folder.
- `origin` and `sha256` in the task record. Found on disk rows in Settings.

Not here: a file watcher (there is none by design), shapers declared by a repository (a
non-goal), any sandbox.

## Repository findings

- **The state home.** `STATE_DIR` in `src/server/config.ts` is already the resolved home. An
  explicit `MISSION_HOME` resolves to itself and the test preload gives every worker its own,
  so `join(STATE_DIR, "shapers")` is isolated with no extra rule.
- **Phase 1 left the seams.** `resolveShapers(config, discovered, input)` takes the list,
  `overrides` and `order` are in the config, and the summary carries `origin` and `sha256`.
- **Phase 3 left the row.** Its row component takes an origin and an optional problem.

## Steps

1. **Scan** (`src/server/shaping/discovery.ts`). List `shapers/` under the state home. A missing
   folder is an empty result, and the daemon never creates it. Read at most 32 entries in name
   order and report whether more were ignored. An entry may be a symlink to a directory. Its
   `shaper.json` must be a regular file inside the resolved directory, of at most 16 KiB, the same cap as a stored entry.
2. **Ownership.** The directory and the manifest must belong to the daemon's user and have no
   group or other write bit. Otherwise the state is `refused`, with the reason.
3. **Parse.** JSON, then `ShaperManifestSchema`. The manifest's `id` must equal the folder
   name. A failure is `invalid`, with the problem as a sentence. That includes a stage
   or transport this build does not know: Mission Control never writes a manifest, so there
   is nothing to preserve. Record the SHA-256 of the
   file's bytes.
4. **Read every time.** Read and hash every manifest on every scan. That is at most 32 files
   of 16 KiB. Keep only the parsed result, keyed by the hash, so an unchanged manifest is not
   parsed again and a replaced one is always noticed, whatever its size or timestamps.
5. **States.** `ok`, `invalid`, `refused`, or `shadowed` when a registered shaper has the same
   id. Only `ok` can run.
6. **Enablement.** Already in `resolveShapers` from Phase 1, as the table in `plan.md` states
   it: a stored choice for the id, on or off, always wins. With no stored choice a discovered
   shaper runs, unless its manifest says `"enabled": false`. This phase supplies the list and
   proves the rule end to end.
7. **Order.** Also already there: `order` lists ids, and a discovered id that is not listed
   sorts after the listed ones of its stage, by id.
8. **Commands.** A `command` that starts with `./` resolves against the folder's real path and
   must stay inside it. Otherwise the manifest is `invalid`.
9. **Engine and routes.** With the flag on, scan at daemon start, at the start of every
   shaping run and at the start of every dry-run. `GET /api/shaping` scans and returns `discovered`: id, path, state, problem,
   SHA-256 and the parsed shaper.
10. **Settings.** Found on disk rows in the same list: the path, the state, and an enable pill
    that writes the stored choice. No edit or remove: the folder is the source.
11. **Docs.** Fill "The shaper folder" in `docs/task-shaping.md`: the layout, enabled on
    discovery, how to switch one off, and the trust statement from `plan.md`. Add the path to
    `docs/configuration.md` and the paragraph to `docs/security.md`.

## Data, API and compatibility

- No schema change. The stored choice for a discovered id is an `overrides` entry.
- Nothing is scanned while the flag is off.
- The ownership check uses POSIX owner and mode bits, which is what the supported platforms
  have.

## Tests and verification

- `test/shaping-discovery.test.ts`, in a temporary state home: a valid folder, invalid JSON, a
  schema failure, an id that differs from the folder name, an oversize manifest, a manifest
  that is not a regular file, a symlinked folder, a group-writable folder (refused), 33 folders,
  a re-read after a change, a replacement of the same size that keeps the old modification
  time, a `./` command that escapes.
- Engine tests: a discovered shaper runs with no settings write; a stored off wins; a manifest
  with `"enabled": false` does not run until the operator switches it on, and then does; a
  shadowed one does not run; `origin` and `sha256` are
  recorded.
- `renderToStaticMarkup` tests for the row's four states.
- `e2e/specs/task-shaping-folder.spec.ts`: with the daemon running, write a folder into its
  state home; the next dispatch shows that shaper's entry in the viewer; Settings shows it as
  Found on disk with its path; switching it off there stops it at the following dispatch.
- Run `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run smoke` and
  `npm run test:e2e`.

## Merge and exit criteria

- A dropped-in folder takes effect at the next dispatch and is visible in Settings and in the
  viewer.
- A replaced manifest runs as its new definition at the next dispatch, and that launch
  records the new hash.
- A stored choice, on or off, always wins over the manifest, and survives a daemon restart.
- A refused, invalid or shadowed manifest never runs and says why.

## Handoff

The folder is the only discovery location. Later work must not add another, and must keep the
rule that a repository's own files never register a shaper.

## Cross-phase audit

- Phase 1: the enablement and ordering rule was moved into Phase 1's `resolveShapers`, so this
  phase edits no shared function. It owns D4's folder half and D4a.
- Plan validation repair 2, 2026-11-19: step 6 said a manifest's `"enabled": false` kept a
  shaper off even against a stored on, which contradicted `plan.md`. A stored choice now
  always wins, in every file.
- Phase 2: the viewer already shows `origin`. No session surface is added here.
- Phase 3: rows reuse its component.
- Phases 5 and 6: a discovered manifest may name any transport, and gets that transport's
  behaviour unchanged.
- Plan validation repair 3, 2026-11-19: a manifest's size cap is 16 KiB, the same as a stored
  entry, and the scan at daemon start that `plan.md` lists is now stated in step 9.
- Review of the plan pull request, 2026-11-19, the operator's choice: step 4 trusted a
  manifest's size and modification time, so a file replaced with one of the same size and a
  preserved timestamp would have kept running as its old definition under its old hash.
  Every scan now reads and hashes every manifest, and only parsing is cached.
