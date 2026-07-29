import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RootDirectoryWatcher,
  type DirectoryWatchAdapter,
  type WatchSubscription
} from '../../../src/main/library/watcher'

class FakeWatchAdapter implements DirectoryWatchAdapter {
  readonly entries = new Map<
    string,
    { event: (filename: string | null) => void; error: (error: unknown) => void; closed: boolean }
  >()
  attempts = 0
  throwError: unknown = null

  watch(
    directory: string,
    onEvent: (filename: string | null) => void,
    onError: (error: unknown) => void
  ): WatchSubscription {
    this.attempts++
    if (this.throwError) throw this.throwError
    const entry = { event: onEvent, error: onError, closed: false }
    this.entries.set(directory, entry)
    return {
      close: () => {
        entry.closed = true
        this.entries.delete(directory)
      }
    }
  }
}

let root: string

beforeEach(() => {
  vi.useFakeTimers()
  root = mkdtempSync(join(tmpdir(), 'fermata-watch-'))
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
})

describe('RootDirectoryWatcher', () => {
  it('watches directories rather than tracks and replaces subscriptions on restart', async () => {
    mkdirSync(join(root, 'Artist', 'Album'), { recursive: true })
    writeFileSync(join(root, 'Artist', 'Album', 'a.flac'), 'x')
    writeFileSync(join(root, 'Artist', 'Album', 'b.flac'), 'x')
    const adapter = new FakeWatchAdapter()
    const watcher = new RootDirectoryWatcher({
      adapter,
      onPaths: async () => {},
      onModeChange: () => {}
    })

    await watcher.startRoot({ id: 1, path: root })
    expect(watcher.watchCount(1)).toBe(3)

    await watcher.startRoot({ id: 1, path: root })
    expect(watcher.watchCount(1)).toBe(3)
    expect(adapter.entries.size).toBe(3)

    watcher.close()
    expect(adapter.entries.size).toBe(0)
  })

  it('coalesces a noisy burst and waits for a stable file observation', async () => {
    const adapter = new FakeWatchAdapter()
    const onPaths = vi.fn(async (_rootId: number, _paths: readonly string[]) => {})
    const watcher = new RootDirectoryWatcher({
      adapter,
      debounceMs: 20,
      settleMs: 0,
      onPaths,
      onModeChange: () => {}
    })
    await watcher.startRoot({ id: 1, path: root })

    writeFileSync(join(root, 'a.flac'), 'x')
    adapter.entries.get(root)!.event('a.flac')
    adapter.entries.get(root)!.event('a.flac')
    adapter.entries.get(root)!.event('a.flac')
    await vi.advanceTimersByTimeAsync(25)
    await vi.waitFor(() => expect(onPaths).toHaveBeenCalledTimes(1))

    expect(onPaths.mock.calls[0][0]).toBe(1)
    expect(onPaths.mock.calls[0][1]).toEqual([join(root, 'a.flac')])
    watcher.close()
  })

  it('degrades once on ENOSPC, closes partial handles, and does not retry', async () => {
    mkdirSync(join(root, 'Artist'), { recursive: true })
    const adapter = new FakeWatchAdapter()
    adapter.throwError = Object.assign(new Error('watch limit'), { code: 'ENOSPC' })
    const onModeChange = vi.fn()
    const watcher = new RootDirectoryWatcher({
      adapter,
      onPaths: async () => {},
      onModeChange
    })

    await watcher.startRoot({ id: 1, path: root })
    expect(watcher.watchCount(1)).toBe(0)
    expect(onModeChange).toHaveBeenCalledTimes(1)
    expect(onModeChange).toHaveBeenCalledWith(
      1,
      'startup-scan-only',
      expect.objectContaining({ code: 'ENOSPC' })
    )
    const attempts = adapter.attempts

    await watcher.refreshRoot(1)
    expect(adapter.attempts).toBe(attempts)
  })
})
