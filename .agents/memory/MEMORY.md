# Memory index

- [topbar-page-segment-guards](topbar-page-segment-guards.md) - adding a page segment to the
  title bar breaks four guards in four layers, and the `library.spec.ts` segment-count
  assertion fails only on CI.
- [review-evidence-needs-the-pr](review-evidence-needs-the-pr.md) - a review round cannot see
  output pasted into a reply, so evidence has to reach the pull request; imagery is not an
  exception, and a binary attaches through the signed-in browser rather than being committed.
- [merged-pr-cannot-take-repairs](merged-pr-cannot-take-repairs.md) - merging before the
  no-mistakes run finishes makes every later repair round impossible to answer; let the rounds
  finish, then merge.
- [merge-watcher-reads-the-session-branch](merge-watcher-reads-the-session-branch.md) - a
  recovery session on a differently-named branch is invisible to the merge watcher, so its
  dependents stay blocked; repair with the complete route and `satisfyDependents`.
- [private-pr-images-need-attachments](private-pr-images-need-attachments.md) - a SHA-pinned
  `raw.githubusercontent.com` image can still 404 in a private PR comment; attach it through
  GitHub's signed-in comment UI and verify it in an authorized context.
