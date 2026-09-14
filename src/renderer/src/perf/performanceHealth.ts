export const HIGH_MEMORY_THRESHOLD_MEGABYTES = 1_024

export function isHighMemory(workingSetMegabytes: number | undefined): boolean {
  return workingSetMegabytes != null && workingSetMegabytes >= HIGH_MEMORY_THRESHOLD_MEGABYTES
}
