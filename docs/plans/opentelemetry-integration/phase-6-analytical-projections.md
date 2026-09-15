# Phase 6: bounded analytical projections over durable facts

## Outcome and value

Export trustworthy cohort summaries: which runs needed human recovery, completed without intervention, finished within a horizon, produced verified PRs, and which features saw repeat use. Metrics consumers can query these summaries through OTLP without a warehouse, raw operator data or per-run metric labels.

Read [the source plan](plan.md), [the index](phased-plan.md), [P5](p5-analysis-delivery/plan.md) and the P0/P1/P2/P3 source contracts. Follow this proposed route where the repository agrees and explain justified adaptations in the PR.

## Entry, dependencies and scope

Direct prerequisite: Phase 4 merged, plus the planning PR. Repository: Mission Control only. Phase 5 may run concurrently. Own `src/server/telemetry/`'s analytical projection subtree and its dedicated registration/catalog entry point, bounded state versions/checkpoints, focused reducer/export tests and analytical guide. Proposed paths must use the extension seams Phase 1 introduced and Phase 4 froze.

Do not edit source/route/worker/browser owners, action definitions, common telemetry migrations or Phase 5's coverage guide. Consume the existing standard action envelope, even where broad feature callers will arrive with Phase 5; session/workflow/control events already provide real inputs. Broad feature metrics correctly report no observation until their source arrives. No source action is re-emitted by a reducer.

Own P5's run/task/PR/installation/feature/review/quality projections, exact denominators and bounded late/censored-state handling. Grafana presentation belongs to Phase 7. Public product hosting, arbitrary retrospective SQL joins and unlimited raw event retention are excluded.

## Existing foundations and inherited contracts

Phases 1-4 provide immutable event-time context, one semantic identity, actor basis, source coverage, per-profile consent epochs and an atomic versioned projection/checkpoint/output facility. Current operational task/workflow/usage stores remain authoritative; analytics consumes captured facts rather than scanning all historical operator records.

P5 defines an eight-review/six-run fixture and SQL as a semantic oracle. Prometheus trend extrapolation is not an exact event census. Exact bounded populations therefore use projected gauges with explicit time bounds and completeness, while activity trends remain ordinary counters/histograms.

## Implementation sequence

1. Finalize each required summary as a versioned metric view: source predicate, grain, denominator, time basis, dimensions, unknown policy, audience and state lifetime. Keep reviewer/author roles distinct. Add analytical definitions only through the separate projection catalog; reuse the P0 cardinality and overflow rules.
2. Implement replay-safe minimal per-run state for start/context, outcome-at-horizon, first confirmed recovery, any human action, designed-human-gate eligibility and observation continuity. Deduplicate by semantic operation/run identity. Required approvals, steering and termination are not successful recovery.
3. Implement review and repair summaries: first semantic review, next executed review resolution, volume/reason shares and no-next-review coverage. Invalid responses and reused passes never alter executed rejection denominators. Use known semantic identity rather than attempting to match raw finding text.
4. Implement task/PR cohorts, early-exit evidence and bounded abandonment classification using declared grace/horizon and continuation/late-merge facts. Count tasks once and PRs at their actual repository grain; missing visibility remains unknown. Cost/tokens use the canonical usage facts and show unfinished/missing attribution.
5. Implement bounded installation/feature activity buckets for first observed use, active/repeat-use indicators and affected-operation/install error summaries. Destination identity resets and partial observation delimit eligibility; a local installation is not a verified unique person. Reuse source action envelopes supplied by Phase 4 and test broad feature fixtures without depending on Phase 5's hooks.
6. Implement expiry/reconciliation of minimal reducer state under Phase 1's budget. Candidate seven-day start windows, seven-day outcome horizon and 30-day state are finalized from Phase 1's measured choice. Keep timestamp bounds as values and window/horizon as bounded enums. Late eligible facts revise current snapshots with a new calculation time; they do not restamp original events or overwrite past exported history.
7. Export coherent cohort gauges plus window/horizon/calculated-at/completeness metadata through the normal durable outbox. Numerator and denominator must describe the same cohort and calculation. Define partial-batch/stale-producer detection so queries cannot silently combine mismatched snapshots or treat missing data as zero. Preserve profile isolation and original resource context.
8. Add exact fixture expectations and a query-contract guide for Phase 7: proposed Prometheus names after translation, allowed filters, zeros/empty/incomplete states, counter versus gauge handling, version/cohort comparisons and trace lookup fields. Run the projection/export path against the real local receiver, not just in-memory arithmetic.

