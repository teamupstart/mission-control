#!/bin/bash
# Generated as install.sh by render-install-bootstrap.mjs. Edit this template.
# Only fixed macOS tools and native gh execute before publisher verification.
set -euo pipefail

fail() { echo "Mission Control: $*" >&2; exit 1; }
field() { /usr/bin/plutil -extract "$2" raw -o - "$1" 2>/dev/null || fail "Missing or invalid metadata: $2"; }
digest() { local value; value=$(/usr/bin/openssl dgst -sha256 "$1"); echo "${value##* }"; }

download() {
  local endpoint=$1 output=$2 limit=$3 accept=${4:-application/vnd.github+json} pid watchdog result=0 seconds=120
  [[ $limit -le 16777216 ]] || seconds=900
  # Bound disk consumption as well as elapsed time. Transport diagnostics stay private.
  (ulimit -f $((limit / 1024 + 1)); exec "$mission_gh" api --hostname github.com "$endpoint" -H "Accept: $accept") >"$output" 2>"$mission_tmp/transport.log" &
  pid=$!
  (trap 'kill "$sleeper" 2>/dev/null || true' TERM EXIT
    /bin/sleep "$seconds" & sleeper=$!
    wait "$sleeper"
    kill -TERM "$pid" 2>/dev/null || true) >/dev/null 2>&1 & watchdog=$!
  wait "$pid" || result=$?
  kill "$watchdog" 2>/dev/null || true
  wait "$watchdog" 2>/dev/null || true
  [[ $result == 0 ]] || fail "Canonical download failed. Check gh authentication and connectivity; no source build was attempted."
  [[ $(/usr/bin/stat -f %z "$output") -le $limit ]] || fail "Download exceeds its size limit."
}

