# Session settings coverage inventory

This is the phase 1 baseline for [Session access to Mission Control settings](plans/session-settings-mcp/plan.md).
The first table uses control IDs from `ALL_SETTINGS_CONTROLS`, including build-hidden categories. Generated
families use their existing registry as the row source. The second table covers additional controls and leaves
without individual search entries. An owner may back several anchors, and an anchor may cover several leaves.

Phase 2 owns ordinary typed preferences. Phase 3 owns specialized intents and reviews the remaining
protected, operational and status dispositions. Pending rows confer no tool access. Backup classification
describes snapshot behavior independently of session access.

## Indexed controls

| Search control ID | Phase | Disposition | Owner and leaves |
| --- | --- | --- | --- |
| `layout` | 2 | Pending | UI config `layout` |
| `line-density` | 2 | Pending | UI config `lineDensity` and `lineHidden`, including the Disabled option |
| `board-grouping` | 2 | Pending | UI config `groupBoardByRepo` |
| `board-sidebar` | 2 | Pending | UI config `boardSidebarAllSessions` under the layout anchor |
| `resident-placement` | 2 | Pending | UI config `residentPlacement` |
| `blocked-placement` | 2 | Pending | UI config `blockedPlacement` |
| `conversation-view` | 2 | Pending | UI config `conversationView` |
| `skin` | 1 | Read/write | UI config `ui.skin`, shipped skin IDs |
| `format-messages` | 2 | Pending | UI config `richText` |
| `board-card` | 2 | Pending | UI config `hiddenDisplayItems` per `DISPLAY_ITEMS` entry, plus `taskKindCard` and `backgroundAgentsStyle`. The seed marker is derived. |
| `pause-controls` | 2 | Pending | UI config `pauseCardControls` and `pauseConsoleControls` per shown action. Pause itself is operational. |
| `topbar` | 2 | Pending | UI config `hiddenTopbarItems` and `compactTopbarItems` per configurable item |
| `conversation-header` | 2 | Pending | UI config `hiddenDisplayItems` conversation group and `taskKindHeader` |
| `working-indicator` | 2 | Pending | UI config `hiddenDisplayItems` working-harness conversation and card marks |
| `guided-dispatch` | 2 | Pending | UI config `guidedDispatch` |
| `keyboard-*` | 2 | Pending | One UI config `keybindings` chord per `ACTIONS` entry. Reset one chord uses the same owner. |
| `setup-checks` | 3 | Status and actions | Setup gathers executable and integration readiness. Recheck, install, repair and onboarding change machine state on operator intent. |
| `multiplexer-terminal` | 2 | Pending | Terminals config `multiplexerTerminal`, platform-specific choices |
| `external-sessions` | 2 | Pending | Terminals config `externalSessions` |
| `auto-mode` | 3 | Protected | Harness config `autoModeOnDispatch` changes the default approval mode |
| `harness-*` | 2 | Pending | One per `AGENT_TYPES`. Harness config `defaultModel`, `defaultEffort`, `sessionRuntime`, `terminalBackend` per agent. Provider/model availability and setup link are read-only. |
| `feature-flags-enable-all` | 3 | Protected | Feature flag master and clear-disabled-overrides intents can re-enable protected features |
| `feature-flag-session-settings-mcp` | 1 | Protected | Feature flag owner `session-settings-mcp` controls rollout. Manage in Settings > Feature flags. |
| `feature-flag-*` | 3 | Pending | Other per-flag intents generated from `FEATURE_FLAGS`. Review each for consent or grant changes. |
| `task-kind-workflow-defaults` | 3 | Pending | Workflow policy `kindWorkflowDefaults` per task kind. Validate the target workflow and preserve its separate execution policy. |
| `task-shaping-shapers` | 3 | Protected configuration | Shaping owner. Order, enablement, choices, name, kind, endpoint or command, arguments and credential references determine what executes on dispatch. |
| `task-shaping-import` | 3 | Operational | Shaping owner imports executable manifests and dry-runs registered shapers on operator intent |
| `task-shaping-identity` | 3 | Protected | Shaping caller identity controls attribution to external services |
| `task-shaping-limits` | 3 | Pending | Shaping time and output budget owner |
| `voice-mode` | 3 | Status and actions | Voice runtime readiness, mute and push-to-talk. Capture and setup have operator/device authority. |
| `voice-roster` | 3 | Status | Voice address roster derived from residents and session call signs |
| `voice-confirmation` | 3 | Pending | UI voice `confirmation`, revisioned placement route |
| `voice-indicators` | 3 | Pending | UI voice `indicators` per configured surface, separate revisioned intent |
| `voice-heard` | 3 | Protected status | Voice's in-memory heard text may be private |
| `voice-input-device` | 3 | Pending | Voice config `inputDevice`, OS inventory and listener reconciliation |
| `voice-hotkey` | 3 | Pending and protected | Voice config `hotkey`, native shortcut registration and hold-to-talk behavior |
| `voice-auto-mute` | 3 | Pending | Voice config `autoMuteDuringCalls`, listener reconciliation |
| `voice-cancel-window` | 3 | Pending | Voice config `cancelWindow` fields and delivery timing |
| `voice-when-unsure` | 3 | Pending | Voice config `whenUnsure`, routing policy |
| `voice-plan-forms` | 3 | Pending | Voice config `planFormsByVoice`, review consent policy |
| `grill-first-defaults` | 2 | Pending | Skills config `grillFirstKinds` per task kind |
| `worktree-policy` | 2 | Pending | Worktrees config `enabled`, `taskRetentionDays`, `maxSlots` and per-repository overrides for those policies |
| `native-worktree-pools` | 3 | Status and actions | Worktree manager leases, adopted directories and pool operations. Cache preferences are under Storage |
| `legacy-worktree-drain` | 3 | Operational | Legacy worktree manager drains directories and preserves active work |
| `repository-index-directories` | 3 | Pending | Repo index owner `directories`, validated roots, remove operations and cache invalidation |
| `repository-index-add` | 3 | Pending | Repo index add intent for the same `directories` list |
| `repository-index-rescan` | 3 | Operational | Refresh the repository scan without mutating preferences |
| `skills-enabled` | 3 | Pending | Skills config `enabled`, installation and generation side effects |
| `skills-plan-storage` | 3 | Pending | Skills config `planStorage`, pinned per plan or task |
| `skills-plan-html` | 2 | Pending | Skills config `commitPlanHtml` |
| `skills-catalog` | 3 | Pending | Skills config `defaultSkillEnabled` and per-skill enablement. Reloading installations is operational. |
| `skills-always-draft-pr` | 2 | Pending | Skills config `alwaysDraftPr` |
| `standing-instructions-default` | 3 | Protected | Standing-instructions owner, operator-authored instructions injected into launches |
| `standing-instructions-repositories` | 3 | Protected | Standing-instructions owner, repository-scoped launch instructions and removal |
| `reports-guidance` | 2 | Pending | Report settings `guidance` |
| `reports-muted` | 3 | Pending | ReportManager's `report_mutes`, per-source unmute intent |
| `cost-track` | 3 | Protected | Cost owner `enabled` affects external export and user-local Claude settings |
| `cost-interval` | 3 | Pending | Cost owner `exportIntervalMs` and Claude settings reconciliation |
| `cost-view` | 2 | Pending | Cost config `view` |
| `telemetry-collect` | 3 | Protected | Telemetry collection consent, including any dependent destinations |
| `telemetry-user` | 3 | Protected | Telemetry export consent, endpoint, headers and credential configuration. Values may be secret. |
| `telemetry-product` | 3 | Protected | Product analytics consent and destination |
| `telemetry-identity` | 3 | Protected | Installation identity display and rotation affect privacy |
| `storage-overview` | 3 | Status | Storage service usage totals and category details |
| `database-backups` | 2 | Pending | Backup owner `scheduledCount`, `preMigrationCount`, `intervalHours`, `scheduledMaxAgeDays`, `preMigrationMaxAgeDays`, `maxTotalBytes`. Backup jobs and status are operational. |
| `storage-pool-caches` | 2 | Pending | Storage limits `poolIdleBudgetBytes`, `poolKeepWarm`. Per-pool reclaim remains operational |
| `storage-cleanup` | 3 | Operational | Preview or remove idle caches with storage cleanup owner |
| `storage-limits` | 2 | Pending | Storage limits `limitBytes`, `warnAtPercent`, `freeFloorBytes`, `fleetBanner`, `desktopNotification` |
| `storage-problems` | 3 | Status | Storage health and diagnostics |
| `restore-settings` | 3 | Protected action | Settings backup service checks a preview digest and restores multiple owners after operator confirmation |
| `foreman-tier` | 3 | Pending | Foreman tier applies coordinated changes. Its standing guidance link leads to operator-authored `foreman.instructions`. |
| `foreman-skip-scout-wrapup` | 2 | Pending | Foreman config `skipScoutWrapup` |
| `foreman-skip-review-artifact-wrapup` | 2 | Pending | Foreman config `skipReviewArtifactWrapup` |
| `foreman-ship-recovery-minutes` | 2 | Pending | Foreman config `shipRecoveryMinutes` |
| `foreman-episodes` | 3 | Status | Foreman decision history |
| `workflow-live-delivery` | 3 | Protected | Workflow policy `liveEnabled` requires operator arming |
| `workflow-judge-passes` | 2 | Pending | Workflow policy `skipPassedJudges` |
| `workflow-allowlist` | 3 | Protected | Workflow policy `repoAllowlist` grants execution |
| `workflow-test-evidence` | 3 | Status | Workflow test proof readiness, no preference |
| `workflow-checks` | 3 | Protected | Workflow policy `checksEnabled` grants branch-authored execution, with operator arming and effective trust |
| `workflow-check-commands` | 3 | Protected | Workflow command definitions in Library affect executable argv and share the workflow trust boundary |
| `workflow-retention` | 3 | Pending | Workflow retention fields through the preview/confirmation owner when shortening retention can prune data |
| `workflow-health` | 3 | Status | Workflow delivery health and failure views |
| `task-sources` | 3 | Pending and protected | Task source owner. Per-source scheduling, filters and mapping need intent adapters. Credentials, repository access and write-back controls retain consent. Delete/sync are operational. |
| `conductor-repos` | 3 | Protected | Pipelines `repos` commissioning policy and repository paths, withheld by this build |
| `conductor-overview` | 3 | Status and actions | Commissioning and runs, withheld by this build |
| `conductor-detection` | 3 | Status | Engine environment and availability, withheld by this build |
| `conductor-enabled` | 3 | Pending | Pipelines `enabled` and observation lifecycle, withheld by this build |
| `conductor-launch-runtime` | 3 | Pending | Pipelines `launchRuntime`, withheld by this build |
| `conductor-foreman-triage` | 3 | Pending | Pipelines `foremanMechanicalTriage`, withheld by this build |
| `task-kind-defaults` | 2 | Pending | Harnesses `kindDefaults` agent, model and effort per task kind |
| `llm-jobs` | 2 | Pending | LLM `runner`, per-job `models`, `runners`, `efforts`, and Claude/Codex transport choices with the existing model and transport validation |
| `foreman-models` | 2 | Pending | Foreman provider/model/effort for triage, review, verify and backlog, including runner inheritance |
| `review-model` | 2 | Pending | Inspector `runner`, `model` and `effort` |
| `inspector-enabled` | 3 | Pending | Inspector service `enabled`, preserve effective repo grants and outward posting policy |
| `inspector-mode` | 3 | Protected | Inspector `mode` can authorize live GitHub posting |
| `yolo` | 3 | Protected | Shipping `autoMerge` authorizes GitHub merges for allowed repos |
| `soak` | 2 | Pending | Shipping `soakMinutes` |
| `merge-method` | 2 | Pending | Shipping `method` |
| `stacked-pull-requests` | 2 | Pending | Shipping `stacking` and `maxStackDepth` |
| `session-settings-access` | 1 | Protected | Installation consent `sessionSettings.access`, off until enabled in the desktop app's Settings > Trust. |
| `trust-grants` | 3 | Protected | Foreman, Workflow, Inspector and Shipping `repoAllowlist` grants and effective Check execution. UI `trustStaged` is local matrix staging. |

