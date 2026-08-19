# Retro

Run the retrospective over this session and commit what it taught into the repository's memory.

## What to do

Use the invoked retro skill to run a retrospective over the work this session just finished.
The envelope above names the session id; read that session's transcript back rather than
working from recollection, because your recollection is the thing being audited.

Look for what the next session in this repository would pay for again: the corrections the
human had to type, the wrong paths a single fact would have prevented, and the review
findings that turned out to be real.

## What it produces

At most three proposed memories, each one shown to the human in full and approved,
rewritten, or rejected individually before anything is written. Proposing fewer than three
is a correct outcome; proposing a deletion of a stale memory, or the promotion of a
well-confirmed one into AGENTS.md, counts as a proposal.

The approved ones are committed as files under `.agents/memory` in the repository each is
about - the one you are standing in, unless this session worked in several - on the branch
that repository is already on. This session action is delivered only while that review can
still accept the memory commit. A retro filed as a separate task follows the task intent and
ships its own pull request instead.

## What not to do

- Do not write or commit anything the human has not approved. A dismissed request means
  nothing is committed at all.
- Do not catalogue a secret, a token, an absolute user path, a port, or anything else that
  is true of this machine rather than of this repository.
- Do not restate what AGENTS.md already says, and do not catalogue a fact about the feature
  you just built. A memory earns its place by being non-obvious and repeatedly costly.
- Do not cut a branch, merge anything, or sweep unrelated working-tree changes into the
  commit. On this same-session path, each repository's memory rides that repository's open
  pull request rather than opening a second one for it.
- Do not add an agent as a commit co-author.
