# Harnesses and terminal backends

Mission Control supports several coding agents and terminal environments without spreading
vendor-specific conditionals through the application. A harness describes an agent's
capabilities. Terminal backends describe how Mission Control can discover, focus, capture,
or write a concrete pane.

The browser-safe capability registry lives in
[`src/shared/harness-capabilities.ts`](../src/shared/harness-capabilities.ts). The daemon's
[harness registry](../src/server/harness/index.ts) adds process, filesystem, transcript,
hook, and SDK adapters. Callers ask for a capability instead of branching on an agent name.

Terminal mechanics are similarly collected in the [terminal registry](../src/server/terminal/registry.ts).
Multiplexer and emulator adapters can compose for one visible session. The binding layer
chooses the innermost pane for writing and capture, while focus walks outward to the
application that can show it to the operator.

This is the technical counterpart to [Sessions and conversations](sessions.md). The rules
for adding a harness, preserving browser-safe shared code, and using capability predicates
are in the authoritative [harnesses and terminals contract](agent-guides/architecture.md#harnesses-and-terminals)
and [harness-change contract](agent-guides/change-contracts.md#harness-changes).
