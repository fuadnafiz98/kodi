#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$project_dir"

if [[ "$(uname -s)" != "Darwin" ]]; then
  exec bun x electron-vite dev "$@"
fi

electron_version="$(bun -e 'console.log(require("./node_modules/electron/package.json").version)')"
cache_base="$HOME/Library/Caches/Kodi"
branded_dist="$cache_base/electron-$electron_version-v1"
brand_marker="$branded_dist/.kodi-brand"

if [[ ! -f "$brand_marker" ]]; then
  mkdir -p "$cache_base"
  staging_dir="$(mktemp -d "$cache_base/.branding.XXXXXX")"
  trap 'rm -rf "$staging_dir"' EXIT

  ditto "$project_dir/node_modules/electron/dist" "$staging_dir/dist"
  app_bundle="$staging_dir/dist/Electron.app"
  info_plist="$app_bundle/Contents/Info.plist"
  plist_buddy=/usr/libexec/PlistBuddy

  "$plist_buddy" -c 'Set :CFBundleName Kodi' "$info_plist"
  if ! "$plist_buddy" -c 'Set :CFBundleDisplayName Kodi' "$info_plist" 2>/dev/null; then
    "$plist_buddy" -c 'Add :CFBundleDisplayName string Kodi' "$info_plist"
  fi
  "$plist_buddy" -c 'Set :CFBundleIdentifier com.fuadnafiz.kodi.development' "$info_plist"

  codesign --force --deep --sign - "$app_bundle" >/dev/null
  touch "$staging_dir/dist/.kodi-brand"
  mv "$staging_dir/dist" "$branded_dist"
  trap - EXIT
  rmdir "$staging_dir"
fi

export ELECTRON_EXEC_PATH="$branded_dist/Electron.app/Contents/MacOS/Electron"
exec bun x electron-vite dev "$@"
