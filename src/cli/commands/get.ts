import { stubCommand } from "./stub.ts";

// Owner: P10. Replace this stub with the real command and keep the `command` export.
export const command = stubCommand("get", "P10", "List tasks, kinds and workflows", "mctl get (tasks|ls|kinds|workflows) [--all] [--repo path] [--state s] [--json]");
