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
    include: ['tests/**/*.test.ts'],

    // The scale suites seed six-figure row counts in a hook, then measure a fast
    // query. On a shared `windows-latest` runner (slow disk, Defender scanning
    // the WAL file on every write) those seeds blow the 5s/10s defaults, while
    // the measured `it()` bodies stay in the tens of milliseconds. This is one
    // CI-wide budget so the fix lives in a single place — bumping a per-test
    // timeout every time a new scale test lands is the whack-a-mole this
    // replaces. Local stays tight enough to catch a genuinely hung test; a real
    // seed on a dev machine clears it with room to spare.
    testTimeout: process.env.CI ? 30_000 : 15_000,
    hookTimeout: process.env.CI ? 120_000 : 30_000
  }
})
