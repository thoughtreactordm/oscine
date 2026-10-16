/**
 * Load `electron-updater`'s `autoUpdater` from the CommonJS main bundle.
 *
 * The main bundle keeps `import('electron-updater')` as a real dynamic import,
 * so Node's ESM loader builds the namespace from cjs-module-lexer's static scan
 * of the package. electron-updater defines `autoUpdater` as an arrow-function
 * getter the lexer does not recognise, so the named export comes back
 * `undefined` and the instance is only reachable through `default` (the CJS
 * `module.exports`). Destructuring the named export shipped from 1.0.2 to 1.1.2
 * and left every packaged install unable to self-update. Prefer the named
 * export in case a future version or bundler resolves it, then fall back.
 */

import type { AppUpdateDriver } from './service'

interface UpdaterModuleShape {
  readonly autoUpdater?: unknown
  readonly default?: { readonly autoUpdater?: unknown }
}

export function pickAutoUpdater(mod: unknown): AppUpdateDriver {
  const shape = mod as UpdaterModuleShape
  const driver = shape.autoUpdater ?? shape.default?.autoUpdater
  if (!driver) {
    throw new Error('electron-updater did not export autoUpdater.')
  }
  return driver as AppUpdateDriver
}

export async function loadAutoUpdater(): Promise<AppUpdateDriver> {
  return pickAutoUpdater(await import('electron-updater'))
}
