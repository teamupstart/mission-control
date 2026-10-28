Mission Control
===============

Install for yourself
--------------------
Copy Agent Mission Control.app into the Applications folder inside your home folder,
then open that copy. Create the folder in Finder if necessary. This personal
location needs no administrator password. To share the app across accounts,
copy it into /Applications instead; Finder may request administrator permission.
A persistent custom application directory is also supported.

Opening a signed distribution directly from this disk image offers an explicit
Install Mission Control action before starting the daemon. It never updates or
enrolls a copy inside the image or App Translocation.

Enroll a copied signed app
--------------------------
In the copied app, open Settings > Setup > Application updates and select
Enroll this copied app. Review the displayed destination. The native GitHub CLI
(gh, authenticated for the canonical repository) retrieves the exact published
build and verifies it before a managed binary receipt is written. Conflicting
managed installations and modified copied apps are refused. State is preserved.

Manual replacement without Node
-------------------------------
Use the signed binary installer described at:
https://github.com/teamupstart/mission-control#installation

Quit the existing app first. A rerun keeps its recorded destination and state,
including older source installations, without invoking their source installer.
No host Node, npm, npx, Git or compilation is required. Automatic updates use complete signed stable or exact-SHA alpha binaries.
Old Mission Control.app receipts migrate to Agent Mission Control.app in the same
folder. An occupied new-name destination is refused. Use the current installer;
older saved bootstraps cannot consume the renamed release layout.
Unavailable signed assets are a refusal, never a local build fallback.

Developer builds
----------------
An ad-hoc DMG made with make app is UNMANAGED and cannot use signed enrollment.
Use make install or scripts/install-source.sh with the documented development
prerequisites. Signed distribution and clean-account qualification remain release
gates; a developer package is not proof of Gatekeeper acceptance.
