# Repository memory

Sessions rediscover the same repo-specific traps over and over, and a correction typed into
one session dies with it. Repository memory is where those corrections go instead: a small
set of markdown files **committed into the repository they are about**, so every session,
every operator, and every checkout of that repo gets them.

The store is deliberately not in Mission Control. MC's own state is instance-local, which
is the one thing this cannot be - clone the repo, get the memory, whether or not Mission
Control ever launched you.

## The convention

```
<repo>/
  AGENTS.md                     # or CLAUDE.md - carries the reference line
  .agents/memory/
    MEMORY.md                   # the index: one line per memory, with a link
    grep-wrapper-lies.md        # one memory per file, with front matter
    e2e-needs-a-build.md
```

`.agents/memory/MEMORY.md` is an **index**, not the corpus: one line per memory, saying what
it is and linking the file that holds it. A session reads the index and opens only the
entries that bear on its task, so a repo with fifty memories costs fifty lines of context
rather than fifty documents.

The root doc (`AGENTS.md`, or `CLAUDE.md` where that is what the repo has) carries a single
reference line pointing at the index. That line is what makes the convention work across
harnesses: Claude and Codex load the root doc natively, so an instruction in it reaches them
the same way every other rule in that file does.

### What belongs in memory

Repeatable, repo-scoped knowledge that makes the next session faster or stops it repeating a
mistake:

| Category | Example |
|---|---|
| Tooling traps | a search wrapper that silently returns zero matches on one file type |
| Test invocation recipes | which suite needs a build first, and which browser to install once |
| Flake catalog | a test that fails locally for an environmental reason and is green in CI |
| Verification recipes | which port serves which checkout, and what an isolated daemon needs |
| Recovery procedures | where a killed run's commits survive, and how to fetch them back |
| Landmine map | generated files, hard limits, and the generator to run instead |
| Repo conventions | a rule that has not hardened into `AGENTS.md` yet |
| Decision provenance | why something is the way it is, so it is not "cleaned up" |

What does **not** belong: secrets, tokens, per-user paths, machine-local state, and anything
`AGENTS.md` already says. A memory that keeps proving itself should be promoted into
`AGENTS.md` and deleted from memory, not duplicated there.

## How memory reaches an agent

| Consumer | How it arrives |
|---|---|
| Claude (terminal and Agent SDK) | loads the worktree's root doc itself; the reference line instructs the read |
| Codex | reads `AGENTS.md` natively, same line |
| Pi | has no file channel, so **dispatch prepends a one-line pointer** to its opening prompt |
| Inspector, Personas, workflow context, Foreman verify | the index is part of the [standards bundle](inspector-and-shipping.md) MC builds for its own prompts |

The pi pointer is added only when the dispatched worktree actually carries an index - a repo
with no memory opens its sessions exactly as it did before, rather than sending them after a
file that does not exist. It is composed into turn one at dispatch, because Pi receives its
first prompt on the launch argv rather than through a pane injection.

Mission Control's own review prompts are the consumers that cannot pick memory up any other
way: they read the standards bundle and nothing else, and they run without file tools. Two
consequences worth knowing when writing an index line:

- **The index reaches them; the topic files do not.** An index line that is only a link is a
  line a reviewer cannot follow. Say what the memory *is* in the line.
- **It is subject to the standards caps** - 24KB per document, 64KB for the whole bundle -
  and it is read last. The repo's `AGENTS.md`/`CLAUDE.md` come first, then any nested doc
  governing a directory the change touched, then memory. At the cap the memory index is the
  first thing dropped, because it is advisory knowledge rather than a rule the repo asserts,
  and the prompt says out loud that documents were omitted.

A `.agents/memory/MEMORY.md` that is a symlink out of the repository is ignored everywhere -
not read into a prompt, and not pointed at on dispatch. Memory is repo content, and repo
content is untrusted input.

## Who writes it

Nothing writes memory automatically, and the daemon never commits. The writer is the
**retro** - an interactive retrospective over a finished session that proposes at most three
memories, each of which a human approves, edits, or rejects - and the session itself commits
the approved ones on its task branch, where they are reviewed in the pull request like any
other change. The first retro in a repository also creates `.agents/memory/` and adds the
reference line to the root doc, once and idempotently.

A session working on some unrelated feature never touches any of this: the reference line
would be an unrelated edit in its diff, and a repo without the line is not broken, it is a
repo with no memories yet.

## The retro

