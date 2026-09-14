#!/usr/bin/env bash
# One recorded pass over the scenarios every phase has to re-run: startup,
# same-folder open, resting memory, and the hidden-idle lifecycle probe.
#
#   scripts/perf/run-matrix.sh <label>
#
# Each scenario writes its own artifact under scripts/perf/results/<label>-*.
# Two warmups are discarded before the recorded samples, and the memory pass
# refuses to sample until the process tree is quiet, so two labels are
# comparable only when both say `quiesced=true`.
set -euo pipefail

label="${1:?Pass a label, e.g. baseline-e397494 or post-lifecycle}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
results="$repo_root/scripts/perf/results"
folder="${KODI_PERF_FOLDER:-$repo_root}"
samples="${KODI_PERF_MATRIX_SAMPLES:-30}"

mkdir -p "$results"
cd "$repo_root"

# A run taken while the machine is busy is not comparable with one taken while
# it is idle, and the difference is far larger than anything this program moves.
# Wait for the one-minute load average to fall, then record what it was.
load_limit="${KODI_PERF_LOAD_LIMIT:-6}"
load_wait="${KODI_PERF_LOAD_WAIT_S:-600}"
for ((waited = 0; waited < load_wait; waited += 10)); do
  load_now="$(uptime | sed 's/.*load averages*: *//' | awk '{print $1}' | tr -d ,)"
  awk -v l="$load_now" -v limit="$load_limit" 'BEGIN { exit !(l < limit) }' && break
  echo "waiting for machine load to drop: ${load_now} >= ${load_limit}"
  sleep 10
done
echo "starting $label at load ${load_now} (limit ${load_limit})"

export KODI_PROBE_HIDDEN=1
export KODI_PERF_CACHE_STATE="${KODI_PERF_CACHE_STATE:-os-page-cache-warm}"

echo "== startup: 2 warmups =="
SAMPLES=2 KODI_PERF_FIXTURE=restored-session bun run perf:startup-probe "warmup-$label" >/dev/null

echo "== startup: $samples recorded =="
SAMPLES="$samples" KODI_PERF_FIXTURE=restored-session bun run perf:startup-probe "$label" | tail -3

echo "== open-folder: 2 warmups =="
FOLDERS="$(basename "$folder"),$(basename "$folder")" KODI_PERF_FIXTURE=repo-folder \
  bun run perf:open-folder-probe "warmup-$label-folder" >/dev/null

echo "== open-folder: $samples recorded =="
folder_list="$(python3 -c "import sys;print(','.join([sys.argv[1]]*int(sys.argv[2])))" "$(basename "$folder")" "$samples")"
FOLDERS="$folder_list" KODI_PERF_FIXTURE=repo-folder \
  bun run perf:open-folder-probe "$label-folder" | tail -3

echo "== resting memory =="
if ! bun scripts/perf/memory-probe.mjs "$label" "$folder" >"$results/$label-memory.txt" 2>&1; then
  echo "memory probe FAILED for $label (see $results/$label-memory.txt)"
fi
tail -8 "$results/$label-memory.txt"

# A build without the lifecycle work fails this by design. Record the failure
# instead of aborting: the failing side is half of the before/after comparison.
echo "== lifecycle =="
if ! KODI_PROBE_LIFECYCLE=1 bun scripts/perf/lifecycle-probe.mjs "$folder" \
  >"$results/$label-lifecycle.json" 2>&1; then
  echo "lifecycle probe did NOT pass for $label"
fi
tail -20 "$results/$label-lifecycle.json"

echo "== done: $label =="
