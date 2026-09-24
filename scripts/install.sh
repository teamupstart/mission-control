#!/bin/bash
# Download only the bootstrap checkout. The shared installer owns release selection,
# packaging, destination policy, verification, and the managed install receipt.
set -euo pipefail

main() {
  if [[ "$(uname -s)" != Darwin ]]; then
    echo "Mission Control's desktop app requires macOS on Apple Silicon." >&2
    return 1
  fi
  for tool in git node; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      echo "$tool is required. Install Node.js 24+ and the Xcode command line tools, then rerun this command." >&2
      return 1
    fi
  done

  mission_install_tmp=$(mktemp -d "${TMPDIR:-/tmp}/mission-control-bootstrap.XXXXXX")
  trap 'rm -rf -- "$mission_install_tmp"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  git clone --depth 1 https://github.com/teamupstart/mission-control.git "$mission_install_tmp/bootstrap"
  node "$mission_install_tmp/bootstrap/scripts/install-app.mjs" --temporary-source "$@"
}

# A complete function is parsed before anything runs, including when read from stdin.
main "$@"
