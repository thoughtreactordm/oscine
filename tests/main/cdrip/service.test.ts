import sharp from 'sharp'
import { mkdir } from 'node:fs/promises'
import { SqliteLibraryService } from '../../../src/main/library/sqliteService'
import { LibraryStore } from '../../../src/main/library/store'
import { readEmbeddedArtwork } from '../../../src/main/library/metadata'
import { artworkHash, createDerivedArtworkStore } from '../../../src/main/library/derivedArtwork'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { computeDiscId } from '@shared/discId'
import type { CdToc, RipProgress, RipRequest, RipTrackSelection } from '@shared/cdrip'
import { OscineError } from '@shared/errors'
import { MIGRATIONS, migrate } from '../../../src/main/db'
import { CdDriveError, type CdDrive } from '../../../src/main/cdrip/drive'
import { EncoderError, type Encoder } from '../../../src/main/cdrip/encoder'
import { RipService, trackRanges, type ApplyRipTags } from '../../../src/main/cdrip/service'
import { RipArtworkPicker } from '../../../src/main/cdrip/artwork'
import { hashToc, RipSessionStore } from '../../../src/main/cdrip/sessionStore'
import type { DiscLookup } from '../../../src/main/cdrip/discLookup'
import type { WritableTags } from '../../../src/main/library/writeback/writer'

/**
 * RipService — W18-5. Every collaborator is injected, so the session runs under
 * plain `npm test`: no drive, no encoder binary, no tag library.
 */

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oscine-rip-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function audioEntry(
  number: number,
  startSector: number,
  sectorCount: number,
  isAudio = true
): CdToc['entries'][number] {
  return { number, startSector, sectorCount, isAudio, preEmphasis: false }
}

function consecutiveToc(tracks: number, sectorsEach: number, extra?: CdToc['entries']): CdToc {
  const entries = Array.from({ length: tracks }, (_, i) =>
    audioEntry(i + 1, i * sectorsEach, sectorsEach)
  )
  if (extra) entries.push(...extra)
  const last = extra && extra.length > 0 ? extra[extra.length - 1]! : entries[entries.length - 1]!
  return {
    firstTrack: 1,
    lastTrack: entries[entries.length - 1]!.number,
    leadOutSector: last.startSector + last.sectorCount,
    entries
  }
}

function pcmFor(_start: number, count: number, fill = 1): Buffer {
  return Buffer.alloc(count * 2352, fill)
}

function fakeDrive(
  toc: CdToc,
  opts: {
    fill?: (start: number, pass: number) => number
    failAt?: number
    onRead?: (start: number, count: number) => void
  } = {}
): CdDrive & { reads: Array<{ start: number; count: number }> } {
  const reads: Array<{ start: number; count: number }> = []
  const passes = new Map<number, number>()
  return {
    reads,
    listDrives: async () => [{ id: 'fake', label: 'Fake', vendor: 'Test', product: 'Disc' }],
    readToc: async () => toc,
    readSectors: async (_id, start, count) => {
      reads.push({ start, count })
      opts.onRead?.(start, count)
      const pass = (passes.get(start) ?? 0) + 1
      passes.set(start, pass)
      if (opts.failAt === start) {
        throw new CdDriveError('read-failed', 'bad sector', start)
      }
      return { pcm: pcmFor(start, count, opts.fill?.(start, pass) ?? 1), c2: null }
    }
  }
}

function fakeEncoder(dests: string[] = []): Encoder {
  return {
    ext: 'flac',
    async encode(pcm, dest, signal) {
      for await (const chunk of pcm) {
        if (signal.aborted) throw new EncoderError('cancelled', 'cancelled')
        void chunk
      }
      const { mkdir, writeFile } = await import('node:fs/promises')
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, 'flac')
      dests.push(dest)
    }
  }
}

function silentLookup(): DiscLookup {
  return { lookup: async () => ({ discId: 'test-disc', candidates: [] }) }
}

