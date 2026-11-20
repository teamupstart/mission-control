import { notImplemented, type HomeDispatchHandler } from "./stub.ts";

// Owner: P4. `GET /dispatch/inbox` (spec 7.7), read only.
export const inboxHandler: HomeDispatchHandler = () => notImplemented();
