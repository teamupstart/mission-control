# Phase 2: Signed stable and exact-SHA alpha distribution

Read [plan.md](plan.md), [phased-plan.md](phased-plan.md) and [Phase 1](phase-1-bundled-install-transaction.md) first. Follow this proposed route where the repository agrees; record justified deviations in the PR. Repository: mission-control only.

## Approved forward rollout, 2026-10-26

Phase 2 retains its signed artifact and publication contracts. R1 qualifies the first newly produced release under the [forward-rollout contract](forward-rollout.md).

## Outcome and entry criteria

Publish complete, trusted prebuilt app assets that installation and update clients can select without compiling. Stable versions and alpha main commits retain distinct immutable identities.

Direct phase prerequisite: Phase 1 merged. The planning publication dependency must also be satisfied. Confirm C1-C3 against the merged implementation. Before distribution signing or publication, obtain the approved Developer ID team identity and use the repository's secure credential mechanism; their existence was not established by planning. Do not request secret values in task comments, logs or evidence. If credentials, permissions or signed-runtime behavior cannot be established, stop publication and report the specific release blocker. Downstream implementation can proceed against the merged contracts; unavailable binaries must remain unavailable to runtime consumers.

## Scope and non-goals

Own C4 and the release producer for C1. Changes to `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `electron-builder.yml`, signing entitlements and packaging scripts are explicitly within this phase's goal. Preserve Release Please, canonical repo trust and normal PR isolation. Do not modify unrelated CI infrastructure, bypass checks, change Setup or enable the binary updater.

## Repository findings and inherited contracts

Release Please owns version, changelog, tag and GitHub Release, authenticated by the existing release GitHub App. The current package job builds an ad-hoc macOS arm64 DMG for tags/manual dispatch and uploads an Actions artifact. It does not provide a durable release asset set. Keep its release-version equality check and do not hand-edit CHANGELOG.md.

Phase 1 supplies one manifest validator, signed build metadata fields, binary receipt provenance, packaged dependency closure and helper protocol. A signature must still permit the intended `ELECTRON_RUN_AS_NODE` path: Electron's run-as-node fuse controls that capability. The earlier copied-app probe used an installed local app and is not evidence for this phase's signed output.

## Runtime flow

Pinned source identity -> macOS build and signing -> Notarization and checks -> Immutable ZIP and DMG -> Manifest published last.

<!-- flow-diagram -->

## Implementation order

1. Review the merged manifest/helper declarations and freeze producer fixtures with that validator. Define stable asset lookup by stable release tag and alpha lookup by full main SHA. Use a dedicated prerelease tag namespace such as `alpha-<full-sha>` for immutable alpha assets, excluded from stable selection. Store the full SHA in manifest and signed build metadata. Do not overload Release Please's stable version identity.
2. Establish a reproducible macOS signing/notarization package path in the existing packaging owners. Keep ordinary local developer packaging usable without distribution credentials; distribution mode must fail if the approved signer/notarization prerequisites are absent. Pin the trusted team/bundle policy in shipped trusted configuration, not in a downloaded manifest alone. Keep `asar` disabled and the complete Phase 1 helper inventory packaged.
3. Order metadata, signing and archive generation correctly: stamp immutable source/protocol identity, package, sign with the approved identity, notarize/staple as appropriate, verify, then produce the app ZIP and installer DMG and compute their sizes/hashes. Respect signed bundles' symlinks/framework layout. Do not mutate signed payload bytes to add their own archive digests afterward.
4. Add an idempotent publisher script, preferably under `scripts/`, using the existing repository authentication owner. It validates local assets against C1, uploads the complete set under the immutable identity, verifies the returned asset ids/lengths and publishes the bounded manifest last. A retry accepts existing matching bytes or resumes an incomplete unpublished set; mismatched bytes under an already advertised identity are an error, never overwritten in place. Use mocked transport tests for failure injection, not a series of real test releases.
5. Extend trusted tag/main build events so stable release tags produce stable assets and each eligible main commit produces its own alpha assets. Never give fork/PR content signing or publication secrets; CI checks PR changes using fixtures and unsigned builds. Avoid cancelling a publish after exposing a ready manifest. Keep version/tag checks and release App permissions narrowly scoped; reuse the existing token owner rather than introducing a personal access token.
6. Specify and enforce retention: stable recovery releases remain available; offered alpha manifests retain their complete referenced assets. If storage cleanup is introduced, it must operate on a coherent unadvertised or explicitly retired set and never leave a ready manifest pointing to deleted bytes. Initial implementation may retain all alpha sets rather than add unsafe cleanup. A client with no retained bytes must request a new explicit offer if the selected asset has expired.
7. Qualify a real signed app in an isolated macOS environment: verify signer, notarization and run-as-node fuse; copy the entire app; run the detached helper while parent and original bundle go away; execute the shipped MCP entry under the copied runtime with host Node/npm/npx traps. Preserve launch signature and entitlements. If this fails, do not silently weaken signing or substitute a new native helper implementation; record findings and obtain a revised approach before downstream work.
8. Update desktop packaging and release-verification documentation with exact producer commands, readiness rules, trust policy, retention and failure recovery. State which controlled publication was actually exercised and which manual prerequisites remain. Link the resulting exact commit, asset manifest and signed-runtime evidence from the PR without exposing credentials.

## Data, API and compatibility

Use C1 unchanged across writer and consumers. Stable manifests require a stable vX.Y.Z tag matching package version and exact commit; alpha manifests pin the chosen main commit while retaining the app's valid package version. GitHub's release latest pointer is discovery only, never installation identity. Drafts, prereleases and alpha namespace entries cannot leak into stable selection.

The ZIP and DMG describe the same signed app identity. The external manifest contains the immutable asset ids, names, lengths and hashes produced after signing. An untrusted URL is not an executable source: later clients use the canonical repository/asset API and validate the signer against shipped policy. Handle both direct-download and redirected API responses without forwarding an authorization header to an arbitrary host.

State compatibility is an explicit release qualification. Unknown database backward compatibility never enables post-commit rollback. Phase 1's forward recovery boundary remains the default. A release needing a different state recovery strategy must document and prove it before being eligible for automatic installation.

## Tests and verification

Extend `test/assert-release-version.test.ts` and source/packaging contract tests; add focused tests for the publisher and manifest producer. Exercise stable/alpha filtering, mismatched version/commit/architecture, partial upload, interruption before and after ready publication, immutable retry collision, access denial, size/digest mismatch and secret-redacted logs. Validate workflow syntax using the repository's available tooling and fixture assertions; do not claim a fixture validates actual GitHub permissions.

Run the applicable single-file commands from AGENTS.md, `npm run typecheck`, `npm run lint`, `npm run build` and `npm run smoke` for implementation acceptance. R1 runs a macOS distribution-mode package through the approved protected release procedure once the first new release is eligible. Run the actual signature/notarization validation and copied-runtime experiment against the final signed bytes. The clean account/VM should preserve quarantine so Gatekeeper behavior is exercised. Do not disable Gatekeeper, strip quarantine as an install recipe, or run replacement against the operator's live app.

Use a controlled canonical publication only within the phase's authorized release procedure. If that cannot be performed, identify the missing external permission/credential as an R1 release qualification blocker rather than reporting publication ready. Preserve exact command output and artifact identities in gitignored workflow evidence and the PR.

## Implementation merge and release qualification

- Existing Release Please/version ownership remains intact; PR checks cannot access publishing secrets.
- Complete signed/notarized stable and exact-SHA alpha asset sets can be produced and retrieved using C1. Partial/mismatched sets are never advertised ready.
- R1 release qualification: the final signed helper runtime must pass real detached lifetime and host-runtime-trap tests; signer identity is grounded, not invented.
- Publication retry, retention and failure states are documented and tested. R1 supplies the first real immutable input; R2 uses it as the baseline for later targets. Artifact production and signed runtime checks remain release qualification gates, not requirements to backfill history before implementation merges.

## Downstream handoff

Phase 3 receives the signed DMG and canonical retrieval/trust policy for first and legacy install. Phase 4 receives app ZIPs and manifest-last stable/alpha semantics. Neither consumer may change C1 or accept ad-hoc artifacts as distribution, use mutable pointers as accepted identities, or compile when a binary is unavailable.

## Cross-phase audit record

- Re-read root, index and Phase 1: signing qualification now consumes, rather than precedes, the implemented helper contract. No schema or receipt writer is duplicated here.
- Native DMG bootstrap is available to Phase 3; app ZIP staging belongs to Phase 4. Both are derived from the same signed app, preventing two build identities.
- Final audit: credentials and hardened-runtime behavior are execution gates, not presumed available. Phase 3 implementation can consume the merged producer contract; its real first-install qualification runs in R1 once the first complete manifest exists.

## Primary references

[Electron signing and notarization](https://www.electronjs.org/docs/latest/tutorial/code-signing), [Electron fuses](https://www.electronjs.org/docs/latest/tutorial/fuses), and [GitHub release assets](https://docs.github.com/en/rest/releases/assets?apiVersion=2022-11-28#get-a-release-asset) were checked during phasing. Recheck the applicable APIs against the implementation version before editing release infrastructure.
