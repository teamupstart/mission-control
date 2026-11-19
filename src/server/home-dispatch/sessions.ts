import { HOME_DISPATCH_ROUTES } from "@shared/home-dispatch.ts";
import type { HomeSessionRegistration, HomeSessionRegistrationResult } from "@shared/home-dispatch.ts";
import { notImplemented, type HomeDispatchResult } from "./stub.ts";

export async function handleRegisterSession(_input: HomeSessionRegistration): Promise<HomeDispatchResult<HomeSessionRegistrationResult>> {
  return notImplemented(HOME_DISPATCH_ROUTES.sessions, "WP2a");
}
