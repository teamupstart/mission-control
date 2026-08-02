// GENERATED FILE - do not edit by hand.
//
// Written by `scripts/builtin-session-actions.ts` from `docs/session-actions/*.md`, which are the
// authored source. Edit the Markdown there and run `npm run session-actions`.

/** The exact bytes of each shipped SessionAction document, in filename order. */
export const BUILTIN_SESSION_ACTION_SOURCES = [
  {
    slug: "pull-request",
    promptMarkdown: "# Pull Request\n\nPrepare the reviewed work as a reviewer-ready pull request.\n\n## What to do\n\nUse the invoked pull-request skill to turn the work this workflow just reviewed into one open\npull request. Commit everything that was reviewed, push the branch, and open the pull request.\n\nDo this once. If an open pull request already exists for this branch and its head matches the\nwork you just pushed, update that pull request rather than opening a second one.\n\n## What the description has to contain\n\nWrite for a reviewer who has not been in this session and will not read the transcript.\n\n- The goal, in the user's terms, and why the change was needed.\n- The design decisions that were not obvious, and the alternatives that were rejected.\n- The tradeoffs the change accepts, stated plainly rather than defended.\n- Concrete proof the work works: the commands that were run and what they reported, the tests\n  that were added and what they would catch, and the behaviour that was observed rather than\n  assumed.\n- For a UI change, attach or link screenshots of the working feature so the reviewer can see\n  the result without reconstructing it locally.\n\nA list of changed files is not a description. Neither is a restatement of the diff.\n\n## What not to do\n\n- Do not open a pull request from work that does not build, does not pass its tests, or was\n  never run.\n- Do not claim evidence that was not produced. \"Should work\" is not proof.\n- Do not merge, and do not ask for the pull request to be merged. Opening it is the whole job;\n  the workflow's final gate reviews it afterwards.\n- Do not add an agent as a commit co-author.\n",
  },
] as const;
