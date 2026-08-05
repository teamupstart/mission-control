# Phase 5: architecture and technical docs

## Outcome

A newcomer can understand how Mission Control is put together without reading source: a
human-readable architecture overview with a component diagram, and per-subsystem
technical pages that go one level deeper, each linking into code and into the agent-guide
contracts rather than duplicating them.

## Entry criteria and dependencies

- Direct prerequisite: phase 4 (the `docs/README.md` index with the reserved
  Architecture section, and the feature pages these docs link to).
- May run concurrently with phases 6 and 7; the only shared file is `docs/README.md`,
  and each phase adds entries only under its own reserved section.

## Scope

- `docs/architecture.md`: the component overview - daemon (loopback HTTP + only SQLite
  writer), web dashboard (React over SSE), Electron shell, MCP server, Foreman worker
  (HTTP only, never SQLite), Inspector (in-daemon), SDK supervisor, terminal registry,
  hook bridges - with a component/data-flow diagram (Mermaid, which renders on GitHub)
  and a link per component to its deeper page.
- Per-subsystem pages under `docs/` (suggested set; merge where thin): session lifecycle
  and eviction; dispatch and runtimes (terminal vs SDK); harness capabilities and
  terminal backends; workflows, personas, session actions and ensembles (how the builtin
  generators fit in); tasks, backlog, scheduler and autopilot; database and migrations;
  the event stream (SSE contract, `useEventStream` exhaustiveness); packaging and the
  Electron build.
- Add the entries under the index's **Architecture** section.

Non-goals: changing any code; restating `docs/agent-guides/architecture.md` or
`change-contracts.md` - those stay the agent-facing contracts, and the new pages link to
them for the rules while explaining the why and the shape for humans. Do not create a
second source of truth: where a contract is already written down, link it.

## Repository findings

- `docs/agent-guides/architecture.md` is a dense 95-line contract table - correct but
  written for agents mid-change, not for orientation.
- `docs/ensembles.md` already covers the ensemble extension surface; link it rather than
  absorb it.
- The process-boundary table in the agent guide is the right skeleton for the overview
  diagram: every row is a box, and the SSE-only browser channel and daemon-only SQLite
  writes are the two arrows people get wrong first.
- Subsystem source anchors: `src/server/index.ts`, `src/server/registry.ts`,
  `src/server/harness/`, `src/server/terminal/`, `src/server/sdk/supervisor.ts`,
  `src/server/foreman/worker.ts`, `src/server/inspector/`, `src/server/workflows/`,
  `src/server/db.ts`, `src/web/useEventStream.ts`, `src/main/index.ts`,
  `src/mcp/server.ts`, `hooks/`.

## Implementation steps

1. Write `docs/architecture.md` from the process-boundary table outward; one Mermaid
   diagram of components and their channels (HTTP, SSE, stdio, hook posts, SQLite).
2. Write the subsystem pages, each: what it owns, how it talks to the rest, the
   invariants (linked to agent-guides where they are contract), and where the code is.
3. Add index entries; cross-link feature pages from phase 4 where a feature page and a
   subsystem page cover the same ground from different altitudes.

## Compatibility

Documentation only.

## Tests and verification

- `npm run lint` (docs are not linted, but guard against stray source edits),
  `npm test` untouched-green.
- Link sweep over the new pages: every intra-repo link and code path named resolves.
- Mermaid blocks render on GitHub (spot-check in the PR's rich diff).

## Merge and exit criteria

- CI green; index Architecture section populated; every new page reachable from the
  index.

## Downstream handoff

Phase 8's README links `docs/architecture.md` prominently. Later work must keep
agent-guides authoritative for contracts; these pages carry orientation, not rules.

## Cross-phase audit record

- 2026-08-04: initial version. Concurrency with phases 6-7 is safe only through the
  index-section contract in `phased-plan.md`; if the index needs restructuring, that is a
  phase 4 follow-up, not a unilateral edit here.
