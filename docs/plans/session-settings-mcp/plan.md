# Session access to Mission Control settings

## The operator experience

A human asks a session to switch Mission Control to its light theme. The session searches for “theme”, finds Display → Skin, learns that Daylight is a valid choice, and sets it. The open dashboard repaints, the picker shows Daylight, and the next launch keeps it. A question such as “Which theme am I using?” ends after the read. Ordinary changes need no second approval. The preference applies to this Mission Control installation across sessions.

## One tool with progressive discovery

Add one session tool, mission_settings, with three operations. find takes a short query and optional cursor and returns up to eight matching keys, labels and access modes. get takes one exact key and returns its effective value, type, editable constraints and available choices on demand. set takes one exact key and a JSON value and returns the effective result. Use the setting owner’s validation and reject ambiguous matches. A known key can be read or changed directly.

Example sequence: find(query="theme") → ui.skin; get(key="ui.skin") → current skin and shipped choices; set(key="ui.skin", value="daylight") → ui.skin = daylight. Return compact error codes with a corrective hint for unknown keys, invalid choices, protected settings, disabled access and stale writes. Keep search results free of values. Page long choice lists and bound large values with explicit continuation or size errors so truncation cannot turn into a write.

Keep the tool description and input schema constant as settings grow. Do not inject the catalog into system prompts, tool enums or startup results. Separate read and write tools would permit tool-level allowlisting but add another permanent definition. A raw configuration or HTTP tool would save definitions while exposing implementation details and operations outside Settings.

## Connect discovery to the existing owners

src/web/lib/settings-search.ts already indexes control labels, aliases, stable UI anchors, risk markers and backup coverage. src/shared/app-config-entries.ts already classifies stored fields, including settings, derived values and runtime state. Neither alone identifies the legal live mutation. For example, feature flags accept intents, and a UI skin change can update the native window background. Snapshot restore has different transaction and notification semantics from a live edit.

Extract browser-safe search metadata from the existing control index where needed. Associate durable setting keys with their owner, value schema, access policy and UI search metadata at the existing declaration. Keep React bindings in the web layer and live getters and mutation handlers in the daemon. Derive descriptors for ordinary fields from the owner’s declared patch schema within its reviewed field policy. Use a domain adapter for special behavior, composite controls and stores outside app_config. Keep storage keys and UI anchors independently evolvable.

Inventory every existing Settings category and searchable control, including dynamically generated controls and panels that group several preferences. Map each ordinary preference to a working read and write, with an explicit disposition for protected, read-only or operational controls. Include persistent settings outside app_config through their real owner. For a genuinely per-window preference, identify its target and persistence semantics before exposing a write. Record unresolved coverage as a delivery gap. A backup domain or an unclassified object must never by itself confer write access.

## Request flow and live behavior

Session tool → authenticated daemon gate → setting owner → persisted change → open dashboards. The dashboard and MCP enter the same owner mutation path. The MCP tool returns only the requested setting. An owner publishes its existing update event, or a bounded invalidation when its clients currently learn changes only from their own write response.

For ui.skin, reuse src/server/ui-config.ts, src/shared/skins.ts and src/web/lib/uiConfig.ts. Today PUT /api/ui/config returns the new view to its caller, while the browser store does not poll for general edits. Reconcile external writes with the existing browser store, cache and skin subscriber. On reconnect fetch authoritative state. Order or version refreshes so a stale response cannot revert a later local edit. Cover the ordinary Settings panel and a second already-open window.

Update only the selected field through the owner and preserve siblings, domain gates, migration behavior and normal side effects. For list or object replacement require a matching version from get or a narrower owner-supported edit. Reject stale replacements without partial application. Repeating a successful scalar set should converge without replaying side effects.

## Access and rollout

Require the machine token and a live registered session, using the signed caller pattern already used by the declared-wait routes in src/server/routes.ts. Enforce the current access setting on discovery, reads and writes in the daemon, including calls from already-running clients. Check again at mutation if an asynchronous operation can outlive revocation. A disabled response carries no settings data. Keep the session tool description explicit that writes act on a human request. The gate authorizes the session; it cannot verify a natural-language instruction.

Provide a durable operator switch, Allow sessions to access Mission Control settings, default true for new and upgraded installations with no stored choice. Switching it off denies the next call and persists across restart. Protect the switch and any bulk or indirect operation that can restore access. Keep permission to use the MCP separate from permissions enforced by individual owners. Use safe status for secrets, preserve existing human-consent boundaries such as arming live delivery, and never expose secret values or grant-changing writes. Protected results can identify the Settings panel the operator can use.

Adopted decisions from the operator’s revision 1 review: ship the rollout flag at the existing default-on stage in the first release, as a feature-specific exception. Keep the durable access switch after flag retirement and preserve explicit opt-outs. The operator approved the root design and selected phased implementation with dependency-linked backlog tasks.

## Compatibility contract and acceptance

Add the contributor rule to root AGENTS.md: every new operator setting must declare its searchable key, read/write behavior and policy through its owner and share its validation with the dashboard. Ordinary new fields in covered domains become usable without changing the MCP handler, tool schema or prompt. New domains supply an owner adapter once. Protected settings and controls that trigger actions declare their reason. Keep previously shipped MCP keys stable or provide aliases when the UI or storage changes.

Add a contract test that joins settings-control and config-owner coverage, detects undeclared additions and proves that a synthetic eligible field is discoverable, readable and writable through the production dispatcher without a tool edit. Assert tools/list gains exactly one fixed definition and its serialized schema is unchanged with a much larger fixture catalog. Check bounded discovery, targeted reads, and secret-free errors and logging.

Run focused daemon and stdio integration tests for fresh and upgraded defaults, opt-out, revocation, unauthorized callers, invalid and protected writes, owner side effects and concurrent edits. Verify supported Claude, Codex and Pi session paths using existing fixtures, including Pi’s tool bridge. Exercise a second domain with different mutation semantics so theme alone cannot make the generic test pass.

Add a Playwright spec with a fixture session that finds and sets Daylight, checks the open dashboard and picker without reloading, verifies persistence, flips the access switch and observes refusal from that same session. Cover an edit in the dashboard followed by an MCP read. Run the repository typecheck, lint, build, smoke and relevant test suites. Update the settings and feature flag guides alongside AGENTS.md.

## Implementation phases

Read the [implementation index](phased-plan.md) for the dependency graph, verification strategy and three phase files.
