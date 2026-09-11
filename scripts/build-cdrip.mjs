import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const native = join(root, 'native', 'cdrip')
if (!['linux', 'win32'].includes(process.platform)) {
  throw new Error('cdrip supports Linux and Windows')
}
const build = spawnSync(
  process.execPath,
  [require.resolve('node-gyp/bin/node-gyp.js'), 'rebuild'],
  {
    cwd: native,
    stdio: 'inherit'
  }
)
if (build.status !== 0) process.exit(build.status ?? 1)
const output = join(native, 'prebuilds', `${process.platform}-${process.arch}`)
mkdirSync(output, { recursive: true })
copyFileSync(join(native, 'build', 'Release', 'cdrip.node'), join(output, 'cdrip.node'))
console.info(`cdrip: Node-API 8 prebuild ready for ${process.platform}-${process.arch}`)
