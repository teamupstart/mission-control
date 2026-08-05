import type { DriverRename } from "../actions.ts";
import { setSdkSessionDisplayName } from "./store.ts";

/**
 * Renaming an embedded session - the driver arm of `POST /api/sessions/:id/rename`.
 *
 * The terminal arm of that route moves a name by driving a backend: it renames the multiplexer
 * session (or retitles the emulator tab), and the next discovery sweep reads the new name back
 * onto the card. There is no equivalent here and no need for one. An embedded session's name is
 * a column on the row the supervisor already keeps so a restart can resume the conversation, so
 * moving it is one UPDATE and the registry's optimistic echo is what the operator sees.
 *
 * Notably this does NOT reach the driver, which is why it needs no supervisor and no live
 * handle. A display name is what the OPERATOR calls the conversation, not something the agent
 * is told - so unlike a context clear or a permission-mode change, it lands the same whether
 * the session is mid-turn, suspended, or not yet bound. Making it a live-handle operation would
 * have meant refusing to rename exactly the sessions a person most wants to label: the ones
 * that are busy.
 *
 * One adapter at the boundary, in the same shape and for the same reason as `driverClearFor`:
 * `actions.ts` is the pane layer and must not import the SDK store, and both callers of
 * `rename` - the route and `TaskManager`'s assign auto-titler - need this identical lambda. A
 * second copy is how one of them ends up passing `agentSessionId` where the other passes `id`
 * and an embedded rename silently writes nothing.
 */
export const renameDriverSession: DriverRename = (session, name) =>
  Promise.resolve(setSdkSessionDisplayName(session.id, name));
