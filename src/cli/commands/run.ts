import { stubCommand } from "./stub.ts";

// Owner: P13. Replace this stub with the real command and keep the `command` export.
export const command = stubCommand("run", "P13", "Create and start a task", "mctl run (<prompt> | -f <file>) [--kind k] [--after-work w] [--agent a] [--model m] [--effort e] [--repo path] [--depends-on id]... [--priority p] [--label l]... [--shelve] [--dry-run] [--watch] [--json]");
