#!/usr/bin/env node
/**
 * Fills the development library with a synthetic corpus.
 *
 * W4-1's acceptance is a scale claim — a 100k-row list scrolls with a flat DOM
 * node count, and sorting it returns without perceptible delay — and a scale
 * claim cannot be checked against a folder of forty MP3s. Generating 100k real
 * audio files to scan would take far longer than it would prove; the panel and
 * the query are what is under test, not the scanner.
 *
 * The rows are deliberately *not* playable: they point at paths that do not
 * exist, so `fermata://track/<id>` 404s for every one of them. That is the
 * honest trade. Use a real folder to test playback and this to test scale, and
 * do not confuse a green scroll test here for a working library.
 *
 *   node scripts/seed-synthetic-library.mjs            # 100,000 rows
 *   node scripts/seed-synthetic-library.mjs --count 5000
 *   node scripts/seed-synthetic-library.mjs --clear    # remove them again
 *   node scripts/seed-synthetic-library.mjs --db path/to/library.db
 *
 * Close the app first: better-sqlite3 writes synchronously and a running
 * Electron process holds the same file.
 */
import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

/** Marks every row this script owns, so `--clear` can remove exactly them. */
const SYNTHETIC_ROOT_PATH = resolve('/__fermata_synthetic__')
const SYNTHETIC_ROOT_LABEL = 'Synthetic benchmark'

const ARTIST_COUNT = 2_000
const ALBUM_COUNT = 8_000
/** Share of tracks left untagged, so nulls-last ordering is actually exercised. */
const UNTAGGED_SHARE = 0.02

const { values } = parseArgs({
  options: {
    count: { type: 'string', default: '100000' },
    db: { type: 'string' },
    clear: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false }
  }
})

if (values.help) {
  console.log(
    [
      'Usage: node scripts/seed-synthetic-library.mjs [options]',
      '',
      '  --count <n>   rows to insert (default 100000)',
      '  --db <path>   database file (default: the development userData copy)',
      '  --clear       remove the synthetic root and its rows, then exit'
    ].join('\n')
  )
  process.exit(0)
}

/**
 * Where Electron keeps `userData` for this app.
 *
 * `fermata` in development, where the name comes from package.json; `Fermata`
 * once packaged, where electron-builder's productName wins. Both are checked
 * rather than guessed at.
 */
function defaultDatabasePath() {
  const roots = []
  if (platform() === 'win32') {
    const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
    roots.push(join(appData, 'fermata'), join(appData, 'Fermata'))
  } else if (platform() === 'darwin') {
    const base = join(homedir(), 'Library', 'Application Support')
    roots.push(join(base, 'fermata'), join(base, 'Fermata'))
  } else {
    const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
    roots.push(join(base, 'fermata'), join(base, 'Fermata'))
  }

  const found = roots.map((root) => join(root, 'library.db')).find((file) => existsSync(file))
  return found ?? join(roots[0], 'library.db')
}

const databasePath = values.db ? resolve(values.db) : defaultDatabasePath()

if (!existsSync(databasePath)) {
  console.error(`No library database at ${databasePath}.`)
  console.error('Launch the app once so the migration runner can create it, then re-run this.')
  process.exit(1)
}

const db = new Database(databasePath)
db.pragma('foreign_keys = ON')

const hasTracks = db
  .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tracks'`)
  .get()
if (!hasTracks) {
  console.error(`${databasePath} has no schema. Launch the app once to run migrations.`)
  process.exit(1)
}

function removeSynthetic() {
  // ON DELETE CASCADE clears tracks; the artists and albums are shared name
  // tables and are left alone, being harmless and cheap.
  const result = db.prepare('DELETE FROM roots WHERE path = ?').run(SYNTHETIC_ROOT_PATH)
  return result.changes > 0
}

if (values.clear) {
  const removed = removeSynthetic()
  db.exec('VACUUM')
  console.log(removed ? 'Removed the synthetic root and its tracks.' : 'Nothing to remove.')
  process.exit(0)
}

const count = Number.parseInt(values.count, 10)
if (!Number.isInteger(count) || count <= 0) {
  console.error('--count must be a positive integer.')
  process.exit(1)
}

/**
 * Deterministic pseudo-randomness.
 *
 * A fixed corpus means a sort timing measured today is comparable to one
 * measured after the next query change, which is the only reason to measure it.
 */
