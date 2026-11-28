import { taskKindForcedRuntime as forcedRuntime } from "../../src/shared/task.ts";

export * from "../../src/shared/task.ts";

// Exercise the terminal dispatch boundary independently of the SDK routing policy.
export const taskKindForcedRuntime: typeof forcedRuntime = (kind) => kind === "resident" ? null : forcedRuntime(kind);
