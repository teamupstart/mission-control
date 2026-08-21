# Phase 2 - Generate the changelog from pull request titles and labels

Source plan: [`plan.md`](plan.md). Index: [`phased-plan.md`](phased-plan.md).

## Outcome

A release's notes describe the work that actually shipped, instead of the sixth of it that happens
to carry a conventional-commit prefix.

## Entry criteria and dependencies

- **Direct phase dependency: Phase 1.** Two reasons, and both are load-bearing. Textually, both
  phases edit `.github/workflows/release.yml`. Substantively, this phase is a redesign of what a
  release cycle produces, and it should be designed against one that has actually run rather than
  against a workflow that has never succeeded.
- `v1.0.0` published, and a first `CHANGELOG.md` in the repository to compare against.

## Scope

In scope: the changelog and release-notes generator, whatever drives the version bump once commit
types no longer do, the label vocabulary those notes group by, disabling merge commits (G3), and
the documentation for all of it.

**Non-goals:**

- Rewriting history, or backfilling labels onto the 1286 commits and hundreds of merged pull
  requests already on `main`. Pull request *titles* are available retroactively; labels are not,
  and pretending otherwise is how this phase becomes unbounded.
- Anything under `src/`. This phase is release infrastructure only.

## Repository findings

These materially change the shape of the work and were not visible when the plan was approved.

**Labels are entirely unused.** Verified against the live repository:

- **0 of the last 100 merged pull requests carry any label at all.**
- The repository has only GitHub's nine stock labels - `bug`, `enhancement`, `documentation`,
  `duplicate`, `good first issue`, `help wanted`, `invalid`, `question`, `wontfix`. There is no
  project-specific vocabulary.

So the "titles" half of D2 works immediately and retroactively; the "labels" half has no data,
requires a vocabulary to be invented, and only starts paying off on pull requests merged after this
phase lands. Plan accordingly: grouping must degrade gracefully to a single flat list when a pull
request carries no label.

**There is no changelog tooling of any kind.** No `.github/release.yml` (GitHub's native
auto-generated-release-notes category config), no `cliff.toml`, and no changelog package in
`devDependencies`. Everything here is new construction, not reconfiguration.

**Nothing else would decide the version bump.** This is the important one. Release Please derives
`major`/`minor`/`patch` from `feat:`, `fix:`, and `!`. Remove conventional commits as the source
and **the semver bump has no driver at all**. The approved plan did not anticipate this, and it
cannot be deferred - a release process that cannot pick a version number is not a release process.

**Squash titles already are pull request titles.** The repository's
`squash_merge_commit_title` is `COMMIT_OR_PR_TITLE`. Worth knowing, because it means "enforce
conventional PR titles" and "conventional commits" are the same intervention wearing different
clothes - which is precisely the option D2 declined.

## Decision C1 - what owns the version, tag, and Release

**This decision is not resolved and must not be guessed.** It is flagged for the human in the
phased-plan index because one of its outcomes revisits approved decision D1.

The two coherent shapes:

**C1-a. Keep Release Please; add native release notes.** Release Please continues to own the
version, tag, Release, and `CHANGELOG.md`. Add `.github/release.yml` so the *GitHub Release body*
is generated from pull request titles grouped by label. The bump still needs a driver, so this
requires either conventional titles after all (contradicting D2) or a `Release-As:` footer /
release label applied per pull request.

- Smaller diff, keeps Phase 1's work exactly as it landed.
- Leaves two changelogs of differing quality: a sparse commit-derived `CHANGELOG.md` and a good
  pull-request-derived Release body. That is a second source of truth, which this repository's
  conventions specifically warn against.

**C1-b. Replace Release Please with a `workflow_dispatch` release.** A human runs the workflow and
picks `major`/`minor`/`patch` (or an explicit version). It bumps `package.json` and
`package-lock.json`, generates notes from GitHub's `generate-release-notes` API - which uses pull
request titles and `.github/release.yml` label categories - writes `CHANGELOG.md`, commits, tags,
and publishes the Release.

