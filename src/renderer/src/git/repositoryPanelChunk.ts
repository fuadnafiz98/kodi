// One loader shared by the lazy panel and the titlebar's hover warm-up, so a
// pointer resting on the button has the chunk parsed before the click lands.
export const loadRepositoryPanel = (): Promise<typeof import('../github/GitHubPanel')> =>
  import('../github/GitHubPanel')

export function preloadRepositoryPanel(): void {
  void loadRepositoryPanel().catch(() => {})
}
