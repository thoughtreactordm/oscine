import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

/**
 * Unit tests run under plain Node, not Electron.
 *
 * That works because better-sqlite3 ships Node-API prebuilds, which are ABI
 * stable across runtimes — the same binary loads under Node 24 (ABI 137) and
 * Electron 43 (ABI 148). `npm run verify:native` is what proves that claim
 * against the Electron binary itself; these tests get to stay fast and plain.
 */
export default defineConfig({
  // Only the aliases the app itself defines. Tests reach into src/main by
  // relative path rather than through a test-only alias that would resolve here
  // and fail in the electron-vite build.
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts']
  }
})
