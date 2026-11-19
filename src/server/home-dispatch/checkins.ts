import { HOME_DISPATCH_ROUTES } from "@shared/home-dispatch.ts";
import type { CheckinResponse, HomeCaller } from "@shared/home-dispatch.ts";
import { notImplemented, type HomeDispatchResult } from "./stub.ts";

export async function handleCheckin(_input: HomeCaller): Promise<HomeDispatchResult<CheckinResponse>> {
  return notImplemented(HOME_DISPATCH_ROUTES.checkins, "WP3");
}
