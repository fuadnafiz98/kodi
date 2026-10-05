// Electron wraps every rejected invoke as "Error invoking remote method
// 'channel': Error: <message>". The channel name means nothing to a reader, and
// it pushed the one sentence that mattered to the end of the banner.
const IPC_ERROR_PREFIX = /^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/

export function getErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(IPC_ERROR_PREFIX, '')
}

export function requireRepositoryApi(): NonNullable<Window['repository']> {
  if (window.repository == null) {
    throw new Error('Desktop integration did not load. Restart the Electron app with “bun run dev”.')
  }
  return window.repository
}
