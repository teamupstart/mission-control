import { HOME_DISPATCH_ROUTES } from "@shared/home-dispatch.ts";
import type { JumpRequest } from "@shared/home-dispatch.ts";
import { notImplemented, type HomeDispatchResult } from "./stub.ts";

export async function handleJump(_input: JumpRequest): Promise<HomeDispatchResult<{ ok: true }>> {
  return notImplemented(HOME_DISPATCH_ROUTES.jump, "WP10");
}
