import { describe, expect, it, vi } from 'vitest'
import type {
  FieldDiff,
  GenreDiff,
  GenreValue,
  PendingWrite,
  WritebackProgress
} from '../../../../src/shared/tagWriteback'
import type { WriteOutcome } from '../../../../src/main/library/writeback/engine'
import {
  TagWritebackService,
  type PendingWriteSource,
  type WriteFn
} from '../../../../src/main/library/writeback/service'
import {
  selectionChangesFile,
  writableTagsFromSelection,
  type WritableTags
} from '../../../../src/main/library/writeback/writer'
import type { WritebackField } from '../../../../src/shared/tagWriteback'

/**
 * The staged review's orchestrator — W16-6.
 *
 * Every collaborator is injected, so the whole preview/flush contract runs under
 * plain `npm test`: no database, no files, no native tag library. The atomic
 * write itself is the engine's own suite; here the seams prove the parts W16-6
 * owns — the per-field selection, the fresh re-derive, the path/reason never
 * leaking, the coalesced progress, and the between-file cancel.
 */

function unchanged<T>(value: T | null): FieldDiff<T> {
  return { current: value, proposed: value, changed: false }
}

function changed<T>(current: T | null, proposed: T | null): FieldDiff<T> {
  return { current, proposed, changed: true }
}

function genreDiff(
  current: readonly GenreValue[],
  proposed: readonly GenreValue[],
  isChanged: boolean
): GenreDiff {
  return { current, proposed, changed: isChanged }
}

interface PendingParts {
  title: FieldDiff<string>
  artist: FieldDiff<string>
  album: FieldDiff<string>
  trackNo: FieldDiff<number>
  discNo: FieldDiff<number>
  year: FieldDiff<number>
  genres: GenreDiff
}

function makePending(trackId: number, parts: Partial<PendingParts> = {}): PendingWrite {
  const p: PendingParts = {
    title: parts.title ?? unchanged('Title'),
    artist: parts.artist ?? unchanged('Artist'),
    album: parts.album ?? unchanged('Album'),
    trackNo: parts.trackNo ?? unchanged(1),
    discNo: parts.discNo ?? unchanged(1),
    year: parts.year ?? unchanged(2020),
    genres: parts.genres ?? genreDiff([], [], false)
  }
  const hasChanges =
    p.title.changed ||
    p.artist.changed ||
    p.album.changed ||
    p.trackNo.changed ||
    p.discNo.changed ||
    p.year.changed ||
    p.genres.changed
  return { trackId, ...p, hasChanges }
}

/** A differ seam driven by a per-track script: a pending, `null`, or a throw. */
function differFrom(script: Map<number, PendingWrite | null | 'throw'>): {
  source: PendingWriteSource
  calls: number[]
} {
  const calls: number[] = []
  const source: PendingWriteSource = {
    async pendingWrite(trackId: number): Promise<PendingWrite | null> {
      calls.push(trackId)
      const entry = script.get(trackId)
      if (entry === 'throw') throw new Error('unreadable')
      return entry ?? null
    }
  }
  return { source, calls }
}

const okOutcome = (absPath: string): WriteOutcome => ({ ok: true, codec: 'flac', path: absPath })

/** A write seam recording every call, returning a configurable outcome. */
function recordingWrite(result: (absPath: string) => WriteOutcome = okOutcome): {
  write: WriteFn
  calls: { absPath: string; desired: WritableTags }[]
} {
  const calls: { absPath: string; desired: WritableTags }[] = []
  const write: WriteFn = async (absPath, desired) => {
    calls.push({ absPath, desired })
    return result(absPath)
  }
  return { write, calls }
}

const resolveSimple = (trackId: number): string => `/music/${trackId}.flac`

const noProgress = (): void => {}

describe('TagWritebackService.preview', () => {
  it('returns only tracks whose file does not already match, in order', async () => {
    const script = new Map<number, PendingWrite | null | 'throw'>([
      [1, makePending(1, { title: changed('Old', 'New') })],
      [2, makePending(2)], // no changes
      [3, makePending(3, { year: changed(2019, 2020) })]
    ])
    const { source } = differFrom(script)
    const service = new TagWritebackService({ differ: source, resolvePath: resolveSimple })

    const preview = await service.preview([1, 2, 3])

    expect(preview.map((p) => p.trackId)).toEqual([1, 3])
  })

  it('drops a track whose file cannot be read rather than failing the batch', async () => {
    const script = new Map<number, PendingWrite | null | 'throw'>([
      [1, 'throw'],
      [2, makePending(2, { title: changed('a', 'b') })]
    ])
    const { source } = differFrom(script)
    const service = new TagWritebackService({ differ: source, resolvePath: resolveSimple })

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const preview = await service.preview([1, 2])
    warn.mockRestore()

    expect(preview.map((p) => p.trackId)).toEqual([2])
  })
})

