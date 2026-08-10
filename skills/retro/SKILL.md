---
name: retro
description: Run the retrospective over a finished session and commit what it learned into this repository's .agents/memory, proposing at most three memories for the human to approve, edit, or reject. Use whenever a retro is requested, a Mission Control retro session action arrives, a session is asked what it learned, or someone asks to catalogue a correction so the next session does not rediscover it.
metadata:
  mission:
    category: shipping
    enforcement: triggered
---

# Retro

A retrospective over the work this session just did, whose output is not a report. It is at
most three durable memories, committed into the repository they are about, where the next
session reads them before it starts.

The rule that shapes every step below: **nothing is written that a human did not approve**,
and the commit is yours. Mission Control never writes to a repository.

## What you are writing into

```
<repo>/
  AGENTS.md                     # or CLAUDE.md - carries one reference line
  .agents/memory/
    MEMORY.md                   # the index: one line per memory, with a link
    grep-wrapper-lies.md        # one memory per file, with front matter
    e2e-needs-a-build.md
```

`.agents/memory/MEMORY.md` is an **index**, not the corpus. A session reads the index and
opens only the entries that bear on its task, so a repo with fifty memories costs fifty
lines of context rather than fifty documents.

Two consumers read the index and never open the files: Mission Control's own review prompts
(the Inspector, the workflow personas, the verifier) load it as part of their standards
bundle and run without file tools. So **an index line that is only a link is a line they
cannot follow**. Say what the memory is in the line itself.

## 1. Read the session back

Work from the transcript, not from memory of it. Your own recollection is the thing being
audited.

Mission Control serves it on loopback:

```sh
curl -s "http://127.0.0.1:7317/api/sessions/<session-id>/transcript?turns=200"
```

Use `$MISSION_PORT` in place of `7317` when it is set. The retro session action names your
session id in its envelope (`Session: <id>`); a dispatched retro task names the session it
is about in its intent. When you have neither, say so in your proposal rather than guessing
an id, and work from the context you already hold.

Read for three things, in this order:

1. **Corrections.** Every turn where the human stopped you, redirected you, or told you the
   thing you had just assumed was wrong. These are the highest-value memories in the
   transcript because somebody paid for them once already.
2. **Avoidable cost.** Time spent on a wrong path that a fact would have prevented: a test
   command that needed an argument nobody told you about, a verification that was measuring
   the wrong process, a file you edited that turned out to be generated.
3. **Review findings that were real.** A finding you fixed is a mistake the next session can
   repeat.

Two honesty constraints on what you read:

- **Roughly half the "user" turns are not the user.** Harness scaffolding, tool results,
  system reminders, and command wrappers all land in the transcript shaped like user turns.
  So do machine-typed deliveries: Foreman work items, workflow packets, and skill-reload
  broadcasts. Mission Control labels the ones it typed, but only for a live conversation -
  the labels are in-memory and a daemon restart forgets them. Treat attribution as
  best-effort, and when a memory rests on who said something, say in the proposal that it
  does.
- **A retro on your own work is a charitable reviewer.** Prefer the memory you can point at
  a transcript line for over the one that reads well.

## 2. Choose at most three

Three is a ceiling, not a target. Two good memories beat three, and a retro that proposes
one and says the rest of the session was unremarkable is a correct retro.

Read `.agents/memory/MEMORY.md` first, if it exists. It tells you what is already known, and
a proposal that restates an existing memory is not a proposal.

Qualifies:

| Category | Example |
|---|---|
| Tooling traps | a search wrapper that silently returns zero matches on one file type |
| Test invocation recipes | which suite needs a build first, and which browser to install once |
| Flake catalog | a test that fails locally for an environmental reason and is green in CI |
| Verification recipes | which port serves which checkout, and what an isolated daemon needs |
| Recovery procedures | where a killed run's commits survive, and how to fetch them back |
| Landmine map | a generated file, and the generator to run instead of editing it |
| Repo conventions | a rule that has not hardened into `AGENTS.md` yet |
| Decision provenance | why something is the way it is, so it is not "cleaned up" |

Does not qualify, and proposing one of these is a defect:

- **Secrets, tokens, credentials.** Never, under any framing.
- **Per-user paths, machine state, ports you happen to be using, worktree names.** The
  memory is committed and read by every operator on every machine. `/Users/you/...` is not a
  fact about the repository.
- **Anything `AGENTS.md` already says.** Duplicating a rule into memory gives the repo two
  copies to keep in sync and one of them will drift.
- **Facts about this feature.** "The retro route lives in routes.ts" is what code search is
  for. A memory earns its place by being non-obvious and repeatedly costly.
- **Anything you did not observe.** A memory is a claim the repository will assert to every
  future session. "Should be" is not a memory.

Two proposals that are not additions, and both count against the three:

- **Deletion.** A memory that the session proved wrong, or that names a trap somebody has
  since fixed, should be removed. Pruning is a first-class outcome, not housekeeping.
- **Promotion.** A memory whose `times-confirmed` keeps climbing has hardened into a rule.
  Propose moving it into `AGENTS.md` and deleting the memory file and its index line, so the
  repo keeps one copy rather than two.

One escape hatch, used rarely: a memory that is purely **procedural** and long - a step-by-step
recipe rather than a fact - is a better repo-local skill than an index line, because a skill
loads only when its trigger fires. Propose it as such, and say why the standing context cost is
not worth paying.

