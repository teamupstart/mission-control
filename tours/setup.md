# Set up this machine

## Settings live behind the gear
<!-- stage: settings -->

Everything about this machine is one click away from the gear in the top bar. Next opens it.

## Open Setup
<!-- stage: setup -->

Setup is the first machine-level category in the Settings rail. Next selects it.

## Install what you will use
<!-- stage: dependencies -->

Setup reports every external tool Mission Control can use on this machine, grouped by the work it unlocks. Install or configure the ones you expect to use, and skip the rest. An incomplete row names what it unlocks and offers a link, a copyable command, or a visible-terminal action, and nothing here is installed for you.

## Re-check once they are installed
<!-- stage: recheck -->

Once a tool is installed or configured, Re-check takes one fresh reading and confirms it. Next moves on from what this machine can do to what it may do on your behalf.

## Trust decides where it may act
<!-- stage: trust -->

Setup is what this machine can do; Trust is which repositories Mission Control may act in. It is the last row in the rail, under Leaves the machine, and the only category on this page that can publish or merge under your GitHub account. Next selects it.

## One table, four grants
<!-- stage: grants -->

Every grant that lets Mission Control act outside this app is here: a row per repository, a column per grant. Clicking a cell writes to that subsystem's own allowlist - Foreman, Workflows, GitHub Inspector, Shipping - so there is one place to read who may act where, and no second list to keep in step.

## Add a repository, then grant it
<!-- stage: trust-add -->

Add the checkouts you work in. Adding is configuration; enabling is consent, so a new row arrives with every cell empty and stays that way until you click one. This tour ends here and leaves you on Trust.
