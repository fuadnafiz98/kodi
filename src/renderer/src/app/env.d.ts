/// <reference types="vite/client" />

import type { RepositoryApi } from '../../../shared/contracts'

declare global {
  interface Window {
    repository?: RepositoryApi
  }
}

export {}
