# Session settings coverage inventory

This inventory tracks coverage for [Session access to Mission Control settings](plans/session-settings-mcp/plan.md).
The first table uses control IDs from `ALL_SETTINGS_CONTROLS`, including build-hidden categories. Generated
families use their existing registry as the row source. The second table covers additional controls and leaves
without individual search entries. An owner may back several anchors, and an anchor may cover several leaves.

Repository Index and Task Sources list saves require the revision returned with the list the client edited.
A client opening a view after a daemon restart must fetch a fresh revision before saving. The daemon
rejects missing or stale revisions before replacing a list so a dashboard or script cannot overwrite a
newer session edit.

The inventory distinguishes live preferences, authority-bearing controls, actions and derived state.
Backup classification describes snapshot behavior independently of session access. Conditional rows
follow the dashboard's feature and build gates.

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
| `board-card` | 2 | Read/write | UI config `hiddenDisplayItems` per `DISPLAY_ITEMS` entry, plus `taskKindCard`, `backgroundAgentsStyle` and `residentCardNameStyles`. A hidden-item value of true hides it. The seed marker is derived. |
| `pause-controls` | 2 | Read/write | UI config `pauseCardControls` and `pauseConsoleControls` per shown action. Pause itself is operational. |
| `topbar` | 2 | Read/write | UI config `hiddenTopbarItems` and `compactTopbarItems` per configurable item. A hidden-item value of true hides it. |
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
| `feature-flag-*` | 3 | Read/write or protected | Each flag declares its session policy at its registry entry. Ordinary flags use individual intents. Flags that grant authority or affect workstation capture require the operator. |
| `task-kind-workflow-defaults` | 3 | Read/write | One effective after-work workflow per launchable task kind. Choose the built-in default, None, or an active published workflow. Execution still requires the existing grants. |
| `task-shaping-shapers` | 3 | Protected configuration | Shaping owner. Order, enablement, choices, name, kind, endpoint or command, arguments and credential references determine what executes on dispatch. |
| `task-shaping-import` | 3 | Operational | Shaping owner imports executable manifests and dry-runs registered shapers on operator intent |
| `task-shaping-identity` | 3 | Protected | Shaping caller identity controls attribution to external services |
| `task-shaping-limits` | 3 | Read/write | Shaping settings intent for `timeoutMs`, `deadlineMs`, `maxBytes` and `totalBytes`. |
| `voice-mode` | 3 | Status and actions | Voice runtime readiness, mute and push-to-talk. Capture and setup have operator/device authority. |
| `voice-roster` | 3 | Status | Voice address roster derived from residents and session call signs |
| `voice-confirmation` | 3 | Read/write | `ui.voice.confirmation` uses the same placement owner as the dashboard. |
| `voice-indicators` | 3 | Read/write | `ui.voice.indicators` exposes one selection intent per registered indicator. |
| `voice-heard` | 3 | Protected status | Voice's in-memory heard text may be private |
| `voice-input-device` | 3 | Read/write | `voice.inputDevice` selects the built-in, system or currently reported input device. |
| `voice-hotkey` | 3 | Protected | Desktop shortcut reservation and verification establish the operator's intended chord. |
| `voice-auto-mute` | 3 | Read/write | `voice.autoMuteDuringCalls` can enable call auto-mute. Disabling it requires the operator because that can resume microphone capture. |
| `voice-listening-mode` | 3 | Protected | Switching between automatic and held microphone capture changes when the workstation listens. |
| `voice-end-of-speech` | 3 | Read/write | `voice.endOfSpeechMs` updates automatic capture timing. |
| `voice-cancel-window` | 3 | Read/write | `voice.cancelWindow.enabled` and `voice.cancelWindow.seconds` update delivery timing. |
| `voice-when-unsure` | 3 | Read/write | `voice.whenUnsure` selects routing behavior when confidence is low. |
| `voice-plan-forms` | 3 | Read/write | `voice.planFormsByVoice` controls form filling. Submission still requires a separate operator gesture. |
| `grill-first-defaults` | 2 | Read/write | `skills.grillFirstKinds`, a versioned replacement of the task-kind list |
| `worktree-policy` | 2 | Read/write | `worktrees.enabled`, `worktrees.taskRetentionDays` and `worktrees.maxSlots`. Existing repository records expose their enabled and slot-cap leaves under a stable hashed repository key. |
| `native-worktree-pools` | 3 | Status and actions | Worktree manager leases, adopted directories and pool operations. Cache preferences are under Storage |
| `legacy-worktree-drain` | 3 | Operational | Legacy worktree manager drains directories and preserves active work |
| `repository-index-directories` | 3 | Read/write | `repoIndex.directories` is a versioned replacement through the index owner. A launch environment override takes precedence. |
| `repository-index-add` | 3 | Read/write | Add, remove or restore roots with a versioned edit of `repoIndex.directories`. Rescanning is an action. |
| `repository-index-rescan` | 3 | Operational | Refresh the repository scan without mutating preferences |
| `skills-enabled` | 3 | Read/write | `skills.enabled` reconciles the shipped skill links through the skill owner. |
| `skills-plan-storage` | 3 | Read/write | `skills.planStorage` sets storage for new plans. Existing plans retain pinned storage. |
| `skills-plan-html` | 2 | Read/write | Skills config `commitPlanHtml` |
| `skills-catalog` | 3 | Read/write | One boolean per shipped catalog entry using the link reconciler. The stored default supplies legacy inheritance. Reload is an action. |
| `skills-always-draft-pr` | 2 | Read/write | Skills config `alwaysDraftPr` |
| `standing-instructions-default` | 3 | Protected | Standing-instructions owner, operator-authored instructions injected into launches |
| `standing-instructions-repositories` | 3 | Protected | Standing-instructions owner, repository-scoped launch instructions and removal |
| `reports-guidance` | 2 | Protected | Free-form report guidance supplies tool instructions to future sessions across repositories. Edit it in Settings > Reports. |
| `reports-muted` | 3 | Protected | ReportManager's per-author mute and unmute routes require the operator. |
| `cost-track` | 3 | Protected | Cost owner `enabled` affects external export and user-local Claude settings |
| `cost-interval` | 3 | Read/write | `cost.exportIntervalMs` reconciles the Claude settings file through the cost owner. |
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
| `foreman-tier` | 3 | Read/write | `foreman.triage` chooses the cheap tier. Standing instructions and unattended action authority are protected. |
| `foreman-skip-scout-wrapup` | 2 | Protected | Clearing `skipScoutWrapup` expands the tasks eligible for automatic shipping. |
| `foreman-skip-review-artifact-wrapup` | 2 | Protected | Clearing `skipReviewArtifactWrapup` expands the tasks eligible for automatic shipping. |
| `foreman-ship-recovery-minutes` | 2 | Read/write | Foreman config `shipRecoveryMinutes` |
| `foreman-episodes` | 3 | Status | Foreman decision history |
| `workflow-live-delivery` | 3 | Protected | Workflow policy `liveEnabled` requires operator arming |
| `workflow-judge-passes` | 2 | Read/write | Workflow policy `skipPassedJudges` |
| `workflow-allowlist` | 3 | Protected | Workflow policy `repoAllowlist` grants execution |
| `workflow-test-evidence` | 3 | Status | Workflow test proof readiness, no preference |
| `workflow-checks` | 3 | Protected | Workflow policy `checksEnabled` grants branch-authored execution, with operator arming and effective trust |
| `workflow-check-commands` | 3 | Protected | Workflow command definitions in Library affect executable argv and share the workflow trust boundary |
| `workflow-retention` | 3 | Read/write with confirmation boundary | `rawEvidenceDays`, `completedRunDays` and `maxCompletedRuns` can be extended. Shortening requires dashboard confirmation. |
| `workflow-health` | 3 | Status | Workflow delivery health and failure views |
| `task-sources` | 3 | Read/write and protected | Existing source label, interval, refresh, batch cap, task kind, agent, priority, labels and provider search/mapping fields are editable. The operator controls enablement, repository, credentials, automatic dispatch and write-back. GitHub filter and Jira query changes require operator action while write-back is configured because they can select issues outside its approved scope. |
| `conductor-repos` | 3 | Protected | Pipelines `repos` commissioning policy and repository paths, withheld by this build |
| `conductor-overview` | 3 | Status and actions | Commissioning and runs, withheld by this build |
| `conductor-detection` | 3 | Status | Engine environment and availability, withheld by this build |
| `conductor-enabled` | 3 | Protected | Activates observation of commissioned repositories. Withheld by this build. |
| `conductor-launch-runtime` | 3 | Read/write | `pipelines.launchRuntime` and the dashboard’s runtime PATCH share a field-scoped owner that applies pipeline reconciliation while preserving saved observation and Foreman consent. |
| `conductor-foreman-triage` | 3 | Protected | Grants automated intervention in the external engine. Withheld by this build. |
| `task-kind-defaults` | 2 | Read/write | Harnesses `kindDefaults` agent, model and effort per task kind |
| `llm-jobs` | 2 | Read/write | LLM `runner`, per-job `models`, `runners`, `efforts`, and Claude/Codex transport choices with the existing model and transport validation |
| `foreman-models` | 2 | Read/write | Foreman provider/model/effort for triage, review, verify and backlog, including runner inheritance |
| `review-model` | 2 | Read/write | Inspector `runner`, `model` and `effort` |
| `inspector-enabled` | 3 | Read/write or protected | `inspector.enabled` uses Inspector reconciliation when configured for private operation. Live posting requires the operator. |
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
| Setup and tours | 3 | Read/write and protected | `ui.showToursOnStartup` and `dispatch.launcher.prompt` use their existing owners. The desktop updater owns Alpha, which can enable multiple previews, and install/restart. Tour launch, dismissal and announcements are runtime state. |
| Setup integrations | 3 | Protected and operational | Connection, repair, installation, provider login, model refresh and diagnostics stay with the operator. |
| Harnesses | 2 | Read/write | Default advisor choice per capable harness. |
| Harness advisor model overrides | 3 | Read/write | One binding per supported shipped, discovered or previously stored model. Null clears one override through the Harnesses owner. |
| Models | 3 | Protected and operational | Provider login, model refresh and readiness have their own operator flows. |
| Foreman | 2 | Read/write | `triage`, `maxFixAttempts`, `maxFixRounds`, `wrapupTriggers`, per-harness backlog model and `maxSessions`. |
| Foreman | 3 | Protected | `enabled`, action `mode`, `autoApproveAccess`, repository grants and standing instructions confer authority. |
| Inspector | 2 | Read/write and operational | `maxCommentsPerRound` is a preference. Per-PR review, posting and resolution are actions. |
| Foreman automation | 2 | Protected | `wrapup`, `trackReviewFeedback`, `trackCiFailures`, `keepShipTasksMoving`, `autoBacklog` and `backlogRespectOpenPrs` can enable unattended actions. |
| Repository worktree overrides | 3 | Read/write and protected | Per-repository enabled and slot limits are writable for registered pools and existing overrides. Resetting an entire override can remove setup argv and dependency claims, which are operator-controlled. |
| Shipping | 3 | Read/write and protected | `shipping.closeSessionAfterMerge` sets lifecycle behavior after a completed merge. CodeRabbit follow-up and merge grants require the operator. |
| Task shaping | 3 | Protected and operational | Per-shaper code, environment references, service and timeout policy, imports, selection, enablement and dry runs determine what executes at dispatch. |
| Voice | 3 | Read/write and protected | The built-in recognition backend and speech voice are writable, subject to the launch override and available voice catalog. Microphone arming, hotkey registration, external decision provider, key management, model installation and audition remain operator controls. |
| Voice live transcript | 3 | Read/write and protected | Transcript style, corner and word limit are presentation preferences. Turning the transcript on or off determines whether captured speech appears on screen and remains operator-only. |
| Trust and workflow matrix | 3 | Protected and operational | Staging rows, batch grants and Check arming are operator controls. |
| Topbar and app preferences | 3 | Read/write and operational | Away stall detection and its three thresholds use Away config. Away presence, Keep Awake, pause, focus and priority are live machine actions. Expanded Board columns and view overrides belong to the window that created them. A session supplies no dashboard window identity. |
| Library and resident configuration | 3 | Protected and operational | Resident skill paths choose instructions loaded into future sessions. MCP commands, env values, profiles, permissions and Library definitions have dedicated authority and lifecycle flows. |

## Implementation decisions

- The stacked preview ships with explicit desktop Trust consent for new and upgraded installations. This phase preserves both gates and leaves the fixed tool definition untouched.
- Individual flag writes use the same service and event as dashboard writes. The registry marks grants and indirect paths to microphone capture as protected.
- Retention decreases, report muting and unmuting, live Inspector activation and desktop shortcut reservations retain their operator pathways. Tool reads project only the selected safe leaf.
- Workflow defaults expose the effective selection. The built-in choice removes that kind’s stored override and reads back the effective workflow.
- Worktree preferences target Git common directories already registered in the pool catalog or the policy store. Per-window ephemeral state retains its originating window as the only target.
