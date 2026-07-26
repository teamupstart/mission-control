# Phase 2 - Per-file and files-only cuts of the artifact patch route

## 1. Outcome and value

The artifact patch route can answer two cheaper questions than "the whole patch": `?path=` returns the diff of one file (the unit the Phase 6 compare workspace and rationale file-anchors consume), and `?filesOnly=1` returns the complete file/stat list with no patch body (what the file-touch matrix needs per candidate without paying for N full patches). Server-only; no UI in this phase.

## 2. Entry criteria and dependencies

- Direct prerequisites: none. Independent of Phase 1 and mergeable in either order relative to it.

## 3. Scope and non-goals

In scope: the snapshot diff primitive, the artifact adapter contract, the HTTP route, tests, docs. Non-goals: any client code (Phase 6), multi-path filtering in one request (deliberately unsupported - `routes.ts:1113-1117` documents the 16KB `maxHeaderSize` failure that killed query-param path lists for `/standards`; one path per request keeps the URL bounded, and the matrix fetches per file anyway).

## 4. Repository findings this phase is built on (verified 2026-07-26)

- Route handler: `src/server/routes.ts:1417-1438`; `maxBytes` via `boundedLimit` (`routes.ts:388`), default 400 KiB, max 4 MiB; it calls `adapter.materialize(artifact.locator, { repoPath, maxPatchBytes })`.
- `materializeSnapshotDiff` (`src/server/git/ensemble-snapshot.ts:232-238`) takes `{ repoPath, baseSha, snapshotSha, maxPatchBytes? }` - no path argument today. The numstat file list (`git diff --numstat -z --find-renames`, `:245-249`) and the patch (`git diff --find-renames`, `:251-255`) are two separate invocations, and the doc comment at `:229-231` states the invariant: statistics are always complete; only the patch is capped.
- Adapter signatures to extend in lockstep: `ArtifactAdapter.materialize` (`src/server/ensembles/artifacts/types.ts:80-83`) and the git adapter's `materialize` (`src/server/ensembles/artifacts/git-snapshot.ts:171-174`).

## 5. Implementation steps

1. `ensemble-snapshot.ts`: extend the input with `paths?: string[]` and `patch?: boolean` (default true). Apply `paths` to the PATCH invocation only, appended after a `--` separator so a path can never be parsed as a flag; reject (typed refusal, not sanitization) any path that is absolute, contains `..` segments, or is empty. The numstat call never takes the filter - the stats stay complete, extending the existing invariant. `patch: false` skips the second git invocation entirely.
2. Extend the materialization result additively with `patchPaths: string[] | null` (null = full patch) so a consumer can tell a cut from the whole; `truncated`/`omittedBytes` keep their existing meaning against the (possibly filtered) patch.
3. Thread `paths?: string[]` and `patch?: boolean` through `ArtifactAdapter.materialize` (`artifacts/types.ts`) and the git adapter (`git-snapshot.ts`). Adapters that are `null` are untouched.
4. `routes.ts` patch route: read `?path=` (single value; if the query key repeats, refuse with 400 and a sentence naming the one-path rule) and `?filesOnly=1`. Map to `{ paths: path ? [path] : undefined, patch: !filesOnly }`. A `path` naming a file absent from the diff is not an error: it returns complete stats and an empty patch with `patchPaths: [path]` - the client can see the file is not in `files`.
5. Doc comment beside the query parsing citing the `/standards` precedent for why multi-path is refused.

## 6. Data / compatibility

Additive only: no persisted shape changes, no new route, existing callers (no query params) get byte-identical behavior plus the new `patchPaths: null` field. `ENSEMBLE_LIMITS` untouched.

## 7. Tests and verification

- Extend `test/ensemble-snapshot.test.ts` (comment: what is at stake is per-file evidence that stays honest): path filter yields only that file's hunks while `files` stays complete; `--` separation proven with a tracked file literally named like a flag (`--exploit`); absolute and `..` paths refused; `patch: false` runs one git invocation (assert via the exec seam); truncation on a filtered patch still reports `omittedBytes`.
- Extend `test/ensemble-http.test.ts`: `?path=` happy path, repeated `path` refused 400, `?filesOnly=1` returns no patch body, non-ready artifact still 409.
- Commands: `npm run typecheck`, `npm test`.

## 8. Merge and exit criteria

Suite green; a manual `curl` of a live run's artifact with `?path=` returns the single-file patch with complete stats. `docs/ensembles.md` artifact section gains one sentence on the two query params. README untouched (internal API surface; the README documents operator surfaces).

## 9. Downstream handoff

Phase 6 may rely on: `?path=` (single), `?filesOnly=1`, `patchPaths` on the response, complete `files` in every response. It must not: batch paths into one request, or infer "file untouched" from an empty filtered patch without consulting `files`.

## 10. Cross-phase audit record

- 2026-07-26: initial version. `filesOnly` was added here (the source plan had only the per-file cut) after Phase 6's matrix design showed it would otherwise fetch N full patches to learn file lists; recorded also in Phase 6's findings.
