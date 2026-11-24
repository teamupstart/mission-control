# Session settings MCP implementation phases

The operator approved revision 1, including default-on access in the first release and creation of dependency-linked implementation tasks. Revision 2 incorporated those selections. The root plan is plan.md. Every phase changes only the Mission Control repository.

## Sizing and merge order

Estimate 1,600 to 3,100 gross production lines added or materially changed, excluding tests. This assumes reuse of settings search metadata, Zod schemas, the daemon’s config owners and existing event consumers. The lower end assumes common scalar patch owners cover most fields. The upper end allows for nested controls, owner-specific side effects, live refresh and settings outside the backup registry. The uncertainty is in connecting existing controls, not in the size of the MCP definition.

## Dependency graph

Planning publication → Phase 1 → Phase 2 → Phase 3. Each task also directly depends on the planning session. Only one implementation phase runs at a time. Phases 2 and 3 share settings metadata, ownership tests and the coverage inventory. Parallel branches would reconcile competing partial inventories.

## Phase files

1. [Live theme changes and access control](phase-1-session-access.md) owns the fixed tool contract, registered caller, default-on rollout, protected access switch, interactive theme change, live update path and baseline inventory.

2. [Typed settings and generic coverage](phase-2-typed-settings.md) owns ordinary typed preferences, their owner adapters, schema-driven field discovery, structured update semantics, contributor contract and coverage tests.

3. [Specialized owners and complete coverage](phase-3-owner-coverage.md) owns every remaining inventory row, including owner-specific intents, consent boundaries and settings outside typed patch stores. It verifies whole-product completeness.

## Why three merges

Phase 1 gives an operator a usable, revocable capability and exercises authentication, native skin persistence and two live windows together. Adding dozens of settings to that first review would obscure failures in the shared access boundary. Phase 2 proves generic onboarding across typed owners before Phase 3 applies the contract to exceptional mutations. Combining the latter two would require reviewing generic derivation, live-service semantics, and the complete privilege inventory in one change.

## Contracts shared across phases

The stable public contract is one mission_settings definition with find, get and set. Phase 1 owns the bounded wire shapes including an opaque conditional-write token for composite replacements, an optional cursor and stable errors. Later phases populate descriptors and owners without growing the tool schema. Each setting has one stable key and one mutation authority shared with the dashboard. Only published keys may be used. Protected paths have safe metadata or status and an operator destination. Unknown fields, arbitrary paths, bulk writes and operational actions are ineligible.

The phase inventory reconciles every Settings control and its editable leaves with its config or external owner. Include generated controls and examine panels with multiple controls per anchor. Phase 1 records a named disposition and implementation phase per row. Phase 2 closes typed-owner rows. Phase 3 closes every remainder. Temporary pending rows never appear as successful MCP capabilities. Each phase must pass its tests at merge.

## Verification and audit

Phase 1 proves the protected default-on access path through a real stdio fixture and rendered dashboard. Phase 2 proves new ordinary settings become accessible without a change to the MCP tool and that concurrent edits preserve siblings. Phase 3 checks complete inventory coverage and owner-specific behavior, then runs all required gates. Each phase keeps its own Playwright coverage for visible changes and uses fixture harnesses without model calls.

The phase boundaries assign the wire contract and Daylight case once, the typed-owner extension contract once, and residual inventory and final conformance once. Shared tests grow cumulatively. A late-discovered control goes to Phase 2 if it uses an ordinary typed patch within that phase’s inventory, otherwise to Phase 3. There is no post-merge cleanup prerequisite. The planning handoff carries all three task edges.
