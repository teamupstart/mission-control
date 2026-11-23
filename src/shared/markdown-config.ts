// The Markdown dialect Mission Control reads, said once for the dashboard and the daemon.
//
// Browser-safe: no `node:` import may reach this module. The dashboard's `Markdown` component
// starts from this list, and the daemon renders a report's Markdown document to the static page
// it publishes with the same list, so a document reads the same in the report reader and in its
// published archive. Display-only additions (code highlighting, workspace path links, diagram
// hosts, find marks, chat line breaks) stay in the component: none of them changes what the
// document says.

import remarkGfm from "remark-gfm";
import type { PluggableList } from "unified";

/** GitHub-flavoured Markdown: tables, task lists, strikethrough and autolinks. */
export const MARKDOWN_REMARK_PLUGINS: PluggableList = [remarkGfm];
