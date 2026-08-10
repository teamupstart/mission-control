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

> The retro itself, the dashboard offer that invites it, and the writing half of this
> convention arrive with the retro feature; see
> [the plan](plans/retro-repo-memory/plan.md). What ships today is the reading half - MC
> understands the convention, loads the index into its review prompts, and points pi at it.
