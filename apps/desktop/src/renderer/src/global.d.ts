import type { Api } from '../../preload/index'

declare global {
  interface Window {
    /** Exposed by src/preload/index.ts via contextBridge. */
    api: Api
  }
}

export {}
