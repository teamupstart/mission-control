# Session settings coverage inventory

This inventory tracks coverage for [Session access to Mission Control settings](plans/session-settings-mcp/plan.md).
The first table uses control IDs from `ALL_SETTINGS_CONTROLS`, including build-hidden categories. Generated
families use their existing registry as the row source. The second table covers additional controls and leaves
without individual search entries. An owner may back several anchors, and an anchor may cover several leaves.

Phase 2 exposes the ordinary typed preferences below. Phase 3 owns specialized intents and reviews the remaining
protected, operational and status dispositions. Pending rows confer no tool access. Backup classification
describes snapshot behavior independently of session access.

## Indexed controls

| Search control ID | Phase | Disposition | Owner and leaves |
| --- | --- | --- | --- |
| `layout` | 2 | Read/write | UI config `layout` |
| `line-density` | 2 | Read/write | UI config `ui.lineDensity` and `ui.lineHidden`. Editing density preserves the disabled state. |
| `board-grouping` | 2 | Read/write | UI config `groupBoardByRepo` |
| `board-sidebar` | 2 | Read/write | UI config `boardSidebarAllSessions` under the layout anchor |
| `resident-placement` | 2 | Read/write | UI config `residentPlacement` |
| `blocked-placement` | 2 | Read/write | UI config `blockedPlacement` |
| `conversation-view` | 2 | Read/write | UI config `conversationView` |
| `skin` | 1 | Read/write | UI config `ui.skin`, shipped skin IDs |
| `format-messages` | 2 | Read/write | UI config `richText` |
| `board-card` | 2 | Read/write | UI config `hiddenDisplayItems` per `DISPLAY_ITEMS` entry, plus `taskKindCard` and `backgroundAgentsStyle`. The seed marker is derived. |
| `pause-controls` | 2 | Read/write | UI config `pauseCardControls` and `pauseConsoleControls` per shown action. Pause itself is operational. |
| `topbar` | 2 | Read/write | UI config `hiddenTopbarItems` and `compactTopbarItems` per configurable item |
| `conversation-header` | 2 | Read/write | UI config `hiddenDisplayItems` conversation group and `taskKindHeader` |
| `working-indicator` | 2 | Read/write | UI config `hiddenDisplayItems` working-harness conversation and card marks |
| `guided-dispatch` | 2 | Read/write | UI config `guidedDispatch` |
| `keyboard-*` | 2 | Read/write | One UI config `keybindings` chord per `ACTIONS` entry. Reset one chord uses the same owner. |
| `setup-checks` | 3 | Status and actions | Setup gathers executable and integration readiness. Recheck, install, repair and onboarding change machine state on operator intent. |
| `multiplexer-terminal` | 2 | Read/write | `terminals.multiplexerTerminal` per multiplexer that uses an external terminal app, with platform-specific choices |
| `external-sessions` | 2 | Read/write | Terminals config `externalSessions` |
| `auto-mode` | 3 | Protected | Harness config `autoModeOnDispatch` changes the default approval mode |
| `harness-*` | 2 | Read/write | One per `AGENT_TYPES`. Harness config `defaultModel`, `defaultEffort`, `sessionRuntime`, `terminalBackend` per agent. Provider/model availability and setup link are read-only. |
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
| `voice-end-of-speech` | 3 | Pending | Voice config `endOfSpeechMs`, listener timing in automatic modes |
| `voice-cancel-window` | 3 | Pending | Voice config `cancelWindow` fields and delivery timing |
| `voice-when-unsure` | 3 | Pending | Voice config `whenUnsure`, routing policy |
| `voice-plan-forms` | 3 | Pending | Voice config `planFormsByVoice`, review consent policy |
| `grill-first-defaults` | 2 | Read/write | `skills.grillFirstKinds`, a versioned replacement of the task-kind list |
| `worktree-policy` | 2 | Read/write | `worktrees.enabled`, `worktrees.taskRetentionDays` and `worktrees.maxSlots`. Existing repository records expose their enabled and slot-cap leaves under a stable hashed repository key. |
| `native-worktree-pools` | 3 | Status and actions | Worktree manager leases, adopted directories and pool operations. Cache preferences are under Storage |
| `legacy-worktree-drain` | 3 | Operational | Legacy worktree manager drains directories and preserves active work |
| `repository-index-directories` | 3 | Pending | Repo index owner `directories`, validated roots, remove operations and cache invalidation |
| `repository-index-add` | 3 | Pending | Repo index add intent for the same `directories` list |
| `repository-index-rescan` | 3 | Operational | Refresh the repository scan without mutating preferences |
| `skills-enabled` | 3 | Pending | Skills config `enabled`, installation and generation side effects |
| `skills-plan-storage` | 3 | Pending | Skills config `planStorage`, pinned per plan or task |
| `skills-plan-html` | 2 | Read/write | Skills config `commitPlanHtml` |
| `skills-catalog` | 3 | Pending | Skills config `defaultSkillEnabled` and per-skill enablement. Reloading installations is operational. |
| `skills-always-draft-pr` | 2 | Read/write | Skills config `alwaysDraftPr` |
| `standing-instructions-default` | 3 | Protected | Standing-instructions owner, operator-authored instructions injected into launches |
| `standing-instructions-repositories` | 3 | Protected | Standing-instructions owner, repository-scoped launch instructions and removal |
| `reports-guidance` | 2 | Read/write | Report settings `guidance` |
| `reports-muted` | 3 | Pending | ReportManager's `report_mutes`, per-source unmute intent |
| `cost-track` | 3 | Protected | Cost owner `enabled` affects external export and user-local Claude settings |
| `cost-interval` | 3 | Pending | Cost owner `exportIntervalMs` and Claude settings reconciliation |
| `cost-view` | 2 | Read/write | Cost config `view` |
| `telemetry-collect` | 3 | Protected | Telemetry collection consent, including any dependent destinations |
| `telemetry-user` | 3 | Protected | Telemetry export consent, endpoint, headers and credential configuration. Values may be secret. |
| `telemetry-product` | 3 | Protected | Product analytics consent and destination |
| `telemetry-identity` | 3 | Protected | Installation identity display and rotation affect privacy |
| `storage-overview` | 3 | Status | Storage service usage totals and category details |
| `database-backups` | 2 | Read/write | Backup owner `scheduledCount`, `preMigrationCount`, `intervalHours`, `scheduledMaxAgeDays`, `preMigrationMaxAgeDays`, `maxTotalBytes`. Any edit that would delete a copy requires dashboard confirmation. Backup jobs and status are operational. |
| `storage-pool-caches` | 2 | Read/write | Storage limits `poolIdleBudgetBytes`, `poolKeepWarm`. Per-pool reclaim remains operational |
| `storage-cleanup` | 3 | Operational | Preview or remove idle caches with storage cleanup owner |
| `storage-limits` | 2 | Read/write | Storage limits `limitBytes`, `warnAtPercent`, `freeFloorBytes`, `fleetBanner`, `desktopNotification` |
| `storage-problems` | 3 | Status | Storage health and diagnostics |
| `restore-settings` | 3 | Protected action | Settings backup service checks a preview digest and restores multiple owners after operator confirmation |
| `foreman-tier` | 3 | Pending | Foreman tier applies coordinated changes. Its standing guidance link leads to operator-authored `foreman.instructions`. |
| `foreman-skip-scout-wrapup` | 2 | Read/write | Foreman config `skipScoutWrapup` |
| `foreman-skip-review-artifact-wrapup` | 2 | Read/write | Foreman config `skipReviewArtifactWrapup` |
| `foreman-ship-recovery-minutes` | 2 | Read/write | Foreman config `shipRecoveryMinutes` |
| `foreman-episodes` | 3 | Status | Foreman decision history |
| `workflow-live-delivery` | 3 | Protected | Workflow policy `liveEnabled` requires operator arming |
| `workflow-judge-passes` | 2 | Read/write | Workflow policy `skipPassedJudges` |
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
| `task-kind-defaults` | 2 | Read/write | Harnesses `kindDefaults` agent, model and effort per task kind |
| `llm-jobs` | 2 | Read/write | LLM `runner`, per-job `models`, `runners`, `efforts`, and Claude/Codex transport choices with the existing model and transport validation |
| `foreman-models` | 2 | Read/write | Foreman provider/model/effort for triage, review, verify and backlog, including runner inheritance |
| `review-model` | 2 | Read/write | Inspector `runner`, `model` and `effort` |
| `inspector-enabled` | 3 | Pending | Inspector service `enabled`, preserve effective repo grants and outward posting policy |
| `inspector-mode` | 3 | Protected | Inspector `mode` can authorize live GitHub posting |
| `yolo` | 3 | Protected | Shipping `autoMerge` authorizes GitHub merges for allowed repos |
| `soak` | 2 | Read/write | Shipping `soakMinutes` |
| `merge-method` | 2 | Read/write | Shipping `method` |
| `stacked-pull-requests` | 2 | Read/write | Shipping `stacking` and `maxStackDepth` |
| `session-settings-access` | 1 | Protected | Installation consent `sessionSettings.access`, off until enabled in the desktop app's Settings > Trust. |
| `trust-grants` | 3 | Protected | Foreman, Workflow, Inspector and Shipping `repoAllowlist` grants and effective Check execution. UI `trustStaged` is local matrix staging. |

