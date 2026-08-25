import type { OscineApi } from './index'

declare global {
  interface Window {
    /**
     * The only channel between the renderer and the rest of the application.
     * Defined in `src/preload/index.ts`, typed from the contract in `src/shared`.
     */
    oscine: OscineApi
  }
}

export {}
