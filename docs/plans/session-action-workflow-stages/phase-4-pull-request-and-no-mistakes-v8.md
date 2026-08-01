# Phase 4: Verified Pull Request action and No-Mistakes Review v8

Source plan: [`plan.md`](plan.md)

Phased index: [`phased-plan.md`](phased-plan.md)

## Outcome and value

The compiled Pull Request SessionAction becomes an available, reusable workflow stage. It sends
the version-snapshotted PR instructions and required `pull-request` skill to the bound session,
waits for durable proof that the resulting PR adopts the current repository head, captures fresh
evidence, and then activates downstream stages.

No-Mistakes Review version 8 uses this action immediately before End. After End, the existing
immutable Inspector completion policy appears as the fixed footer and remains the sole PR review
poller. Versions 1 through 7 retain their exact legacy post-End handoff behavior.

## Entry criteria and direct dependencies

Direct prerequisite: Phase 3 is merged.

Before editing:

1. Read the source plan, phased index, Phase 3 downstream handoff, root `AGENTS.md`, architecture
   guide, change contracts, ensemble extension guide, and current Pull Request skill contract.
2. Inspect merged SessionAction adapters, continuation expectations, delivery/recovery, Inspector
   claim/poll logic, PR adoption persistence, built-in workflow generation, and all No-Mistakes
   versions.
3. Run `git status --short`, preserve unrelated work, and run the full Phase 3 verification suite.
4. Bind and inspect versions 1 through 7 from the merged store. Record their graph hashes and
   completion policies for compatibility assertions.

## Scope

In scope:

- A reusable server-owned `pull_request` completion adapter.
- Durable PR adoption provenance tied to an action attempt, repository, branch, and expected head.
- Pull Request-specific wait, mismatch, retry, recovery, and already-satisfied behavior.
- Extraction of shared handoff mechanics without changing the legacy `pr_handoff` entry path.
- Enabling the compiled Pull Request SessionAction in catalogs, APIs, and builder capabilities.
- No-Mistakes Review version 8 with Pull Request before End.
- A version-8 missing-PR policy of `wait` and unchanged Inspector completion policy.
- PR-specific run presentation and final operator/developer documentation.
- Full regression, migration, runtime, visual, and compatibility verification.

Explicit non-goals:

- No mutation of No-Mistakes versions 1 through 7.
- No replacement of Inspector polling with an action node.
- No generic GitHub automation node, arbitrary remote provider, or browser-side PR polling.
- No automatic merge or release behavior.
- No inference of success solely from `Session.prUrl`, output text, branch name, or a PR existing.
- No second PR skill implementation inside Mission Control.

## Repository findings and inherited contracts

### Existing handoff mechanics are reusable, not replaceable

The legacy path already owns PR packet rendering, required-skill resolution, consent, payload
preparation, send recovery, and uncertain-write handling. Extract shared primitives carefully so
both callers use them, while retaining `pr_handoff` records and `WorkflowManager.preparePr` behavior
for pinned versions.

### Adoption proof is stronger than URL discovery

The action succeeds only when durable PR metadata proves that the intended repository and branch
have an open PR whose adopted remote head matches the local head associated with the action's
continuation. A session-populated URL is a hint until the existing adoption path validates and
stores provenance.

### Inspector still starts after graph success

The PR action creates or updates the PR and proves adoption. It does not review the PR. Once its
fresh evidence flows through `complete` to End, the immutable completion policy lets Inspector
claim the run and perform its existing review/poll cycle.

## Implementation steps

### 1. Define Pull Request proof and expectation contracts

Add a closed persisted expectation variant owned by the adapter, containing only the fields needed
to validate continuation capture, such as:

```ts
type PullRequestContinuationExpectation = {
  kind: "pull_request";
  repositoryKey: string;
  branch: string;
  expectedHeadOid: string;
  pullRequestUrl: string;
  pullRequestNumber: number | null;
  adoptionRevision: number;
};
```

Use the repository's actual provider-neutral identifiers and existing PR metadata types after
inspection. Validate every persisted field. Never store credentials, remote responses, or
unbounded command output in the attempt.

The completion adapter returns waiting for absent or still-unverified adoption, blocked for a
durable contradiction that needs operator action, and complete only with a validated expectation.

### 2. Extract shared PR handoff preparation

Refactor the existing `preparePr` and `renderPrHandoff` path into narrow shared helpers for:

