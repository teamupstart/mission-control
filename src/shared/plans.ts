/**
 * Where a plan task's artifacts live in the checkout that produced them.
 *
 * Beside `scouts.ts`, for the reason that module states: `archives.ts` owns the BUNDLE -
 * identity, paths, digests, the manifest - and says nothing about what is inside one,
 * because a bundle's kind is the only thing that differs between one kind of archive and
 * another. Each captured kind brings its own module beside that one for the single thing
 * that is genuinely its own shape. For a scout that is the submission call and the path it
 * writes to; for a plan it is only the path, because a plan submits nothing.
 *
 * `docs/plans/<name>/` - a directory rather than a file, because a plan is a markdown
 * source, the page it renders to, and (once it has been phased) one document per phase
 * beside them, all linked relatively. `<name>` is chosen by whoever writes the plan rather
 * than derived from the task, which is why nothing here resolves a concrete path: this
 * states the SHAPE. What a given task actually wrote is a question for that task's diff.
 *
 * Three documents state this convention and have to agree: `skills/html-plans/SKILL.md`,
 * which is how a plan gets written; the daemon's plan appendix (`server/plans/prompt.ts`),
 * which is what a plan task is told; and this, which is what code reads. Keeping the three
 * in step is what `test/plan-prompt.test.ts` exists for.
 *
 * Browser-safe (no `node:` imports), like everything else in this directory.
 */

/** The checkout-relative root every plan directory sits directly under. */
export const PLAN_ROOT = "docs/plans";
/** The plan's source of truth. The page is a rendering of it, never a fork. */
export const PLAN_SOURCE_FILENAME = "plan.md";
/** The rendered page a human actually reviews. */
export const PLAN_PAGE_FILENAME = "plan.html";

/** The shape a plan's markdown is written at, as a contract quotes it back. */
export const PLAN_SOURCE_PATH_SHAPE = `${PLAN_ROOT}/<name>/${PLAN_SOURCE_FILENAME}`;
/** The shape its rendered page is written at, beside the source above. */
export const PLAN_PAGE_PATH_SHAPE = `${PLAN_ROOT}/<name>/${PLAN_PAGE_FILENAME}`;
