import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionCard } from "../src/web/components/SessionCard.tsx";
import { ConsoleDetail } from "../src/web/components/layouts/ConsoleDetail.tsx";
import { TaskRepoPrs } from "../src/web/components/session-bits.tsx";
import { mkSession, mkTaskSummary } from "./helpers/session-fixture.ts";
import { mkSessionView } from "./helpers/session-view.ts";
import { containsMarkup, tooltipLabels } from "./helpers/markup.ts";
import type { TaskRepoPrSummary } from "../src/shared/types.ts";

// What a multi-repo task's pull requests LOOK like, and - just as load-bearing - what a
// single-repo task's still looks like.
//
// The promise the dispatch modal already makes in so many words is "one session, one worktree
// per repo; each repo you change gets its own pull request". Until this, both surfaces that
// showed a task collapsed that to a single outcome link, so an operator watching a two-repo
// task saw one link and had no way to tell whether the second repository had shipped, was
// waiting, or had been skipped.
//
// The other half is a non-change. `repoPrs` is empty for every single-repo task by
// construction, the component renders nothing at all for an empty list, and the assertions
// below compare a single-repo card against one built before any of this existed.

const REPO_PRS: TaskRepoPrSummary[] = [
  {
    repoRoot: "/Users/dev/work/api",
    primary: true,
    prUrl: "https://github.com/example/api/pull/10",
    prState: "merged",
    mergedAt: 5_000,
  },
  {
    repoRoot: "/Users/dev/work/web",
    primary: false,
    prUrl: "https://github.com/example/web/pull/20",
    prState: "open",
    mergedAt: null,
  },
  {
    repoRoot: "/Users/dev/work/docs",
    primary: false,
    prUrl: null,
    prState: null,
    mergedAt: null,
  },
];

function card(repoPrs: TaskRepoPrSummary[]): string {
  return renderToStaticMarkup(
    createElement(SessionCard, {
      session: mkSession({ task: mkTaskSummary({ repoPrs }) }),
      onOpenReviews: () => {},
    }),
  );
}

function detail(repoPrs: TaskRepoPrSummary[]): string {
  const session = mkSession({ task: mkTaskSummary({ repoPrs }) });
  return renderToStaticMarkup(
    createElement(ConsoleDetail, { session, view: mkSessionView(session) }),
  );
}

test("a multi-repo task's card names every repo and the pull request it has", () => {
  const html = card(REPO_PRS);

  // The repo, by leaf name, beside its pull request number - so a row of these reads as
  // "which repo, which pull request" rather than as interchangeable numbers.
  assert.match(html, /class="task-repo-name">api</);
  assert.match(html, /class="task-repo-name">web</);
  assert.match(html, /class="task-repo-name">docs</);
  assert.match(html, /href="https:\/\/github\.com\/example\/api\/pull\/10"/);
  assert.match(html, /href="https:\/\/github\.com\/example\/web\/pull\/20"/);
  // Merged and open are visually distinct, on the same tone vocabulary the session chip uses.
  assert.match(html, /class="task-repo-pr pr-merged"/);
  assert.match(html, /class="task-repo-pr pr-open"/);

  // The repo still missing a pull request is SHOWN, not omitted. It is the one thing an
  // operator can act on, and it is exactly what the completion quorum is waiting for.
  assert.match(html, /class="task-repo-pr task-repo-pr-none"/);
  assert.match(html, />no PR</);
});

test("each repo line says which repo it is and what its pull request is doing", () => {
  const labels = tooltipLabels(card(REPO_PRS));
  // The full path, because two attached repos can share a leaf name and the chip is short.
  assert.ok(
    labels.includes("/Users/dev/work/api (primary repo) - pull request #10 merged - open on GitHub"),
  );
  assert.ok(
    labels.includes("/Users/dev/work/web (attached repo) - pull request #20 open - open on GitHub"),
  );
  assert.ok(
    labels.includes("/Users/dev/work/docs (attached repo) - no pull request opened here yet"),
  );
});

test("the console detail draws the same shared leaf the card does", () => {
  // The parity rule this repo keeps: the card is rendered by one layout and the detail by
  // two, so a private copy in either silently misses a surface.
  const leaf = renderToStaticMarkup(createElement(TaskRepoPrs, { repoPrs: REPO_PRS }));
  assert.ok(containsMarkup(card(REPO_PRS), leaf), "the card renders the shared leaf");
  assert.ok(containsMarkup(detail(REPO_PRS), leaf), "and so does the console detail");
});

test("a single-repo task's markup is exactly what it was", () => {
  // Not "looks similar" - identical. Every surface gates on a list that is empty for a
  // single-repo task, so nothing about the tasks that are nearly all of them may move.
  const before = renderToStaticMarkup(
    createElement(SessionCard, {
      session: mkSession({ task: mkTaskSummary() }),
      onOpenReviews: () => {},
    }),
  );
  assert.equal(card([]), before);
  assert.equal(card([]).includes("task-repo-pr"), false);
  assert.equal(detail([]).includes("task-repo-pr"), false);
  assert.equal(renderToStaticMarkup(createElement(TaskRepoPrs, { repoPrs: [] })), "");
});
