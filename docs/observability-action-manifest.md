# Phase 5 operation manifest

Read [the coverage guide](observability-actions.md) for the counting, lifecycle, actor, privacy and recovery contracts. This inventory is method-specific: GET reads are not primary mutations, including polling, probes and search result loads. Intentional navigation is observed in the browser at its transition, not on each GET.

## Primary mutation adapters

[`PRIMARY_ACTION_ROUTES`](../src/shared/telemetry-sources/primary-actions.ts) is the authoritative method, owner endpoint, stable action ID and feature inventory. `PRIMARY_FEATURES` derives from those routes; adding a route extends the action and browser feature schemas without a separate feature list. The [manifest test](../test/telemetry-primary-actions.test.ts) checks every declared operation against the schemas and compares route coverage with the daemon's mutations.

Each registered route emits `mission.action.result` through `primaryActionTelemetry` after the route's actual owner returns. Applied means the named operation happened, not all later work finished. HTTP refusals are `refused`, unexpected failures `failed`, queued/unknown acknowledgements `pending`; owner cancellation is `cancelled`. Task creation and background automation also use the owner seams in the coverage guide. Feature-family owner and browser evidence are listed in that guide.

Attribution comes from the shared app/MCP/Foreman context or the explicit owner. All operations exclude request bodies, URL paths, response prose and arbitrary values from facts; only declared action/feature IDs and scoped opaque references enter telemetry.

`ensemble.action` and `pipeline.action` are refusal fallbacks for invalid bodies. Valid ensemble verbs come from [`EnsembleActionSchema`](../src/shared/protocol.ts) and emit `ensemble.<verb>`; pipeline controls come from [`PIPELINE_ACTIONS`](../src/shared/pipeline.ts) and emit `pipeline.control.<verb>`. Both sets derive from the existing domain registries.

## Phase 4 mutation ownership

[`WORKFLOW_ACTION_ROUTES`](../src/shared/workflow-actions.ts) owns the workflow/persona/command mutation inventory. These operations already emit their standard action result. Phase 5 supplies only missing browser/MCP context and safe error correlation, never another success event. The semantic owner is the workflow/persona/command manager behind each route, tested by `telemetry-workflows.test.ts`.

## Earlier owners and explicit exclusions

[`ACTION_EXCLUSIONS`](../src/shared/telemetry-sources/action-exclusions.ts) records each excluded mutation's method, endpoint and reason or existing phase owner. This includes earlier session/dispatch/telemetry observations, read-only handshakes, heartbeats and typing signals. The manifest test checks exclusions alongside the primary and Phase 4 registries, so every daemon mutation has exactly one declared owner or exclusion.

## Exported browser API inventory

Each public callable below either reaches the method-specific owner above, reads existing state, or composes/parses another callable. GETs and pure helpers are explicitly excluded from action counts: an automatic reload is not a new use. Shared request helpers propagate context for mutations; they cannot declare a separate success. Type-only exports are wire contracts rather than operations. `api.listFiles` and `api.readFile` are aliases of `fetchSessionFiles` and `fetchSessionFile`; both are excluded reads with intentional file selection observed by `sessionFiles`.

