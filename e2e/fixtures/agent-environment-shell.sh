#!/bin/sh
export E2E_LISTED_TOKEN=synthetic-profile-credential E2E_UNLISTED_TOKEN=unlisted-fixture
case "$2" in
  *E2E_DELAYED_NAME*)
    : > "$MC_E2E_RECORD_DIR/probe-started"
    while [ ! -f "$MC_E2E_RECORD_DIR/probe-release" ]; do sleep 0.05; done
    ;;
esac
exec /bin/sh -c "$2"
