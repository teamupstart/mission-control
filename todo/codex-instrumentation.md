# Codex session instrumentation

Make Codex sessions first-class across the sessions dashboard, on par with Claude.
Parked pending the spike below (blocked on Codex being logged in).

## Problem

Codex sessions show up as **cards** (process discovery classifies `codex` the
same as `claude`, and after the worktree-cwd fix they get the correct
cwd/branch/pid). But they're second-class:

- **No live state.** Working/idle/awaiting-input all come from Claude hook
  events. Codex has no wired instrumentation, so a codex card just looks
  generically "working" while the process is alive.
- **No transcript.** `resolveTranscriptPath` returns `null` for any non-Claude
  agent (`src/server/transcript.ts`, the `agent !== "claude"` guard).

Goal: correct identity/cwd (done), **live state**, and **transcript rendering**
for Codex - without coupling to Codex internals we don't control.

## Constraints / decisions already made

- **Do NOT query Codex's private SQLite DB** (`~/.codex/state_5.sqlite`) as a
  load-bearing dependency. The `state_5` / `logs_2` version suffixes mean the
  schema has already migrated repeatedly; it's undocumented and brittle. (User
  veto.) Reading it read-only works technically, but don't build on it.
- Prefer authoritative sources the agent exposes; keep few fallback layers.

## What we already shipped (reuse this)

PR #19 (`mancej/fix-worktree-cwd-discovery`) fixed worktree cwd discovery and
Claude transcript resolution. The **instrumentation pipeline it built is
agent-agnostic and reusable**:

- `HookIngestSchema` + `POST /hooks/:event` ingest (`src/shared/protocol.ts`,
  `src/server/routes.ts`).
- Registry hook overlay keyed by terminal pane / session id; `agentSessionId`
  and `transcriptPath` plumbed through `Session`, `mergeDiscovered`,
  `sessionEqual` (`src/server/registry.ts`).
- `resolveTranscriptPath(session, projectsDir?)` - prefers the hook-reported
  `transcriptPath`, else derives from cwd (`src/server/transcript.ts`).
- Discovery already classifies codex, native vs wrapper
  (`src/server/discovery/processes.ts` `classifyAgent`/`nativeAgent`), and yields
  the correct cwd via `readProcCwds` (`src/server/discovery/proc-cwd.ts`).

## What we learned about Codex (partial spike)

- Package: `@openai/codex`, `codex-cli 0.144.1` (node launcher →
  `/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js` → native binary).
- **Storage: rollout FILES on disk** (readable transcript), with SQLite only as
  an *index*. `codex doctor` reports "rollout files" and "rollout files and state
  DB thread inventory agree". So we can read the transcript **without the DB**.
  (0 files right now - Codex unused on this machine.)
- SQLite index (`state_5.sqlite` `threads`, for reference only): `id`,
  `rollout_path`, `cwd`, `git_branch`, `git_sha`, `created_at_ms`,
  `updated_at_ms`, `recency_at_ms`, `title`, `first_user_message`, `archived`;
  indexed by `(archived, cwd, ...)`.
- **Codex has a native hook system**: `--dangerously-bypass-hook-trust` ("run
  enabled hooks without requiring persisted hook trust"). So hooks are
  registered + trusted somewhere. No `codex hooks` subcommand; config format not
  found in CLI help and `config.toml` is empty. Likely a `config.toml` section, a
  hooks dir, or plugin-delivered - **needs docs / the spike**.
- Other surfaces: `codex mcp-server` (Codex as an MCP server over stdio),
  `codex exec --json` (streams events as JSONL to stdout), `plugin` system,
  `--output-last-message <FILE>`.
- **Blocker:** Codex is "Not logged in", so we could not run `codex exec` to
  watch live events or see a rollout file get created.

## Options (ranked)

1. **Codex-native hook (front-runner).** Mirror `hooks/harness-hook.mjs` for
   Codex; reuse the entire pipeline above. Clean, no wrapper, no DB. Viable
   **iff** a codex hook can report session id + rollout path + cwd + lifecycle
   events. This is exactly what the spike decides.
2. **Launch wrapper** (generalize `scripts/new-session.mjs`). Register the
   session with the daemon at launch (session id, pane, cwd, branch) and capture
   the rollout path by watching the rollout dir for the file created after launch
   time `T` in this cwd. Most deterministic and agent-agnostic, but heavier and
   only covers sessions this app launched. Fallback if hooks are insufficient.
3. **Rollout-file indexer** (file-based, no DB). Watch the rollout dir, read the
   self-describing rollout JSONL. Mostly a way to *learn the path* if there's no
   hook/wrapper; redundant for Claude now.
4. **Codex-as-MCP / `--json` event stream.** Alternative live-state channel worth
   noting.
- **Rejected:** querying the SQLite DB directly (brittle internal schema).

## The spike (do this once Codex is logged in)

Decides hook-vs-wrapper. Keep it contained; no building yet.

1. Find the **Codex hook config format** and how to register/trust a hook
   (OpenAI Codex hooks docs; check `config.toml` `[hooks]`/`[[hooks]]`, the
   `plugin` system, or a hooks dir; `--dangerously-bypass-hook-trust` + "persisted
   hook trust" implies a trust store).
2. Enumerate **hook events** (session start/end, pre/post tool, turn complete,
   waiting-for-input/notification).
3. Capture a **hook payload**: write a trivial hook that dumps stdin/argv/env to a
   file. Confirm whether it includes: session id, `rollout_path` (or transcript
   path), `cwd`, event name.
4. Run `codex exec --json "say hi"` (needs login). Watch: the JSONL event stream
   on stdout, and `~/.codex` for a new rollout file - capture its **path pattern
   and format** (is it self-describing JSONL like Claude's?). Cross-check the
   `threads` row appears (not as a dependency).

**Decision criteria:**
- Hook reports session id + `rollout_path` + `cwd` + lifecycle → **build a Codex
  hook** mirroring `hooks/harness-hook.mjs`; reuse the overlay/`transcriptPath`
  plumbing; add a codex branch to `resolveTranscriptPath`.
- Hook can't report the rollout path → **wrapper** registers identity at launch +
  watches the rollout dir (cwd + created-after-`T`) to capture the path.

## Follow-on work once the path is chosen

- **Codex rollout parser.** `toMessage`/`parseLines` in `src/server/transcript.ts`
  assume Claude's JSONL record shape. Codex rollout files have their own shape →
  needs a codex-specific parser (dispatch by `session.agent`).
- **Agent-dispatched `resolveTranscriptPath`** (claude vs codex).
- **Live-state mapping**: which Codex events map to
  working/idle/awaiting_input (`hookToState` equivalent for codex).

## Open questions

- Codex hook config/trust mechanism + payload contents (the spike).
- Codex rollout file format + path pattern.
- Live-state event mapping for Codex.

## Pointers

- This PR: `mancej/fix-worktree-cwd-discovery` (GitHub PR #19).
- Reusable pipeline: `src/server/registry.ts`, `src/shared/protocol.ts`,
  `src/server/transcript.ts`, `hooks/harness-hook.mjs`.
- Discovery: `src/server/discovery/{processes,correlate,proc-cwd}.ts`.
