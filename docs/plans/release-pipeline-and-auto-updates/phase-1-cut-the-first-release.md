# Phase 1 - Unblock the release trigger and cut v1.0.0

Source plan: [`plan.md`](plan.md). Index: [`phased-plan.md`](phased-plan.md).

## Outcome

`mancej-cyc/ai-harness` publishes its first GitHub Release, `v1.0.0`, and the `Release` workflow
stops failing on every push to `main`.

This is the phase that turns the auto-updater from dead code into a working feature. Until a
stable Release exists, `latestStableRelease` returns `null` and every update check - background
and manual alike - lands on `up-to-date` (`src/main/updater.ts:454-456`). Nothing else in this
plan can be verified until this merges and a human merges the release pull request it produces.

## Entry criteria and dependencies

- **Direct phase dependencies:** none. This phase is the root of the graph.
- **Prerequisite outside the repository:** a credential that is allowed to open a pull request must
  be created and stored as a repository secret. This is a human action - see step 1. The code
  changes here can be written and reviewed before the secret exists, but the phase's exit criteria
  cannot be met without it.

## Scope

In scope: the release trigger credential, the first release's version number, the prerelease-tag
parser divergence (G7), the `package` job's behaviour once tags start triggering workflows, and the
release documentation that describes all of it.

**Non-goals:**

- Changing what the changelog is generated *from*. That is Phase 2, and it deliberately lands after
  a release cycle has actually run. The first `CHANGELOG.md` will be conventional-commit derived
  and sparse; that is expected and is not a defect to fix here.
- Any change under `src/main/`, `src/web/`, or `scripts/apply-update.mjs`. Phase 3 owns those and
  runs concurrently with this phase.
- Attaching a dmg to the Release. Decision D3 declined this outright.

## Repository findings

Verified against the checkout; these correct or sharpen the source plan.

**The action passes no token.** `.github/workflows/release.yml:52-56` is:

```yaml
      - name: Open or update the release pull request, and release when one is merged
        id: release
        uses: googleapis/release-please-action@v4
        with:
          config-file: release-please-config.json
          manifest-file: .release-please-manifest.json
```

There is no `token:` input, so it defaults to `${{ github.token }}` - the ephemeral per-run
`GITHUB_TOKEN`. The workflow's `permissions:` block (`release.yml:36-38`) already grants
`contents: write` and `pull-requests: write`, so **the workflow permissions are not the problem**;
the organization-level "Allow GitHub Actions to create and approve pull requests" setting is. Do
not try to fix this by editing `permissions:`.

**`release-as` belongs in the package object.** `release-please-config.json` is manifest-driven,
so `release-as` is valid both top-level and per-package. Put it inside `"packages": { "." : { … } }`
beside `package-name` and `changelog-path` - the narrowest scope. It is **sticky**: it pins every
subsequent run to the same version until removed, so removing it is part of this phase, not
follow-up.

**A PAT-pushed tag changes `ci.yml`'s behaviour.** `ci.yml:44-49` already has `push: tags: ['v*']`,
and the `package` job's gate (`ci.yml:336`) is
`startsWith(github.ref, 'refs/tags/') || github.event_name == 'workflow_dispatch'`. The job does
not fire today only because GitHub suppresses workflow runs for events originating from
`GITHUB_TOKEN`. **That suppression does not apply to a PAT or GitHub App token.** So the moment
step 1 lands, `package` begins running on every release tag - building a dmg and uploading it as a
90-day artifact.

This invalidates two pieces of prose that currently assert the opposite:

- `.github/workflows/release.yml:24-27`
- `docs/desktop-and-packaging.md:162-164`

Both must be corrected in this phase. Leaving them is worse than a stale comment: they are the
documented reason the `package` job is safe from racing the release.

**G7 is real, and there is a second divergence in the opposite direction.**

- `scripts/assert-release-version.mjs:22` is
  `/^v(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)$/` - it **accepts** `v1.2.3-rc.1`, asserted at
  `test/assert-release-version.test.ts:13`.
- `src/shared/update.ts:58` is `/^\d+\.\d+\.\d+$/` after stripping a leading `v` - it **rejects**
  `1.2.3-rc.1`, so `versionFromReleaseTag` returns `null` and `updater.ts:455` short-circuits to
  `up-to-date` with nothing logged.
- Additionally, `update.ts` **accepts** a bare `1.2.3` that the script rejects. The source plan did
  not note this second divergence.

## Implementation steps

### 1. Give Release Please a credential that may open a pull request (D1)

A human creates either a fine-grained PAT (contents: read/write, pull requests: read/write on this
repository) or a GitHub App installation token, and stores it as a repository secret. Name it
descriptively - `RELEASE_PLEASE_TOKEN` is the conventional spelling.

Then pass it in `.github/workflows/release.yml`:

```yaml
        with:
          token: ${{ secrets.RELEASE_PLEASE_TOKEN }}
          config-file: release-please-config.json
          manifest-file: .release-please-manifest.json
```

Note in the workflow header comment *why* the token exists - the organization policy - so the next
person does not "simplify" it back to the default token and silently reintroduce the outage.

### 2. Decide what `package` does on a release tag

