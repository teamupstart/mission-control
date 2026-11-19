import { HOME_DISPATCH_ROUTES } from "@shared/home-dispatch.ts";
import type { InboxResponse } from "@shared/home-dispatch.ts";
import { notImplemented, type HomeDispatchResult } from "./stub.ts";

export async function handleReadInbox(_input: { repo: string }): Promise<HomeDispatchResult<InboxResponse>> {
  return notImplemented(HOME_DISPATCH_ROUTES.inbox, "WP2b");
}
