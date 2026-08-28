#!/usr/bin/env node
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { buildWritebackCorpus } from './lib/writeback-corpus.mjs'

/**
 * Builds the W16-2 tag write-back corpus and leaves it on disk to inspect.
 *
 * The synthesis half of the gate, split out the way `make-m2-probe-fixture`
 * splits from the M2 probe: run this to eyeball the fixture in a tag editor, run
 * `writeback-corpus-probe` to actually verify the round-trip. Needs ffmpeg.
 */

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    help: { type: 'boolean', default: false }
  }
})

if (values.help) {
  console.log('Usage: node scripts/make-writeback-corpus.mjs [--out <dir>]')
  process.exit(0)
}

const outDir = resolve(values.out ?? join(tmpdir(), 'oscine-writeback-corpus'))
console.log(`Building tag write-back corpus in ${outDir}`)
const manifest = await buildWritebackCorpus(outDir, (message) => console.log(`  ${message}`))
console.log(`Built ${manifest.tracks.length} tracks.`)
console.log(`Library root: ${manifest.libraryDir}`)