- Satisfies D2 fully and directly, with one changelog and one source of truth.
- Gives the human the explicit "create a release in GitHub and it does the rest" button the
  original request asked for.
- **Revisits D1.** With no release pull request, the "Actions may not create pull requests" policy
  stops mattering, and the PAT is needed only so the tag push triggers `ci.yml`. D1's reasoning
  still holds, but its premise weakens.
- Larger diff, and it discards working infrastructure Phase 1 just fixed.

**Recommendation: C1-b**, because it is the only option that leaves one changelog, one source of
truth, and an answer to "what decides the version". Phase 1 is deliberately robust to either
outcome: the token it wires stays useful for tag-triggered CI, and the version-equality assertion
is unchanged either way.

## Implementation steps

Sequence depends on C1. Common to both:

1. **Establish the label vocabulary.** Small and enforced - roughly `feature`, `fix`, `docs`,
   `internal`, `breaking`. Create them on the repository and document what each means and who
   applies it. Add a catch-all `*` category so an unlabelled pull request still appears.
2. **Create `.github/release.yml`** mapping those labels to release-note sections, with the
   catch-all last.
3. **Close G3: disable merge commits**, leaving squash-only. A merge commit collapses the title
   into `Merge pull request #N from <branch>`, which carries nothing either generator can use, and
   20 of the last 245 commits are exactly that. This setting is what makes the rest of the phase
   hold; without it the generator has a hole in it by design.
4. **Implement C1-a or C1-b** in `.github/workflows/release.yml`, preserving Phase 1's token wiring
   and the `scripts/assert-release-version.mjs` equality assertion.
5. **Document the release procedure.** There is no release runbook today. Update
   `docs/desktop-and-packaging.md`'s **Release identity** section (`:134-164`) and add a runbook
   under `docs/runbooks/` if C1-b makes releasing a human-operated action.

## Verification

- `npm run typecheck`, `npm run lint`, and `npm test` pass.
- Any pure logic introduced (a version-bump calculator, a notes formatter) has unit tests in
  `test/`, per the repository's convention that non-UI logic is cheap to test there.
- **Generate notes for the already-published `v1.0.0` range and read them.** The output is the
  deliverable; if it does not read better than the commit-derived changelog, the phase has not
  achieved its outcome.
- Confirm an unlabelled pull request still appears in the output.

No UI surface, so no Playwright spec is required.

## Merge and exit criteria

1. C1 is resolved by the human and recorded in this file.
2. Merge commits are disabled on the repository; squash is the only merge method.
3. The label vocabulary exists and is documented.
4. A release cut through the new path produces notes derived from pull request titles, grouped by
   label, with unlabelled work still present.
5. There is exactly one changelog source of truth.
6. `docs/desktop-and-packaging.md` matches the implementation.

## Downstream handoff

Later phases may rely on: squash-only merges, the label vocabulary, and a documented release
procedure. Nothing in Phase 3 or Phase 4 consumes this phase's output, which is why neither depends
on it.

## Cross-phase audit record

- **vs Phase 1:** depends on it. Both edit `.github/workflows/release.yml`; this phase must
  preserve the token wiring and the version-equality assertion. If C1-b is chosen, this phase
  removes the Release Please action that Phase 1 repaired - that is expected, not a conflict, and
  Phase 1's token remains in use for tag-triggered CI.
- **vs Phase 3:** fully disjoint. Phase 3 touches no release infrastructure and this phase touches
  no application code. They may merge in either order.
- **vs Phase 4:** independent. Phase 4 verifies the install-and-update journey against whatever
  releases exist; it does not care how their notes were generated. If both are in flight, Phase 4
  should verify against a release cut by whichever process is live at the time.
- **Reverse dependency check:** Phase 1's exit criteria do not reference anything here, so no edit
  to Phase 1 is required.
