import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const M2_SAMPLE_RATE = 48_000
export const M2_GAPLESS_TRACK_SAMPLES = M2_SAMPLE_RATE * 2 + 257
export const M2_REPLAYGAIN_REFERENCE = Object.freeze({
  gainDb: -1,
  gainToleranceDb: 0.1,
  peak: 0.2,
  peakTolerance: 0.002
})

const TAGGED_GAIN = ['replaygain_track_gain=0.00 dB', 'replaygain_track_peak=0.70']

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} exited ${code}\n${stderr.trim()}`))
    })
  })
}

async function requireFfmpeg() {
  try {
    await run('ffmpeg', ['-version'])
  } catch {
    throw new Error(
      'ffmpeg is required for the M2 probe fixture. ' +
        'Install it with winget install Gyan.FFmpeg or your Linux package manager.'
    )
  }
}

function pcm16Wav(samples, sampleRate = M2_SAMPLE_RATE) {
  const bytes = Buffer.alloc(44 + samples.length * 2)
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
  bytes.writeUInt32LE(samples.length * 2, 40)
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.min(1, Math.max(-1, samples[index]))
    bytes.writeInt16LE(Math.round(clamped * 32767), 44 + index * 2)
  }
  return bytes
}

function continuousSignal() {
  return Float64Array.from(
    { length: M2_GAPLESS_TRACK_SAMPLES * 2 },
    (_, sample) =>
      Math.sin((2 * Math.PI * sample) / 997) * 0.44 +
      Math.sin((2 * Math.PI * sample) / 1597) * 0.19 +
      Math.sin((2 * Math.PI * sample) / 2713) * 0.07
  )
}

function constantSignal(seconds, amplitude) {
  return Float64Array.from({ length: Math.round(M2_SAMPLE_RATE * seconds) }, () => amplitude)
}

function metadataArgs(title, replayGain = TAGGED_GAIN) {
  const args = [
    '-metadata',
    `title=${title}`,
    '-metadata',
    'artist=Oscine M2 Gate',
    '-metadata',
    'album=M2 Exit Probe'
  ]
  for (const tag of replayGain ?? []) args.push('-metadata', tag)
  return args
}

async function encodeWavToFlac(wavPath, flacPath, title, replayGain = TAGGED_GAIN) {
  await run('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-i',
    wavPath,
    '-map_metadata',
    '-1',
    '-c:a',
    'flac',
    '-compression_level',
    '5',
    ...metadataArgs(title, replayGain),
    flacPath
  ])
}

async function encodeSineToFlac({
  path,
  title,
  seconds,
  frequency,
  amplitude,
  channels = 1,
  replayGain = TAGGED_GAIN
}) {
  await run('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${frequency}:duration=${seconds}:sample_rate=${M2_SAMPLE_RATE}`,
    '-filter:a',
    // lavfi's sine source has a 1/8 peak. Scale to the requested PCM peak so
    // the ReplayGain reference remains independent of that ffmpeg convention.
    `volume=${amplitude * 8}`,
    '-ac',
    String(channels),
    '-map_metadata',
    '-1',
    '-c:a',
    'flac',
    '-compression_level',
    '5',
    ...metadataArgs(title, replayGain),
    path
  ])
}

