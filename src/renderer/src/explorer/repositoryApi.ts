export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function requireRepositoryApi(): NonNullable<Window['repository']> {
  if (window.repository == null) {
    throw new Error('Desktop integration did not load. Restart the Electron app with “bun run dev”.')
  }
  return window.repository
}
