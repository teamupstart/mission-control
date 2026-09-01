import assert from "node:assert/strict";
import test from "node:test";

import type { Session } from "../src/shared/types.ts";
import {
  fileWorkspacePropsEqual,
  type FileWorkspaceProps,
} from "../src/web/components/FileWorkspace.tsx";
import type { SessionFilesController } from "../src/web/lib/sessionFiles.ts";

const controller = {} as SessionFilesController;
const session = {
  id: "session-1",
  name: "Comment review",
  state: "idle",
  activity: "waiting",
  lastActivity: 1,
} as unknown as Session;

function props(overrides: Partial<FileWorkspaceProps> = {}): FileWorkspaceProps {
  return {
    session,
    controller,
    fileCommentThreads: [],
    fileCommentReviews: [],
    fileLineRequest: null,
    ...overrides,
  };
}

test("Files ignores session activity fields that do not affect its rendered output", () => {
  const previous = props();
  const activeTurn: FileWorkspaceProps = {
    ...previous,
    session: {
      ...session,
      state: "working",
      activity: "running a command",
      lastActivity: 2,
    },
  };

  assert.equal(fileWorkspacePropsEqual(previous, activeTurn), true);
});

test("Files redraws when an input visible in the workspace changes", () => {
  const previous = props();

  assert.equal(
    fileWorkspacePropsEqual(previous, {
      ...previous,
      session: { ...session, name: "Renamed review" },
    }),
    false,
  );
  assert.equal(fileWorkspacePropsEqual(previous, { ...previous, fileCommentThreads: [] }), false);
  assert.equal(
    fileWorkspacePropsEqual(previous, { ...previous, controller: {} as SessionFilesController }),
    false,
  );
});
