/**
 * Verifies that the native runtime dependencies load under Electron's ABI, and
 * that the SQLite build behind better-sqlite3 has the features schema v1
 * depends on.
 *
 * Why this exists as a script rather than a one-off check: W2-1 could only be
 * verified on Windows. D10 makes Linux first-class, so the check has to be
 * runnable rather than remembered — W6-1's CI matrix runs `npm run verify:native`
 * on ubuntu-latest and this stops being an assumption.
 *
 * It re-executes itself under Electron (ELECTRON_RUN_AS_NODE) so that the
 * `process.versions.modules` doing the loading is Electron's, not the system
 * Node's. Those differ — Electron 43 is ABI 148, Node 24.14 is ABI 137 — which is
 * exactly the mismatch that would bite at packaging time.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const selfPath = fileURLToPath(import.meta.url)

if (!process.versions.electron) {
  // Parent leg: re-exec under Electron. `electron` resolves to the binary path.
  const { default: electronPath } = await import('electron')
  const child = spawnSync(electronPath, [selfPath], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    // Electron is a GUI-subsystem binary on Windows and writes nothing to an
    // inherited console, so capture the pipes and re-emit them ourselves.
    encoding: 'utf8'
  })
  if (child.stdout) process.stdout.write(child.stdout)
  if (child.stderr) process.stderr.write(child.stderr)
  process.exit(child.status ?? 1)
}

// Child leg: running under Electron's Node.
const { default: Database } = await import('better-sqlite3')

const dir = mkdtempSync(join(tmpdir(), 'fermata-abi-'))
const file = join(dir, 'probe.db')
let failed = false

function check(label, fn) {
  try {
    const detail = fn()
    console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`)
  } catch (err) {
    failed = true
    console.log(`  FAIL  ${label} — ${err.message}`)
  }
}

console.log(
  `electron ${process.versions.electron} · node ${process.versions.node} · module ABI ${process.versions.modules}`
)

try {
  const db = new Database(file)

  check('native binding loads', () => `sqlite ${db.prepare('select sqlite_version() v').get().v}`)

  check('WAL mode', () => {
    const mode = db.pragma('journal_mode = WAL', { simple: true })
    if (mode !== 'wal') throw new Error(`journal_mode came back as ${mode}`)
    return mode
  })

  check('foreign_keys pragma', () => {
    db.pragma('foreign_keys = ON')
    if (db.pragma('foreign_keys', { simple: true }) !== 1) throw new Error('stayed off')
    return 'ON'
  })

  // Schema v1 declares a virtual table with fts5. A SQLite built without it
  // fails at migration time, not at load time, so check it here.
  check('fts5 available', () => {
    db.exec("CREATE VIRTUAL TABLE probe_fts USING fts5(a, content='')")
    return 'yes'
  })

  check('unicode61 remove_diacritics 2 tokenizer', () => {
    db.exec(
      "CREATE VIRTUAL TABLE probe_tok USING fts5(a, tokenize='unicode61 remove_diacritics 2')"
    )
    return 'yes'
  })

  db.close()

  try {
    const { AudioContext } = await import('node-web-audio-api')
    const context = new AudioContext({ sinkId: { type: 'none' } })
    await context.close()
    console.log('  ok    ReplayGain decoder binding — worker-safe sink')
  } catch (error) {
    failed = true
    console.log(`  FAIL  ReplayGain decoder binding — ${error.message}`)
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(failed ? '\nnative check FAILED' : '\nnative check passed')
process.exit(failed ? 1 : 0)
