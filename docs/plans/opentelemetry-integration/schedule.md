# OpenTelemetry task schedule

Created 2026-09-13 after publishing plan commit `5e62fea7f63a60d287e7ffe4671cf944705fec63`. All seven tasks target the canonical Mission Control repository, with no additional repositories and no model or effort overrides. They were verified in the backlog through the daemon API.

Every task has a direct prerequisite on planning task `029710f7-b160-45dd-9080-955b2939dcfb`, resolved by Mission Control from the current session. That edge remains unsatisfied until the planning PR merges. Direct implementation prerequisites are listed below; transitive edges are omitted.

| Phase and guide | Task ID | Direct phase prerequisites |
| --- | --- | --- |
| [1. Durable walking slice and local reference stack](phase-1-durable-walking-slice.md) | `d3b7baa9-ce4f-4770-8cf6-51badfd7628b` | None |
| [2. Export profiles, consent and Settings](phase-2-profiles-and-settings.md) | `053c2d24-57c0-43a9-9d80-0bc087bc5787` | 1 |
| [3. Session attribution and verified outcomes](phase-3-session-attribution.md) | `212cd9e2-8f42-4221-9ed5-7ae083906142` | 2 |
| [4. Workflow stages, verdicts and recovery](phase-4-workflow-insights.md) | `b434ca9f-ec2a-4c2a-82ec-2e585ef22cee` | 3 |
| [5. Primary actions, automation and safe errors](phase-5-actions-and-errors.md) | `9cf90755-b85a-4050-9b12-362db0a5cfa8` | 4 |
| [6. Bounded analytical projections](phase-6-analytical-projections.md) | `60dcf818-09a5-43b7-9fa5-01eb3bb05157` | 4 |
| [7. Six local Grafana dashboards](phase-7-grafana-dashboards.md) | `ea77fc60-1123-484e-8b1e-6a217e0b156b` | 5, 6 |

Execution order: `1 -> 2 -> 3 -> 4 -> {5, 6} -> 7`. Phases 5 and 6 can execute and merge in either order. Phase 7 waits for both. Each phase task opens its own implementation PR; a completed prerequisite is released by its merged PR rather than by a plan checkbox.

Read the [rendered implementation index](phased-plan.html) or [source index](phased-plan.md) for ownership and verification. The task prompts reference the published source plan, index and exact phase guide, and leave implementation detail in those documents.