Keep it short at both levels. The index is what Mission Control loads into its own review
prompts, under a 24KB cap that drops it entirely when exceeded, so a bloated index costs every
reviewer the whole of memory. And a memory nobody finishes reading is a memory nobody applies.

## 3. Ask before you write

Call the Mission Control MCP tool **`request_plan_decisions`**. It renders your proposals in
the dashboard, **blocks until the human submits or dismisses**, and returns their selections.

- `title` - name the session the retro is about.
- `plan` - the **full proposed text of every memory**, exactly as it would be committed,
  each under its own heading, each with the evidence from the transcript that justifies it.
  The human is approving words that will land in their repository; showing a summary and
  committing something else is a breach of that.
- `decisions` - **one decision per proposed memory**, never one decision listing all three.
  Each with `options` of `{ id: "add", label: "Commit this memory" }` and
  `{ id: "skip", label: "Skip it" }`, and `allowOther: true` so the human can rewrite the
  wording instead of choosing between yes and no. For a deletion or a promotion, label the
  options for what they actually do.

Then obey what comes back, literally:

- Selected `add` with no free text: commit exactly the text you showed.
- Selected `add` with free text: the free text wins. Commit their wording, not yours.
- Selected `skip`: write nothing for that memory, and do not raise it again in this retro.
- **Dismissed:** write nothing at all, commit nothing, and stop. A dismissal is not a
  deferral, and it is never an approval of the ones they did not get to.

If the tool is not available at all - the Mission Control MCP server is not connected - ask the
same questions in the conversation, showing each memory in full, and wait for a real answer. The
approval is the ceremony; losing the form is not permission to skip it.

## 4. Write the approved memories

One file per memory, at `.agents/memory/<slug>.md`, with front matter:

```markdown
---
category: tooling-trap
date: <today, as YYYY-MM-DD>
source-session: <session id, or "unknown" when the retro could not resolve one>
times-confirmed: 1
---

# The Bash grep wrapper lies about protocol.ts

One paragraph on what happens, then what to do instead. Concrete enough to act on
without reading anything else.
```

`times-confirmed` starts at `1`. When a retro confirms an existing memory rather than adding
one, increment that number and change nothing else - that count is what later tells a retro
the memory has hardened enough to promote into `AGENTS.md`.

Then add or update the index line in `.agents/memory/MEMORY.md`:

```markdown
# Memory index

- [grep-wrapper-lies](grep-wrapper-lies.md) - the Bash grep wrapper silently returns zero
  matches on `src/shared/protocol.ts`; reproduce negatives with `command grep` or `-a`.
```

Before committing, **validate that the index matches the directory**: every `.md` file
beside `MEMORY.md` has exactly one index line, and every index line points at a file that
exists. An index that has drifted from its directory is worse than no index, because a
session that reads it believes it has seen everything.

## 5. Bootstrap the reference line, once

A repository learns to load its own memory through one line in its root doc. The first retro
in a repository writes that line; every later retro finds it and leaves it alone.

1. Find the **real** root doc. `AGENTS.md` if it exists, else `CLAUDE.md`. Resolve symlinks
   before you edit: a repo that ships `CLAUDE.md -> AGENTS.md` has one document with two
   names, and appending to both writes the line twice.
2. Look for the marker string `.agents/memory/MEMORY.md` anywhere in it. **Present means
   done** - change nothing, whatever the surrounding sentence says. The marker is what makes
   this idempotent, so do not match on the whole sentence.
3. Absent, append one line:

   ```markdown
   Read `.agents/memory/MEMORY.md` (this repository's agent memory) before starting work, and
   any entry it links that bears on your task.
   ```

4. Neither doc exists: create a minimal `AGENTS.md` containing that line and nothing else.
   Do not invent repository conventions to fill it out.

## 6. Commit it

```sh
git add .agents/memory            # plus the root doc, only if step 5 wrote the line
git commit -m "docs(memory): <what was learned>"
```

- **On the current branch.** Never cut a new one, never switch, never rebase.
- **Only the retro's own files.** A retro that sweeps unrelated working-tree changes into
  its commit has made itself unreviewable.
- **No co-author trailer**, and no change to how this repository pushes or merges.

Where it goes from there depends on how the retro reached you, and there are exactly two
ways:

- **Riding a session's own branch** (the usual case: a session action arrived in the session
  that did the work). The branch already has a review in flight, so push, and the memory is
  read in the same pull request as the work it came from. Do not open a second one.
- **Dispatched as its own task**, because the session that did the work was already gone. The
  commit is then the task's entire deliverable and there is no review for it to ride, so
  finish the task the way this repository ships any other one - which normally means opening
  a pull request for the memory commit.

Then say, in one short message, what was committed and what was skipped. The retro is over;
do not start on a memory the human declined.

## What not to do

- Do not write, commit, or "prepare" a memory before the human has answered. The approval is
  the whole ceremony.
- Do not exceed three proposals, and do not pad to three.
- Do not put a secret, a token, an absolute user path, or a machine-local fact in a
  committed file.
- Do not edit `AGENTS.md` beyond adding the one reference line when it is missing, or
  applying a promotion the human approved.
- Do not merge anything, and do not change CI. The commit is the job; the review of it is
  somebody else's.
