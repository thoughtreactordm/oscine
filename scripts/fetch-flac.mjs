/**
 * Place the reference `flac` encoder under `resources/bin/<platform>-<arch>/`.
 *
 * Windows takes the official Xiph zip (checksum-pinned). Linux copies the host
 * `flac` plus the libFLAC/libogg it dlopens, then sets the executable bit —
 * that bit does not survive a naive copy, and the failure is a confusing EACCES
 * at first rip.
 *
 * Each platform vendors its own binary; there is no cross-copy. electron-builder
 * extraResources then maps this folder onto `process.resourcesPath/bin`.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const FLAC_VERSION = '1.5.0'
const WIN_ZIP = `flac-${FLAC_VERSION}-win.zip`
const WIN_URL = `https://github.com/xiph/flac/releases/download/${FLAC_VERSION}/${WIN_ZIP}`
const WIN_SHA256 = '53f1500f0d6e7c61379d7fee50d4a9f7f504c650009506d9ba015530d76c0dde'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = join(root, 'resources', 'bin', `${process.platform}-${process.arch}`)

if (!['linux', 'win32'].includes(process.platform)) {
  throw new Error('flac vendor step supports Linux and Windows')
}

mkdirSync(outDir, { recursive: true })

if (process.platform === 'win32') {
  await vendorWindows()
} else {
  vendorLinux()
}
chmodSync(join(outDir, process.platform === 'win32' ? 'flac.exe' : 'flac'), 0o755)
console.info(`flac: ${process.platform}-${process.arch} encoder ready in ${outDir}`)

async function vendorWindows() {
  const zip = join(outDir, WIN_ZIP)
  const body = Buffer.from(await (await fetch(WIN_URL)).arrayBuffer())
  const hash = createHash('sha256').update(body).digest('hex')
  if (hash !== WIN_SHA256) {
    throw new Error(`flac zip sha256 mismatch: ${hash}`)
  }
  writeFileSync(zip, body)
  const unpack = mkdtempSync(join(tmpdir(), 'oscine-flac-'))
  try {
    const extract = spawnSync('tar', ['-xf', zip, '-C', unpack], { encoding: 'utf8' })
    if (extract.status !== 0) {
      throw new Error(extract.stderr || 'failed to extract flac zip')
    }
    const exe = findFile(unpack, 'flac.exe')
    if (!exe) throw new Error('flac.exe missing from official zip')
    copyFileSync(exe, join(outDir, 'flac.exe'))
    for (const name of readdirSync(dirname(exe))) {
      if (name.toLowerCase().endsWith('.dll')) {
        copyFileSync(join(dirname(exe), name), join(outDir, name))
      }
    }
  } finally {
    rmSync(unpack, { recursive: true, force: true })
    rmSync(zip, { force: true })
  }
}

function vendorLinux() {
  const which = spawnSync('which', ['flac'], { encoding: 'utf8' })
  const src = (which.stdout ?? '').trim()
  if (which.status !== 0 || !src || !existsSync(src)) {
    throw new Error('flac not found on PATH; install the flac package and re-run')
  }
  const dest = join(outDir, 'flac')
  copyFileSync(src, dest)
  const ldd = spawnSync('ldd', [dest], { encoding: 'utf8' })
  for (const line of (ldd.stdout ?? '').split('\n')) {
    const match = /^\s+(lib(?:FLAC|ogg)\.so\.\S+)\s+=>\s+(\S+)/.exec(line)
    if (match && existsSync(match[2])) copyFileSync(match[2], join(outDir, match[1]))
  }
}

function findFile(dir, name) {
  const lower = name.toLowerCase()
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = findFile(path, name)
      if (found) return found
    } else if (entry.name.toLowerCase() === lower) {
      return path
    }
  }
  return null
}
