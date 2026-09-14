#!/usr/bin/env bash
set -euo pipefail

sample_label="${1:-manual}"
sample_count="${KODI_PERF_SAMPLES:-5}"
sample_interval="${KODI_PERF_INTERVAL:-2}"
process_name_pattern="${KODI_PROCESS_NAME:-^(Kodi|Electron)$}"

root_pid="$({
  ps -axo pid=,ppid=,comm= | awk -v pattern="$process_name_pattern" '
    {
      process = $3
      for (field = 4; field <= NF; field += 1) process = process " " $field
      sub(/^.*\//, "", process)
      if (process ~ pattern) { print $1; exit }
    }
  '
} || true)"

if [[ -z "$root_pid" ]]; then
  echo "Kodi is not running." >&2
  exit 1
fi

process_name="$(ps -p "$root_pid" -o comm= | sed 's#^.*/##')"
echo "# root_pid=$root_pid root_process=$process_name"
echo "label,sample,timestamp,pid,ppid,rss_mb,cpu_percent,process"
for ((sample = 1; sample <= sample_count; sample += 1)); do
  timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  ps -axo pid=,ppid=,rss=,%cpu=,comm= | awk \
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
  '
  if ((sample < sample_count)); then sleep "$sample_interval"; fi
done

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
