#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { arch, platform, tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { parseArgs } from 'node:util'

import {
  buildWritebackCorpus,
  CODECS,
  CORPUS_VERSION,
  verifyRoundTrip
} from './lib/writeback-corpus.mjs'
import { FIELD_CASES } from './lib/writeback-field-cases.mjs'

/**
 * The tag write-back round-trip gate — W16-2, design authority D28.
 *
 * One of D7's two literal preconditions for write-back: it synthesises the
 * mixed-format corpus in a throwaway directory, runs write → read → verify over
 * every v1 codec, and writes a markdown report. It exits non-zero on any failed
 * check, in the M1/M2 gate spirit — a red run is a triage card, never a quiet fix
 * folded into the flush path. Needs ffmpeg on PATH. W16-13 extends the same gate
 * with multi-picture and custom-frame write-path checks; W16-16 adds a
 * `written:<field>` round-trip per registry field and reports it as a field ×
 * codec matrix — the evidence Decision D admits a field on.
 *
 * The fixture is built in a fresh temp directory and removed on exit (unless
 * `--keep`), so the gate never touches the operator's library and leaves nothing
 * behind. Nothing here is platform-conditional: the same audio, the same embedded
 * cover bytes, and the same tag values are measured on Windows and Linux alike.
 */

const require = createRequire(import.meta.url)

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    keep: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false }
  }
})

if (values.help) {
  console.log('Usage: node scripts/writeback-corpus-probe.mjs [--out <file>] [--keep]')
  process.exit(0)
}

/** Captures the first line of `ffmpeg -version`, or a marker when it is absent. */
function ffmpegVersion() {
  return new Promise((resolve) => {
    const child = spawn('ffmpeg', ['-version'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      out += chunk
    })
    child.on('error', () => resolve('(ffmpeg not found)'))
    child.on('close', () => resolve(out.split('\n')[0].trim() || '(unknown)'))
  })
}

/** The matrix's rows: every registry field, then the grouped album artist (W16-14). */
const MATRIX_FIELDS = [...FIELD_CASES.map((fieldCase) => fieldCase.key), 'album-artist']

/** `written:<field>:<case>`, `read:<field>`, and their `reader:` twins → the field. */
const FIELD_CHECK = /^(?:reader:)?(?:written|read):([^:]+)(?::(.+))?$/

/**
 * One cell per field × codec. A cell is green only when every check for that
 * field on that codec passed; a missing cell (the field pass threw) is red.
 */
function fieldMatrix(report) {
  const cells = new Map()
  for (const item of report.checks) {
    const match = FIELD_CHECK.exec(item.name)
    if (match === null || !MATRIX_FIELDS.includes(match[1])) continue
    const key = `${match[1]}|${item.codec}`
    const cell = cells.get(key) ?? { failed: [] }
    if (!item.passed) {
      const label = item.name.startsWith('reader:') ? `reader ${match[2] ?? ''}` : match[2]
      cell.failed.push((label ?? 'read').trim())
    }
    cells.set(key, cell)
  }
  return MATRIX_FIELDS.map((field) => {
    const row = CODECS.map((codec) => {
      const cell = cells.get(`${field}|${codec.id}`)
      if (cell === undefined) return { green: false, text: '— (no result)' }
      return cell.failed.length === 0
        ? { green: true, text: '✅' }
        : { green: false, text: `❌ ${cell.failed.join(', ')}` }
    })
    return { field, row, green: row.every((cell) => cell.green) }
  })
}