describe('TagWritebackService.apply — selection', () => {
  it('writes proposed for selected fields and the fresh current for the rest', async () => {
    const pending = makePending(1, {
      title: changed('Old Title', 'New Title'),
      genres: genreDiff([{ key: 'a', label: 'A' }], [{ key: 'b', label: 'B' }], true)
    })
    const { source } = differFrom(new Map([[1, pending]]))
    const { write, calls } = recordingWrite()
    const service = new TagWritebackService({ differ: source, resolvePath: resolveSimple, write })

    const report = await service.apply([{ trackId: 1, fields: ['title'] }], noProgress)

    expect(report).toMatchObject({ total: 1, written: 1, skipped: 0, failed: 0, cancelled: false })
    expect(calls).toHaveLength(1)
    // Selected → proposed; deselected genre → the file's fresh current, not proposed.
    expect(calls[0].desired.title).toBe('New Title')
    expect(calls[0].desired.genres).toEqual([{ key: 'a', label: 'A' }])
    expect(calls[0].absPath).toBe('/music/1.flac')
  })

  it('skips a track whose selected fields no longer change the file', async () => {
    // The operator selected a field, but a fresh re-derive shows it unchanged.
    const pending = makePending(1, { title: changed('x', 'y') })
    const { source } = differFrom(new Map([[1, pending]]))
    const { write, calls } = recordingWrite()
    const service = new TagWritebackService({ differ: source, resolvePath: resolveSimple, write })

    // Select 'artist', which is unchanged in the pending → nothing to write.
    const report = await service.apply([{ trackId: 1, fields: ['artist'] }], noProgress)

    expect(report).toMatchObject({ written: 0, skipped: 1, failed: 0 })
    expect(calls).toHaveLength(0)
    expect(report.outcomes[0]).toEqual({ trackId: 1, status: 'skipped' })
  })

  it('re-derives each pending fresh at flush time (R7), not the reviewed copy', async () => {
    const { source, calls } = differFrom(
      new Map([[1, makePending(1, { title: changed('a', 'b') })]])
    )
    const service = new TagWritebackService({ differ: source, resolvePath: resolveSimple })

    await service.apply([{ trackId: 1, fields: ['title'] }], noProgress)

    expect(calls).toEqual([1]) // the differ was consulted during apply
  })
})

describe('TagWritebackService.apply — outcomes never leak a path', () => {
  it('maps an engine failure to a bare { trackId, status, code }', async () => {
    const pending = makePending(1, { title: changed('a', 'b') })
    const { source } = differFrom(new Map([[1, pending]]))
    const { write } = recordingWrite(() => ({
      ok: false,
      code: 'verify-failed',
      reason: "read /home/op/Music/secret.flac: it's all here",
      path: '/home/op/Music/secret.flac'
    }))
    const service = new TagWritebackService({ differ: source, resolvePath: resolveSimple, write })

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const report = await service.apply([{ trackId: 1, fields: ['title'] }], noProgress)
    warn.mockRestore()

    expect(report).toMatchObject({ failed: 1 })
    const outcome = report.outcomes[0]
    expect(outcome).toEqual({ trackId: 1, status: 'failed', code: 'verify-failed' })
    // No `path`, no `reason` on the wire shape.
    expect(Object.keys(outcome).sort()).toEqual(['code', 'status', 'trackId'])
  })

  it('fails a track whose path no longer resolves, without touching the writer', async () => {
    const pending = makePending(1, { title: changed('a', 'b') })
    const { source } = differFrom(new Map([[1, pending]]))
    const { write, calls } = recordingWrite()
    const service = new TagWritebackService({
      differ: source,
      resolvePath: () => null,
      write
    })

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const report = await service.apply([{ trackId: 1, fields: ['title'] }], noProgress)
    warn.mockRestore()

    expect(report).toMatchObject({ failed: 1 })
    expect(report.outcomes[0]).toEqual({ trackId: 1, status: 'failed', code: 'write-failed' })
    expect(calls).toHaveLength(0)
  })
})

describe('TagWritebackService.apply — progress', () => {
  it('coalesces intermediate progress but always emits a full final count', async () => {
    const script = new Map<number, PendingWrite | null | 'throw'>([
      [1, makePending(1, { title: changed('a', 'b') })],
      [2, makePending(2, { title: changed('c', 'd') })]
    ])
    const { source } = differFrom(script)
    const { write } = recordingWrite()
    // A large throttle with a frozen clock suppresses every intermediate emit.
    const service = new TagWritebackService({
      differ: source,
      resolvePath: resolveSimple,
      write,
      now: () => 1000,
      throttleMs: 10_000
    })

    const events: WritebackProgress[] = []
    await service.apply(
      [
        { trackId: 1, fields: ['title'] },
        { trackId: 2, fields: ['title'] }
      ],
      (p) => events.push(p)
    )

    const last = events[events.length - 1]
    expect(last).toEqual({ done: 2, total: 2, written: 2, skipped: 0, failed: 0 })
  })

  it('emits per-file when unthrottled', async () => {
    const script = new Map<number, PendingWrite | null | 'throw'>([
      [1, makePending(1, { title: changed('a', 'b') })],
      [2, makePending(2, { title: changed('c', 'd') })]
    ])
    const { source } = differFrom(script)
    const { write } = recordingWrite()
    let clock = 0
    const service = new TagWritebackService({
      differ: source,
      resolvePath: resolveSimple,
      write,
      now: () => (clock += 1000),
      throttleMs: 0
    })

    const events: WritebackProgress[] = []
    await service.apply(
      [
        { trackId: 1, fields: ['title'] },
        { trackId: 2, fields: ['title'] }
      ],
      (p) => events.push(p)
    )

    expect(events.map((e) => e.done)).toContain(1)
    expect(events.map((e) => e.done)).toContain(2)
  })
})

