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
  // Only the aliases the app itself defines. Tests reach into src/main and
  // src/renderer by relative path rather than through a test-only alias that
  // would resolve here and fail in the electron-vite build.
  //
  // `@renderer` is deliberately absent even though the renderer build defines
  // it. `tests/` compiles under tsconfig.node.json, which maps only `@shared`
  // and has no DOM lib; adding the alias here would let a test import an
  // alias-using renderer module, pass, and then fail typecheck. A renderer
  // module meant to be unit-tested stays free of both — see `trackWindow.ts`
  // and `playback/`.
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