The procedure is the [**retro** skill](skills-and-settings.md#skills-every-session-mixed-reload-behavior)
(`skills/retro/SKILL.md`), which is opt-in and **must be switched on** before a retro can run.
It tells the session to read itself back from
`GET /api/sessions/:id/transcript` rather than from recollection, to look for the corrections
a human had to type and the wrong paths a single fact would have prevented, to propose at most
three memories through the `request_plan_decisions` MCP tool, and to commit only what came
back approved. A dismissal writes nothing at all.

Mission Control's half is one route:

```sh
curl -X POST http://127.0.0.1:7317/api/sessions/<session-id>/retro
```

Whether it types into that session or files a task depends on whether the session can still be
typed into, and the response says which happened. Every status the route can answer with:

| Response | When | What happened |
|---|---|---|
| `200 {"kind":"delivered", ...}` | the session is live and the write landed | The shipped **Retro** session action was rendered and typed into it. The session that did the work runs its own retrospective, because it already holds the context a fresh one would have to reconstruct from transcript bytes. |
| `200 {"kind":"dispatched","task":{...}}` | the session cannot receive a turn | A retro task is filed in the backlog against that session's repository, naming the session, its branch and its pull request. Dispatch it when you want it. |
| `404` | no session by that id | The registry has no row at all. An *exited* session is not this: it is the dispatch row above, and it is the only place the branch and pull request a retro task must name are still readable. |
| `409` | the retro skill is off, or there is no repository to file against | The refusal names the reason. Nothing is typed and nothing is filed. |
| `503` | the session is live but the write did not land | A pane busy with another write, a multiplexer in copy mode, a session mid-reset, an embedded session whose driver rejected the turn, or the skill going stale between rendering the packet and writing it. The error carries what the delivery layer said, and the body also carries `pasted` - see below. |
| `500` | this build cannot produce the packet | Either it ships no retro action at all, or the rendered packet exceeds what one delivery can carry. Both are build-integrity failures rather than anything an operator did, and a shipped action cannot reach the second. |

**A live session is not a promise of delivery**, which is why `503` is its own row: the write
goes through the same pane or driver every other turn does, and that can refuse.

When it does, read `pasted` before retrying. Delivery is not atomic - it is a paste followed by
a submit - so the two failures are opposite problems:

- `"pasted": false` - nothing reached the composer. Safe to retry once the named condition
  clears.
- `"pasted": true` - the packet **is** in the composer and the submit is what failed. Retrying
  appends a second retro instruction under the first; press Enter in the session, or clear it,
  rather than re-sending.

That is the same contract [`/inject`](sessions.md) holds, for the same reason: absence of
evidence is not evidence, so a route that can know this says it rather than letting a caller
assume.

**Both arms fail closed on the skill**, including the one that types nothing. The skill is where
the human-approval ceremony lives, so a task filed while it is switched off would reach an agent
holding an intent that names a procedure it cannot load - and the retro's one hard rule, that
nothing is written a human did not approve, would survive only as prose. The two arms ask the
question of different agents at different times: the live arm asks whether *this* session can
run the skill now, reload watermark included; the dispatch arm asks whether the harness it is
about to pick could run it at launch, where a watermark about some other session's history is
not evidence.

The delivered packet carries the receiving session's own id, which is how the skill knows
which transcript to read - the action's prompt is frozen bytes and cannot carry a per-delivery
fact.

Two properties hold on both paths. **The daemon never commits**: the commit is an agent turn,
on a branch a human reviews. And **nothing is ever typed autonomously** - the route is a
request, and the dashboard affordances below are what make it a click.

Where a workflow stage runs the Retro action rather than a human asking for one, its
completion is `repo_commit`: the action is finished when the checkout's HEAD is a commit made
after the session picked the packet up. A retrospective that discussed three memories and
wrote none of them does not complete.

## When the dashboard offers one

The server only ever **proposes**; you always click. There is no path anywhere in the daemon
that delivers a retro on its own.

The offer appears at one moment and is absent the rest of the time, which is the point: a
Retro button standing on every card for the life of every session says "you could have
retrospected", where an offer that appears says "now is the time". Nothing is ever drawn
disabled.

**Where it appears**, all reading one predicate so no two surfaces can disagree:

| Surface | Where exactly |
|---|---|
| Session card | The action row, beside Complete |
| Console detail | The footer action row, beside `complete` |
| Workflow ladder | The ladder's own action row, on the Board tile and in the session's Workflows tab |
| Complete dialog | A secondary **Run a retro first**, which sends the retro and completes nothing |

**The condition is two independent halves, and both must hold** (except in the Complete
dialog - see below):

1. **The session is worth retrospecting.** Either a human corrected it - a turn in its
   transcript beyond the opening brief that Mission Control did not type itself - or the
   Inspector raised findings on its pull request that were then resolved. A clean run nobody
   had to steer teaches nothing, and gets no prompt. This rides the session payload as
   `Session.retro`, and the offer's tooltip names which reason applied.
2. **The review has finished.** Either the bound workflow run's Inspector gate reads `clean`,
   or - for the great majority of sessions, which bind no workflow - the session's own
   Inspector chip reads clean. A dry-run review counts, because that chip counts it. A pull
   request that merged before the gate cleared keeps the offer, because the session's review
   outcome is unchanged even though the run is now blocked on a closed pull request.

The Complete dialog is the one place the second half is dropped. A scout or a spike never
opens a pull request, so it never reaches that moment at all, and Complete is the last time
anybody is looking at it. It sends the retro and leaves the task open and the session alive,
because the retro is a turn that session still has to take.

Clicking reports which arm the route took - typed into this session, or filed as a backlog
task - rather than a bare success, because those are different next moves.

Two things this deliberately is **not**: there is no post-Inspector workflow stage (the
Inspector is the completion policy that runs after the graph's End, not a node to hook), and
there is no per-repo "always retro" policy. Both were considered and rejected for v1; the
completion policy, not the graph, is where a standing offer would be raised later.

The signal behind half of it is computed lazily. The findings half is free - it comes out of
the same ledger query that already builds the Inspector chip. The corrections half reads the
transcript, so it is polled (`MISSION_RETRO_SCAN_MS`, default 10s), reads only the bytes
appended since the last pass, and stops reading a session entirely once it has flipped. Set
it to `0` to switch transcript scanning off; the findings half still works.
