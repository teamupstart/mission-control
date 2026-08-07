import type { Session } from "../../src/shared/types.ts";
import type { SessionFilesController } from "../../src/web/lib/sessionFiles.ts";
import type { SessionViewProps } from "../../src/web/components/layouts/types.ts";

/**
 * The bundle App hands every layout, filled in for one session.
 *
 * Here rather than in each test for the reason `mkSession` is: `SessionViewProps` is the shared
 * wiring three layouts read, so it grows, and a literal per test file is a literal per test file
 * to update. Every field is overridable, so a test that cares about one of them says so.
 *
 * `files` is cast rather than faked: a detail rendered by `renderToStaticMarkup` draws no
 * transcript, and `cardProps` passes the controller by reference without dereferencing it. A
 * test that needs a real one passes it.
 */
export function mkSessionView(
  session: Session,
  over: Partial<SessionViewProps> = {},
): SessionViewProps {
  return {
    sessions: [session],
    tasks: [],
    backlog: [],
    onEditTask: () => {},
    backlogPlan: null,
    selectedId: session.id,
    consoleZone: "rail",
    onConsoleZoneChange: () => {},
    onSelect: () => {},
    onDeselect: () => {},
    expandedId: session.id,
    onToggleExpand: () => {},
    onOpenReviews: () => {},
    onOpenDiff: () => {},
    onOpenFiles: () => {},
    onOpenFile: () => false,
    onOpenFilePath: () => {},
    fileTabRequest: null,
    conversationTabRequest: null,
    workflowsTabRequest: null,
    diffTabRequest: null,
    files: {} as SessionFilesController,
    onReset: () => {},
    onComplete: () => {},
    onKill: () => {},
    onKilled: () => {},
    resetNonces: {},
    registerEl: () => {},
    registerActions: () => {},
    registerLaunchers: () => {},
    registerFind: () => {},
    registerDetailScroll: () => {},
    registerReaderTab: () => {},
    renamingId: null,
    onRenameStart: () => {},
    onRenameClose: () => {},
    foremanMode: "dry-run",
    foremanEnabled: false,
    foremanAllowlist: [],
    inputReviewBySession: new Map<string, string>(),
    pendingReviewIds: new Set<string>(),
    reviews: [],
    ...over,
  };
}
