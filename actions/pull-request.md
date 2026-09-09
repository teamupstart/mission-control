# Pull Request

Prepare the reviewed work as a reviewer-ready pull request.

## What to do

Use the invoked pull-request skill to turn the work this workflow just reviewed into one open
pull request. Commit everything that was reviewed, push the branch, and open the pull request.

This is about one repository and one branch: the repository named in the packet above, or the
one you are standing in when it names none. If an open pull request already exists for that
branch and its head matches the work you just pushed, update that pull request rather than
opening a second one for it.

A task that changed several repositories gets one review, and one of these, per repository -
so a second packet naming a different repository is not a repeat of this one. Answer each in
its own repository, and leave the others to theirs.

## What the description has to contain

Write for a reviewer who has not been in this session and will not read the transcript.

The skill owns the shape, and it is two top-level sections. `## For Humans` carries the why,
a concise description of the total feature, the tradeoffs, the known gaps, the durable evidence,
and the recommended follow-up work, each under its own heading. For every UI-based change, attach
screenshots of the working feature to the pull request description or a comment for human review.
Evidence files are never committed to the repository: produce them in a gitignored location and
upload them to the pull request. GitHub CLI 2.100.0 and later support image attachments; use
`gh pr create --attach` or `gh pr edit --attach` for the pull request description, or
`gh pr comment --attach` for a comment, whenever that version floor is met. `## For Agents`
carries the design decisions and the implementation detail. Follow that contract exactly rather
than inventing a shape here.

Every claim in the evidence subsection is something that was run and reported, not something
assumed. A list of changed files is not a description. Neither is a restatement of the diff.

## What not to do

- Do not open a pull request from work that does not build, does not pass its tests, or was
  never run.
- Do not claim evidence that was not produced. "Should work" is not proof.
- Do not merge, and do not ask for the pull request to be merged. Opening it is the whole job;
  this run's final gate reviews it afterwards.
- Do not fold another repository's changes into this pull request, and do not skip a repository
  because this one is open. Each is reviewed, gated and merged on its own.
- Do not add an agent as a commit co-author.
