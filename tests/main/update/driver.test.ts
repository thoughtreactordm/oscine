import { describe, expect, it } from 'vitest'
import { pickAutoUpdater } from '../../../src/main/update/driver'

describe('pickAutoUpdater', () => {
  const driver = { isUpdaterActive: () => true }

  it('falls back to default when the ESM namespace hides the getter export', () => {
    // What Node's loader hands a CJS bundle for electron-updater: the
    // arrow-function getter is invisible to cjs-module-lexer.
    const namespace = { autoUpdater: undefined, default: { autoUpdater: driver } }
    expect(pickAutoUpdater(namespace)).toBe(driver)
  })

  it('prefers the named export when the loader resolves it', () => {
    const other = { isUpdaterActive: () => false }
    expect(pickAutoUpdater({ autoUpdater: driver, default: { autoUpdater: other } })).toBe(driver)
  })

  it('throws rather than handing the service an undefined driver', () => {
    expect(() => pickAutoUpdater({ default: {} })).toThrow(/did not export autoUpdater/)
  })
})