function makeService(
  drive: CdDrive,
  extra: Partial<ConstructorParameters<typeof RipService>[0]> = {}
): { service: RipService; tags: WritableTags[]; dests: string[] } {
  const dests: string[] = []
  const tags: WritableTags[] = []
  const applyTags: ApplyRipTags = async (_path, desired) => {
    tags.push(desired)
  }
  const service = new RipService({
    drive,
    lookup: silentLookup(),
    encoder: fakeEncoder(dests),
    resolvePath: (_rootId, relPath) => join(dir, ...relPath.split('/')),
    applyTags,
    readChunkSectors: extra.readChunkSectors ?? 450,
    now: extra.now,
    throttleMs: extra.throttleMs,
    ...extra
  })
  return { service, tags, dests }
}

function tracks(count: number): RipTrackSelection[] {
  return Array.from({ length: count }, (_, i) => ({
    number: i + 1,
    title: `Track ${i + 1}`,
    artist: 'Artist'
  }))
}

function request(over: Partial<RipRequest> = {}): RipRequest {
  const list = over.tracks ?? tracks(12)
  return {
    driveId: 'fake',
    rootId: 1,
    relDir: '',
    template: '{track:02} {title}',
    album: 'Album',
    albumArtist: 'Artist',
    year: 2000,
    verify: false,
    onCollision: 'overwrite',
    ...over,
    tracks: list
  }
}

const noProgress = (): void => {}

describe('trackRanges', () => {
  it('appends the pregap to the preceding track from consecutive TOC offsets', () => {
    const toc: CdToc = {
      firstTrack: 1,
      lastTrack: 2,
      leadOutSector: 250,
      entries: [audioEntry(1, 0, 100), audioEntry(2, 150, 100)]
    }
    const ranges = trackRanges(toc)
    expect(ranges.get(1)).toEqual({ start: 0, count: 150, isAudio: true })
    expect(ranges.get(2)).toEqual({ start: 150, count: 100, isAudio: true })
  })
})