## Controls without individual search entries

| Surface | Phase | Disposition | Owner and leaves |
| --- | --- | --- | --- |
| Display and dashboard chrome | 2 | Pending | UI config `keybindingHints`, dock and fold state (`residentDrawerPinned`, `conversationRailCollapsed`, `blockedFrameCollapsed`, `collapsedBoardColumns`, `sessionRailFolded`), and alerts policy. Audit shared installation settings and window-specific presentation before issuing keys. |
| Keyboard | 3 | Operational | Reset all shortcuts replaces the full map. Per-chord settings are assigned to phase 2. |
| Setup and tours | 3 | Pending and operational | Desktop application update channel and launcher prompt have separate owners. UI `showToursOnStartup` is a preference, `guidedTour` and `announcedTours` track onboarding. Repairs, tour launch, install, update, restart and dismissals are actions. |
| Setup integrations | 3 | Protected and operational | Integration connection, repair and installation actions for harness CLIs, terminal tools, GitHub, Conductor, Pi extensions and voice listener. Local paths, credentials and private diagnostics stay under the setup owner. |
| Harnesses | 2 | Pending | Advisor defaults in `harnesses.advisor` (agent, runtime, model, effort and permission mode). Review the permission mode separately as protected. |
| Models | 3 | Protected and operational | Credential/login, provider setup, model catalog refresh and readiness are not ordinary patch fields. |
| Foreman | 2 | Pending | Typed tuning fields `triage`, `maxFixAttempts`, `maxFixRounds`, `wrapupTriggers`, `wrapup`, `trackReviewFeedback`, `trackCiFailures`, `keepShipTasksMoving`, `autoBacklog`, `backlogRespectOpenPrs`, `backlogDefaultModel`, `maxSessions`. Review outward effects in the owner. |
| Foreman | 3 | Protected | `enabled`, action `mode`, `autoApproveAccess` and executable or prompt authority remain operator-controlled |
| Inspector | 2 | Pending | `maxCommentsPerRound`. Per-PR finding review, posting and resolution are operations |
| Shipping | 3 | Pending and protected | `closeSessionAfterMerge` has lifecycle effects. `codeRabbitAutoResolve` enables automated external follow-up. |
| Task shaping | 3 | Protected and operational | Per-shaper executable environment, timeout and policies, deletion, and dry-run disclosure are owned by the shaper service |
| Voice | 3 | Pending and protected | `hotkey`, `speech`, `decisionProvider`, `backend` use listener/runtime owners. Installing models, testing speech, device consent and secret input are operator actions. |
| Trust and workflow matrix | 3 | Protected and operational | Add/remove staged rows, batch grants and Check arming use consent-aware routes. No writable parent object may include them. |
| Topbar and app preferences | 3 | Pending and operational | Away stall thresholds and detection use Away config. Away presence, Keep Awake, pause state and the priority session are live machine actions. Per-window local state needs a target and persistence decision. |
| Library and resident configuration | 3 | Protected and pending | Resident skill source directories and MCP definitions are separately stored. Preserve authority for executable MCP programs, protected env values and resident permissions. Profiles and the Library catalog have their own edit and action flows. |
