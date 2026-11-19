import { HOME_DISPATCH_ROUTES } from "@shared/home-dispatch.ts";
import type { DispatchOptionsRequest, DispatchOptionsResponse } from "@shared/home-dispatch.ts";
import { notImplemented, type HomeDispatchResult } from "./stub.ts";

export async function handleDispatchOptions(_input: DispatchOptionsRequest): Promise<HomeDispatchResult<DispatchOptionsResponse>> {
  return notImplemented(HOME_DISPATCH_ROUTES.dispatchOptions, "WP3");
}
