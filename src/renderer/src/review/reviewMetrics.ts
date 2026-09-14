export interface ReviewMetrics {
  loadedItems: number
  hydratedFiles: number
  workspaceRenders: number
  agentStreamEvents: number
}

let loadedItems = 0
const hydratedFiles = new Set<string>()
let workspaceRenders = 0
let agentStreamEvents = 0

export function setLoadedReviewItemCount(count: number): void {
  loadedItems = count
}

export function markReviewFileHydrated(name: string): void {
  hydratedFiles.add(name)
}

export function markRepositoryWorkspaceRender(): void {
  workspaceRenders += 1
}

export function markAgentStreamEvent(): void {
  agentStreamEvents += 1
}

export function resetReviewFileMetrics(): void {
  loadedItems = 0
  hydratedFiles.clear()
}

export function getReviewMetrics(): ReviewMetrics {
  return {
    loadedItems,
    hydratedFiles: hydratedFiles.size,
    workspaceRenders,
    agentStreamEvents
  }
}
