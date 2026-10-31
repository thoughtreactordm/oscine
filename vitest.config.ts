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
/** The suites that assert wall-clock budgets through `tests/support/perfBudget.ts`. */
const SCALE_SUITES = ['tests/**/*Scale.test.ts']

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

    // The scale suites seed six-figure row counts in a hook, then measure a fast
    // query. The seed is CPU-bound — the trigram FTS trigger dominates, and a
    // larger page cache leaves its WAL traffic unchanged — so it competes with
    // every other worker for the runner's cores. A dev machine seeds 100k rows
    // in ~4s; a typical `windows-latest` runner takes ~30s, and a slow one ran
    // the whole suite 3x slower and pushed a seed past 120s, which failed the
    // 1.0.3 release gate. The measured `it()` bodies stay in the tens of
    // milliseconds throughout. This is one CI-wide budget so the fix lives in a
    // single place — bumping a per-test timeout every time a new scale test
    // lands is the whack-a-mole this replaces. Local stays tight enough to catch
    // a genuinely hung test; a real seed on a dev machine clears it with room to
    // spare.
    testTimeout: process.env.CI ? 30_000 : 15_000,
    hookTimeout: process.env.CI ? 300_000 : 30_000,

    // The wall-clock budget suites run as a second group, after every other file
    // has finished. Measured alongside the rest of the suite, their p95 tracked
    // the suite's size rather than Oscine's code: with 317 files compose's loaded
    // p95 sat at ~300 ms, and the W24-5 files alone moved it to 410-505 ms
    // against an isolated cost that had not moved (~270 ms on both commits). A
    // budget that has to be re-derived every time a test file lands is measuring
    // the test runner. In their own group the four suites share the machine only
    // with each other, so the numbers in their budget comments are the code's.
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['tests/**/*.test.ts'],
          exclude: SCALE_SUITES,
          sequence: { groupOrder: 0 }
        }
      },
      {
        extends: true,
        test: { name: 'scale', include: SCALE_SUITES, sequence: { groupOrder: 1 } }
      }
    ]
  }
})
