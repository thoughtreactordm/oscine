import { createRequire } from 'node:module'
import { join } from 'node:path'
import type { CdDriveInfo, CdReadError, CdToc } from '../../shared/cdrip'

export interface CdSectorRead {
  /** 2352 bytes/sector: signed 16-bit little-endian stereo, 44100 Hz. */
  pcm: Buffer
  /** 294 error-pointer bytes/sector; null when unavailable, never fabricated zeros. */
  c2: Buffer | null
}

/** Every device operation runs in a native libuv worker. Inject this in consumers. */
export interface CdDrive {
  listDrives(): Promise<CdDriveInfo[]>
  readToc(driveId: string): Promise<CdToc>
  /** Bounded chunks, count 1..450. Data-track and lead-out crossings are rejected. */
  readSectors(driveId: string, startSector: number, count: number): Promise<CdSectorRead>
}

export class CdDriveError extends Error {
  constructor(
    public readonly code: CdReadError,
    message: string,
    public readonly sector?: number,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'CdDriveError'
  }
}

const codes: readonly CdReadError[] = [
  'no-disc',
  'not-audio',
  'device-busy',
  'read-failed',
  'unsupported-drive'
]
function normalize(error: unknown): CdDriveError {
  if (error instanceof CdDriveError) return error
  const value = error as { code?: CdReadError; message?: string; sector?: number } | null
  const code = value?.code && codes.includes(value.code) ? value.code : 'read-failed'
  return new CdDriveError(code, value?.message ?? String(error), value?.sector, { cause: error })
}

/** Lazy loading keeps fake-disc tests and unrelated application paths hardware-free. */
export function createCdDrive(load: () => CdDrive = loadNative): CdDrive {
  let addon: CdDrive | undefined
  const invoke = async <T>(operation: (native: CdDrive) => Promise<T>): Promise<T> => {
    try {
      addon ??= load()
      return await operation(addon)
    } catch (error) {
      throw normalize(error)
    }
  }
  return {
    listDrives: () => invoke((native) => native.listDrives()),
    readToc: (id) => invoke((native) => native.readToc(id)),
    readSectors: (id, sector, count) => invoke((native) => native.readSectors(id, sector, count))
  }
}

function loadNative(): CdDrive {
  try {
    return createRequire(join(__dirname, 'cdrip-loader.cjs'))('@oscine/cdrip') as CdDrive
  } catch (cause) {
    throw new CdDriveError(
      'unsupported-drive',
      'The optical drive addon could not be loaded',
      undefined,
      { cause }
    )
  }
}