- repository/branch context;
- required `pull-request` skill resolution;
- deterministic envelope rendering;
- delivery approval and note identity;
- send-time revalidation;
- uncertain-write recovery.

Keep two explicit callers:

1. legacy completion-policy handoff producing delivery kind `pr_handoff` with no node attempt;
2. Pull Request SessionAction producing delivery kind `session_action` linked to its attempt.

Do not silently route legacy versions through a synthetic graph node. Snapshot prompt text for the
new action comes from the published SessionAction snapshot. Legacy packet text remains whatever
its pinned contract currently specifies.

### 3. Implement durable PR adoption proof

Register and enable the `pull_request` completion adapter. After the generic pickup and settled-idle
proof, it must:

1. resolve the action's bound repository and branch;
2. read the current local head through the existing repository evidence service;
3. find only durable adopted PR metadata for that same repository and branch;
4. require an open PR with remote head equal to that local head;
5. reject stale URLs, wrong repositories, wrong branches, closed PRs, and older remote heads;
6. persist a bounded continuation expectation before reporting complete.

If the PR is delayed, remain waiting and react to the existing adoption/update signal or bounded
manager reconciliation. Do not add an unbounded browser or per-action polling loop. If an already
adopted matching PR exists after delivery and settled idle, complete idempotently.

`Session.prUrl` may help locate a candidate but can never satisfy the adapter by itself.

### 4. Bind proof to the captured continuation

Pass the expected head into Phase 2's continuation capture transaction. Capture fresh context and
evidence, then assert the captured HEAD still equals `expectedHeadOid` before marking the action
complete or emitting its receipt.

If HEAD changes between PR proof and capture, do not activate downstream work on mismatched
evidence. Return to the adapter's waiting/reconciliation state and require the PR to adopt the new
head. Retrying must reuse or safely supersede the incomplete child reservation without creating a
duplicate segment.

Persist the adopted PR provenance on the action attempt/continuation through the closed expectation
contract so Inspector and diagnostics can explain exactly what was proven.

### 5. Define PR-specific waiting and recovery behavior

Add bounded server states and UI labels for:

- waiting for PR adoption;
- PR found, waiting for remote head;
- wrong repository or branch;
- remote head behind local head;
- PR closed or inaccessible;
- local head changed during capture;
- matching PR verified.

Classify transient provider/access failures consistently with Inspector's existing policy. Preserve
uncertain delivery semantics: never retype solely because no PR appeared. Cancellation, reset,
daemon restart, session removal, and adoption events must converge without duplicate send,
duplicate segment, or duplicate completion.

### 6. Enable the built-in Pull Request action

Mark `pull_request` available in the server completion registry only after its proof and recovery
tests pass. The existing server capability and catalog rules then make the compiled Pull Request
action visible and addable in the SessionActions library, Pipeline view, and Graph view.

The built-in remains read-only and has:

- the stable reserved id introduced in Phase 1;
- exact generated prompt Markdown;
- `requiredSkillId: "pull-request"`;
- `completion: { kind: "pull_request" }`;
- a stable synthetic revision.

Add UI tests proving capability enablement, not a client special case, reveals it.

### 7. Append No-Mistakes Review version 8

Add one new append-only built-in version id. Do not rename, reorder, regenerate, or mutate versions
1 through 7.

Version 8 preserves the existing evaluation topology and completion policy, then adds a singleton
Pull Request stage immediately before End:

```text
Session -> existing No-Mistakes evaluation stages -> Pull Request -> End
                                                              fixed Inspector footer
```

The stage snapshot embeds the built-in action's exact prompt, skill, completion kind, source id,
and revision. Its outgoing `complete` edge targets End. The immutable completion policy remains
Inspector-enabled, and its missing-PR behavior is `wait` because the action is expected to establish
verified PR provenance before End.

Update generator fixtures and built-in catalog tests. Assert byte-level or deep structural
equality for versions 1 through 7 and an explicit expected graph for version 8.

### 8. Preserve the legacy completion path

Compatibility tests must exercise a bound version from each legacy behavior family, including the
versions that use post-End PR preparation. Verify:

- their published graphs have no action node;
- their version ids and snapshots are unchanged;
- End still triggers the legacy completion policy;
- `pr_handoff` delivery rows remain the kind used;
- Inspector claim/review behavior is unchanged;
- existing recovery fixtures still pass.

