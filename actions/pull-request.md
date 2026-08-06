# Pull Request

Prepare the reviewed work as a reviewer-ready pull request.

## What to do

Use the invoked pull-request skill to turn the work this workflow just reviewed into one open
pull request. Commit everything that was reviewed, push the branch, and open the pull request.

Do this once. If an open pull request already exists for this branch and its head matches the
work you just pushed, update that pull request rather than opening a second one.

## What the description has to contain

Write for a reviewer who has not been in this session and will not read the transcript.

The skill owns the shape, and it is two top-level sections. `## For Humans` carries the why,
a concise description of the total feature, the tradeoffs, the known gaps, the evidence -
including screenshots of a UI change - and the recommended follow-up work, each under its own
heading. `## For Agents` carries the design decisions and the implementation detail. Follow
that contract exactly rather than inventing a shape here.

Every claim in the evidence subsection is something that was run and reported, not something
assumed. A list of changed files is not a description. Neither is a restatement of the diff.

## What not to do

- Do not open a pull request from work that does not build, does not pass its tests, or was
  never run.
- Do not claim evidence that was not produced. "Should work" is not proof.
- Do not merge, and do not ask for the pull request to be merged. Opening it is the whole job;
  the workflow's final gate reviews it afterwards.
- Do not add an agent as a commit co-author.
