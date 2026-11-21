// Fake dispatch-options reply (P5): the real pages, built by the same shared function the
// daemon uses, so a mod test sees what a real daemon would offer for its request instead of one
// canned page. It knows only the built-in Workflows, and a request names no repository, so the
// Repo page is built only when the request's `cwd` is the fake "not a repository" path.
import { buildDispatchQuestions } from "../../src/shared/dispatch-options.ts";
import { HomeDispatchOptionsRequestSchema } from "../../src/shared/home-dispatch.ts";
import {
  BUG_FIX_REVIEW_WORKFLOW_ID,
  DOCUMENTATION_REVIEW_WORKFLOW_ID,
  NO_MISTAKES_REVIEW_WORKFLOW_ID,
  PLAN_VALIDATION_WORKFLOW_ID,
} from "../../src/shared/builtin-workflow.ts";
import type { FakeRouteOverrides } from "./home-dispatch-fakes.ts";

/** A `cwd` the fake treats as outside any repository. */
export const FAKE_NO_REPO_CWD = "/fake/not-a-repo";

const BUILTIN_WORKFLOWS = [
  { id: NO_MISTAKES_REVIEW_WORKFLOW_ID, name: "No Mistakes Review" },
  { id: BUG_FIX_REVIEW_WORKFLOW_ID, name: "Bug Fix Review" },
  { id: PLAN_VALIDATION_WORKFLOW_ID, name: "Plan Validation" },
  { id: DOCUMENTATION_REVIEW_WORKFLOW_ID, name: "Documentation Review" },
];

export const routes: FakeRouteOverrides = {
  "POST /dispatch/dispatch-options": (request) => {
    const body = HomeDispatchOptionsRequestSchema.parse(request.body);
    return {
      body: {
        questions: buildDispatchQuestions({
          entry: body.entry,
          kind: body.kind,
          brief: body.brief,
          inRepository: body.cwd !== FAKE_NO_REPO_CWD,
          workspaceRepos: ["/fake/repo", "/fake/other"],
          workflows: BUILTIN_WORKFLOWS,
          configured: {},
          planStorage: "repository",
        }),
      },
    };
  },
};
