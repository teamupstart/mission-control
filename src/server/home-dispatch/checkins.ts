import type { CheckinResponse, HomeCaller, InboxItem } from "@shared/home-dispatch.ts";
import { resolveRepoRoot } from "../repos.ts";
import type { HomeDispatchDeps } from "./deps.ts";
import { handleReadInbox } from "./inbox.ts";
import type { HomeDispatchResult } from "./stub.ts";

/** When each session last checked in. In memory only, as the spec keeps it (7.7). */
const lastCheckin = new Map<string, number>();
let clock: () => number = Date.now;

/** Tests only: forget every check-in time and (optionally) replace the clock. */
export function resetCheckinsForTest(now?: () => number): void {
  lastCheckin.clear();
  clock = now ?? Date.now;
}

/**
 * Sort one repository's inbox into the check-in lists (spec 7.7): what waits on the person,
 * what runs, and what finished (ready or failed) since `since`, or all of it on a first
 * check-in. Queued and shelved are counts only. Newest first within each list.
 */
export function buildCheckin(items: readonly InboxItem[], since: number | null): CheckinResponse {
  const newestFirst = (a: InboxItem, b: InboxItem): number => b.changedAt - a.changedAt;
  const pick = (state: InboxItem["state"]): InboxItem[] => items.filter((item) => item.state === state);
  const finished = items
    .filter((item) => (item.state === "ready" || item.state === "failed") && (since === null || item.changedAt > since))
    .sort(newestFirst);
  return {
    waiting: pick("waiting").sort(newestFirst),
    running: pick("running").sort(newestFirst),
    finished,
    queued: pick("queued").length,
    shelved: pick("shelved").length,
  };
}

/** `POST /mcp/dispatch/checkins`. Records this session's check-in time in memory. */
export async function handleCheckin(
  input: HomeCaller,
  deps: HomeDispatchDeps = {},
): Promise<HomeDispatchResult<CheckinResponse>> {
  const repo = (await resolveRepoRoot(input.cwd)) ?? input.cwd;
  const inbox = await (deps.readInbox ?? handleReadInbox)({ repo });
  if (inbox.status !== 200) return inbox as HomeDispatchResult<never>;
  const items = (inbox.body as { items: InboxItem[] }).items;
  const body = buildCheckin(items, lastCheckin.get(input.sessionId) ?? null);
  lastCheckin.set(input.sessionId, clock());
  return { status: 200, body };
}
