import type { Registry } from "../registry.ts";
import type { TaskManager } from "../tasks.ts";
import type { WorkflowManager } from "../workflows/manager.ts";
import type { InboxResponse } from "@shared/home-dispatch.ts";
import type { HomeDispatchResult } from "./stub.ts";

/**
 * What the dispatch handlers need from the daemon beyond the request. `routes.ts` hands them
 * over once; a test passes fakes. Both are optional so a handler that needs neither (the
 * stubs still waiting on their work package) keeps its one-argument signature.
 */
export interface HomeDispatchDeps {
  tasks?: TaskManager;
  workflows?: WorkflowManager | null;
  registry?: Registry;
  /** Where a check-in reads the repository's tasks from. Defaults to the inbox handler. */
  readInbox?: (input: { repo: string }) => Promise<HomeDispatchResult<InboxResponse>>;
}
