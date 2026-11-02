# Set up this machine

## Settings live behind the gear
<!-- stage: settings -->

Everything about this machine is one click away from the gear in the top bar. Next opens it.

## Open Setup
<!-- stage: setup -->

Setup is the first machine-level category in the Settings rail. Next selects it.

## Install what you will use
<!-- stage: dependencies -->

Setup reports every external tool Mission Control can use on this machine, grouped by the work it unlocks. Electron includes Node for the desktop app, binary updates and Mission-owned tools. Runtime identifies the actual serving daemon; external Node is optional for source development and independent tools. Install or configure the tools you expect to use, and skip the rest. An incomplete row names what it unlocks and offers guidance or an action you can start. Nothing installs automatically. In the desktop app, choose Install Claude integrations to install or repair Mission-owned hooks and MCP.

## Re-check once they are installed
<!-- stage: recheck -->

Once a tool is installed or configured, Re-check takes one fresh reading and confirms it. Next moves on from what this machine can do to what it may do on your behalf.

## Trust decides where it may act
<!-- stage: trust -->

Setup is what this machine can do; Trust is which repositories Mission Control may act in. It is the last row in the rail, under Leaves the machine, and the only category on this page that can publish or merge under your GitHub account. Next selects it.

## One table, four grants
<!-- stage: grants -->

Every grant that lets Mission Control act outside this app is here: a row per repository, a column per grant. Each column is one subsystem's own allowlist, and clicking a cell writes there, so the Foreman, Workflows, GitHub Inspector and Shipping panels keep working against the same lists. One place to read who may act where, and no second list to keep in step.

## Add the repositories you work in
<!-- stage: trust-add -->

Pick as many checkouts as you like, or type a path, and add them in one go. Each new row arrives with Foreman, Workflows and GitHub Inspector granted; YOLO merges stays off until you click it, and any grant is one click to revoke. This tour ends here and leaves you on Trust.
