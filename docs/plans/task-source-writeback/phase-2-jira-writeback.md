# Phase 2: Jira annotate and resolve

Source plan: [`plan.md`](plan.md). Index: [`phased-plan.md`](phased-plan.md).

## Outcome

A configured Jira task source writes the pull request back onto the issue it swept, as a remote
link and a comment, and moves the issue to a target status the operator named when the task
completes. The refusals name the fix: a missing target status, or a status the issue cannot
reach from where it is, comes back with the transitions that are actually available.

## Entry criteria and dependencies

Depends on **Phase 1**, and on nothing else. It needs Phase 1's contract (`WritebackNotice`,
`WritebackResult`, the `annotate` / `resolve` slots, and the `resolveTransition` / `linkVia`
config fields, all of which Phase 1 lands), and Phase 1's ledger and worker to deliver through.

Concurrent with **Phase 3**. The two share no owned surface: this phase changes `jira.ts`,
`config.ts`, the two Jira capability booleans, and the Jira e2e fixture; Phase 3 changes the
routes, the web layer, and the panel's e2e spec. They may merge in either order.

## Scope

In scope:

- `jiraBin()` in `src/server/config.ts`, and every `JIRA_BIN` call site converted.
- Jira `annotate`: remote link and comment, on both the CLI rung and the REST rung.
- Jira `resolve`: read available transitions, match the configured target, POST the id.
- The `preflight` additions that catch an unusable write-back configuration before delivery.
- Flipping Jira's `canAnnotate` / `canResolve` to `true` in `TASK_SOURCE_KIND_INFO`.
- A fake `jira` binary for end-to-end runs, wired through `MISSION_JIRA_BIN`.
- `test/` coverage, the `docs/configuration.md` and `e2e/README.md` entries for the new
  environment variable, and the Jira half of the write-back documentation.

Explicitly **not** in scope:

- Anything in `src/web/`, the retry / discard routes, or the panel. Phase 3.
- Widening the UpstartClaw rung to write tools. That rung stays read-only, and says so.
- Creating Jira issues. `canPush: false` is unchanged.

## Repository findings

Verified against the current tree:

- `JIRA_BIN` is a module constant (`src/server/task-sources/jira.ts:53`), not a seam. `ghBin()`
  (`src/server/config.ts:237-239`) is the pattern, and `e2e/fixtures/daemon.ts:435` already sets
  `MISSION_GH_BIN` for a stated reason: on a machine where `gh` is signed in, an unfaked binary
  publishes for real. The Jira CLI has the identical exposure and no equivalent seam, so this is
  a safety fix that happens to also make the phase testable.
- The auth ladder is `ladder()` (`jira.ts:1257`): CLI first when `hasBin(JIRA_BIN)`, REST when
  `restCredentialFrom(process.env)` yields a pair AND `credentialTargetProblem` clears the host.
  Writes reuse it unchanged. They must, because the guard at `jira.ts:167-281` is the thing that
  stops `JIRA_API_TOKEN` being sent to a host that merely looks like Jira, and a write path with
  its own host handling would be a second place to get that wrong.
- `restSearch` (`jira.ts:888-916`) is the model for every outbound call here: `Basic` built
  inline from `restCredentialFrom`, `AbortSignal.any([ctx.signal, AbortSignal.timeout(...)])`
  for both bounds, never throwing, and a catch that reports the message and the cause code but
  never the request - because a thrown fetch must not carry the Authorization header into a
  panel or a log line.
- `externalIdFor` (`jira.ts:345`) yields the issue key, which is what every write endpoint's
  path segment needs. `siteHost` (`jira.ts:181`) yields the host, and the request is always
  built as `https://` even when an operator typed `http://`.
- `queryVia: "upstartclaw"` (`jira.ts:1182`) runs through a tool allowlist
  (`UPSTARTCLAW_JQL_TOOLS`, `:111`) that contains one read-only search tool. Writing would mean
  adding write tools to that allowlist, which is a separate consent decision, so a source on
  that rung reports the limitation in `preflight` rather than failing at delivery time.
- `preflight` (`jira.ts:1341`) is ordered cheapest-first and each answer names one thing to do.
  The write-back checks belong at the front of that order, because they cost nothing.