Shared extraction is acceptable only if these observations remain true. Do not migrate old rows or
rewrite stored workflow versions to version 8.

### 9. Complete PR and Inspector presentation

Extend the generic action run presentation with PR-proof details from bounded server projections:

- action prompt and required skill;
- delivery/pickup/settle state;
- adopted PR link;
- expected and observed short head ids;
- mismatch/wait reason;
- child evidence segment;
- transition from End to fixed Inspector footer.

Keep the action and Inspector visually separate: Pull Request creates and proves the PR; Inspector
reviews it. The footer must not appear complete merely because the action completes.

### 10. Finish documentation

Update README, workflow/ensemble docs, architecture, and change contracts as appropriate with:

- the final Check, Persona, SessionAction, and Inspector abstraction model;
- SessionAction catalog fields, snapshots, capability adapters, and arbitrary placement;
- exact delivery, pickup, settled-idle, fresh-evidence, and downstream-only semantics;
- Pull Request proof requirements and recovery behavior;
- No-Mistakes Review v8 topology;
- legacy version compatibility;
- Preview and Live expectations;
- operator troubleshooting for delayed/wrong/stale PRs;
- extension guidance for future closed completion adapters.

Document that a new completion adapter is code with proof and recovery tests, not a user-entered
string or skill alone.

## API, data, and compatibility notes

- Enabling `pull_request` is a server capability change; no new client-only enum is introduced.
- Existing action API shapes already represent the built-in and require no special PR mutation
  route.
- PR adoption provenance remains server-owned and validated.
- No-Mistakes v8 is additive. Stored and compiled versions 1 through 7 remain unchanged.
- `pr_handoff` remains append-only and readable; `session_action` remains the new node-linked kind.
- Inspector is still represented only by `WorkflowCompletionPolicy`.

## Focused tests

Add or extend tests for:

- exact built-in Pull Request generation and snapshotting;
- required-skill resolution at preparation and send;
- matching repository, branch, open state, and remote head proof;
- missing, delayed, wrong-repository, wrong-branch, closed, inaccessible, and behind-head PRs;
- a matching pre-existing PR after a genuine action turn;
- rejection of `Session.prUrl` without durable adoption;
- head changing between proof and continuation capture;
- restart at delivery, pickup, settle, adoption, proof, capture, receipt, End, and Inspector claim;
- uncertain send never causing automatic retype;
- action provenance and fixed-footer presentation;
- capability-driven visibility in library, Pipeline, and Graph views;
- version 8 graph, snapshot, ordering, missing-PR wait policy, and Inspector policy;
- immutable versions 1 through 7 and legacy `pr_handoff` execution;
- a full v8 run from Session through PR action, fresh evidence, End, and Inspector;
- Preview preparing the PR packet without typing or completing.

Run:

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
```

Run Electron/runtime visual verification for the library, Pipeline, Graph, run detail, Board ladder,
PR wait states, and fixed Inspector footer. Perform a disposable-repository Live run that creates
or updates a real test PR only where repository credentials and authorization are explicitly
available. Record exact commands and evidence in the implementation PR.

## Exit criteria

- Pull Request is a reusable built-in SessionAction exposed through generic capabilities.
- Completion requires durable matching PR adoption and a continuation capture of the same head.
- No-Mistakes Review v8 places Pull Request before End and Inspector after End as a fixed footer.
- Versions 1 through 7 and legacy `pr_handoff` behavior remain unchanged.
- Restart and mismatch tests prove no duplicate side effects or stale downstream evidence.
- README and technical docs match the final abstraction and operator experience.
- Typecheck, lint, tests, build, smoke, runtime proof, and visual verification pass.

## Final cross-phase audit

- The revisioned library, immutable snapshots, and stable graph identifiers from Phase 1 remain the
  sole authoring and publication truth.
- Phase 2's `(round, segment)` model supplies fresh evidence without consuming repair budget.
- Phase 3's generic library, builder, run states, and Inspector footer require no PR-only fork.
- Phase 4 adds only the verified adapter, capability enablement, built-in workflow version, and
  specialized copy/tests.
- Checks and Personas remain evaluators; SessionActions remain side-effecting session turns;
  Inspector remains completion policy.
- Every approved decision and source-plan requirement is implemented or explicitly preserved as a
  non-goal.
