import type { FermataApi } from './index'

declare global {
  interface Window {
    fermata: FermataApi
  }
}

export {}
