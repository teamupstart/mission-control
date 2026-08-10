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

The approved ones are committed on the current branch as files under `.agents/memory`, so
they are reviewed with the work they came from.

## What not to do

- Do not write or commit anything the human has not approved. A dismissed request means
  nothing is committed at all.
- Do not catalogue a secret, a token, an absolute user path, a port, or anything else that
  is true of this machine rather than of this repository.
- Do not restate what AGENTS.md already says, and do not catalogue a fact about the feature
  you just built. A memory earns its place by being non-obvious and repeatedly costly.
- Do not cut a branch, merge anything, or sweep unrelated working-tree changes into the
  commit. This branch already has a review in flight; the memory rides it rather than
  opening a second pull request.
- Do not add an agent as a commit co-author.