Now that the tag triggers workflows, pick one and implement it:

- **Let it run** as a build check on every release. Costs a macOS runner minute per release and
  produces an artifact nobody has to consume. Its `assert-release-version` step then genuinely
  gates.
- **Exclude release tags** from the gate, keeping packaging a deliberate `workflow_dispatch`.

Either is defensible. Letting it run is the recommendation: it is the only place a release tag's
artifact is ever actually built, and a release that cannot be packaged is worth failing loudly.
Whichever is chosen, update `release.yml:24-27` and `docs/desktop-and-packaging.md:162-164` to
describe the new reality.

### 3. Set the first release to v1.0.0 (D4)

Add `"release-as": "1.0.0"` inside the `"."` package object of `release-please-config.json`.

**Removing it again is part of this phase.** Once `v1.0.0` is published, the follow-up change that
deletes `release-as` must land, or every subsequent release re-proposes `1.0.0`. Do not leave this
as a note for someone else.

### 4. Fix G7 by tightening the script, not by loosening the app

Change `scripts/assert-release-version.mjs:22` to `/^v(\d+\.\d+\.\d+)$/` and flip
`test/assert-release-version.test.ts:13` to assert `versionFromTag("v1.2.3-rc.1") === null`.

This direction is deliberate. Both release-resolution paths already pass `--exclude-pre-releases`
(`src/main/updater.ts:103`, `scripts/install-app.mjs:84`), so a prerelease can never be selected by
either consumer. Tightening the script makes CI refuse a tag the product could never install -
failing loudly where a human is watching. Loosening `src/shared/update.ts` instead would require
real semver prerelease precedence in `isNewerVersion` (`1.2.3` must beat `1.2.3-rc.1`), which its
`number[]` representation cannot express, and would also require fixing `versionFromReleaseTag`,
which reconstitutes via `parts.join(".")` and would silently drop the suffix. That is a materially
larger, riskier change to a code path that is dead by query.

Also close the reverse divergence: decide whether a bare `1.2.3` is a valid input to
`parseReleaseVersion` and make the two files agree in both directions, with a test pinning each.

### 5. Update the release documentation

`docs/desktop-and-packaging.md`'s **Release identity** section (`:134-164`) is the only non-plan
doc describing this process. Update it for: the token and why it exists, `v1.0.0` as the first
release, the `package` job's new trigger behaviour, and the tightened tag grammar.

## Verification

- `npm run typecheck`, `npm run lint`, and `npm test` pass.
- `test/assert-release-version.test.ts` covers the tightened grammar in both directions, including
  the bare-`1.2.3` case.
- **The release pull request actually opens.** This is the real exit signal and it cannot be
  faked: push to `main` and confirm the `Release` workflow run succeeds and a release pull request
  exists.

No UI surface changes here, so the repository's Playwright requirement does not apply.

## Merge and exit criteria

1. This phase's pull request is merged to `main`.
2. The `Release` workflow run on that merge **succeeds** and opens a release pull request proposing
   `1.0.0`.
3. A human merges that release pull request.
4. The following run creates the `v1.0.0` tag and publishes the GitHub Release, and
   `scripts/assert-release-version.mjs` passes against it.
5. `gh release list --repo mancej-cyc/ai-harness --exclude-drafts --exclude-pre-releases` returns
   `v1.0.0` - the exact query both the installer and the updater use.
6. The `release-as` pin is removed in a follow-up commit once `v1.0.0` exists.

Steps 3-6 involve a human action this phase cannot perform. The phase is not done at "merged"; it
is done when the Release exists and the query returns it.

## Downstream handoff

Later phases may rely on:

- A published stable Release existing, and `v`-prefixed three-part stable tags being the only tag
  grammar CI accepts.
- `RELEASE_PLEASE_TOKEN` (or its chosen name) existing as a repository secret with permission to
  open pull requests and push tags.
- Release tags triggering workflow runs.

They must not change: the `--exclude-drafts --exclude-pre-releases` query shape, or the equality
between the tag, `package.json`, and both `package-lock.json` version fields.

**Phase 2 will edit `.github/workflows/release.yml` and may replace Release Please entirely** (see
its C1 decision). It must preserve the token wiring and the version-equality assertion regardless
of what it does to the changelog.

## Cross-phase audit record

- **vs Phase 2:** both edit `.github/workflows/release.yml`, so Phase 2 depends on this one. The
  ordering is also substantive, not just textual - Phase 2 needs a completed release cycle to
  design against.
- **vs Phase 3:** disjoint. G7 is fixed here in `scripts/assert-release-version.mjs`; Phase 3
  touches `src/main/updater.ts`, `src/shared/update.ts`, `scripts/apply-update.mjs`,
  `scripts/install-app.mjs`, and `README.md`. The chosen G7 direction deliberately avoids
  `src/shared/update.ts` so the two phases cannot conflict. **If step 4's reverse-divergence fix
  requires editing `src/shared/update.ts`, coordinate with Phase 3** - prefer keeping the change in
  the script.
- **vs Phase 4:** Phase 4 cannot start until this phase's exit criteria are met, because it needs a
  real published Release to install from.
