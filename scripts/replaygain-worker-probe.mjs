/**
 * Exercises the exact built worker entry and packaged decoder dependency.
 *
 * CI runs this after `electron-vite build` on Windows and Linux. It catches the
 * three failures a source-level unit test cannot: a missing worker entry, a
 * wrong chunk-relative path, and a platform native binding that did not ship.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'

function wavFixture() {
  const sampleRate = 48_000
  const samples = sampleRate * 2
  const bytes = Buffer.alloc(44 + samples * 2)
  bytes.write('RIFF', 0)
  bytes.writeUInt32LE(bytes.length - 8, 4)
  bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(sampleRate, 24)
  bytes.writeUInt32LE(sampleRate * 2, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36)
  bytes.writeUInt32LE(samples * 2, 40)
  for (let index = 0; index < samples; index++) {
    const sample = Math.round(Math.sin((2 * Math.PI * 1000 * index) / sampleRate) * 0.2 * 32767)
    bytes.writeInt16LE(sample, 44 + index * 2)
  }
  return bytes
}

const dir = mkdtempSync(join(tmpdir(), 'oscine-rg-probe-'))
const fixture = join(dir, 'reference.wav')
writeFileSync(fixture, wavFixture())

const worker = new Worker(join(process.cwd(), 'out', 'main', 'replayGainWorker.js'))

/**
 * Best-effort removal of the temp fixture.
 *
 * The worker is never `terminate()`d — its native audio binding poisons the
 * process exit code during worker_threads teardown on Windows (see the explicit
 * `process.exit` below) — so on Windows it can still hold the fixture open when
 * this runs, and `rmSync` throws `EBUSY`/`EPERM`, which `force` does not
 * suppress. The dir is in the OS temp area on an ephemeral runner, so leaving it
 * costs nothing; failing the probe over a temp-file unlink would fail a build
 * whose actual validation already passed, which is exactly the symptom this
 * guard removes.
 */
function cleanup() {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Intentionally swallowed — see the doc comment.
  }
}

try {
  const message = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('ReplayGain worker timed out.')), 15_000)
    worker.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    worker.once('message', (value) => {
      clearTimeout(timeout)
      resolve(value)
    })
    worker.postMessage({ id: 1, path: fixture })
  })

  if (message.error) throw new Error(message.error)
  const { trackGainDb, trackPeak, histogram } = message.result
  if (!Number.isFinite(trackGainDb)) throw new Error('Worker returned a non-finite gain.')
  if (Math.abs(trackPeak - 0.2) > 0.002) {
    throw new Error(`Worker peak ${trackPeak} is outside the fixture tolerance.`)
  }
  if (!Array.isArray(histogram) || histogram.length === 0) {
    throw new Error('Worker returned no loudness histogram.')
  }
  console.log(
    `ReplayGain worker passed on ${process.platform}/${process.arch}: ` +
      `${trackGainDb.toFixed(2)} dB, peak ${trackPeak.toFixed(4)}`
  )
} catch (error) {
  cleanup()
  console.error(error instanceof Error ? error.stack : error)
  process.exit(1)
}

cleanup()
// node-web-audio-api's native binding intermittently poisons the process exit
// code during worker_threads teardown on Windows: the probe prints "passed" and
// then exits 1 with no JS error. Validation is complete and already reported, so
// exit explicitly here rather than awaiting worker.terminate() and letting its
// native teardown decide our exit code.
process.exit(0)