## Implementation steps

### 1. `src/server/config.ts`

```ts
export function jiraBin(): string {
  return envVar("JIRA_BIN") || "jira";
}
```

Documented in the same terms as `ghBin()`: THE seam every `jira` subprocess resolves through,
and the reason it exists is that an unfaked binary on a configured machine performs a real write.

### 2. `src/server/task-sources/jira.ts` - the seam conversion

Replace every use of the `JIRA_BIN` constant with `jiraBin()`: `hasBin` in `ladder`, `run` in
`readCli`, and the new write calls below. Keep the exported constant only if something outside
this module reads it; otherwise remove it so there is one way to name the binary.

### 3. Jira `annotate`

Exported pure halves first, so the interesting part is testable without a subprocess or a
socket:

- `export function remoteLinkPayload(notice: WritebackNotice): unknown` - the
  `/rest/api/3/issue/{key}/remotelink` body, with `globalId` set to `notice.prUrl`. That
  `globalId` is what makes the call idempotent upstream: posting it twice updates one link
  rather than adding two. Title, url and a relationship of "mentioned in".
- `export function commentBodyAdf(notice: WritebackNotice): unknown` and
  `export function commentBodyText(notice: WritebackNotice): string` - the REST rung needs ADF,
  the CLI rung needs plain text, and both say the same thing.
- `export function writebackFailure(res: RestAnswer | CliRun): WritebackResult` - the reader,
  reusing `restMessage` / `cliFailure` for the message and mapping an unreadable outcome to
  `outcomeUnknown: true`.

The verb itself: refuse early on `siteProblem`, then run the enabled halves of `cfg.linkVia` in
order (remote link, then comment). Partial success is reported honestly - if the remote link
landed and the comment failed, the result is an error whose `detail` says the link is there, and
the ledger's retry re-posts the link idempotently while retrying the comment. That asymmetry is
why the remote link goes first.

### 4. Jira `resolve`

- `export function transitionFor(available: unknown, wanted: string): { id: string } | { problem: string }`
  - the matcher, pure. Case-insensitive against both the transition's own name and its target
  status name. On no match, the problem sentence lists the names that ARE available:
  `MC-431 cannot move to "Done" from "In Review" - available from here: Ready for QA, Reject`.
  That sentence is the phase's main product; guessing at a transition would be worse than
  refusing, and a bare "transition failed" would send the operator to Jira's admin screens.
- The verb: refuse with a named fix when `cfg.resolveTransition` is empty; refuse on
  `siteProblem`; `GET .../transitions`; match; `POST .../transitions` with the id. A Jira 400
  from the second call is surfaced with its first message only, because a required field on a
  transition screen is information that exists nowhere else.
- Both rungs. The CLI rung uses `jira issue move <KEY> "<status>"`, whose own failure text
  already lists valid statuses on recent versions; the REST rung uses the two calls above.

### 5. `preflight` additions

At the front of the existing order, and only when the source's `writeback` switches are on:

- `writeback.resolve` with an empty `resolveTransition`: "this source resolves issues but has no
  target status - set it to the status a finished issue should land in, e.g. Done".
- `queryVia === "upstartclaw"` with any write-back switch on: "the UpstartClaw connection is
  read-only - write-back needs the Jira CLI or JIRA_API_TOKEN and JIRA_EMAIL".

### 6. Capability flags

In `TASK_SOURCE_KIND_INFO` (`src/shared/task-source.ts`), flip Jira's `canAnnotate` and
`canResolve` to `true`, replacing Phase 1's comment naming this phase. This is the **only** edit
this phase makes to that file, and `test/task-source-contract.test.ts` fails if it lands without
the verbs or the verbs land without it.

### 7. End-to-end fixture

- A fake `jira` binary beside `e2e/fixtures/fake-claude.mjs` and friends, recording what it was
  asked and answering the read and write subcommands this phase uses.
- `MISSION_JIRA_BIN` set in `e2e/fixtures/daemon.ts` beside `MISSION_GH_BIN`.
- `e2e/README.md` gains the row in its environment table, with the reason: on a machine where
  the operator's Jira CLI is configured, an unfaked run could transition a real issue.