describe('RipService.start', () => {
  it('rips twelve audio tracks to the templated paths', async () => {
    const drive = fakeDrive(consecutiveToc(12, 8))
    const { service } = makeService(drive)
    const report = await service.start(request(), noProgress)

    expect(report).toMatchObject({
      total: 12,
      written: 12,
      skipped: 0,
      failed: 0,
      cancelled: false,
      trackIds: []
    })
    expect(report.outcomes).toHaveLength(12)
    for (let i = 0; i < 12; i++) {
      const rel = `${String(i + 1).padStart(2, '0')} Track ${i + 1}.flac`
      expect(report.outcomes[i]).toEqual({
        trackNumber: i + 1,
        status: 'written',
        relPath: rel
      })
      expect(existsSync(join(dir, rel))).toBe(true)
    }
  })

  it('observes cancel within one chunk and reports cancelled', async () => {
    const box: { service: RipService | null } = { service: null }
    const drive = fakeDrive(consecutiveToc(2, 6), {
      onRead: () => {
        if (drive.reads.length === 1) box.service!.cancel()
      }
    })
    const { service, dests } = makeService(drive, { readChunkSectors: 1 })
    box.service = service

    const report = await service.start(request({ tracks: tracks(2) }), noProgress)

    expect(report.cancelled).toBe(true)
    expect(drive.reads).toHaveLength(1)
    expect(report.outcomes).toHaveLength(0)
    expect(dests.every((path) => !existsSync(path))).toBe(true)
    expect(readdirSync(dir).filter((name) => name.endsWith('.part'))).toEqual([])
  })

  it('isolates a single failing track and still writes the others', async () => {
    const toc = consecutiveToc(12, 4)
    const failStart = toc.entries[5]!.startSector
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const drive = fakeDrive(toc, { failAt: failStart })
    const { service } = makeService(drive)
    const report = await service.start(request(), noProgress)
    warn.mockRestore()

    expect(report.written).toBe(11)
    expect(report.failed).toBe(1)
    expect(report.outcomes).toHaveLength(12)
    expect(report.outcomes[5]).toMatchObject({
      trackNumber: 6,
      status: 'failed',
      code: 'read-failed'
    })
    expect(report.outcomes.filter((o) => o.status === 'written')).toHaveLength(11)
  })

  it('never sends data tracks to the encoder', async () => {
    const toc = consecutiveToc(11, 4, [audioEntry(12, 44, 8, false)])
    const drive = fakeDrive(toc)
    const dests: string[] = []
    const { service } = makeService(drive, { encoder: fakeEncoder(dests) })
    const report = await service.start(request({ tracks: tracks(12) }), noProgress)

    expect(dests).toHaveLength(11)
    expect(report.total).toBe(11)
    expect(report.written).toBe(11)
    expect(report.outcomes.map((o) => o.trackNumber)).not.toContain(12)
  })

  it('reads gap sectors on the preceding track', async () => {
    const toc: CdToc = {
      firstTrack: 1,
      lastTrack: 2,
      leadOutSector: 250,
      entries: [audioEntry(1, 0, 100), audioEntry(2, 150, 100)]
    }
    const drive = fakeDrive(toc)
    const { service } = makeService(drive, { readChunkSectors: 50 })
    await service.start(request({ tracks: tracks(2) }), noProgress)

    const track1 = drive.reads.filter((read) => read.start < 150)
    const track2 = drive.reads.filter((read) => read.start >= 150)
    expect(track1.reduce((n, read) => n + read.count, 0)).toBe(150)
    expect(track2.reduce((n, read) => n + read.count, 0)).toBe(100)
  })

  it('reports a verify mismatch without deleting the file', async () => {
    const toc = consecutiveToc(1, 8)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const drive = fakeDrive(toc, { fill: (_start, pass) => (pass === 1 ? 1 : 9) })
    const { service } = makeService(drive)
    const report = await service.start(request({ tracks: tracks(1), verify: true }), noProgress)
    warn.mockRestore()

    expect(report.outcomes[0]).toEqual({
      trackNumber: 1,
      status: 'verify-failed',
      relPath: '01 Track 1.flac',
      startSector: 0,
      sectorCount: 8
    })
    expect(existsSync(join(dir, '01 Track 1.flac'))).toBe(true)
    expect(report.failed).toBe(1)
    expect(report.written).toBe(0)
  })

  it('coalesces progress by elapsed time, not chunk count', async () => {
    let clock = 0
    const toc = consecutiveToc(1, 80)
    const drive = fakeDrive(toc)
    const { service } = makeService(drive, {
      readChunkSectors: 1,
      throttleMs: 50,
      now: () => (clock += 1)
    })
    const events: RipProgress[] = []
    await service.start(request({ tracks: tracks(1) }), (p) => events.push(p))

    expect(events.length).toBeLessThan(80)
    expect(events.length).toBeLessThanOrEqual(Math.floor(clock / 50) + 4)
    expect(events[events.length - 1]?.sectorsDone).toBe(80)
  })

  it('skips an existing file when onCollision is skip', async () => {
    writeFileSync(join(dir, '01 Track 1.flac'), 'existing')
    const drive = fakeDrive(consecutiveToc(1, 4))
    const dests: string[] = []
    const { service } = makeService(drive, { encoder: fakeEncoder(dests) })
    const report = await service.start(
      request({ tracks: tracks(1), onCollision: 'skip' }),
      noProgress
    )

    expect(report.outcomes[0]).toEqual({
      trackNumber: 1,
      status: 'skipped',
      relPath: '01 Track 1.flac'
    })
    expect(dests).toHaveLength(0)
  })

  it('ingests written paths once after the last rename', async () => {
    const ingest = vi.fn(async () => [41, 42])
    const drive = fakeDrive(consecutiveToc(2, 4))
    const { service } = makeService(drive, { ingest })
    const report = await service.start(request({ tracks: tracks(2) }), noProgress)

    expect(ingest).toHaveBeenCalledTimes(1)
    expect(ingest).toHaveBeenCalledWith(1, [
      join(dir, '01 Track 1.flac'),
      join(dir, '02 Track 2.flac')
    ])
    expect(report.trackIds).toEqual([41, 42])
    expect(existsSync(join(dir, '01 Track 1.flac'))).toBe(true)
    expect(existsSync(join(dir, '02 Track 2.flac'))).toBe(true)
  })

  it('does not ingest when every track is skipped', async () => {
    writeFileSync(join(dir, '01 Track 1.flac'), 'existing')
    const ingest = vi.fn(async () => [1])
    const drive = fakeDrive(consecutiveToc(1, 4))
    const { service } = makeService(drive, { ingest })
    const report = await service.start(
      request({ tracks: tracks(1), onCollision: 'skip' }),
      noProgress
    )

    expect(ingest).not.toHaveBeenCalled()
    expect(report.trackIds).toEqual([])
  })

  it('rejects a second concurrent rip with a conflict', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const drive = fakeDrive(consecutiveToc(1, 4))
    const original = drive.readSectors
    drive.readSectors = async (id, start, count) => {
      await gate
      return original.call(drive, id, start, count)
    }
    const { service } = makeService(drive)
    const first = service.start(request({ tracks: tracks(1) }), noProgress)
    await expect(service.start(request({ tracks: tracks(1) }), noProgress)).rejects.toBeInstanceOf(
      OscineError
    )
    await expect(service.start(request({ tracks: tracks(1) }), noProgress)).rejects.toThrow(
      /already running/
    )
    release()
    await first
  })
})

