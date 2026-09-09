import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { stat, unlink } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/**
 * Codec-agnostic encode surface. Only FLAC is implemented; a later codec is a
 * new factory behind this, not a refactor of the rip pipeline above it.
 *
 * The reference `flac` CLI is a subprocess, not a linked library: a crashing
 * encoder loses one track, not the app, and the GPL CLI stays mere aggregation
 * with Oscine (libFLAC itself is BSD).
 *
 * Tags are not this module's job. W16's `resolveCodecWriter` / `applyWritableTags`
 * write Vorbis comments after encode, so ripped files share the field mapping
 * the write-back corpus already gates. W18-5's order is encode, then tag, then
 * rename into a watched root — tagging a file the watcher can already see races.
 */
export interface Encoder {
  readonly ext: string
  encode(pcm: Readable, dest: string, signal: { aborted: boolean }): Promise<void>
}

export type EncoderFailure = 'nonzero-exit' | 'stderr' | 'broken-pipe' | 'cancelled'

export class EncoderError extends Error {
  constructor(
    public readonly code: EncoderFailure,
    message: string,
    public readonly stderr = '',
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'EncoderError'
  }
}

type SpawnImpl = (command: string, args: string[], options: SpawnOptions) => ChildProcess

const DEFAULT_COMPRESSION = 5
const STDERR_CAP = 8 * 1024

export interface FlacEncoderDeps {
  binaryPath: string
  compressionLevel?: number
  /** Test seam. Production leaves this unset and uses `child_process.spawn`. */
  spawn?: SpawnImpl
}

export function createFlacEncoder(deps: FlacEncoderDeps): Encoder {
  const level = deps.compressionLevel ?? DEFAULT_COMPRESSION
  if (!Number.isInteger(level) || level < 0 || level > 8) {
    throw new RangeError(`FLAC compression level must be an integer 0–8, got ${level}`)
  }
  const run = deps.spawn ?? spawn
  return {
    ext: 'flac',
    encode: (pcm, dest, signal) => encodeFlac(run, deps.binaryPath, level, pcm, dest, signal)
  }
}

/**
 * Packaged: `process.resourcesPath/bin/flac[.exe]`.
 * Dev: repo-relative `resources/bin/<platform>-<arch>/flac[.exe]`.
 *
 * Callers pass the layout; they do not branch on packaged vs dev themselves.
 */
export interface EncoderBinaryLayout {
  readonly isPackaged: boolean
  readonly resourcesPath: string
  readonly appRoot: string
  readonly platform?: NodeJS.Platform
  readonly arch?: string
}

export function resolveFlacBinaryPath(layout: EncoderBinaryLayout): string {
  const platform = layout.platform ?? process.platform
  const arch = layout.arch ?? process.arch
  const name = platform === 'win32' ? 'flac.exe' : 'flac'
  if (layout.isPackaged) return join(layout.resourcesPath, 'bin', name)
  return join(layout.appRoot, 'resources', 'bin', `${platform}-${arch}`, name)
}

async function encodeFlac(
  run: SpawnImpl,
  binaryPath: string,
  level: number,
  pcm: Readable,
  dest: string,
  signal: { aborted: boolean }
): Promise<void> {
  if (signal.aborted) throw await fail(dest, cancelled())

  const child = run(
    binaryPath,
    [
      '--endian=little',
      '--sign=signed',
      '--channels=2',
      '--bps=16',
      '--sample-rate=44100',
      `--compression-level-${level}`,
      // Stats otherwise land on stderr and would look like a diagnostic.
      '--silent',
      '-o',
      dest,
      '-'
    ],
    {
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true,
      env: encoderEnv(binaryPath)
    }
  )
  const diagnostic = collectStderr(child)
  const closed = new Promise<{ code: number | null; death: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, death) => resolve({ code, death }))
    }
  )
  const abortTimer = setInterval(() => {
    if (signal.aborted && !child.killed) child.kill()
  }, 25)

  let pipeError: unknown
  try {
    if (!child.stdin) throw new EncoderError('broken-pipe', 'Encoder stdin is not writable')
    await pipeline(pcm, child.stdin)
  } catch (error) {
    pipeError = error
    if (!child.killed) child.kill()
  }

  let code: number | null
  let death: NodeJS.Signals | null
  try {
    ;({ code, death } = await closed)
  } catch (error) {
    clearInterval(abortTimer)
    if (signal.aborted) throw await fail(dest, cancelled())
    const message = error instanceof Error ? error.message : String(error)
    throw await fail(
      dest,
      new EncoderError('nonzero-exit', message, diagnostic(), { cause: error })
    )
  }
  clearInterval(abortTimer)

  const stderr = diagnostic()
  if (signal.aborted) throw await fail(dest, cancelled())
  if (code !== 0 && code !== null) {
    throw await fail(
      dest,
      new EncoderError('nonzero-exit', stderr || `FLAC encoder exited with code ${code}`, stderr)
    )
  }
  let produced = 0
  try {
    produced = (await stat(dest)).size
  } catch {
    // dest missing
  }
  if (produced === 0 && stderr) {
    throw await fail(dest, new EncoderError('stderr', stderr, stderr))
  }
  if ((pipeError && isPipeError(pipeError)) || death === 'SIGPIPE') {
    throw await fail(
      dest,
      new EncoderError('broken-pipe', stderr || 'Broken pipe to FLAC encoder', stderr, {
        cause: pipeError
      })
    )
  }
  if (produced === 0) {
    throw await fail(dest, new EncoderError('stderr', 'FLAC encoder produced no output', stderr))
  }
}

function encoderEnv(binaryPath: string): NodeJS.ProcessEnv {
  const env = { ...process.env }
  if (process.platform === 'linux') {
    const dir = dirname(binaryPath)
    env.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH ? `${dir}${delimiter}${env.LD_LIBRARY_PATH}` : dir
  }
  return env
}

function collectStderr(child: ChildProcess): () => string {
  let text = ''
  child.stderr?.on('data', (chunk: Buffer | string) => {
    if (text.length >= STDERR_CAP) return
    text += chunk.toString()
    if (text.length > STDERR_CAP) text = text.slice(0, STDERR_CAP)
  })
  return () => text.trim()
}

function isPipeError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return (
    code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || code === 'ERR_STREAM_PREMATURE_CLOSE'
  )
}

function cancelled(): EncoderError {
  return new EncoderError('cancelled', 'FLAC encode cancelled')
}

async function fail(dest: string, error: EncoderError): Promise<EncoderError> {
  await removeDest(dest)
  return error
}

async function removeDest(dest: string): Promise<void> {
  try {
    await unlink(dest)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
