#!/bin/sh
export E2E_LISTED_TOKEN=synthetic-profile-credential E2E_UNLISTED_TOKEN=unlisted-fixture
exec /bin/sh -c "$2"