async function sha256(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

/**
 * Build the complete, isolated library used by the M2 exit probe.
 *
 * The reference file lives outside `libraryDir`, so it can be used for the
 * split-signal oracle without becoming another row or ReplayGain work item.
 */
export async function buildM2Fixture(rootDir, log = () => {}) {
  await requireFfmpeg()
  await rm(rootDir, { recursive: true, force: true })
  const libraryDir = join(rootDir, 'library')
  const supportDir = join(rootDir, 'support')
  const sourceDir = join(rootDir, 'source')
  await Promise.all([
    mkdir(libraryDir, { recursive: true }),
    mkdir(supportDir, { recursive: true }),
    mkdir(sourceDir, { recursive: true })
  ])

  const tracks = []
  const add = (key, title, fileName) => {
    const entry = { key, title, path: join(libraryDir, fileName) }
    tracks.push(entry)
    return entry
  }

  log('building continuous split-signal fixtures')
  const continuous = continuousSignal()
  const gaplessA = add('gaplessA', '10 Gapless A', '10-gapless-a.flac')
  const gaplessB = add('gaplessB', '11 Gapless B', '11-gapless-b.flac')
  const referencePath = join(supportDir, 'gapless-reference.flac')
  const referenceWav = join(sourceDir, 'gapless-reference.wav')
  const leftWav = join(sourceDir, 'gapless-a.wav')
  const rightWav = join(sourceDir, 'gapless-b.wav')
  await Promise.all([
    writeFile(referenceWav, pcm16Wav(continuous)),
    writeFile(leftWav, pcm16Wav(continuous.slice(0, M2_GAPLESS_TRACK_SAMPLES))),
    writeFile(rightWav, pcm16Wav(continuous.slice(M2_GAPLESS_TRACK_SAMPLES)))
  ])
  await Promise.all([
    encodeWavToFlac(referenceWav, referencePath, 'Gapless Reference'),
    encodeWavToFlac(leftWav, gaplessA.path, gaplessA.title),
    encodeWavToFlac(rightWav, gaplessB.path, gaplessB.title)
  ])

  log('building equal-power and scheduler fixtures')
  for (const [key, title, fileName, amplitude] of [
    ['crossfade250A', '20 Crossfade 250 A', '20-crossfade-250-a.flac', 0.2],
    ['crossfade250B', '21 Crossfade 250 B', '21-crossfade-250-b.flac', 0.2],
    ['crossfade750A', '30 Crossfade 750 A', '30-crossfade-750-a.flac', 0.25],
    ['crossfade750B', '31 Crossfade 750 B', '31-crossfade-750-b.flac', 0.25],
    ['skipA', '40 Skip A', '40-skip-a.flac', 0.18],
    ['skipB', '41 Skip B', '41-skip-b.flac', 0.18],
    ['skipC', '42 Skip C', '42-skip-c.flac', 0.18],
    ['boundaryDecoded', '50 Boundary Decoded', '50-boundary-decoded.flac', 0.16]
  ]) {
    const entry = add(key, title, fileName)
    const wav = join(sourceDir, `${key}.wav`)
    await writeFile(wav, pcm16Wav(constantSignal(2, amplitude)))
    await encodeWavToFlac(wav, entry.path, entry.title)
  }

  log('building twenty-minute streaming fixture')
  const streaming = add(
    'boundaryStreaming',
    '51 Boundary Streaming 20 Minutes',
    '51-boundary-streaming.flac'
  )
  await encodeSineToFlac({
    path: streaming.path,
    title: streaming.title,
    seconds: 20 * 60,
    frequency: 110,
    amplitude: 0.2,
    channels: 2
  })

  log('building tagged and compute-when-missing ReplayGain fixtures')
  const tagged = add('replayGainTagged', '60 ReplayGain Tagged', '60-replaygain-tagged.flac')
  await encodeSineToFlac({
    path: tagged.path,
    title: tagged.title,
    seconds: 2,
    frequency: 1000,
    amplitude: 0.2,
    replayGain: ['replaygain_track_gain=-7.25 dB', 'replaygain_track_peak=0.2000']
  })

  const computed = add(
    'replayGainComputed',
    '61 ReplayGain Computed Reference',
    '61-replaygain-computed.flac'
  )
  await encodeSineToFlac({
    path: computed.path,
    title: computed.title,
    seconds: 2,
    frequency: 1000,
    amplitude: 0.2,
    replayGain: null
  })

  for (const [index, amplitude] of [0.1, 0.15, 0.25].entries()) {
    const number = index + 1
    const entry = add(
      `replayGainResume${number}`,
      `6${number + 1} ReplayGain Resume ${number}`,
      `6${number + 1}-replaygain-resume-${number}.flac`
    )
    await encodeSineToFlac({
      path: entry.path,
      title: entry.title,
      // Long enough that the two real worker threads cannot finish every
      // pending item between the first checkpoint event and the cancel IPC on
      // a fast Windows host. They remain highly compressible sine fixtures.
      seconds: 5 * 60,
      frequency: 220 + index * 110,
      amplitude,
      replayGain: null
    })
  }

  await rm(sourceDir, { recursive: true, force: true })

  const manifest = {
    version: 1,
    sampleRateHz: M2_SAMPLE_RATE,
    gaplessTrackSamples: M2_GAPLESS_TRACK_SAMPLES,
    replayGainReference: M2_REPLAYGAIN_REFERENCE,
    libraryDir,
    referencePath,
    tracks: Object.fromEntries(
      await Promise.all(
        tracks.map(async ({ key, title, path }) => [
          key,
          { title, fileName: path.slice(libraryDir.length + 1), sha256: await sha256(path) }
        ])
      )
    )
  }
  await writeFile(join(rootDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return manifest
}
