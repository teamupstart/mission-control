# Claude-session control (preview)

From a built checkout, start Mission Control and run `node dist/cli/mctl.mjs setup`. Setup enables the `headless-mode` preview flag, stages the built mod in the Mission Control state directory, and installs it for the current Claude Code user. It detects Claude through `MISSION_CLAUDE_BIN`, PATH, or supported local installation paths. An explicit binary override is authoritative.

Run `node dist/cli/mctl.mjs doctor` to check the daemon, flag, Claude, installed mod, staged version, and allowed daemon calls. Doctor reports enabled plugins with load errors as failures. It does not change settings or spend model tokens.

Setup retries a failed plugin install once. If it still fails, the report includes commands to register the staged marketplace and install the plugin. A failed upgrade can leave the plugin uninstalled; run the recovery commands or retry setup. Setup refuses to stage the mod inside a Git checkout, including through a symlink. Set `MISSION_HOME` to a persistent state directory outside the checkout. Setup also refuses an existing `mission-control` marketplace that points elsewhere; remove that registration before retrying.

Run `node dist/cli/mctl.mjs setup --off` to turn off the preview without uninstalling the plugin. To remove it, run `claude plugin uninstall mission-control@mission-control --scope user`. Service installation and the Codex setup step are not available in this build.
