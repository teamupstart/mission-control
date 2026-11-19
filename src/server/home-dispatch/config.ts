import { HOME_DISPATCH_ROUTES } from "@shared/home-dispatch.ts";
import type { HomeDispatchConfigView } from "@shared/home-dispatch.ts";
import { notImplemented, type HomeDispatchResult } from "./stub.ts";

export async function handleReadConfig(_input: Record<string, never>): Promise<HomeDispatchResult<HomeDispatchConfigView>> {
  return notImplemented(HOME_DISPATCH_ROUTES.config, "WP2b");
}