No new e2e spec here. This phase adds no UI surface, and Phase 3's spec covers the panel.

### 8. Documentation

`docs/configuration.md` gains `MISSION_JIRA_BIN`, beside `MISSION_GH_BIN` and the existing
`JIRA_API_TOKEN` / `JIRA_EMAIL` / `JIRA_ALLOWED_HOSTS` entries.

`docs/dispatch-and-backlog.md`'s existing `### Jira` section gains the Jira half of write-back:
what a remote link and a comment each carry, why a target status has to be named per source
rather than inferred, what the "available from here" refusal is telling the reader, and that the
UpstartClaw rung is read-only. **This phase owns that paragraph.** Phase 3 owns the separate
`### Writing back to the source` section describing the mechanism and the operator surface, so
neither phase writes into the other's text and neither cross-links a section that may not exist
yet. Whichever merges first documents exactly what works at that moment.

## Data and compatibility

No schema change. `resolveTransition` and `linkVia` were landed by Phase 1 as Zod defaults over
the `app_config` blob, so an existing Jira source reads back `{ resolveTransition: "", linkVia:
"both" }` with no migration. Flipping the capability flags changes what the build advertises but
nothing that is stored.

## Tests and verification

New `test/jira-writeback.test.ts`:

- `remoteLinkPayload` carries `globalId` equal to the pull request url, which is the idempotency
  claim this phase makes;
- `commentBodyAdf` is well-formed ADF and `commentBodyText` says the same thing;
- `transitionFor` matches by transition name and by target status name, case-insensitively, and
  its no-match problem lists the available names;
- an empty `resolveTransition` refuses without any call leaving the process;
- the egress guard refuses a write to a non-Jira-Cloud host, and to a `site` carrying a
  credential, exactly as the search path does - asserted on the write path specifically, because
  a second code path is precisely how that guard gets lost;
- a transport failure becomes an error with the cause code and **never** echoes the request;
- an unreadable outcome becomes `outcomeUnknown: true`.

Extend `test/jira-preflight.test.ts` with the two new sentences.

`test/task-source-contract.test.ts` is unchanged in code and must now pass with Jira's flags
true - which is the assertion that this phase's two halves shipped together.

Commands:

```sh
node --test --import ./test/setup-state.mjs --import tsx test/jira-writeback.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/jira-preflight.test.ts
node --test --import ./test/setup-state.mjs --import tsx test/task-source-contract.test.ts
npm test
npm run typecheck
npm run lint
npm run build && npm run smoke
npm run test:e2e
```

`npm run test:e2e` runs here despite there being no new spec, because `MISSION_JIRA_BIN` changes
the daemon fixture every existing spec boots.

## Merge and exit criteria

- A Jira source with the write-back switches on posts a remote link and a comment when a swept
  task's pull request appears, and moves the issue to the configured status when it completes.
- A misconfigured resolve refuses with a sentence naming the fix, before anything leaves the
  process where that is possible, and with the available transitions where it is not.
- No `jira` subprocess in any test or e2e run resolves to a real binary.
- `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm run smoke`,
  `npm run test:e2e` pass.

## Downstream handoff

- Jira's `canAnnotate` / `canResolve` are `true` from this merge. Phase 3's panel reads those
  flags rather than hardcoding a kind, so it is correct whichever order the two land in.
- `jiraBin()` is the only way to name the Jira binary. Nothing may reintroduce a literal.
- `MISSION_JIRA_BIN` is set for every e2e daemon and must stay set.

## Cross-phase audit record

- Reconciled against Phase 1. Phase 1 owns every declaration in `src/shared/task-source.ts`,
  including the two Jira config fields this phase reads; this phase's only edit there is the two
  boolean flips, which cannot be moved earlier because the contract test would fail on a kind
  advertising a verb it does not implement.
- Reconciled against Phase 3. Two files are touched by both, in disjoint regions: `e2e/README.md`
  (the environment table here, the spec inventory there) and `docs/dispatch-and-backlog.md` (the
  existing `### Jira` section here, a new `### Writing back to the source` section there).
  Ownership is stated in both files so neither writes into the other's text and neither
  cross-links a section that may not exist yet.
