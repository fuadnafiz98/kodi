/** Draft text as it is typed, for whoever is showing it — outside React state. */
export interface DraftTextChannel {
  publish(text: string): void
  subscribe(listener: (text: string) => void): () => void
}

export function createDraftTextChannel(): DraftTextChannel {
  const listeners = new Set<(text: string) => void>()
  return {
    publish(text) {
      for (const listener of listeners) listener(text)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }
  }
}
