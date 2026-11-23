# Enterprise package recommendations

Enable **Enterprise package recommendations** in **Settings > Feature flags**, then open
**Settings > Setup > Agent CLIs**. Each agent shows its organization's recommended packages,
their source identifiers and installation guides. The operator chooses what to install.
Recommendations do not affect agent readiness, dispatch, or the Setup banner.

## Configure a deployment

Place `enterprise-packages.json` in the daemon's `MISSION_HOME` (normally
`~/.mission-control`). The file replaces the entire [bundled catalog](../config/enterprise-packages.json).
Press **Re-check** after changing the file. Removing it restores the bundled catalog, which
recommends [Upstart's Pi telemetry package](pi-telemetry.md). Use `{"packages":[]}` for a
deployment without recommendations. An invalid or unreadable file shows an error in Agent CLIs
and suppresses all recommendations until corrected.

For example, an organization with a Claude plugin and a Codex package could deploy this file:

```json
{
  "packages": [
    {
      "harness": "claude",
      "label": "Team workflows",
      "source": "team-workflows@company-marketplace",
      "description": "Adds the team's code review workflows to Claude Code.",
      "guide": "https://engineering.example.org/claude/team-workflows"
    },
    {
      "harness": "codex",
      "label": "Team skills",
      "source": "team-skills",
      "description": "Adds the team's release checklist to Codex.",
      "guide": "https://engineering.example.org/codex/team-skills"
    }
  ]
}
```

The supported harness IDs are `claude`, `codex` and `pi`. All five fields in the example are
required. Use an HTTPS guide URL. The source is displayed as text. List several packages for
one harness in display order, using a unique source for each. The catalog accepts up to
64 entries and must be smaller than 64 KiB.

## Check a Pi installation

A Pi entry can also declare `piExtension`. Its `source` must then be an exact
`npm:<package>@<version>` pin. Set `piExtension.entry` to the relative path of the extension
declared in the package's `pi.extensions` manifest. Optionally list conflicting npm package
names in `piExtension.conflicts`. The bundled catalog illustrates both fields.

On Re-check, the daemon reads registration, the installed manifest and the named entry in the
daemon's Pi agent directory. **Ready** means the recommended version is installed and
registered and the expected extension entry is readable. Runtime activation and downstream
service health require the checks in the package's guide. A package without `piExtension`
appears with its installation guide and no installation status.