## Controls without individual search entries

| Surface | Phase | Disposition | Owner and leaves |
| --- | --- | --- | --- |
| Display and dashboard chrome | 2 | Read/write | Installation-wide UI config `keybindingHints`, dock and fold state (`residentDrawerPinned`, `conversationRailCollapsed`, `blockedFrameCollapsed`, `collapsedBoardColumns`, `sessionRailFolded`), and individual alerts preferences. Expanded Board columns and per-conversation view overrides are window-local. |
| Keyboard | 3 | Operational | Reset all shortcuts replaces the full map. Per-chord settings are assigned to phase 2. |
| Setup and tours | 3 | Pending and operational | Desktop application update channel and launcher prompt have separate owners. UI `showToursOnStartup` is a preference, `guidedTour` and `announcedTours` track onboarding. Repairs, tour launch, install, update, restart and dismissals are actions. |
| Setup integrations | 3 | Protected and operational | Integration connection, repair and installation actions for harness CLIs, terminal tools, GitHub, Conductor, Pi extensions and voice listener. Local paths, credentials and private diagnostics stay under the setup owner. |
| Harnesses | 2 | Read/write | Default advisor choice per capable harness. The stacked owner stores an advisor choice and model-keyed overrides, with no advisor agent, runtime, effort or permission fields. |
| Models | 3 | Protected and operational | Credential/login, provider setup, model catalog refresh and readiness are not ordinary patch fields. |
| Foreman | 2 | Read/write | `triage`, `maxFixAttempts`, `maxFixRounds`, `wrapupTriggers` (versioned replacement), per-harness `backlogDefaultModel` and `maxSessions`. |
| Foreman | 3 | Protected | `enabled`, action `mode`, `autoApproveAccess` and executable or prompt authority remain operator-controlled |
| Inspector | 2 | Read/write | `maxCommentsPerRound`. Per-PR finding review, posting and resolution are operations |
| Foreman automation | 2 | Protected | `wrapup`, `trackReviewFeedback`, `trackCiFailures`, `keepShipTasksMoving`, `autoBacklog` and `backlogRespectOpenPrs` can enable unattended actions. Manage them in Foreman. |
| Repository worktree overrides | 3 | Pending and protected | Review repository discovery for creating a new override. Setup argv and dependency claims retain operator control because they can execute commands. |
| Harness advisor model overrides | 3 | Pending | Add and remove model overrides using the owner and model catalog. The published default advisor is independent of its per-model map. |
| Shipping | 3 | Pending and protected | `closeSessionAfterMerge` has lifecycle effects. `codeRabbitAutoResolve` enables automated external follow-up. |
| Task shaping | 3 | Protected and operational | Per-shaper executable environment, timeout and policies, deletion, and dry-run disclosure are owned by the shaper service |
| Voice | 3 | Pending and protected | `hotkey`, `speech`, `decisionProvider`, `backend` use listener/runtime owners. Installing models, testing speech, device consent and secret input are operator actions. |
| Trust and workflow matrix | 3 | Protected and operational | Add/remove staged rows, batch grants and Check arming use consent-aware routes. No writable parent object may include them. |
| Topbar and app preferences | 3 | Pending and operational | Away stall thresholds and detection use Away config. Away presence, Keep Awake, pause state and the priority session are live machine actions. Per-window local state needs a target and persistence decision. |
| Library and resident configuration | 3 | Protected and pending | Resident skill source directories and MCP definitions are separately stored. Preserve authority for executable MCP programs, protected env values and resident permissions. Profiles and the Library catalog have their own edit and action flows. |


## Phase 2 implementation notes

- The stacked Phase 1 branch ships an opt-in preview and explicit desktop Trust consent. Its access gates apply to every typed owner.
- The dashboard's search and generated control registries provide the shared metadata. The owner allowlist remains a separate policy from Settings backup classifications.
- Workflow judge reuse uses a narrow patch through the policy owner, which keeps the legacy full-policy PUT and its command-catalog transaction available. Cost display saves through its existing owner without reconciling telemetry.
- The backup service compares the exact deletion preview before saving. Session writes can change backup preferences when the removal set is empty. The dashboard owns confirmation and deletion.
