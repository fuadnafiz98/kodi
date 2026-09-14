#!/usr/bin/env bash
# The pull-request size matrix, one recorded label per bucket.
#
#   scripts/perf/run-pr-matrix.sh <label-prefix>
#
# Buckets come from `fixtures.json`. Each is run on its own so its samples never
# land in another bucket's percentile — a 1-file open and a 1,263-file open are
# different scenarios, not two samples of one.
#
# The pull requests are public and read with the existing `gh` login. Nothing is
# created, pushed, or modified in any repository.
set -euo pipefail

prefix="${1:?Pass a label prefix, e.g. ab3-post}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

checkout="$(python3 -c "import json;print(json.load(open('scripts/perf/fixtures.json'))['pullRequests']['checkout'])")"
if [[ ! -d "$checkout/.git" ]]; then
  echo "Fixture checkout missing: $checkout" >&2
  echo "Clone it first: git clone --filter=blob:none https://github.com/microsoft/TypeScript.git $checkout" >&2
  exit 2
fi

export KODI_PROBE_HIDDEN=1
export KODI_PERF_CACHE_STATE="${KODI_PERF_CACHE_STATE:-os-page-cache-warm}"
export PR_TIMEOUT_MS="${PR_TIMEOUT_MS:-60000}"

# The review needs the checkout to be an approved root, so open it once and let
# it become the restored session the warm runs start from.
echo "== approving fixture checkout =="
bun -e '
import { launch, settle, quit } from "./scripts/perf/cdp.mjs"
const { cdp } = await launch(9481, ["--kodi-folder", process.argv[2]])
await settle(cdp)
await Bun.sleep(4000)
await quit()
' "$checkout" >/dev/null

python3 -c "
import json
for bucket in json.load(open('scripts/perf/fixtures.json'))['pullRequests']['buckets']:
    print(bucket['id'], bucket['url'], bucket['samples'], bucket['changedFiles'])
" | while read -r id url samples files; do
  echo "== $id ($files changed files, $samples cold samples) =="
  # One unrecorded warmup run, then the recorded one. Samples come from the cold
  # path: a warm reopen of a pull request that already has a tab is absorbed by
  # that tab, so repeating a URL in one warm app measures a single open.
  PRS="$url" COLD_SAMPLES=1 KODI_PERF_FIXTURE="$id" \
    bun scripts/perf/pr-open-probe.mjs "warmup-$prefix-$id" >/dev/null 2>&1 || true

  PRS="$url" COLD_SAMPLES="$samples" KODI_PERF_FIXTURE="$id" \
    bun scripts/perf/pr-open-probe.mjs "$prefix-$id" 2>&1 | grep '^PERF' || echo "  $id produced no PERF line"
done

echo "== done: $prefix =="
