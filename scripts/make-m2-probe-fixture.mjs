#!/usr/bin/env node
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { buildM2Fixture } from './lib/m2-fixture.mjs'

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    help: { type: 'boolean', default: false }
  }
})

if (values.help) {
  console.log('Usage: node scripts/make-m2-probe-fixture.mjs [--out <dir>]')
  process.exit(0)
}

const outDir = resolve(values.out ?? join(tmpdir(), 'oscine-m2-probe-fixture'))
console.log(`Building M2 probe fixture in ${outDir}`)
const manifest = await buildM2Fixture(outDir, (message) => console.log(`  ${message}`))
console.log(`Built ${Object.keys(manifest.tracks).length} tracks.`)
console.log(`Library root: ${manifest.libraryDir}`)
