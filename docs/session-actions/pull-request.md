# Pull Request

Prepare the reviewed work as a reviewer-ready pull request.

## What to do

Use the invoked pull-request skill to turn the work this workflow just reviewed into one open
pull request. Commit everything that was reviewed, push the branch, and open the pull request.

Do this once. If an open pull request already exists for this branch and its head matches the
work you just pushed, update that pull request rather than opening a second one.

## What the description has to contain

Write for a reviewer who has not been in this session and will not read the transcript.

- The goal, in the user's terms, and why the change was needed.
- The design decisions that were not obvious, and the alternatives that were rejected.
- The tradeoffs the change accepts, stated plainly rather than defended.
- Concrete proof the work works: the commands that were run and what they reported, the tests
  that were added and what they would catch, and the behaviour that was observed rather than
  assumed.

A list of changed files is not a description. Neither is a restatement of the diff.

## What not to do

- Do not open a pull request from work that does not build, does not pass its tests, or was
  never run.
- Do not claim evidence that was not produced. "Should work" is not proof.
- Do not merge, and do not ask for the pull request to be merged. Opening it is the whole job;
  the workflow's final gate reviews it afterwards.
- Do not add an agent as a commit co-author.
