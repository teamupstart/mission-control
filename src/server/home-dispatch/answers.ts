import { HOME_DISPATCH_ROUTES } from "@shared/home-dispatch.ts";
import type { AnswerRequest, Receipt } from "@shared/home-dispatch.ts";
import { notImplemented, type HomeDispatchResult } from "./stub.ts";

export async function handleAnswer(_input: AnswerRequest): Promise<HomeDispatchResult<Receipt>> {
  return notImplemented(HOME_DISPATCH_ROUTES.answers, "WP2b");
}