describe('RipService drive surface', () => {
  it('maps a missing disc to a renderer-safe not-found', async () => {
    const drive = fakeDrive(consecutiveToc(1, 4))
    drive.readToc = async () => {
      throw new CdDriveError('no-disc', 'empty tray')
    }
    const { service } = makeService(drive)
    await expect(service.readToc('fake')).rejects.toMatchObject({
      name: 'OscineError',
      code: 'not-found'
    })
  })

  it('reports a missing addon instead of pretending the drive is unsupported', async () => {
    const drive = fakeDrive(consecutiveToc(1, 4))
    drive.listDrives = async () => {
      throw new CdDriveError('unsupported-drive', 'The optical drive addon could not be loaded')
    }
    const { service } = makeService(drive)
    await expect(service.listDrives()).rejects.toMatchObject({
      name: 'OscineError',
      code: 'io-error',
      message: 'The optical drive addon could not be loaded.'
    })
  })
})

describe('RipService session persistence', () => {
  let db: Database.Database | undefined
  afterEach(() => {
    db?.close()
  })

  function persisted(
    drive: CdDrive,
    extra: Partial<ConstructorParameters<typeof RipService>[0]> = {}
  ): ReturnType<typeof makeService> & { db: Database.Database; sessions: RipSessionStore } {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    migrate(db, MIGRATIONS)
    const sessions = new RipSessionStore(db)
    const made = makeService(drive, { sessions, ...extra })
    return { ...made, db, sessions }
  }

  function sessionInput(toc: CdToc, count = 12) {
    return {
      discId: computeDiscId(toc),
      tocHash: hashToc(toc),
      releaseMbid: null,
      rootId: 1,
      relDir: '',
      template: '{track:02} {title}',
      album: 'Album',
      albumArtist: 'Artist',
      year: 2000,
      verify: false,
      tracks: tracks(count).map((track) => ({
        number: track.number,
        title: track.title,
        artist: track.artist,
        relPath: `${String(track.number).padStart(2, '0')} Track ${track.number}.flac`
      }))
    }
  }

  it('writes the selected original into every new track and checkpoints it for resume', async () => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 1])
    const path = join(dir, 'cover.jpg')
    writeFileSync(path, bytes)
    const hash = 'a'.repeat(64)
    const artwork = new RipArtworkPicker(async () => path, {
      store: async () => ({ hash, generated: true }),
      has: async () => true
    })
    await artwork.pick()
    const toc = consecutiveToc(2, 1)
    const { service, tags, sessions, db: storeDb } = persisted(fakeDrive(toc), { artwork })
    const report = await service.start(
      request({ tracks: tracks(2), artworkHash: hash }),
      noProgress
    )
    expect(report.written).toBe(2)
    expect(tags.map((tag) => tag.artwork)).toEqual([
      { kind: 'set', bytes, mime: 'image/jpeg' },
      { kind: 'set', bytes, mime: 'image/jpeg' }
    ])
    const { id } = storeDb.prepare('SELECT id FROM rip_sessions').get() as { id: number }
    expect(sessions.load(id).artwork).toEqual({ bytes, mime: 'image/jpeg' })
  })

  it('resumes with persisted cover bytes even with no picker or original file', async () => {
    const toc = consecutiveToc(1, 1)
    const { service, tags, sessions } = persisted(fakeDrive(toc))
    const artwork = { bytes: Buffer.from([0xff, 0xd8, 0xff, 1]), mime: 'image/jpeg' }
    const id = sessions.create({ ...sessionInput(toc, 1), artwork })
    const report = await service.resume(
      { sessionId: id, driveId: 'fake', onCollision: 'overwrite' },
      noProgress
    )
    expect(report.written).toBe(1)
    expect(tags[0]?.artwork).toEqual({ kind: 'set', ...artwork })
  })

  it('rejects missing cover bytes before encoding and releases the running lock', async () => {
    const { service, dests } = persisted(fakeDrive(consecutiveToc(1, 1)))
    await expect(
      service.start(request({ tracks: tracks(1), artworkHash: 'a'.repeat(64) }), noProgress)
    ).rejects.toMatchObject({ code: 'not-found' })
    expect(dests).toHaveLength(0)
    const report = await service.start(request({ tracks: tracks(1) }), noProgress)
    expect(report.written).toBe(1)
  })

  it('embeds a real image in FLAC and indexes the same cover on the imported album', async () => {
    const bytes = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#448866' }
    })
      .png()
      .toBuffer()
    const path = join(dir, 'cover.png')
    writeFileSync(path, bytes)
    const cacheDir = join(dir, 'artwork')
    const processor = {
      async generate(cache: string, hash: string, image: Uint8Array) {
        await mkdir(cache, { recursive: true })
        for (const variant of ['small', 'large']) {
          await sharp(image)
            .webp()
            .toFile(join(cache, `${hash}-${variant}.webp`))
        }
        return true
      },
      validate: async () => true,
      close: async () => {}
    }
    const artwork = new RipArtworkPicker(
      async () => path,
      createDerivedArtworkStore({ cacheDir, processor })
    )
    const selected = await artwork.pick()
    const toc = consecutiveToc(1, 1)
    const { service, db: storeDb } = persisted(fakeDrive(toc), {
      artwork,
      // A real one-sector stereo-silence FLAC fixture, encoded with libFLAC.
      encoder: {
        ext: 'flac',
        async encode(pcm, dest) {
          for await (const chunk of pcm) void chunk
          writeFileSync(
            dest,
            Buffer.from(
              'ZkxhQwAAACIQABAAAAAAAAAACsRC8AAAAAAAAAAAAAAAAAAAAAAAAAAAhAAAKCAAAAByZWZlcmVuY2UgbGliRkxBQyAxLjUuMCAyMDI1MDIxMQAAAAD/+HkYAAJL2gAAAAAAAGuo',
              'base64'
            )
          )
        }
      },
      applyTags: undefined,
      ingest: (rootId, paths) => library.ingestRippedFiles(rootId, paths)
    })
    const root = new LibraryStore(storeDb).insertRoot(dir, 'Rips', Date.now())
    const library = new SqliteLibraryService({
      db: storeDb,
      artworkCacheDir: cacheDir,
      pickFolder: async () => null,
      onProgress: () => {},
      artworkProcessor: processor
    })
    try {
      const report = await service.start(
        request({ rootId: root.id, tracks: tracks(1), artworkHash: selected!.hash }),
        noProgress
      )
      expect(report.written).toBe(1)
      expect(report.trackIds).toHaveLength(1)
      const pictures = await readEmbeddedArtwork(join(dir, '01 Track 1.flac'))
      expect(Buffer.from(pictures[0]!.bytes)).toEqual(bytes)
      expect(storeDb.prepare('SELECT artwork_hash AS hash FROM albums').get()).toEqual({
        hash: artworkHash(bytes)
      })
      expect(existsSync(join(cacheDir, `${artworkHash(bytes)}-large.webp`))).toBe(true)
    } finally {
      await library.close()
    }
  })

  it('keeps a pending row when the encoder is killed mid-track', async () => {
    let release!: (error?: Error) => void
    let notify!: () => void
    const started = new Promise<void>((resolve) => {
      notify = resolve
    })
    const encoder: Encoder = {
      ext: 'flac',
      async encode(_pcm, _dest, signal) {
        notify()
        await new Promise<void>((resolve, reject) => {
          release = (error) => (error ? reject(error) : resolve())
        })
        if (signal.aborted) throw new EncoderError('cancelled', 'cancelled')
      }
    }
    const { service, db: storeDb } = persisted(fakeDrive(consecutiveToc(1, 4)), { encoder })
    const done = service.start(request({ tracks: tracks(1) }), noProgress)
    await started
    const row = storeDb
      .prepare(
        `SELECT status AS status, attempts AS attempts, rel_path AS relPath
           FROM rip_session_tracks WHERE track_number = 1`
      )
      .get() as { status: string; attempts: number; relPath: string }
    expect(row.status).toBe('pending')
    expect(row.attempts).toBe(1)
    expect(row.relPath.startsWith('/')).toBe(false)
    service.cancel()
    release()
    const report = await done
    expect(report.cancelled).toBe(true)
  })

  it('resumes after track 4 and does not re-rip 1–4', async () => {
    const toc = consecutiveToc(12, 4)
    const drive = fakeDrive(toc)
    const { service, sessions, dests } = persisted(drive)
    const id = sessions.create(sessionInput(toc))
    for (let n = 1; n <= 4; n++) {
      sessions.recordOutcome(id, {
        trackNumber: n,
        status: 'written',
        relPath: `${String(n).padStart(2, '0')} Track ${n}.flac`
      })
    }

    const report = await service.resume(
      { sessionId: id, driveId: 'fake', onCollision: 'overwrite' },
      noProgress
    )

    expect(report.written).toBe(12)
    expect(report.cancelled).toBe(false)
    expect(dests).toHaveLength(8)
    expect(drive.reads.every((read) => read.start >= 16)).toBe(true)
    expect(sessions.load(id).state).toBe('complete')
    expect(sessions.load(id).tracks.filter((track) => track.status === 'written')).toHaveLength(12)
  })

  it('refuses resume against a different disc', async () => {
    const original = consecutiveToc(12, 4)
    const other = consecutiveToc(10, 8)
    const { service, sessions } = persisted(fakeDrive(other))
    const id = sessions.create(sessionInput(original))

    await expect(
      service.resume({ sessionId: id, driveId: 'fake', onCollision: 'skip' }, noProgress)
    ).rejects.toMatchObject({
      name: 'OscineError',
      code: 'conflict',
      message: 'The disc in the drive is not the one this rip started on.'
    })
    expect(sessions.load(id).state).toBe('running')
  })

  it('stores a relative path and pcm hash when a track lands', async () => {
    const { service, db: storeDb } = persisted(fakeDrive(consecutiveToc(1, 4)))
    await service.start(request({ tracks: tracks(1) }), noProgress)
    const row = storeDb
      .prepare(
        `SELECT rel_path AS relPath, sha256 AS sha256, status AS status
           FROM rip_session_tracks WHERE track_number = 1`
      )
      .get() as { relPath: string; sha256: string | null; status: string }
    expect(row.status).toBe('written')
    expect(row.relPath).toBe('01 Track 1.flac')
    expect(row.relPath.startsWith('/')).toBe(false)
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('retries a failed track on resume', async () => {
    const toc = consecutiveToc(2, 4)
    const { service, sessions, dests } = persisted(fakeDrive(toc))
    const id = sessions.create(sessionInput(toc, 2))
    sessions.beginTrack(id, 1)
    sessions.recordOutcome(id, {
      trackNumber: 1,
      status: 'written',
      relPath: '01 Track 1.flac'
    })
    sessions.beginTrack(id, 2)
    sessions.recordOutcome(id, {
      trackNumber: 2,
      status: 'failed',
      code: 'nonzero-exit'
    })

    const report = await service.resume(
      { sessionId: id, driveId: 'fake', onCollision: 'overwrite' },
      noProgress
    )
    expect(report.written).toBe(2)
    expect(dests).toHaveLength(1)
    expect(sessions.load(id).tracks[1]?.status).toBe('written')
  })
})