function markdownReport(report, env) {
  const failed = report.checks.filter((item) => !item.passed)
  const matrix = fieldMatrix(report)
  const lines = []
  lines.push('# Tag write-back corpus — round-trip gate (W16-3 / W16-13 / W16-16)')
  lines.push('')
  lines.push(`- Result: **${failed.length === 0 ? 'PASS' : 'FAIL'}**`)
  lines.push(`- Checks: ${report.checks.length - failed.length}/${report.checks.length} passed`)
  lines.push(`- Generated: ${env.when}`)
  lines.push(`- Platform: ${env.platform}/${env.arch}`)
  lines.push(`- ffmpeg: ${env.ffmpeg}`)
  lines.push(`- node-taglib-sharp: ${env.taglib}`)
  lines.push(`- Corpus version: ${report.version}`)
  lines.push('')

  const red = matrix.filter((row) => !row.green).map((row) => row.field)
  lines.push('## Field matrix (W16-16, Decision D)')
  lines.push('')
  lines.push(
    'A field is admitted to the registry only when its row is green on every codec. ' +
      'A red cell is a triage card and the field stays non-admitted — never a fix ' +
      'folded into this run.'
  )
  lines.push('')
  lines.push(`- Green on all five: ${matrix.length - red.length}/${matrix.length}`)
  lines.push(`- Red: ${red.length === 0 ? 'none' : red.map((field) => `\`${field}\``).join(', ')}`)
  lines.push('')
  lines.push(`| Field | ${CODECS.map((codec) => codec.id).join(' | ')} |`)
  lines.push(`| --- | ${CODECS.map(() => '---').join(' | ')} |`)
  for (const { field, row } of matrix) {
    lines.push(`| \`${field}\` | ${row.map((cell) => cell.text).join(' | ')} |`)
  }
  lines.push('')

  for (const codec of CODECS) {
    const rows = report.checks.filter((item) => item.codec === codec.id)
    const codecFailed = rows.filter((item) => !item.passed).length
    lines.push(
      `## ${codec.id} — ${codec.file} (${codecFailed === 0 ? 'pass' : `${codecFailed} failed`})`
    )
    lines.push('')
    lines.push('| Check | Result | Detail |')
    lines.push('| --- | --- | --- |')
    for (const item of rows) {
      lines.push(
        `| ${item.name} | ${item.passed ? '✅' : '❌'} | ${item.passed ? '' : item.detail} |`
      )
    }
    lines.push('')
  }

  lines.push('## Notes')
  lines.push('')
  lines.push(
    '- Genres are written as one separator-joined value and verified through the ' +
      "app's `primaryGenre` + `splitGenres` pipeline, not as native multi-frame " +
      'genres — the app keeps only the first genre element and re-splits it, so ' +
      'multiple frames would lose all but the first on rescan. The flush engine ' +
      '(W16-3) must serialise genres the same way.'
  )
  lines.push(
    '- Artwork and custom frames (text, binary, and multi-instance) are seeded, ' +
      'then a scalar-only write must leave them byte-for-byte intact. A subsequent ' +
      'front-cover set/clear (Decision B) must write the new cover, preserve the ' +
      'back cover on codecs whose containers distinguish picture types, and still ' +
      'leave custom frames untouched. Decoded PCM is hashed before and after to ' +
      'prove the audio stream was never rewritten. Apple `covr` has no picture-type ' +
      'field, so back-cover checks skip AAC.'
  )
  lines.push(
    '- Field cells cover set, clear and (for lists) an ordered two-entry write, ' +
      'type-exact for ints and bools. A clear is green only if no other field — ' +
      'generic or grouped — moved with it. Read-only ReplayGain rows are seeded and ' +
      'read back, never cleared. Album artist is also read through music-metadata, ' +
      'which is what the scanner groups albums on.'
  )
  lines.push('')
  return lines.join('\n')
}

console.log('Writeback corpus probe')
console.log(`  platform: ${platform()}/${arch()}`)
console.log(`  corpus version: ${CORPUS_VERSION}`)

const runRoot = await mkdtemp(join(tmpdir(), 'oscine-writeback-corpus-'))
const outPath = resolvePath(values.out ?? join(tmpdir(), `writeback-corpus-${platform()}.md`))

let report
try {
  console.log('Synthesising corpus')
  const manifest = await buildWritebackCorpus(runRoot, (message) => console.log(`  ${message}`))
  console.log('Verifying round-trip')
  report = await verifyRoundTrip(manifest, (message) => console.log(`  ${message}`))
} finally {
  if (!values.keep) {
    await rm(runRoot, { recursive: true, force: true })
  } else {
    console.log(`  fixture kept at ${runRoot}`)
  }
}

const env = {
  when: new Date().toISOString(),
  platform: platform(),
  arch: arch(),
  ffmpeg: await ffmpegVersion(),
  taglib: require('node-taglib-sharp/package.json').version
}

await writeFile(outPath, markdownReport(report, env), 'utf8')
console.log(`Report written to ${outPath}`)

const failed = report.checks.filter((item) => !item.passed)
if (failed.length > 0) {
  console.error(
    `Writeback corpus probe failed ${failed.length} of ${report.checks.length} check(s).`
  )
  for (const item of failed) {
    console.error(`  ${item.codec} ${item.name} — ${item.detail}`)
  }
  process.exitCode = 1
} else {
  console.log(`Writeback corpus probe passed all ${report.checks.length} checks.`)
}