- Documentation-order hazard, resolved. An earlier draft had Phase 3 documenting the Jira
  behavior this phase implements, which would have shipped documentation describing something
  that did not work if Phase 3 merged first. Moving the Jira paragraph here makes each phase's
  documentation true at its own merge, in either order.
- Phase 3's panel must not assert Jira's capability booleans, because this phase flips them from
  false to true. Recorded as an explicit non-goal in Phase 3's scope.

## Deviations taken during implementation

Recorded here as well as in the pull request, because each one is a place a later reader
would otherwise find the code and this document disagreeing.

1. **The two `preflight` sentences moved into the verbs.** Step 5 asked for them "only when
   the source's `writeback` switches are on", and `preflight(config, ctx)` cannot see those
   switches: `SweepContext` carries `sourceId`, `repoRoot` and `signal`, and the consent
   lives on the `TaskSourceInstance` the route holds. Widening that signature is an edit to
   the contract Phase 1 froze, and adding the checks unconditionally would turn **Check it
   works** red for every existing Jira source that never writes back. So an empty
   `resolveTransition` and the UpstartClaw rung are refused by `resolve` / `annotate`
   themselves - which is where the consent is actually known, and still before anything
   leaves the process.

2. **A remote link is REST-only, and a CLI-only machine degrades rather than fails.**
   jira-cli has no remote-link command at all, so `linkVia: "both"` cannot be fully honoured
   without `JIRA_API_TOKEN`. Failing the whole delivery would retry a comment that has no
   idempotency of its own, leaving one comment per attempt on an issue whose link can never
   be posted. The comment goes, the delivery succeeds, and the `detail` names the half that
   did not run. `linkVia: "remote-link"` with no credential still refuses outright, because
   then nothing can be written at all.

3. **`WritebackResult.detail` stays null on failure.** Step 3 wanted the partial-success
   error to carry "the link is there" in `detail`; the frozen contract documents `detail` as
   null on failure, so that fact is appended to the `error` sentence instead.

4. **`transitionFor` takes the issue as well as the transitions.** The phase file's
   signature is `(available, wanted)`, but the refusal sentence it specifies names the issue
   key and the status it is standing in. Splitting one sentence across two functions was
   worse than a third argument.

5. **`test/task-source-contract.test.ts` and `test/task-source-writeback.test.ts` changed
   after all.** Both used Jira as the kind that cannot write back, which this phase makes
   untrue - there is now no shipped kind in that state. Each empties the registry slot (or
   the capability flag) it is testing and restores it in a `finally`, so the refusal branch
   stays pinned rather than becoming unreachable. The capability/verb pairing tests are
   unchanged and pass with Jira's flags true, which is the assertion the phase asked for.

6. **`cliFailure` gained a `verb` parameter, and its `--paginate` branch was tightened.**
   The write path reuses its four CLI-level diagnoses; only the fallback sentence named
   `jira issue list`. The unknown-flag branch also had to stop claiming `--paginate` for
   every unknown flag, since the write path passes `--no-input`.

7. **No `test/jira-preflight.test.ts` additions.** Following from (1), the sentences it was
   asked to pin are not preflight sentences. They are covered in `test/jira-writeback.test.ts`
   against the registered kind, which is the boundary the worker calls through.

### Resolve requires the credential rung

The phase file has both rungs resolving. They do not, and the reason is the operator decision
this phase is held to: **a misconfigured resolve must refuse naming the transitions actually
available from the issue's current status.**

Only a read of Jira produces that list. `jira issue move` can move an issue but cannot be
asked what an issue is able to do - jira-cli ships no command that lists transitions, and the
move's own error text lists them on recent versions and not on older ones. So on a CLI-only
machine the good case works and the bad case is unactionable: "it would not move", with
nothing to do about it. An earlier draft papered over this by pointing at whatever the CLI
happened to print, which is a promise that is empty exactly when it is needed.

So `resolve` requires the read rung and refuses before it spawns anything when that rung is
absent, naming the credential as the fix. With the credential present the CLI still goes
first, and only a move it refuses is handed to the read rung. `annotate` is untouched and
still works on the CLI alone.
