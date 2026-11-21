import { notImplemented, type HomeDispatchHandler } from "./stub.ts";

// Owner: P9. Chat and follow (spec 7.23). Only this file may import `sendText` from
// `src/server/actions.ts`; nothing under `src/server/home-dispatch/` imports `focus`,
// `raiseThrough` or `src/server/terminal/` (see test/home-dispatch-guards.test.ts).
export const transcriptHandler: HomeDispatchHandler = () => notImplemented();
export const transcriptStreamHandler: HomeDispatchHandler = () => notImplemented();
export const sendHandler: HomeDispatchHandler = () => notImplemented();
