# Phase 1: Push contract and gh plumbing

Part of [plan.md](plan.md) via [phased-plan.md](phased-plan.md). Read both before this file.

## 1. Outcome and value

After this phase, the task-source subsystem has a complete, tested **push capability at the contract and implementation level**: the shared kind registry declares which kinds can receive pushed tasks, the github-issues implementation can create an issue and read the result safely, and every `gh` invocation in the codebase goes through one overridable seam (`ghBin()`). Nothing user-visible changes and no caller exists yet - this phase is the foundation phases 2 and 3 consume.

Engineering value on its own: the `MISSION_GH_BIN` seam makes every gh-touching subsystem (task sources, PR poller, Inspector) fakeable in tests and e2e, which the codebase cannot do today.

## 2. Entry criteria and dependencies

- Direct dependencies: none. First phase.
- Entry: clean checkout of the default branch with this plan directory merged.

## 3. Scope and non-goals

In scope:

- `src/shared/task-source.ts`: `canPush` on the kind info, `PushDraft` / `PushResult` / `PushContext` types, optional `push` verb on `TaskSourceImpl`, honest header-comment rewrite.
- `src/server/task-sources/index.ts`: erased `push` slot, `canPushTo`, `pushToSource`.
- `src/server/config.ts`: `ghBin()`.
- `ghBin()` substitution at **all 14** literal `"gh"` call sites (counts verified against HEAD): 3 in `src/server/task-sources/github-issues.ts` (lines ~200, ~215, ~223), 2 in `src/server/pr.ts` (lines ~93-94, ~151), 9 in `src/server/inspector/github.ts` (lines ~101, ~272, ~446, ~488, ~699, ~745, ~768, ~804, ~849).
- `src/server/task-sources/github-issues.ts`: `ghIssueCreateArgs`, `pushResultFrom`, module-private `push`, registered on the `githubIssues` impl.
- Unit tests in `test/task-source-contract.test.ts` and `test/github-issues-map.test.ts`.

Non-goals (owned by later phases):

- No DB write, no `attachSource`, no `push.ts` chokepoint, no route (phase 2).
- No web/UI change, no e2e fixture or spec, no `MISSION_GH_BIN` in `e2e/fixtures/daemon.ts` (phase 3). Setting that env var before `FAKE_GH` exists would point the daemon at a missing binary.
- No docs prose changes beyond the `task-source.ts` header comment (phase 3 owns `docs/dispatch-and-backlog.md` and panel wording).

## 4. Repository findings and inherited contracts

Verified against current HEAD (a6146ee):

- `TaskSourceImpl` has exactly `preflight` + `sweep`; the header comment at `src/shared/task-source.ts:5-25` states the read-only contract this phase widens. Rewrite it honestly: sweeps stay read-only; a kind may additionally declare `push`, which writes to the EXTERNAL system, never to our DB; the DB writer for the push path will be `src/server/task-sources/push.ts` (phase 2), exactly as `ingest.ts` is for sweeps.
- `TASK_SOURCE_KIND_INFO: Record<TaskSourceKind, TaskSourceKindInfo>` and `TASK_SOURCES: Record<TaskSourceKind, ErasedTaskSource>` are compiler-enforced records; adding `canPush` to the info type forces both kinds to declare it.
- `erase()` in `src/server/task-sources/index.ts` parses config at the boundary for `preflight`/`sweep`; the new `push` slot must do the same.
- `envVar()` (re-exported by `src/server/config.ts` from `src/shared/harness-runtime.mjs:32`) resolves `MISSION_<suffix>` then `FLEET_<suffix>` then `HARNESS_<suffix>`, so `envVar("GH_BIN")` gives the `MISSION_GH_BIN` override for free.
- `run()` (`src/server/util/exec.ts`) never throws; `RunResult` carries `stdout, stderr, code, outcomeUnknown, overflowed`. `outcomeUnknown` is the load-bearing flag: it means the child never reported its own exit, so the action MAY have landed.
- `externalIdFor(url)` in `github-issues.ts` already derives `owner/repo#123` from an issue URL with a stable fallback to the URL itself; reuse it, do not duplicate the regex.
- `GhResult` / `wasRefused` in `src/server/inspector/github.ts:23,57` are the write-safety vocabulary precedent: only an explicit `outcomeUnknown === false` failure means "nothing was published, retry safe".
- `gh issue create` prints the created issue URL on stdout; `--label` fails hard when the label does not exist on the repo (accepted by design; the error surfaces loudly).

## 5. Implementation steps

1. `src/shared/task-source.ts`
   - Add `canPush: boolean` to `TaskSourceKindInfo` with a doc comment ("this kind can receive a task pushed outward from the backlog; the Record makes every kind declare it"). Set `true` for `"github-issues"`, `false` for `jira` in `TASK_SOURCE_KIND_INFO`.
   - Add `PushDraft { title: string; intent: string }`, `PushResult { ref: TaskSourceRef | null; error: string | null; outcomeUnknown: boolean }` (doc: `outcomeUnknown` means the item MAY exist upstream - a caller must never treat it as retry-safe), and `export type PushContext = SweepContext`.
   - Add `push?(config: C, draft: PushDraft, ctx: PushContext): Promise<PushResult>` to `TaskSourceImpl`, documented as present exactly when `canPush`, fired only on explicit operator action, never from the sweep loop.
   - Rewrite the header contract comment per section 4.