## State and compatibility

All state uses the existing bounded versioned projection store; no new common DB migration is needed in this parallel phase. Declare reducer state upgrades/reset behavior and output-stream baselines. Changing metric meaning creates a new version/instrument rather than retroactive relabeling.

Charge indexes/dedupe/minimal state to the agreed total budget. Do not keep full raw payloads for the cohort lifetime. Expiry, quota rejection or unknown actor attribution makes relevant coverage incomplete; it cannot create a false human-free outcome. Product opt-in begins a separate epoch and cannot inherit pre-opt-in totals from the local profile.

The Phase 5/6 concurrency contract is an entry gate. If the base lacks a required common source/storage interface, coordinate that prerequisite before continuing; never read the concurrent branch or add an undocumented dependency.

## Tests and verification

Use the root `AGENTS.md` isolated unit-runner contract. Add deterministic clock/property fixtures for replay order, duplicate delivery, restart between state and output, late outcomes, consent reset, expired state, zero eligible runs, overflow/custom dimensions, mixed models, multiple PRs and unknown actor/visibility. Assert bounded state/series at the agreed limits.

Consume Phase 3's ownership-removal/late-merge fixture. Within the retained horizon, the verified delivery fact revises the current PR/outcome cohort exactly once while original session-end evidence and operational task status remain distinct. An expired association marks coverage incomplete. Projection replay cannot complete a task or satisfy any dependency.

The six-run oracle must produce 8 executed reviews, 6 pass, 2 fail, 4 completed runs, 1 pending, 1 cancelled and confirmed recovery in 1 of 6. R2 alone is known human-free; R6 remains ambiguous. Excluding R5's authored approval leaves 5 automation-eligible runs. Position timestamps against a frozen matured-cohort horizon; short SQL examples require the full after-start/horizon/consent filters in actual reducers.

Run `npm run typecheck`, `npm run lint`, `npm run build` and `npm run smoke`. Run real-stack metric assertions with same calculation metadata, reload/replay, metric name translation and partial/stale snapshots. No UI changes are needed; if a visible surface is added, supply its Playwright coverage in this phase rather than deferring it.

## Merge, exit and handoff

Exit with all required bounded summaries exported through the ordinary durable facility, exact fixture reconciliation, documented query contracts, bounded state/series, consent separation and truthful gap handling. This is useful backend behavior even before Grafana panels are complete.

Phase 7 consumes the analytical metric catalog, snapshot-coherence filters, golden fixture, supported windows and version/coverage rules. It must not approximate distinct runs from raw action counts or use sampled traces for denominators. Phase 5 can land before or after this phase without changing reducer meanings or files.

Open a reviewable PR, meet the verification bar and resolve current-main conflicts/valid feedback. Phase 7 is released only after both this phase and Phase 5 merge.

## Cross-phase audit

2026-09-13: re-read source/index and Phases 1-5. Retained payload and cohort state have separate bounded lifetimes under one owner/budget. No new source events, common migrations or source-registration edits are needed. Phase 5's broad callers are optional inputs until they land, not an implementation prerequisite. Added explicit snapshot-coherence/partial-delivery handling so the final dashboards cannot pair different cohort calculations.

Review reconciliation: Phase 3 now explicitly owns durable late-PR observation after ownership invalidation. This phase tests cohort revision from that input without adding polling, operational bindings or dependency-release authority.
