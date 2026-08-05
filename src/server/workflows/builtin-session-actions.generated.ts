// GENERATED FILE - do not edit by hand.
//
// Written by `scripts/builtin-session-actions.ts` from `docs/session-actions/*.md`, which are the
// authored source. Edit the Markdown there and run `npm run session-actions`.

/** The exact bytes of each shipped SessionAction document, in filename order. */
export const BUILTIN_SESSION_ACTION_SOURCES = [
  {
    slug: "pull-request",
    promptMarkdown: "# Pull Request\n\nPrepare the reviewed work as a reviewer-ready pull request.\n\n## What to do\n\nUse the invoked pull-request skill to turn the work this workflow just reviewed into one open\npull request. Commit everything that was reviewed, push the branch, and open the pull request.\n\nDo this once. If an open pull request already exists for this branch and its head matches the\nwork you just pushed, update that pull request rather than opening a second one.\n\n## What the description has to contain\n\nWrite for a reviewer who has not been in this session and will not read the transcript.\n\nThe skill owns the shape, and it is two top-level sections. `## For Humans` carries the why,\na concise description of the total feature, the tradeoffs, the known gaps, the evidence -\nincluding screenshots of a UI change - and the recommended follow-up work, each under its own\nheading. `## For Agents` carries the design decisions and the implementation detail. Follow\nthat contract exactly rather than inventing a shape here.\n\nEvery claim in the evidence subsection is something that was run and reported, not something\nassumed. A list of changed files is not a description. Neither is a restatement of the diff.\n\n## What not to do\n\n- Do not open a pull request from work that does not build, does not pass its tests, or was\n  never run.\n- Do not claim evidence that was not produced. \"Should work\" is not proof.\n- Do not merge, and do not ask for the pull request to be merged. Opening it is the whole job;\n  the workflow's final gate reviews it afterwards.\n- Do not add an agent as a commit co-author.\n",
  },
] as const;