2. `src/server/config.ts`: add `ghBin(): string` returning `envVar("GH_BIN") || "gh"` (empty string counts as unset), doc-commented as the one seam every gh subprocess goes through, override intended for e2e fakes and wrappers.
3. Substitute `run("gh", ...)` with `run(ghBin(), ...)` at all 14 sites listed in section 3. Mechanical; no argv or option changes. Import `ghBin` where missing.
4. `src/server/task-sources/github-issues.ts`
   - `export function ghIssueCreateArgs(cfg: GithubIssuesConfig, draft: PushDraft): string[]` returning `["issue","create","--title",draft.title,"--body",draft.intent, ...(cfg.repo ? ["--repo", cfg.repo] : []), ...cfg.labelsAny.flatMap((l) => ["--label", l])]`. Doc: labels are the source's own sweep filter, so the pushed issue matches the very filter this source sweeps; argv array, so no quoting rules apply.
   - `export function pushResultFrom(res: RunResult, ctx: PushContext): PushResult` with rules IN ORDER: (a) `res.outcomeUnknown` true -> `{ref: null, error: "gh issue create did not report back - the issue may exist; check GitHub before retrying", outcomeUnknown: true}`; (b) non-zero exit -> first non-empty stderr/stdout line as error, `outcomeUnknown: false`; (c) exit 0 -> last non-empty stdout line parsed as the issue URL, `ref = {sourceId: ctx.sourceId, externalId: externalIdFor(url), url}`; (d) exit 0 with no line that looks like a URL (`/^https?:\/\//`) -> `outcomeUnknown: true`, message saying the issue was created but could not be read back. Never map (d) to success or to a retryable refusal.
   - Module-private `async function push(cfg, draft, ctx)` = `run(ghBin(), ghIssueCreateArgs(cfg, draft), { cwd: ctx.repoRoot, timeoutMs: GH_TIMEOUT_MS })` then `pushResultFrom`.
   - Register `push` on the exported `githubIssues` impl object. Leave `jira.ts` untouched.
5. `src/server/task-sources/index.ts`
   - `ErasedTaskSource` gains `canPush: boolean` and `push: ((config: unknown, draft: PushDraft, ctx: PushContext) => Promise<PushResult>) | null`.
   - `erase()` wires `push` when `impl.push` exists, parsing config through `impl.configSchema` first; a rejected config becomes `{ref: null, error: reason(parsed.error), outcomeUnknown: false}`.
   - `export function canPushTo(inst: TaskSourceInstance): boolean` (reads `TASK_SOURCES[inst.kind].canPush`; the call-site-safe form of the question so nothing outside this file tests `inst.kind`).
   - `export async function pushToSource(inst, draft, ctx): Promise<PushResult>`: null `push` -> `{ref: null, error: `${inst.kind} cannot receive pushed tasks`, outcomeUnknown: false}`; a thrown error is caught as `{ref: null, error, outcomeUnknown: false}` (a throw is our own pre/post-processing; `run()` never throws and reports its own outcomeUnknown).

## 6. Data / API / migration notes

None. No persisted shape changes: `canPush` is a compile-time constant, not stored config, so existing `taskSources` blobs in `app_config` parse unchanged. `ghBin()` defaults to `"gh"` when the env var is unset, so runtime behavior is byte-identical for every existing deployment.

## 7. Tests and verification

- `test/task-source-contract.test.ts` (extend): "a kind says canPush exactly when its implementation can push" (`TASK_SOURCES[k].push !== null` iff `TASK_SOURCE_KIND_INFO[k].canPush`, for every kind); "pushing to a kind that cannot receive is an error, never a silent success" (jira instance through `pushToSource`); "push parses config at the boundary and refuses an unusable blob as an error".
- `test/github-issues-map.test.ts` (extend): `ghIssueCreateArgs` full argv (repo + two labels -> repeated `--label`) and minimal argv (no `--repo`, no `--label`); `pushResultFrom` success URL -> stable ref (externalId `owner/repo#N`, sourceId from ctx); non-zero exit -> refusal with `outcomeUnknown: false`; `outcomeUnknown` propagation with the "may exist" message; exit 0 with no URL -> `outcomeUnknown: true`.
- Commands: `npm run typecheck && npm run lint && npm test`. Single-file loop: `node --test --test-concurrency=2 --import tsx test/github-issues-map.test.ts`.
- No build-surface change beyond server code: `npm run build && npm run smoke` once before the PR.

## 8. Merge and exit criteria

- All commands in section 7 green.
- Zero behavior change with `MISSION_GH_BIN` unset (no test churn outside the two extended files).
- `command grep -rn '"gh"' src/server --include='*.ts'` shows no remaining literal gh binary argument to `run()` (comments and strings inside error messages excepted).
- Reviewable PR merged to the default branch.

## 9. Downstream handoff

Later phases may rely on, and must not change:

- `PushDraft`, `PushResult`, `PushContext`, `TaskSourceImpl.push`, `canPush` exactly as typed here.
- `canPushTo(inst)` and `pushToSource(inst, draft, ctx)` as the only entry points to push implementations; no caller tests `inst.kind`.
- `pushResultFrom`'s four-rule reading, especially: `outcomeUnknown: true` is never retry-safe, and exit-0-without-URL is `outcomeUnknown`, not success.
- `ghBin()` as the single gh seam; `MISSION_GH_BIN` as its override (phase 3 sets it in e2e).

## 10. Cross-phase audit record

- 2026-08-09: initial version. Verified against HEAD a6146ee: 14 gh call sites (3 github-issues, 2 pr.ts, 9 inspector), `envVar` prefix chain `MISSION_/FLEET_/HARNESS_`, `TaskSourceImpl` currently `preflight`+`sweep` only. Decision "convert every gh call site now" (plan review) is owned here. The e2e consequence (FAKE_GH must answer `pr list`) is owned by phase 3, which is the phase that sets `MISSION_GH_BIN`.