| Export | Route / shared helper contract |
| --- | --- |
| [`fetchForemanConfig`](../src/web/lib/api.ts#L250) | `/api/foreman/config` |
| [`fetchForemanStatus`](../src/web/lib/api.ts#L251) | `/api/foreman/status` |
| [`fetchForemanEpisodes`](../src/web/lib/api.ts#L259) | `/api/foreman/episodes` |
| [`fetchForemanEpisode`](../src/web/lib/api.ts#L270) | `/api/foreman/episodes/:id` |
| [`fetchBacklogPlan`](../src/web/lib/api.ts#L282) | `/api/backlog/plan` |
| [`fetchHarnessesConfig`](../src/web/lib/api.ts#L284) | `/api/harnesses/config` |
| [`fetchTerminalsConfig`](../src/web/lib/api.ts#L286) | `/api/terminals/config` |
| [`fetchHarnessModelCatalogs`](../src/web/lib/api.ts#L294) | `/api/harnesses/models` |
| [`fetchWorktrees`](../src/web/lib/api.ts#L305) | `/api/worktrees` |
| [`updateWorktreesConfig`](../src/web/lib/api.ts#L340) | `/api/worktrees/config` |
| [`previewWorktreeAction`](../src/web/lib/api.ts#L343) | `/api/worktrees/actions/preview` |
| [`executeWorktreeAction`](../src/web/lib/api.ts#L346) | `/api/worktrees/actions/execute` |
| [`dismissWorktreeOperation`](../src/web/lib/api.ts#L352) | `/api/worktrees/operations/:id/dismiss` |
| [`openWorktreeTerminal`](../src/web/lib/api.ts#L355) | `/api/worktrees/:id/open` |
| [`fetchEnvironmentChecks`](../src/web/lib/api.ts#L364) | `/api/environment/checks` |
| [`fetchSetupChecks`](../src/web/lib/api.ts#L367) | `/api/setup/checks` |
| [`openSetupInstaller`](../src/web/lib/api.ts#L369) | `/api/setup/install` |
| [`startSetupService`](../src/web/lib/api.ts#L372) | `/api/setup/service` |
| [`fetchUiConfig`](../src/web/lib/api.ts#L378) | `/api/ui/config` |
| [`fetchCostConfig`](../src/web/lib/api.ts#L384) | `/api/cost/config` |
| [`fetchInspectorConfig`](../src/web/lib/api.ts#L385) | `/api/inspector/config` |
| [`fetchInspectorPrs`](../src/web/lib/api.ts#L398) | `/api/inspector/prs`<br>`/api/inspector/prs?adoptedSince=:id` |
| [`fetchInspectorStatus`](../src/web/lib/api.ts#L404) | `/api/inspector/status` |
| [`fetchLlmConfig`](../src/web/lib/api.ts#L406) | `/api/llm/config` |
| [`fetchLlmStatus`](../src/web/lib/api.ts#L414) | `/api/llm/status` |
| [`fetchPersonaDefaults`](../src/web/lib/api.ts#L415) | `/api/personas/defaults` |
| [`fetchShippingConfig`](../src/web/lib/api.ts#L417) | `/api/shipping/config` |
| [`fetchRepoIndex`](../src/web/lib/api.ts#L419) | `/api/repo-index` |
| [`fetchTaskSources`](../src/web/lib/api.ts#L426) | `/api/task-sources/config` |
| [`fetchPipelines`](../src/web/lib/api.ts#L435) | `/api/pipelines/config` |
| [`setPipelinesConfig`](../src/web/lib/api.ts#L445) | `/api/pipelines/config` |
| [`fetchStandingInstructions`](../src/web/lib/api.ts#L477) | `/api/instructions` |
| [`saveStandingInstructions`](../src/web/lib/api.ts#L487) | `/api/instructions` |
| [`fetchResolvedStandingInstructions`](../src/web/lib/api.ts#L533) | `/api/instructions/resolved?:id` |
| [`fetchSessionStandingInstructions`](../src/web/lib/api.ts#L547) | `/api/sessions/:id/standing-instructions` |
| [`fetchPipelineRepos`](../src/web/lib/api.ts#L560) | `/api/pipelines/repos` |
| [`fetchPipelineInstallers`](../src/web/lib/api.ts#L564) | `/api/pipelines/installers?provider=:id` |
| [`openPipelineInstaller`](../src/web/lib/api.ts#L570) | `/api/pipelines/install` |
| [`fetchPipelineRunDetail`](../src/web/lib/api.ts#L580) | `/api/pipelines/run?provider=:id&repoRoot=:id&slug=:id` |
| [`runPipelineAction`](../src/web/lib/api.ts#L600) | `/api/pipelines/action` |
| [`openPipelineConsole`](../src/web/lib/api.ts#L631) | `/api/pipelines/console` |
| [`fetchAwayConfig`](../src/web/lib/api.ts#L660) | `/api/away` |
| [`fetchAwayDigest`](../src/web/lib/api.ts#L666) | `/api/away/digest` |
| [`fetchAwayBuffer`](../src/web/lib/api.ts#L674) | `/api/away/buffer` |
| [`fetchAwayStalls`](../src/web/lib/api.ts#L680) | `/api/away/stalls` |
| [`fetchSettingsBackups`](../src/web/lib/api.ts#L719) | `/api/settings-backups` |
| [`previewSettingsRestore`](../src/web/lib/api.ts#L723) | `/api/settings-backups/:id/preview` |
| [`submitSettingsRestore`](../src/web/lib/api.ts#L732) | `/api/settings-backups/:id/restore` |
| [`fetchSkills`](../src/web/lib/api.ts#L747) | `/api/skills` |
| [`fetchResetPreview`](../src/web/lib/api.ts#L750) | `/api/sessions/:id/reset/preview` |
| [`fetchSessionDiff`](../src/web/lib/api.ts#L771) | `/api/sessions/:id/diff:id` |
| [`fetchEnsembles`](../src/web/lib/api.ts#L830) | `/api/ensembles` |
| [`fetchEnsembleDetail`](../src/web/lib/api.ts#L836) | `/api/ensembles/:id` |
| [`fetchEnsembleArtifactPatch`](../src/web/lib/api.ts#L840) | `/api/ensembles/:id/artifacts/:id/patch` |
| [`fetchArtifactFiles`](../src/web/lib/api.ts#L849) | `/api/ensembles/:id/artifacts/:id/patch?filesOnly=1` |
| [`fetchArtifactFilePatch`](../src/web/lib/api.ts#L859) | `/api/ensembles/:id/artifacts/:id/patch?:id` |
| [`previewEnsemble`](../src/web/lib/api.ts#L877) | `/api/ensembles/preview` |
| [`createEnsemble`](../src/web/lib/api.ts#L885) | `/api/ensembles` |
| [`ensembleAction`](../src/web/lib/api.ts#L893) | `/api/ensembles/:id/actions` |
| [`submitEnsembleMember`](../src/web/lib/api.ts#L901) | `/api/ensembles/:id/members/:id/submit` |
| [`deleteEnsemble`](../src/web/lib/api.ts#L913) | `/api/ensembles/:id` |
| [`resolveRepo`](../src/web/lib/api.ts#L923) | `/api/repos/resolve` |
| [`fetchRepos`](../src/web/lib/api.ts#L950) | `/api/repos` |
| [`fetchWorkflowRepoAllowlist`](../src/web/lib/api.ts#L970) | `/api/workflows/config` |
| [`previewSchedule`](../src/web/lib/api.ts#L1080) | `/api/schedules/preview` |
| [`createSchedule`](../src/web/lib/api.ts#L1101) | `/api/schedules` |
| [`updateSchedule`](../src/web/lib/api.ts#L1104) | `/api/schedules/:id/update` |
| [`setScheduleEnabled`](../src/web/lib/api.ts#L1107) | `/api/schedules/:id/set-enabled` |
| [`archiveSchedule`](../src/web/lib/api.ts#L1110) | `/api/schedules/:id/archive` |
| [`runScheduleNow`](../src/web/lib/api.ts#L1114) | `/api/schedules/:id/run-now` |
| [`fetchScheduleHistory`](../src/web/lib/api.ts#L1139) | `/api/schedules/:id/occurrences` |
| [`fetchQueue`](../src/web/lib/api.ts#L1160) | `/api/sessions/:id/queue` |
| [`fetchTranscriptBefore`](../src/web/lib/api.ts#L1181) | `/api/sessions/:id/transcript?before=:id` |
| [`fetchSessionFiles`](../src/web/lib/api.ts#L1218) | `/api/sessions/:id/files` |
| [`fetchSessionFile`](../src/web/lib/api.ts#L1231) | `/api/sessions/:id/file?path=:id` |
| [`fetchOpenTargets`](../src/web/lib/api.ts#L1256) | `/api/open-targets` |
| [`fetchTerminalTargets`](../src/web/lib/api.ts#L1266) | `/api/terminal-targets` |
| [`uploadImage`](../src/web/lib/api.ts#L1274) | `/api/uploads` |
| [`fetchProductIssuePreflight`](../src/web/lib/api.ts#L1317) | `/api/product-issues/preflight` |
| [`previewProductIssue`](../src/web/lib/api.ts#L1345) | `/api/product-issues/preview` |
| [`confirmProductIssue`](../src/web/lib/api.ts#L1381) | `/api/product-issues/confirm` |
| [`submitProductIssue`](../src/web/lib/api.ts#L1419) | `/api/product-issues` |
| [`setKeepAwake`](../src/web/lib/api.ts#L1459) | `/api/keep-awake` |
| [`isArchiveAbort`](../src/web/lib/api.ts#L1564) | Shared request/validation or derived-view helper; action ownership is at its invoking route. |
| [`archiveSearchPath`](../src/web/lib/api.ts#L1575) | `/api/archives?:id`<br>`/api/archives` |
| [`api.saveFile`](../src/web/lib/api.ts#L1599) | `/api/sessions/:id/file` |
| [`api.openFile`](../src/web/lib/api.ts#L1609) | `/api/sessions/:id/file/open` |
| [`api.sendText`](../src/web/lib/api.ts#L1614) | `/api/sessions/:id/send` |
| [`api.reportComposerActivity`](../src/web/lib/api.ts#L1616) | `/api/sessions/:id/composer-activity` |
| [`api.recallPendingTurn`](../src/web/lib/api.ts#L1626) | `/api/sessions/:id/pending-turns/:id/recall` |
| [`api.retryPendingTurn`](../src/web/lib/api.ts#L1631) | `/api/sessions/:id/pending-turns/:id/retry` |
| [`api.resolvePendingTurn`](../src/web/lib/api.ts#L1636) | `/api/sessions/:id/pending-turns/:id/resolve` |
| [`api.focus`](../src/web/lib/api.ts#L1641) | `/api/sessions/:id/focus` |
| [`api.launchTerminal`](../src/web/lib/api.ts#L1649) | `/api/sessions/:id/launch` |
| [`api.rename`](../src/web/lib/api.ts#L1655) | `/api/sessions/:id/rename` |
| [`api.kill`](../src/web/lib/api.ts#L1657) | `/api/sessions/:id/kill` |
| [`api.interrupt`](../src/web/lib/api.ts#L1666) | `/api/sessions/:id/interrupt` |
| [`api.cycleMode`](../src/web/lib/api.ts#L1670) | `/api/sessions/:id/mode/cycle` |
| [`api.setMode`](../src/web/lib/api.ts#L1675) | `/api/sessions/:id/mode` |
| [`api.setEffort`](../src/web/lib/api.ts#L1684) | `/api/sessions/:id/effort` |
| [`api.reset`](../src/web/lib/api.ts#L1689) | `/api/sessions/:id/reset` |
| [`api.runRetro`](../src/web/lib/api.ts#L1700) | `/api/sessions/:id/retro` |
| [`api.selectOption`](../src/web/lib/api.ts#L1716) | `/api/sessions/:id/select-option` |
| [`api.submitOptions`](../src/web/lib/api.ts#L1727) | `/api/sessions/:id/submit-options` |
| [`api.submitAnswers`](../src/web/lib/api.ts#L1741) | `/api/sessions/:id/submit-options` |
| [`api.handoff`](../src/web/lib/api.ts#L1754) | `/api/sessions/:id/handoff` |
| [`api.resolveReview`](../src/web/lib/api.ts#L1764) | `/api/reviews/:id/resolve` |
| [`api.dispatch`](../src/web/lib/api.ts#L1772) | `/api/tasks` |
| [`api.startTourDemo`](../src/web/lib/api.ts#L1780) | `/api/tours/:id/dispatch` |
| [`api.startTourPreview`](../src/web/lib/api.ts#L1786) | `/api/tours/:id/preview` |
| [`api.completeTourTask`](../src/web/lib/api.ts#L1792) | `/api/tours/:id/tasks/:id/complete` |
| [`api.dispatchBacklog`](../src/web/lib/api.ts#L1800) | `/api/tasks/:id/dispatch` |
| [`api.recheckPipelineReadiness`](../src/web/lib/api.ts#L1802) | `/api/tasks/:id/pipeline/readiness` |
| [`api.startPipelineAfterReadiness`](../src/web/lib/api.ts#L1804) | `/api/tasks/:id/pipeline/start` |
| [`api.retryPipelineAttempt`](../src/web/lib/api.ts#L1806) | `/api/tasks/:id/pipeline/retry` |
| [`api.refreshPipelineSuccessor`](../src/web/lib/api.ts#L1808) | `/api/tasks/:id/pipeline/successor/refresh` |
| [`api.adoptPipelineSuccessor`](../src/web/lib/api.ts#L1810) | `/api/tasks/:id/pipeline/successor/adopt` |
| [`api.abandonPipelineCommission`](../src/web/lib/api.ts#L1812) | `/api/tasks/:id/pipeline/abandon` |
| [`api.cancelPipelineCommission`](../src/web/lib/api.ts#L1814) | `/api/tasks/:id/pipeline/cancel` |
| [`api.updateTask`](../src/web/lib/api.ts#L1824) | `/api/tasks/:id/update` |
| [`api.reorderTask`](../src/web/lib/api.ts#L1841) | `/api/tasks/:id/reorder` |
| [`api.assignTask`](../src/web/lib/api.ts#L1855) | `/api/tasks/:id/assign` |
| [`api.cancelTask`](../src/web/lib/api.ts#L1866) | `/api/tasks/:id/cancel` |
| [`api.reclaimTask`](../src/web/lib/api.ts#L1867) | `/api/tasks/:id/reclaim` |
| [`api.rescheduleTask`](../src/web/lib/api.ts#L1872) | `/api/tasks/:id/reschedule` |
| [`api.requeueTask`](../src/web/lib/api.ts#L1888) | `/api/tasks/:id/requeue` |
| [`api.completeTask`](../src/web/lib/api.ts#L1876) | `/api/tasks/:id/complete` |
| [`api.deleteTask`](../src/web/lib/api.ts#L1891) | `/api/tasks/:id` |
| [`api.bulkUpdateTasks`](../src/web/lib/api.ts#L1909) | `/api/tasks/bulk-update` |
| [`api.bulkDeleteTasks`](../src/web/lib/api.ts#L1914) | `/api/tasks/bulk-delete` |
| [`api.pushTaskToSource`](../src/web/lib/api.ts#L1900) | `/api/tasks/:id/push` |
| [`api.setForemanConfig`](../src/web/lib/api.ts#L1904) | `/api/foreman/config` |
| [`api.retryForemanPlanner`](../src/web/lib/api.ts#L1905) | `/api/foreman/planner/retry` |
| [`api.setSkillsConfig`](../src/web/lib/api.ts#L1906) | `/api/skills/config` |
| [`api.setHarnessesConfig`](../src/web/lib/api.ts#L1909) | `/api/harnesses/config` |
| [`api.setTerminalsConfig`](../src/web/lib/api.ts#L1911) | `/api/terminals/config` |
| [`api.setInspectorConfig`](../src/web/lib/api.ts#L1912) | `/api/inspector/config` |
| [`api.resolveInspectorFindings`](../src/web/lib/api.ts#L1922) | `/api/inspector/resolve-findings` |
| [`api.setLlmConfig`](../src/web/lib/api.ts#L1926) | `/api/llm/config` |
| [`api.setShippingConfig`](../src/web/lib/api.ts#L1929) | `/api/shipping/config` |
| [`api.setRepoIndex`](../src/web/lib/api.ts#L1932) | `/api/repo-index` |
| [`api.rescanRepoIndex`](../src/web/lib/api.ts#L1934) | `/api/repo-index/rescan` |
| [`api.registerPipelineRepo`](../src/web/lib/api.ts#L1938) | `/api/pipelines/register` |
| [`api.setTaskSources`](../src/web/lib/api.ts#L1945) | `/api/task-sources/config` |
| [`api.sweepTaskSource`](../src/web/lib/api.ts#L1947) | `/api/task-sources/:id/sweep` |
| [`api.preflightTaskSource`](../src/web/lib/api.ts#L1950) | `/api/task-sources/:id/preflight` |
| [`api.forgetTaskSourceSeen`](../src/web/lib/api.ts#L1955) | `/api/task-sources/:id/seen` |
| [`api.retryTaskSourceWriteback`](../src/web/lib/api.ts#L1966) | `/api/task-sources/:id/writeback/retry` |
| [`api.discardTaskSourceWriteback`](../src/web/lib/api.ts#L1972) | `/api/task-sources/:id/writeback` |
| [`api.setUiConfig`](../src/web/lib/api.ts#L1979) | `/api/ui/config` |
| [`api.setCostConfig`](../src/web/lib/api.ts#L1980) | `/api/cost/config` |
| [`api.dismissSetupBanner`](../src/web/lib/api.ts#L1983) | `/api/setup/checks` |
| [`api.setAwayConfig`](../src/web/lib/api.ts#L1987) | `/api/away` |
| [`api.setNote`](../src/web/lib/api.ts#L1988) | `/api/sessions/:id/note` |
| [`api.inviteForeman`](../src/web/lib/api.ts#L1997) | `/api/sessions/:id/foreman-invite` |
| [`api.withdrawForemanInvite`](../src/web/lib/api.ts#L1999) | `/api/sessions/:id/foreman-invite` |
| [`api.resolveEpisode`](../src/web/lib/api.ts#L2011) | `/api/sessions/:id/foreman-episode/resolve` |
| [`api.episodes`](../src/web/lib/api.ts#L2013) | `/api/sessions/:id/foreman-episodes` |
| [`api.goal`](../src/web/lib/api.ts#L2016) | `/api/sessions/:id/goal` |
| [`api.resolvedReviews`](../src/web/lib/api.ts#L2025) | `/api/sessions/:id/resolved-reviews` |
| [`api.addWorkItem`](../src/web/lib/api.ts#L2029) | `/api/sessions/:id/queue` |
| [`api.editWorkItem`](../src/web/lib/api.ts#L2032) | `/api/sessions/:id/queue/:id` |
| [`api.removeWorkItem`](../src/web/lib/api.ts#L2037) | `/api/sessions/:id/queue/:id` |
| [`api.reorderQueue`](../src/web/lib/api.ts#L2039) | `/api/sessions/:id/queue/order` |
| [`api.approveWorkItem`](../src/web/lib/api.ts#L2041) | `/api/sessions/:id/queue/:id/approve` |
| [`api.setWrapupAnswer`](../src/web/lib/api.ts#L2043) | `/api/sessions/:id/queue/wrapup` |
| [`api.startBuiltinReview`](../src/web/lib/api.ts#L2045) | `/api/sessions/:id/workflow-review` |
| [`api.reattachQueue`](../src/web/lib/api.ts#L2054) | `/api/sessions/:id/queue/reattach` |
| [`api.injectPrompt`](../src/web/lib/api.ts#L2057) | `/api/sessions/:id/inject` |
| [`api.listArchives`](../src/web/lib/api.ts#L2063) | Shared request/validation or derived-view helper; action ownership is at its invoking route. |
| [`api.archiveDetail`](../src/web/lib/api.ts#L2072) | `/api/archives/:id` |
| [`api.archiveArtifact`](../src/web/lib/api.ts#L2084) | `/api/archives/:id/artifacts/:id` |
| [`api.openArchiveArtifact`](../src/web/lib/api.ts#L2109) | `/api/archives/:id/artifacts/:id/open` |
| [`api.renameArchive`](../src/web/lib/api.ts#L2116) | `/api/archives/:id` |
| [`api.deleteArchive`](../src/web/lib/api.ts#L2131) | `/api/archives/:id` |
| [`createFileComment`](../src/web/lib/api.ts#L2174) | `/api/sessions/:id/file-comments` |
| [`resolveHtmlBlockAnchor`](../src/web/lib/api.ts#L2189) | `/api/sessions/:id/html-block-anchor` |
| [`resolveHtmlBlockTarget`](../src/web/lib/api.ts#L2250) | `/api/sessions/:id/html-block-target` |
| [`queueFileComment`](../src/web/lib/api.ts#L2281) | `/api/file-comments/:id/queue` |
| [`appendFileCommentMessage`](../src/web/lib/api.ts#L2284) | `/api/file-comments/:id/messages` |
| [`editFileCommentMessage`](../src/web/lib/api.ts#L2289) | `/api/file-comment-messages/:id` |
| [`markFileCommentRead`](../src/web/lib/api.ts#L2294) | `/api/file-comments/:id/read` |
| [`setFileCommentStatus`](../src/web/lib/api.ts#L2302) | `/api/file-comments/:id/status` |
| [`fetchFileCommentThread`](../src/web/lib/api.ts#L2308) | `/api/file-comments/:id` |
| [`reorderFileComments`](../src/web/lib/api.ts#L2311) | `/api/sessions/:id/file-comments/reorder` |
| [`controlFileCommentReview`](../src/web/lib/api.ts#L2342) | `/api/sessions/:id/file-comment-review` |
| [`deleteFileComment`](../src/web/lib/api.ts#L2367) | `/api/file-comments/:id` |
| [`fetchTelemetryConfig`](../src/web/lib/api.ts#L2395) | `/api/telemetry/config` |
| [`fetchTelemetryHealth`](../src/web/lib/api.ts#L2398) | `/api/telemetry/health` |
| [`setTelemetryConfig`](../src/web/lib/api.ts#L2438) | `/api/telemetry/config` |
| [`runTelemetryOperation`](../src/web/lib/api.ts#L2441) | `/api/telemetry/operation` |
| [`probeTelemetryEndpoint`](../src/web/lib/api.ts#L2446) | `/api/telemetry/probe` |
| [`drainTelemetry`](../src/web/lib/api.ts#L2452) | `/api/telemetry/drain` |
| [`submitBrowserTelemetry`](../src/web/lib/api.ts#L2468) | `/api/telemetry/ingress` |
| [`workflowRequest`](../src/web/workflows/workflowApi.ts#L23) | Shared request/validation or derived-view helper; action ownership is at its invoking route. |
| [`personaRequest`](../src/web/workflows/personaApi.ts#L12) | Shared request/validation or derived-view helper; action ownership is at its invoking route. |
| [`deriveImportedPersonaName`](../src/web/workflows/personaApi.ts#L35) | Shared request/validation or derived-view helper; action ownership is at its invoking route. |
| [`personaMarkdownBlob`](../src/web/workflows/personaApi.ts#L42) | Shared request/validation or derived-view helper; action ownership is at its invoking route. |
| [`importPersonaFromPath`](../src/web/workflows/personaApi.ts#L53) | `/api/personas/import` |
| [`reimportPersona`](../src/web/workflows/personaApi.ts#L61) | `/api/personas/:id/reimport` |
| [`fetchPersonaDrift`](../src/web/workflows/personaApi.ts#L75) | `/api/personas/drift` |
| [`sessionActionRequest`](../src/web/workflows/sessionActionApi.ts#L32) | Shared request/validation or derived-view helper; action ownership is at its invoking route. |
| [`sessionActionConflict`](../src/web/workflows/sessionActionApi.ts#L50) | Shared request/validation or derived-view helper; action ownership is at its invoking route. |
| [`fetchSessionActionCapabilities`](../src/web/workflows/sessionActionApi.ts#L82) | `/api/session-actions/capabilities` |
| [`useSessionActionCapabilities`](../src/web/workflows/sessionActionApi.ts#L92) | Shared request/validation or derived-view helper; action ownership is at its invoking route. |
| [`fetchForemanProfile`](../src/web/workflows/foremanProfileApi.ts#L50) | `/api/foreman/instructions` |
| [`updateForemanProfile`](../src/web/workflows/foremanProfileApi.ts#L55) | `/api/foreman/instructions` |
| [`foremanMarkdownBlob`](../src/web/workflows/foremanProfileApi.ts#L66) | Shared request/validation or derived-view helper; action ownership is at its invoking route. |

## MCP operations

The MCP `http` boundary supplies declared agent provenance and an operation ID. Waiting/polling a review is not a second request or a human answer. The dashboard's later resolution has its own actor and outcome. `scripts/smoke-bundles.mjs` checks the complete published tool list via `npm run smoke`.

| Tool | Owner / event or exclusion |
| --- | --- |
| `share_plan` | Review creation, `attention.request` |
| `request_plan_decisions` | Review creation, `attention.request`; subsequent polling excluded |
| `request_review` | Review creation, `attention.request`; subsequent polling excluded |
| `create_task` | Task owner, `task.create`; dispatch remains Phase 3 |
| `request_input` | Review creation, `attention.request`; subsequent polling excluded |
| `report_product_feedback` | Product-issue preview/confirmation/submission owner, `task.issue_*` |
| `report_product_issue` | Product-issue submission owner, `task.issue_submit` |
| `report_status` | Explicitly excluded liveness/status update |
| `respond_to_file_comments` | File-comment owner, `file.comment_reply` |
| `adopt_pipeline_run` | Pipeline owner, `pipeline.adopt` |
| `report_pipeline_workspace` | Pinned workspace owner, `pipeline.workspace` |
| `complete_retro_no_change` | Retrospective owner, `session.retro_no_change` |
| `submit_ensemble_result` | Generic ensemble submission owner, `ensemble.submit` |
| `get_plan_publication_context` | Publication-context read, explicitly excluded |
| `submit_workflow_evidence` | Evidence owner, `runs.evidence_register`; capability probe excluded |
| `submit_scout_artifacts` | Archive submission owner, `archive.scout_submit` |

## Non-HTTP observations

| Entry point | Event / identity | Actor and bound |
| --- | --- | --- |
| `TaskManager.create` | `mission.action.result`, task ID, or enclosing task-create operation | Request context when present; schedule owner when scheduled; otherwise unknown. Multiple member tasks remain distinct. |
| `QueueManager.write` | `mission.automation.transition`, item ID + round + normalized outcome | Request actor when known; otherwise unknown daemon origin. |
| `claimOccurrence` / `finishOccurrence` | `mission.automation.transition`, occurrence ID + outcome | Scheduler owner, separate from schedule configuration. |
| `EnsembleManager.publish` | `mission.automation.transition`, run/member/stage attempt/handoff + outcome | System owner; registered generic primitives, no strategy label. |
| `refreshPipelineRepo` | `mission.automation.transition`, normalized run/step + outcome | Unknown external actor. No fabricated external attempt identity. |
| Commission bind, append, cancel, failure, committed Engineer event | `mission.automation.transition`, commission + active attempt + outcome; retained primary start update | Unknown external observation, correlated to the original app action when retained. |
| Inspector completed analysis / failed work | `mission.automation.transition`, PR key + head + round for completion; failure execution time for retry failures | System owner. Review prose, GitHub URLs and finding content excluded. |
| Registered LLM runner `run` | `mission.error.occurrence`, shared exception occurrence | Optional daemon observer; worker stays HTTP-only. Abort is not a failure. |
| Unexpected API failure | `mission.error.occurrence`, propagated occurrence or new route occurrence | Same operation as the action; header prevents renderer recount. |
| Global renderer error/rejection, action transport, SSE connection | Browser-eligible error/recovery events | Bounded buffer, app-frame minimization and per-minute loop suppression. |
| Startup after unclean predecessor | `mission.error.occurrence`, process / `termination_unknown` | No asserted crash cause and no change to fatal behavior. |
| Foreman answers / workflow persona runs / PR outcomes / cost | Earlier Phase 3/4 sources | Referenced rather than emitted again by Phase 5. |
