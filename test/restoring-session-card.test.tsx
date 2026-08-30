import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { RestoringSessionsColumn } from "../src/web/components/RestoringSessionsColumn.tsx";

test("restoring Board cards expose durable context without interactive session affordances", () => {
  const html = renderToStaticMarkup(
    <RestoringSessionsColumn
      groupByRepo
      sessions={[{
        id: "sdk:restoring-card",
        agent: "codex",
        name: "Keep the stable title",
        cwd: "/repo/.worktrees/one",
        repoRoot: "/repo",
        taskId: "task-one",
        taskTitle: "Keep the stable title",
        createdAt: 1,
      }]}
    />,
  );

  assert.match(html, /aria-label="Restoring Keep the stable title"/);
  assert.match(html, /data-session-id="sdk:restoring-card"/);
  assert.match(html, /codex · repo/);
  assert.doesNotMatch(html, /<button|<a\b|draggable=|tabindex=/i);
});
