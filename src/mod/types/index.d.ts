// The mod's `$.state` contract (spec 7.10), named in `plugin.json` as `types`. It is a script
// file with no top-level import or export so it can ship beside the bundle as it is: the engine
// holds every `$.state` key the module names to it. The shapes are structural copies of
// `src/shared/home-dispatch.ts`; `test/home-dispatch-mod-skeleton.test.ts` fails if they drift.
// Owner after P2: P8.

declare module "claude-code" {
  /** `GET /dispatch/inbox` items carry more fields; the mod reads them where it draws. */
  interface MissionControlInboxItem {
    taskId: string;
    changedAt: number;
    state: "waiting" | "blocked" | "ready" | "running" | "queued" | "shelved" | "failed";
    [field: string]: unknown;
  }

  interface MissionControlInbox {
    items: MissionControlInboxItem[];
    needsYou: string[];
    counts: Partial<Record<MissionControlInboxItem["state"], number>>;
    slots: { used: number; ceiling: number };
    dashboardOnly: number;
  }

  interface MissionControlRegistration {
    sessionId: string;
    repoRoot: string | null;
    created: boolean;
    offerLauncher: boolean;
    counts: { running: number; waiting: number };
    daemonVersion: string;
    minModApi: number;
    dashboardUrl: string;
  }

  interface MissionControlResident {
    runId: string;
    taskId: string;
    name: string;
    [field: string]: unknown;
  }

  /** What the mod keeps per session. A reload keeps it; nothing is kept in `$.store`. */
  interface MissionControlModState {
    registration: MissionControlRegistration | null;
    draftId: string | null;
    inbox: MissionControlInbox | null;
    residents: MissionControlResident[] | null;
    paneTab: "needs-you" | "tasks" | "workflows" | "residents";
    paneView: "list" | "item" | "chat";
    selectedTaskId: string | null;
    /** The item and revision hash an `Approve rev {hash}` press has armed, or null. */
    armedApproval: { taskId: string; reviewId: string; revisionHash: string } | null;
    /** The transcript offset the chat view reads after (`since`). */
    chatSince: number;
  }

  /**
   * The engine's validator reads each key off this declaration's source, so they are spelled out
   * here and typed from `MissionControlModState`, which stays the one shape the mod's code uses.
   */
  interface PluginState {
    "mission-control": {
      registration: MissionControlModState["registration"];
      draftId: MissionControlModState["draftId"];
      inbox: MissionControlModState["inbox"];
      residents: MissionControlModState["residents"];
      paneTab: MissionControlModState["paneTab"];
      paneView: MissionControlModState["paneView"];
      selectedTaskId: MissionControlModState["selectedTaskId"];
      armedApproval: MissionControlModState["armedApproval"];
      chatSince: MissionControlModState["chatSince"];
    };
  }
}
