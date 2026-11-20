import { notImplemented, type HomeDispatchHandler } from "./stub.ts";

// Owner: P4. `POST /dispatch/answers` (spec 7.8): answer, approve_plan, request_changes,
// approve_review, reject_review and chat_first.
export const answersHandler: HomeDispatchHandler = () => notImplemented();
