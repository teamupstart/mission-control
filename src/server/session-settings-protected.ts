import { controlMetadata } from "./session-settings-specialized.ts";
import type { SettingDescriptor } from "./settings-dispatcher.ts";

export function operatorSetting(key: string, control: string, reason: string, label?: string): SettingDescriptor {
  const metadata = controlMetadata(control);
  return { ...metadata, label: label ?? metadata.label, key, access: "protected", reason };
}

/** These controls change authority, expose private values, or initiate operator actions. */
export const protectedSettings = [
  operatorSetting("featureFlags.enableAll", "feature-flags-enable-all", "The master switch can enable protected features."),
  operatorSetting("featureFlags.overrides", "feature-flags-enable-all", "Bulk reset can re-enable protected features.", "Reset feature flag overrides"),
  operatorSetting("agentEnvironment", "agent-environment-names", "Selects which workstation variables future sessions receive."),
  operatorSetting("harnesses.autoModeOnDispatch", "auto-mode", "Changes the approval mode for future sessions."),
  operatorSetting("shaping.shapers", "task-shaping-shapers", "Configures executable shapers and credential references."),
  operatorSetting("shaping.overrides", "task-shaping-shapers", "Enables or disables executable shapers.", "Shaper enablement"),
  operatorSetting("shaping.order", "task-shaping-shapers", "Ordering affects which executable shapers run within the budget.", "Shaper order"),
  operatorSetting("shaping.import", "task-shaping-import", "Imports or dry-runs executable shapers."),
  operatorSetting("shaping.caller", "task-shaping-identity", "Controls attribution sent to external services."),
  operatorSetting("voice.muted", "voice-mode", "Changes live microphone capture."),
  operatorSetting("voice.hotkey", "voice-hotkey", "The desktop must reserve and verify the native shortcut."),
  operatorSetting("voice.listeningMode", "voice-listening-mode", "Changes when the workstation captures microphone input."),
  operatorSetting("voice.showTranscript", "voice-mode", "Controls whether private speech appears on the dashboard.", "Show live voice transcript"),
  operatorSetting("voice.decisionProvider", "voice-mode", "Selecting an external provider authorizes sending spoken text.", "Voice decision provider"),
  operatorSetting("voice.decisionKey", "voice-mode", "Credentials are managed by the operator.", "Voice decision credentials"),
  operatorSetting("voice.heard", "voice-heard", "Heard text may contain private speech."),
  operatorSetting("instructions.standing.default", "standing-instructions-default", "Instructions are injected into future agent launches."),
  operatorSetting("instructions.standing.repositories", "standing-instructions-repositories", "Repository instructions are injected into future agent launches."),
  operatorSetting("reports.muted", "reports-muted", "Only the operator may change which authors are muted."),
  operatorSetting("cost.enabled", "cost-track", "Controls usage export and edits user-local Claude settings."),
  operatorSetting("telemetry.collect", "telemetry-collect", "Requires the operator's collection consent."),
  operatorSetting("telemetry.user", "telemetry-user", "Controls external export and contains credential settings."),
  operatorSetting("telemetry.product", "telemetry-product", "Requires the operator's analytics consent."),
  operatorSetting("telemetry.identity", "telemetry-identity", "Installation identity and rotation affect privacy."),
  operatorSetting("settings.restore", "restore-settings", "A confirmed restore can change multiple settings and grants."),
  operatorSetting("updates.alpha", "setup-checks", "The desktop updater owns signed build selection and enabling Alpha also enables previews.", "Alpha updates"),
  operatorSetting("workflows.liveEnabled", "workflow-live-delivery", "Live repair delivery requires explicit operator arming."),
  operatorSetting("workflows.repoAllowlist", "workflow-allowlist", "Grants execution in repositories."),
  operatorSetting("workflows.checksEnabled", "workflow-checks", "Arms branch-authored command execution."),
  operatorSetting("workflows.checkCommands", "workflow-check-commands", "Configures command execution."),
  operatorSetting("pipelines.repos", "conductor-repos", "Grants external engine access to repositories."),
  operatorSetting("pipelines.enabled", "conductor-enabled", "Activates commissioned repository observation."),
  operatorSetting("pipelines.foremanMechanicalTriage", "conductor-foreman-triage", "Authorizes automated intervention in external pipelines."),
  operatorSetting("inspector.mode", "inspector-mode", "Live mode authorizes GitHub posting."),
  operatorSetting("shipping.autoMerge", "yolo", "Authorizes automatic GitHub merges."),
  operatorSetting("trust.grants", "trust-grants", "Repository grants and their staging are operator-controlled."),
  ...(["foreman", "inspector", "shipping"] as const).map(owner =>
    operatorSetting(`${owner}.repoAllowlist`, "trust-grants", "Grants unattended repository actions.", `${owner} repository grants`)),
  operatorSetting("foreman.instructions", "foreman-tier", "Standing instructions affect future automated decisions.", "Foreman standing instructions"),
  operatorSetting("foreman.enabled", "foreman-tier", "Enables unattended agent and repository actions.", "Enable Foreman"),
  operatorSetting("foreman.mode", "foreman-tier", "Grants live action delivery.", "Foreman action mode"),
  operatorSetting("foreman.autoApproveAccess", "foreman-tier", "Allows automated approval of access prompts.", "Foreman access approvals"),
  operatorSetting("shipping.codeRabbitAutoResolve", "yolo", "Controls automatic external review follow-up.", "CodeRabbit follow-up"),
  operatorSetting("worktrees.repositorySetup", "worktree-policy", "Setup commands and dependency claims can run executable code.", "Repository worktree setup"),
];
