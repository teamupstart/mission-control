Mission Control
===============

This disk image is the offline copy of Mission Control. Installing from here is
UNMANAGED: the app will not update itself, because nothing on this image records
where it came from.


Install it for yourself
-----------------------

1. Open a Finder window and choose Go > Home, then open the Applications folder
   inside your home folder. Create one if it is not there yet.
2. Drag "Mission Control.app" from this disk image into that folder.
3. Open it from there.

This is the recommended location. It needs no administrator password, it belongs
to your account alone, and it is where a managed install puts the app too.


Install it for everyone on this Mac
-----------------------------------

Drag "Mission Control.app" into the /Applications folder at the top level of your
startup disk instead. macOS will ask for an administrator password.


Turn on automatic updates
-------------------------

The app updates itself only when it was installed by the managed install command,
which builds from a clean checkout and records a receipt. From a checkout of the
repository, run:

    make install

That installs into your own Applications folder by default, replacing whatever
copy you dragged across, and keeps it current from then on. To install for every
account on this Mac instead, run:

    make install ARGS="--scope system"
