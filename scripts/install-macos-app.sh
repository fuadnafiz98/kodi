#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "$0")/.." && pwd)"
source_app="$project_dir/release/mac-arm64/Kodi.app"
user_applications="${HOME}/Applications"
target_app="$user_applications/Kodi.app"
staged_app="$user_applications/.Kodi.installing.$$"
backup_app="$user_applications/.Kodi.previous.$$"
legacy_app="/Applications/Kodi.app"
trash_dir="${HOME}/.Trash"
bundle_id="com.fuadnafiz.kodi"

if [[ ! -d "$source_app" ]]; then
  echo "Missing packaged app: $source_app" >&2
  echo "Run 'bun run dist:mac' first." >&2
  exit 1
fi

source_bundle_id="$(defaults read "$source_app/Contents/Info.plist" CFBundleIdentifier)"
if [[ "$source_bundle_id" != "$bundle_id" ]]; then
  echo "Unexpected bundle identifier: $source_bundle_id" >&2
  exit 1
fi

cleanup() {
  if [[ -d "$staged_app" ]]; then
    mv "$staged_app" "$trash_dir/Kodi incomplete install.$$"
  fi

  if [[ -d "$backup_app" && ! -d "$target_app" ]]; then
    mv "$backup_app" "$target_app"
  fi
}
trap cleanup EXIT

mkdir -p "$user_applications" "$trash_dir"

pkill -x "Kodi" 2>/dev/null || true
pkill -x "Kodi Helper" 2>/dev/null || true
pkill -x "Kodi Helper (Renderer)" 2>/dev/null || true
pkill -x "Horus" 2>/dev/null || true
pkill -x "Horus Helper" 2>/dev/null || true
pkill -x "Horus Helper (Renderer)" 2>/dev/null || true

ditto "$source_app" "$staged_app"

# electron-builder with CSC_IDENTITY_AUTO_DISCOVERY=false leaves the stock
# Electron linker signature (Identifier=Electron, no sealed resources). Launch
# Services then fails Gatekeeper's first check on a 300 MB bundle — that is the
# long dock bounce when Raycast opens a just-replaced build.
codesign --force --deep --sign - "$staged_app"

staged_bundle_id="$(defaults read "$staged_app/Contents/Info.plist" CFBundleIdentifier)"
if [[ "$staged_bundle_id" != "$bundle_id" ]]; then
  echo "Staged app failed bundle validation." >&2
  exit 1
fi

if [[ -d "$target_app" ]]; then
  mv "$target_app" "$backup_app"
fi

mv "$staged_app" "$target_app"

if [[ -d "$backup_app" ]]; then
  mv "$backup_app" "$trash_dir/Kodi previous.$$"
fi

if [[ -d "$legacy_app" ]]; then
  legacy_bundle_id="$(defaults read "$legacy_app/Contents/Info.plist" CFBundleIdentifier 2>/dev/null || true)"
  if [[ "$legacy_bundle_id" == "$bundle_id" ]]; then
  mv "$legacy_app" "$trash_dir/Kodi legacy.$$"
  fi
fi

# Pre-rename installs keep working from their old paths until this replaces
# them; anything still named Horus.app belongs to the previous identity.
for retired_app in "$user_applications/Horus.app" "/Applications/Horus.app"; do
  if [[ -d "$retired_app" ]]; then
    retired_bundle_id="$(defaults read "$retired_app/Contents/Info.plist" CFBundleIdentifier 2>/dev/null || true)"
    if [[ "$retired_bundle_id" == "com.fuadnafiz.horus" ]]; then
      mv "$retired_app" "$trash_dir/Horus replaced by Kodi.$$"
    fi
  fi
done

# The retired_app loop above owns predecessor cleanup; a same-name check here
# once trashed the app this script had just installed.

mv "$source_app" "$trash_dir/Kodi build.$$"

trap - EXIT

# Put the bundled CLI on PATH so `kodi .` opens the app in this folder.
cli_source="$target_app/Contents/Resources/kodi"
cli_installed=""
if [[ -f "$cli_source" ]]; then
  chmod +x "$cli_source" 2>/dev/null || true
  for cli_dir in "/usr/local/bin" "${HOME}/.local/bin" "${HOME}/bin"; do
    if mkdir -p "$cli_dir" 2>/dev/null && [[ -w "$cli_dir" ]]; then
      ln -sf "$cli_source" "$cli_dir/kodi" && cli_installed="$cli_dir/kodi"
      break
    fi
  done
fi

version="$(defaults read "$target_app/Contents/Info.plist" CFBundleShortVersionString)"
echo "Installed Kodi $version in $target_app."
if [[ -n "$cli_installed" ]]; then
  echo "CLI linked at $cli_installed — run 'kodi .' inside any folder."
else
  echo "CLI not linked: add $cli_source to your PATH to use 'kodi .'." >&2
fi