verify_app() {
  local app=$1 link target count=0 size
  [[ -d "$app" && ! -L "$app" ]] || fail "The image has no regular Mission Control.app."
  size=$(/usr/bin/du -sk "$app"); size=${size%%[[:space:]]*}
  [[ $size -le 8388608 ]] || fail "The app exceeds the unpacked size limit."
  # Framework links are expected, but every resolved target must stay inside this app.
  while IFS= read -r -d '' link; do
    count=$((count + 1)); [[ $count -le 200000 ]] || fail "App inventory exceeds its limit."
    if [[ -L "$link" ]]; then
      target=$link
      for ((depth=0; depth<40; depth++)); do
        target="$(cd -P -- "$(/usr/bin/dirname "$target")" && pwd)/$(/usr/bin/basename "$target")"
        [[ -L "$target" ]] || break
        value=$(/usr/bin/readlink "$target")
        if [[ "$value" == /* ]]; then target=$value; else target="$(/usr/bin/dirname "$target")/$value"; fi
      done
      [[ $depth -lt 40 && -e "$target" && "$target" == "$app/"* ]] || fail "The app contains an escaping or invalid link."
    fi
  done < <(/usr/bin/find "$app" -print0)
  [[ $(field "$app/Contents/Info.plist" CFBundleIdentifier) == '@BUNDLE_ID@' ]] || fail "Unexpected app identity."
  [[ $(field "$app/Contents/Info.plist" CFBundleExecutable) == 'Mission Control' ]] || fail "Unexpected app executable."
  [[ $(/usr/bin/od -An -tx1 -N8 "$app/Contents/MacOS/Mission Control" | /usr/bin/tr -d ' \n') == cffaedfe0c000001 ]] || fail "The app is not an arm64 executable."
  /usr/bin/codesign --verify --deep --strict --all-architectures -R 'anchor apple generic and identifier "@BUNDLE_ID@" and certificate leaf[subject.OU] = "@TEAM@"' "$app" 2>"$mission_tmp/signature.log" || fail "App publisher verification failed."
  /usr/sbin/spctl --assess --type execute --verbose=4 "$app" 2>"$mission_tmp/assessment.log" || fail "macOS refused the app."
  /usr/bin/grep -qx 'source=Notarized Developer ID' "$mission_tmp/assessment.log" || fail "The app is not notarized."
  local metadata="$app/Contents/Resources/app/package.json"
  [[ $(field "$metadata" missionBinary.commit) == "$commit" && $(field "$metadata" missionBinary.version) == "$version" ]] || fail "The signed app differs from the selected release."
}

main() {
  local ref='' channel='' scope='' apps='' repo='@REPO@' option seen=' '
  local -a forwarded=()
  while [[ $# -gt 0 ]]; do
    option=$1; shift
    [[ "$seen" != *" $option "* ]] || fail "Repeated option: $option"
    seen="$seen$option "
    case "$option" in
      --ref|--channel|--scope|--apps-dir|--repo)
        [[ $# -gt 0 && -n $1 ]] || fail "$option needs a value."
        case "$option" in
          --ref) ref=$1;; --channel) channel=$1;; --scope) scope=$1; forwarded+=(--scope "$1");;
          --apps-dir) apps=$1; forwarded+=(--apps-dir "$1");; --repo) repo=$1;;
        esac; shift;;
      --dry-run|--enroll) forwarded+=("$option");;
      --help|-h) echo 'Usage: install.sh [--ref vX.Y.Z|FULL_SHA] [--channel stable|alpha] [--scope user|system | --apps-dir DIR] [--dry-run] [--enroll]'; return;;
      *) fail "$option is unsupported by the binary installer. Source builds and forks use scripts/install-source.sh or node scripts/install-app.mjs.";;
    esac
  done
  [[ "$repo" == '@REPO@' ]] || fail "Binary installation trusts only @REPO@. Use the explicit source installer for forks."
  [[ -z "$scope" || "$scope" == user || "$scope" == system ]] || fail 'Scope must be user or system.'
  [[ -z "$scope" || -z "$apps" ]] || fail '--scope and --apps-dir cannot be combined.'
  [[ -z "$channel" || "$channel" == stable || "$channel" == alpha ]] || fail 'Channel must be stable or alpha.'
  if [[ -n "$ref" ]]; then
    if [[ "$ref" =~ ^[a-f0-9]{40}$ ]]; then [[ "$channel" != stable ]] || fail 'A full SHA requires alpha.'; channel=alpha
    elif [[ "$ref" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then [[ "$channel" != alpha ]] || fail 'A version tag requires stable.'; channel=stable
    else fail 'Select a stable vX.Y.Z tag or full lowercase main SHA.'; fi
  fi
  channel=${channel:-stable}
  [[ $(/usr/bin/uname -s) == Darwin && $(/usr/bin/uname -m) == arm64 ]] || fail 'The desktop app requires macOS on Apple Silicon.'
  [[ $(/usr/bin/sw_vers -productVersion) != 10.* && $(/usr/bin/sw_vers -productVersion) != 11.* ]] || fail 'macOS 12 or newer is required.'
  mission_gh=$(command -v gh) || fail 'GitHub CLI (gh) is required for authenticated downloads. Install its native binary or download the signed DMG from GitHub Releases.'
  unset GH_DEBUG DEBUG NODE_OPTIONS NODE_PATH
  export GH_HOST=github.com GH_PROMPT_DISABLED=1 LC_ALL=C
  umask 077
  mission_tmp=$(/usr/bin/mktemp -d /private/tmp/mission-binary-install.XXXXXX)
  mission_mounted=0
  trap 'if [[ $mission_mounted == 1 ]]; then /usr/bin/hdiutil detach "$mission_tmp/image" >/dev/null 2>&1 || true; fi; echo "Installer files retained at $mission_tmp" >&2' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  if [[ -z "$ref" && "$channel" == alpha ]]; then
    download 'repos/@REPO@/commits/main' "$mission_tmp/commit.json" 1048576
    ref=$(field "$mission_tmp/commit.json" sha)
    [[ "$ref" =~ ^[a-f0-9]{40}$ ]] || fail 'Invalid main identity.'
  fi
  local tag endpoint release="$mission_tmp/release.json" manifest="$mission_tmp/manifest.json"
  if [[ "$channel" == alpha ]]; then tag="alpha-$ref"; else tag=$ref; fi
  endpoint="repos/@REPO@/releases/tags/$tag"; [[ -n "$tag" ]] || endpoint='repos/@REPO@/releases/latest'
  download "$endpoint" "$release" 1048576
  [[ $(field "$release" draft) == false ]] || fail 'Draft releases cannot be installed.'
  tag=$(field "$release" tag_name)
  if [[ "$channel" == stable ]]; then
    [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ && $(field "$release" prerelease) == false ]] || fail 'Expected a stable release.'
  else [[ "$tag" == "alpha-$ref" && $(field "$release" prerelease) == true ]] || fail 'Expected the exact alpha release.'; fi
  local manifest_id='' id name bytes index=0
  while /usr/bin/plutil -extract "assets.$index" xml1 -o - "$release" >/dev/null 2>&1; do
    name=$(field "$release" "assets.$index.name")
    if [[ "$name" == '@MANIFEST@' ]]; then
      [[ -z "$manifest_id" ]] || fail 'Duplicate ready manifest.'
      manifest_id=$(field "$release" "assets.$index.id")
    fi
    index=$((index + 1)); [[ $index -le 100 ]] || fail 'Release inventory exceeds its limit.'
  done
  [[ "$manifest_id" =~ ^[1-9][0-9]*$ ]] || fail 'This release has no ready binary. Retry after publication, or select an explicit ready release; no compilation fallback is available.'
  download "repos/@REPO@/releases/assets/$manifest_id" "$manifest" @MAX_MANIFEST@ application/octet-stream
  [[ $(field "$manifest" protocol) == 1 && $(field "$manifest" repo) == '@REPO@' && $(field "$manifest" bundleId) == '@BUNDLE_ID@' && $(field "$manifest" arch) == arm64 && $(field "$manifest" platform) == darwin && $(field "$manifest" channel) == "$channel" ]] || fail 'Unexpected manifest identity or protocol.'
  commit=$(field "$manifest" commit); version=$(field "$manifest" version)
  [[ "$commit" =~ ^[a-f0-9]{40}$ ]] || fail 'Invalid commit.'
  if [[ "$channel" == stable ]]; then [[ "$tag" == "v$version" && $(field "$manifest" releaseTag) == "$tag" ]] || fail 'Stable identity mismatch.'
  else [[ "$commit" == "$ref" ]] || fail 'Alpha identity mismatch.'; fi
  download "repos/@REPO@/commits/$tag" "$mission_tmp/tag.json" 1048576
  [[ $(field "$mission_tmp/tag.json" sha) == "$commit" ]] || fail 'Release tag and manifest disagree.'
  # Both assets must still exist in the accepted release. Full C1 validation follows
  # in the verified runtime before it can mutate any installation or receipt.
  local asset_index release_index found dmg_id='' dmg_bytes='' dmg_hash='' kind hash
  for asset_index in 0 1; do
    id=$(field "$manifest" "assets.$asset_index.id"); name=$(field "$manifest" "assets.$asset_index.name")
    bytes=$(field "$manifest" "assets.$asset_index.bytes"); kind=$(field "$manifest" "assets.$asset_index.kind"); hash=$(field "$manifest" "assets.$asset_index.sha256")
    [[ "$id" =~ ^[1-9][0-9]{0,17}$ && "$bytes" =~ ^[1-9][0-9]{0,9}$ && $bytes -le @MAX_ASSET@ && "$hash" =~ ^[a-f0-9]{64}$ ]] || fail 'Invalid asset identity, size or digest.'
    found=0
    for ((release_index=0; release_index<index; release_index++)); do
      if [[ $(field "$release" "assets.$release_index.id") == "$id" && $(field "$release" "assets.$release_index.name") == "$name" && $(field "$release" "assets.$release_index.size") == "$bytes" && $(field "$release" "assets.$release_index.state") == uploaded ]]; then found=$((found + 1)); fi
    done
    [[ $found == 1 ]] || fail 'The ready release is incomplete.'
    if [[ "$kind" == dmg ]]; then [[ -z "$dmg_id" ]] || fail 'Duplicate DMG.'; dmg_id=$id; dmg_bytes=$bytes; dmg_hash=$hash
    else [[ "$kind" == app-zip ]] || fail 'Unexpected asset kind.'; fi
  done
  [[ -n "$dmg_id" ]] || fail 'The manifest has no DMG.'
  echo "Installing $tag ($commit) from @REPO@"
  download "repos/@REPO@/releases/assets/$dmg_id" "$mission_tmp/installer.dmg" "$dmg_bytes" application/octet-stream
  [[ $(/usr/bin/stat -f %z "$mission_tmp/installer.dmg") == "$dmg_bytes" && $(digest "$mission_tmp/installer.dmg") == "$dmg_hash" ]] || fail 'DMG size or SHA-256 mismatch.'
  /usr/bin/codesign --verify --strict -R 'anchor apple generic and certificate leaf[subject.OU] = "@TEAM@"' "$mission_tmp/installer.dmg" 2>"$mission_tmp/signature.log" || fail 'DMG publisher verification failed.'
  /usr/sbin/spctl --assess --type open --context context:primary-signature --verbose=4 "$mission_tmp/installer.dmg" 2>"$mission_tmp/assessment.log" || fail 'macOS refused the DMG.'
  /usr/bin/grep -qx 'source=Notarized Developer ID' "$mission_tmp/assessment.log" || fail 'The DMG is not notarized.'
  /bin/mkdir "$mission_tmp/image"
  /usr/bin/hdiutil attach "$mission_tmp/installer.dmg" -readonly -nobrowse -mountpoint "$mission_tmp/image" >"$mission_tmp/mount.log" 2>&1 || fail 'Could not mount the DMG read-only.'
  mission_mounted=1
  local entry
  shopt -s dotglob nullglob
  for entry in "$mission_tmp/image/"*; do
    case "${entry##*/}" in 'Mission Control.app'|'Read Me.txt'|'.DS_Store'|'.background'|'.VolumeIcon.icns'|'.fseventsd'|'.Trashes') ;; *) fail 'Unexpected DMG root.';; esac
  done
  verify_app "$mission_tmp/image/Mission Control.app"
  /usr/bin/ditto "$mission_tmp/image/Mission Control.app" "$mission_tmp/Mission Control.app"
  verify_app "$mission_tmp/Mission Control.app"
  /usr/bin/hdiutil detach "$mission_tmp/image" >/dev/null; mission_mounted=0
  # The complete private runtime survives every destination rename and all its
  # synchronous children. Failures retain it for recovery; no candidate runs mounted.
  ELECTRON_RUN_AS_NODE=1 "$mission_tmp/Mission Control.app/Contents/MacOS/Mission Control" \
    "$mission_tmp/Mission Control.app/Contents/Resources/app/scripts/install-binary.mjs" \
    --bundle "$mission_tmp/Mission Control.app" --manifest "$manifest" "${forwarded[@]}"
  trap - EXIT
  /bin/rm -rf -- "$mission_tmp"
}
main "$@"
