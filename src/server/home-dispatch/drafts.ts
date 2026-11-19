import { HOME_DISPATCH_ROUTES } from "@shared/home-dispatch.ts";
import type {
  DraftConfirm, DraftConfirmResult, DraftCreate, DraftSummary, DraftUpdate,
} from "@shared/home-dispatch.ts";
import { notImplemented, type HomeDispatchResult } from "./stub.ts";

export async function handleCreateDraft(_input: DraftCreate): Promise<HomeDispatchResult<DraftSummary>> {
  return notImplemented(HOME_DISPATCH_ROUTES.drafts, "WP3");
}

export async function handleUpdateDraft(_id: string, _input: DraftUpdate): Promise<HomeDispatchResult<DraftSummary>> {
  return notImplemented(HOME_DISPATCH_ROUTES.draft, "WP3");
}

export async function handleConfirmDraft(_id: string, _input: DraftConfirm): Promise<HomeDispatchResult<DraftConfirmResult>> {
  return notImplemented(HOME_DISPATCH_ROUTES.draftConfirm, "WP3");
}