let seed = 0x9e3779b9
function random() {
  seed = (seed * 1664525 + 1013904223) >>> 0
  return seed / 0x1_0000_0000
}
function pick(list) {
  return list[Math.floor(random() * list.length)]
}

const FIRST = ['Ash', 'Bell', 'Corvid', 'Dust', 'Ember', 'Fathom', 'Glass', 'Hollow', 'Iron', 'Juniper', 'Kestrel', 'Lantern', 'Marrow', 'North', 'Oxide', 'Pallor', 'Quartz', 'Rivet', 'Salt', 'Tundra', 'Umber', 'Vellum', 'Winter', 'Yarrow']
const SECOND = ['Anchor', 'Bloom', 'Cinder', 'Drift', 'Echo', 'Fable', 'Grain', 'Haze', 'Inlet', 'Junction', 'Knot', 'Ledger', 'Mire', 'Nocturne', 'Orbit', 'Pier', 'Quarry', 'Relay', 'Shoal', 'Threshold', 'Undertow', 'Vault', 'Wane']
const CODECS = ['flac', 'mp3', 'vorbis', 'opus']

function phrase() {
  return `${pick(FIRST)} ${pick(SECOND)}`
}

console.log(`Seeding ${count.toLocaleString()} synthetic tracks into ${databasePath}`)
const startedAt = Date.now()

removeSynthetic()

const insertRoot = db.prepare(
  'INSERT INTO roots (label, path, added_at, last_scan_at) VALUES (?, ?, ?, ?)'
)
const insertArtist = db.prepare(
  'INSERT INTO artists (name, sort_name) VALUES (?, ?) ON CONFLICT(name) DO NOTHING'
)
const artistId = db.prepare('SELECT id FROM artists WHERE name = ?').pluck()
const insertAlbum = db.prepare(
  `INSERT INTO albums (title, album_artist_id, year) VALUES (?, ?, ?)
   ON CONFLICT(title, album_artist_id) DO NOTHING`
)
const albumId = db
  .prepare('SELECT id FROM albums WHERE title = ? AND album_artist_id IS ?')
  .pluck()
const insertTrack = db.prepare(
  `INSERT INTO tracks (
     root_id, rel_path, mtime, size, duration_ms, codec, sample_rate, channels,
     bit_depth, title, artist_id, album_id, track_no, disc_no
   ) VALUES (
     @rootId, @relPath, @mtime, @size, @durationMs, @codec, @sampleRate, @channels,
     @bitDepth, @title, @artistId, @albumId, @trackNo, @discNo
   )`
)

const seedAll = db.transaction(() => {
  const now = Date.now()
  const rootId = insertRoot.run(SYNTHETIC_ROOT_LABEL, SYNTHETIC_ROOT_PATH, now, now)
    .lastInsertRowid

  const artistIds = []
  for (let index = 0; index < ARTIST_COUNT; index++) {
    const name = `${phrase()} ${index}`
    insertArtist.run(name, name)
    artistIds.push(artistId.get(name))
  }

  const albumIds = []
  for (let index = 0; index < ALBUM_COUNT; index++) {
    const title = `${phrase()} ${index}`
    const owner = pick(artistIds)
    insertAlbum.run(title, owner, 1970 + Math.floor(random() * 55))
    albumIds.push(albumId.get(title, owner))
  }

  for (let index = 0; index < count; index++) {
    const untagged = random() < UNTAGGED_SHARE
    insertTrack.run({
      rootId,
      relPath: `synthetic/${String(index).padStart(7, '0')}.flac`,
      mtime: now,
      size: 4_000_000 + Math.floor(random() * 40_000_000),
      durationMs: 45_000 + Math.floor(random() * 555_000),
      codec: pick(CODECS),
      sampleRate: 44_100,
      channels: 2,
      bitDepth: 16,
      title: `${phrase()} ${index}`,
      artistId: untagged ? null : pick(artistIds),
      albumId: untagged ? null : pick(albumIds),
      trackNo: untagged ? null : 1 + Math.floor(random() * 18),
      discNo: 1
    })
  }
})

seedAll()

const total = db.prepare('SELECT count(*) FROM tracks').pluck().get()
console.log(
  `Done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s — ${total.toLocaleString()} tracks in the library.`
)
console.log('These rows have no files behind them; playing one will fail. Use --clear to remove.')
db.close()
