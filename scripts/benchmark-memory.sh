#!/usr/bin/env bash
set -euo pipefail

sample_label="${1:-manual}"
sample_count="${KODI_PERF_SAMPLES:-5}"
sample_interval="${KODI_PERF_INTERVAL:-2}"
root_pid="${KODI_ROOT_PID:-${2:-}}"

if [[ -z "$root_pid" ]]; then
  echo "Set KODI_ROOT_PID (or pass the PID as argument 2). Refusing to guess between Kodi instances." >&2
  exit 2
fi
if ! [[ "$root_pid" =~ ^[0-9]+$ ]] || ! ps -p "$root_pid" -o pid= >/dev/null 2>&1; then
  echo "KODI_ROOT_PID does not identify a running process: $root_pid" >&2
  exit 2
fi

process_name="$(ps -p "$root_pid" -o comm= | sed 's#^.*/##')"

# Sampling a tree that is still opening a repository measures the work, not the
# resting cost, and a run that quiesced cannot be compared against one that did
# not. Wait for every non-Electron child (git, gh, rg) to exit and for the tree
# CPU to fall below the threshold, then say in the output whether that happened.
quiesce_timeout="${KODI_PERF_QUIESCE_TIMEOUT_S:-45}"
quiesce_cpu="${KODI_PERF_QUIESCE_CPU:-8}"
quiesce_stable="${KODI_PERF_QUIESCE_STABLE_S:-3}"

tree_pids() {
  ps -axo pid=,ppid= | awk -v root="$root_pid" '
    { pids[NR] = $1; parent[$1] = $2 }
    END {
      included[root] = 1
      changed = 1
      while (changed) {
        changed = 0
        for (row = 1; row <= NR; row += 1) {
          pid = pids[row]
          if (!included[pid] && included[parent[pid]]) { included[pid] = 1; changed = 1 }
        }
      }
      for (row = 1; row <= NR; row += 1) if (included[pids[row]]) print pids[row]
    }
  '
}

tree_stat() {
  local pids
  pids="$(tree_pids | paste -sd, -)"
  [[ -n "$pids" ]] || { echo "0 0"; return; }
  ps -p "$pids" -o %cpu=,comm= | awk '
    { cpu += $1; if ($2 !~ /Kodi/) helpers += 1 }
    END { printf "%.1f %d", cpu + 0, helpers + 0 }
  '
}

quiesced=false
stable_for=0
for ((waited = 0; waited < quiesce_timeout; waited += 1)); do
  read -r tree_cpu helper_count <<<"$(tree_stat)"
  if awk -v c="$tree_cpu" -v limit="$quiesce_cpu" 'BEGIN { exit !(c < limit) }' && ((helper_count == 0)); then
    stable_for=$((stable_for + 1))
    if ((stable_for >= quiesce_stable)); then quiesced=true; break; fi
  else
    stable_for=0
  fi
  sleep 1
done

echo "# root_pid=$root_pid root_process=$process_name quiesced=$quiesced quiesce_cpu_limit=$quiesce_cpu"
echo "label,sample,timestamp,pid,ppid,rss_mb,cpu_percent,process"
total_rss_values=()
total_cpu_values=()
child_count_values=()
for ((sample = 1; sample <= sample_count; sample += 1)); do
  timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  sample_rows="$(ps -axo pid=,ppid=,rss=,%cpu=,comm= | awk \
    -v root="$root_pid" -v label="$sample_label" -v sample="$sample" -v timestamp="$timestamp" '
    {
      pids[NR] = $1
      parent[$1] = $2
      rss[$1] = $3
      cpu[$1] = $4
      process = $5
      for (field = 6; field <= NF; field += 1) process = process " " $field
      commands[$1] = process
    }
    END {
      included[root] = 1
      changed = 1
      while (changed) {
        changed = 0
        for (row = 1; row <= NR; row += 1) {
          pid = pids[row]
          if (!included[pid] && included[parent[pid]]) {
            included[pid] = 1
            changed = 1
          }
        }
      }
      for (row = 1; row <= NR; row += 1) {
        pid = pids[row]
        if (!included[pid]) continue
        command = commands[pid]
        gsub(/"/, "\"\"", command)
        printf "%s,%d,%s,%d,%d,%.1f,%s,\"%s\"\n", label, sample, timestamp, pid, parent[pid], rss[pid] / 1024, cpu[pid], command
      }
    }
  ')"
  echo "$sample_rows"
  total_rss_values+=("$(awk -F, '{ sum += $6 } END { printf "%.1f", sum }' <<<"$sample_rows")")
  total_cpu_values+=("$(awk -F, '{ sum += $7 } END { printf "%.1f", sum }' <<<"$sample_rows")")
  child_count_values+=("$(awk 'END { print NR }' <<<"$sample_rows")")
  if ((sample < sample_count)); then sleep "$sample_interval"; fi
done

percentile() {
  local fraction="$1"
  shift
  printf '%s\n' "$@" | sort -n | awk -v fraction="$fraction" '{ values[NR] = $1 } END {
    if (NR == 0) { print "null"; exit }
    rank = int(NR * fraction)
    if (rank < NR * fraction) rank += 1
    if (rank < 1) rank = 1
    print values[rank]
  }'
}

echo "summary,total_rss_p50_mb,total_rss_p95_mb,total_rss_max_mb,total_cpu_p50_percent,total_cpu_p95_percent,process_count_max,quiesced"
echo "summary,$(percentile 0.50 "${total_rss_values[@]}"),$(percentile 0.95 "${total_rss_values[@]}"),$(printf '%s\n' "${total_rss_values[@]}" | sort -nr | head -1),$(percentile 0.50 "${total_cpu_values[@]}"),$(percentile 0.95 "${total_cpu_values[@]}"),$(printf '%s\n' "${child_count_values[@]}" | sort -nr | head -1),$quiesced"

echo
echo "macOS physical footprint"
while IFS= read -r pid; do
  [[ -n "$pid" ]] || continue
  echo "pid=$pid"
  footprint -p "$pid" 2>/dev/null | awk '
    /64-bit    Footprint:/ || /phys_footprint:/ || /phys_footprint_peak:/ { print }
  '
done < <(ps -axo pid=,ppid= | awk -v root="$root_pid" '
  { pids[NR] = $1; parent[$1] = $2 }
  END {
    included[root] = 1
    changed = 1
    while (changed) {
      changed = 0
      for (row = 1; row <= NR; row += 1) {
        pid = pids[row]
        if (!included[pid] && included[parent[pid]]) { included[pid] = 1; changed = 1 }
      }
    }
    for (row = 1; row <= NR; row += 1) if (included[pids[row]]) print pids[row]
  }
')
