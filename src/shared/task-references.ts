// How an agent names a Mission Control task when it is talking to a person.
//
// A task id is a tool argument and nothing else. The dashboard never prints one: a card, a
// drawer, a dependency chip and a review item all show the task's title. So an id in a
// sentence the operator reads is a dead reference - they cannot search for it, click it, or
// tell two of them apart. The title is the handle they actually have.
//
// ONE sentence, read by every surface that hands an agent task ids - the bundled MCP server's
// instructions and the descriptions of the task tools whose results carry them - so the rule
// cannot be worded one way for one harness and another way for the next.
//
// The rule is guidance, and an agent can still ignore it. So the prose the dashboard prints
// verbatim is also rewritten on the way to the screen with `withTaskTitles`: everything an
// agent writes - conversation turns, its status line, its blocker, its questions - and
// Foreman's plan reasons and note, as the daemon serves them to the dashboard
// (`src/server/task-titles.ts`). What is stored keeps the words as they were written.

/** The rule, as an agent reads it. */
export const TASK_REFERENCE_RULE =
  "When you mention a Mission Control task to the human, name it by its title, never by its id. " +
  "Task ids are only for tool calls: the dashboard never shows them, so a person cannot find or act on one.";

/**
 * Before and after a task id: no letter or digit, because one touching the UUID makes it part
 * of a longer token that is not a UUID at all.
 *
 * Nothing else is a bound, deliberately. A task id is a random 128-bit value, so wherever a
 * saved task's id appears in an agent's words it names that task - `task-<id>`, `task_<id>`,
 * `/tasks/<id>`, `<id>-retry` alike - and a person can follow none of them. Listing the forms
 * that count would leave every form nobody listed showing an id. Mission Control never builds a
 * branch name from a full task id (a task branch is `harness/<slug>-<short id>`), so the one
 * real name made from one is the checkout path below.
 */
const BEFORE = String.raw`(?<![0-9a-z])`;
const AFTER = String.raw`(?![0-9a-z])`;

/**
 * Where a task id is part of a real path rather than a reference to the task: a task's checkout
 * lives at `<state>/worktrees/<task id>`, or `<task id>-<slot>` for a further repository. An
 * agent prints that path to say where a file is, the conversation links it to the file, and
 * rewriting it would leave a path that opens nothing.
 */
const CHECKOUT_PATH = String.raw`(?<!worktrees\/)`;

/**
 * A task id's shape. Every creator mints one with `randomUUID`, which is lowercase, but a UUID
 * is the same UUID in either case and an agent may well write it in capitals, so the shape is
 * matched without regard to case.
 */
// Bounded like `withTaskTitles`, so a token it would never replace is never looked up either.
const TASK_ID_SHAPE = new RegExp(
  String.raw`${BEFORE}${CHECKOUT_PATH}[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}${AFTER}`,
  "gi",
);

/**
 * The distinct task-shaped ids in `text`, lowercased - the form a task id is stored in - in
 * first-seen order.
 *
 * A candidate is only that: agent session ids and request ids share the shape, so a caller
 * resolves candidates against real tasks and leaves every unresolved one exactly as written.
 */
export function taskIdCandidates(text: string): string[] {
  return [...new Set((text.match(TASK_ID_SHAPE) ?? []).map((id) => id.toLowerCase()))];
}

/**
 * Replace every known task id in `text` with that task's quoted title.
 *
 * The backstop for model-written prose that the dashboard renders verbatim, where the prompt
 * already carries `TASK_REFERENCE_RULE` and a reply ignored it anyway. Every occurrence of a
 * known id is replaced, whatever punctuation surrounds it, except one touching a letter or digit
 * (`BEFORE`, `AFTER`) or forming a checkout path (`CHECKOUT_PATH`). An id matches in any case,
 * since an agent that capitalises one still means the task.
 */
export function withTaskTitles(text: string, titles: ReadonlyMap<string, string>): string {
  const lowered = text.toLowerCase();
  const byId = new Map([...titles].map(([id, title]) => [id.toLowerCase(), title]));
  const ids = [...byId.keys()].filter((id) => id.length > 0 && lowered.includes(id));
  if (ids.length === 0) return text;
  // A quote or backtick already wrapping the id is consumed with it, so `"id"` reads as one
  // quoted title rather than a title inside two pairs of quotes.
  const pattern = new RegExp(
    `${BEFORE}${CHECKOUT_PATH}(["'\`]?)(${ids.map(escapeRegExp).join("|")})\\1${AFTER}`,
    "gi",
  );
  return text.replace(pattern, (match, _quote: string, id: string) => {
    const title = byId.get(id.toLowerCase());
    return title === undefined ? match : `"${title}"`;
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