describe('TagWritebackService.apply — cancel', () => {
  it('stops between files and resolves cancelled with the outcomes it reached', async () => {
    const script = new Map<number, PendingWrite | null | 'throw'>([
      [1, makePending(1, { title: changed('a', 'b') })],
      [2, makePending(2, { title: changed('c', 'd') })]
    ])
    const { source } = differFrom(script)
    let cancelNow: () => void = () => {}
    const { write, calls } = recordingWrite((absPath) => {
      cancelNow() // cancel while the first file is being written
      return okOutcome(absPath)
    })
    const service = new TagWritebackService({ differ: source, resolvePath: resolveSimple, write })
    cancelNow = () => service.cancel()

    const report = await service.apply(
      [
        { trackId: 1, fields: ['title'] },
        { trackId: 2, fields: ['title'] }
      ],
      noProgress
    )

    expect(report.cancelled).toBe(true)
    expect(report.written).toBe(1)
    expect(report.outcomes).toHaveLength(1)
    expect(calls).toHaveLength(1) // the second file was never written
  })

  it('rejects a second concurrent flush with a conflict', async () => {
    const script = new Map<number, PendingWrite | null | 'throw'>([
      [1, makePending(1, { title: changed('a', 'b') })]
    ])
    const { source } = differFrom(script)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const write: WriteFn = async (absPath) => {
      await gate
      return okOutcome(absPath)
    }
    const service = new TagWritebackService({ differ: source, resolvePath: resolveSimple, write })

    const first = service.apply([{ trackId: 1, fields: ['title'] }], noProgress)
    await expect(service.apply([{ trackId: 1, fields: ['title'] }], noProgress)).rejects.toThrow(
      /already running/
    )
    release()
    await first
  })
})

describe('TagWritebackService.previewPending', () => {
  it('previews every pending track, changed-only', async () => {
    const script = new Map<number, PendingWrite | null | 'throw'>([
      [1, makePending(1, { title: changed('a', 'b') })],
      [2, makePending(2)]
    ])
    const { source } = differFrom(script)
    const service = new TagWritebackService({
      differ: source,
      resolvePath: resolveSimple,
      pendingTrackIds: () => [1, 2]
    })

    const preview = await service.previewPending()

    expect(preview.map((p) => p.trackId)).toEqual([1])
  })
})

describe('TagWritebackService.apply — retire', () => {
  it('retires the selected fields of written tracks, but not failed ones', async () => {
    const script = new Map<number, PendingWrite | null | 'throw'>([
      [1, makePending(1, { title: changed('a', 'b') })],
      [2, makePending(2, { title: changed('c', 'd') })]
    ])
    const { source } = differFrom(script)
    const { write } = recordingWrite((absPath) =>
      absPath.includes('/2.')
        ? { ok: false, code: 'write-failed', reason: 'x', path: absPath }
        : okOutcome(absPath)
    )
    const retired: Array<{ trackId: number; fields: readonly WritebackField[] }> = []
    const service = new TagWritebackService({
      differ: source,
      resolvePath: resolveSimple,
      write,
      retire: (trackId, fields) => {
        retired.push({ trackId, fields })
      }
    })

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await service.apply(
      [
        { trackId: 1, fields: ['title'] },
        { trackId: 2, fields: ['title'] }
      ],
      noProgress
    )
    warn.mockRestore()

    expect(retired).toEqual([{ trackId: 1, fields: ['title'] }])
  })
})

describe('writableTagsFromSelection / selectionChangesFile', () => {
  const pending = makePending(1, {
    title: changed('Old', 'New'),
    year: changed(2019, 2020),
    genres: genreDiff([{ key: 'a', label: 'A' }], [{ key: 'b', label: 'B' }], true)
  })

  it('takes proposed only for selected fields', () => {
    const desired = writableTagsFromSelection(pending, new Set<WritebackField>(['title', 'genres']))
    expect(desired.title).toBe('New')
    expect(desired.genres).toEqual([{ key: 'b', label: 'B' }])
    expect(desired.year).toBe(2019) // deselected → current
  })

  it('reports whether the selection still changes the file', () => {
    expect(selectionChangesFile(pending, new Set<WritebackField>(['year']))).toBe(true)
    expect(selectionChangesFile(pending, new Set<WritebackField>(['artist']))).toBe(false)
  })
})
