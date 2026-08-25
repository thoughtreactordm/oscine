#!/usr/bin/env node
/**
 * Builds the mixed-format folder the M1 exit gate needs, and cannot get from a
 * real library.
 *
 * The gate's step 1 asks for "MP3, FLAC and OGG files together". Real libraries
 * rarely oblige — the one this was first run against holds 2853 FLAC and 119 MP3
 * and not a single OGG, which meant the step had silently never been exercised
 * on either platform. A fixture is the honest fix: it is the same five files on
 * Windows and on Linux, so the two columns of the gate compare like with like.
 *
 * Everything is synthesised from `lavfi` rather than transcoded from the
 * operator's music, for three reasons: the result is identical on both machines,
 * it needs no source track to exist, and it copies nobody's audio into a temp
 * folder.
 *
 * The long track is the interesting one. R1 is about decode memory, and decoded
 * cost is `duration x rate x channels x 4` no matter what the encoder achieved —
 * so a 60-minute sine wave compresses to a rounding error on disk while still
 * decoding to ~1.3GiB. That gives both platforms the same worst case without
 * requiring both to own the same hour-long album.
 *
 * Requires ffmpeg on PATH. Windows: `winget install Gyan.FFmpeg`.
 *
 *   node scripts/make-probe-fixture.mjs [--out <dir>] [--long-minutes <n>]
 */
import { spawn } from 'node:child_process'
import { mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    'long-minutes': { type: 'string', default: '60' },
    help: { type: 'boolean', default: false }
  }
})

if (values.help) {
  console.log('Usage: node scripts/make-probe-fixture.mjs [--out <dir>] [--long-minutes <n>]')
  process.exit(0)
}

// `join(tmpdir(), ...)` rather than a literal, so this is one of the paths that
// stays correct on both platforms without anyone thinking about it.
const outDir = values.out ?? join(tmpdir(), 'oscine-probe-fixture')
const longMinutes = Number.parseFloat(values['long-minutes'])

if (!Number.isFinite(longMinutes) || longMinutes <= 0) {
  console.error(`--long-minutes must be a positive number, got "${values['long-minutes']}"`)
  process.exit(1)
}

/**
 * One entry per format the walker claims to support, so the gate exercises the
 * whole of `SUPPORTED_EXTENSIONS` rather than the two formats that happen to be
 * lying around. Distinct frequencies so an operator checking by ear can tell
 * which file is playing.
 */
const SHORT_CLIPS = [
  { name: 'probe-flac.flac', hz: 220, args: ['-c:a', 'flac'] },
  { name: 'probe-mp3.mp3', hz: 330, args: ['-c:a', 'libmp3lame', '-b:a', '192k'] },
  { name: 'probe-ogg.ogg', hz: 440, args: ['-c:a', 'libvorbis', '-q:a', '5'] },
  { name: 'probe-opus.opus', hz: 550, args: ['-c:a', 'libopus', '-b:a', '128k'] },
  { name: 'probe-m4a.m4a', hz: 660, args: ['-c:a', 'aac', '-b:a', '192k'] }
]

const SHORT_SECONDS = 20
const LONG_NAME = 'probe-long.flac'

function run(command, args) {
  return new Promise((resolve, reject) => {
    // `shell: false` is the default and stays that way: every argument below
    // reaches ffmpeg exactly as written, with no quoting rules that differ
    // between cmd.exe and a POSIX shell.
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}\n${stderr.trim()}`))
    )
  })
}

async function requireFfmpeg() {
  try {
    await run('ffmpeg', ['-version'])
  } catch {
    console.error('ffmpeg is not on PATH.')
    console.error('  Windows: winget install Gyan.FFmpeg')
    console.error('  Debian/Ubuntu: sudo apt install ffmpeg')
    console.error('  Arch: sudo pacman -S ffmpeg')
    process.exit(1)
  }
}

/** A stereo sine of a given length, tagged so the scan has something to parse. */
function encode({ path, hz, seconds, args, title, trackNo }) {
  return run('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${hz}:duration=${seconds}:sample_rate=44100`,
    '-ac',
    '2',
    ...args,
    '-metadata',
    `title=${title}`,
    '-metadata',
    'artist=Oscine Gate',
    '-metadata',
    'album=M1 Exit Probe',
    '-metadata',
    `track=${trackNo}`,
    '-metadata',
    'date=2026',
    path
  ])
}

await requireFfmpeg()
await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

console.log(`Building probe fixture in ${outDir}`)

for (const [index, clip] of SHORT_CLIPS.entries()) {
  const path = join(outDir, clip.name)
  await encode({
    path,
    hz: clip.hz,
    seconds: SHORT_SECONDS,
    args: clip.args,
    title: `Probe ${clip.name.split('.').pop().toUpperCase()}`,
    trackNo: index + 1
  })
  const { size } = await stat(path)
  console.log(`  ${clip.name.padEnd(16)} ${String(size).padStart(9)} bytes  ${clip.hz}Hz`)
}

const longPath = join(outDir, LONG_NAME)
const longSeconds = Math.round(longMinutes * 60)
console.log(`  ${LONG_NAME} — ${longMinutes} minutes, this takes a moment…`)
await encode({
  path: longPath,
  hz: 110,
  seconds: longSeconds,
  args: ['-c:a', 'flac'],
  title: 'Probe Long Decode',
  trackNo: SHORT_CLIPS.length + 1
})

const { size: longSize } = await stat(longPath)
const decodedBytes = longSeconds * 44100 * 2 * 4
console.log(
  `  ${LONG_NAME.padEnd(16)} ${String(longSize).padStart(9)} bytes  ` +
    `decodes to ~${(decodedBytes / 1024 ** 3).toFixed(2)}GiB at 44.1kHz`
)
console.log(`\nAdd this folder as a library root: ${outDir}`)
