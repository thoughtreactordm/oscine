/**
 * Asserts that `release/` holds exactly the deliverables and electron-updater
 * sidecars this platform's electron-builder run should have produced, and with
 * `--upload <tag>` attaches them to that GitHub release.
 *
 * Why this is a script rather than inline workflow shell: the release job was
 * the only place the assertion ran, and it only runs on a push to main — so
 * 1.0.2 found out at release time that the Linux check expected a file
 * electron-builder never writes. CI now runs the same script against a packaged
 * build on every pull request, and the release job runs it again to upload.
 * One definition of "the release artifacts" for both, and for both platforms.
 *
 * The AppImage has no separate `.blockmap`. electron-builder appends the
 * blockmap to the AppImage itself and records its length as `blockMapSize` in
 * `latest-linux.yml`; electron-updater reads it back from the end of the file
 * (FileWithEmbeddedBlockMapDifferentialDownloader). So the Linux check is that
 * the feed carries `blockMapSize` for the AppImage, not that a sidecar exists.
 * Without it the AppImage updater falls back to a full download at best.
 *
 *   node scripts/release-artifacts.mjs                 # verify only
 *   node scripts/release-artifacts.mjs --upload v1.2.3 # verify, then attach
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const RELEASE_DIR = 'release'

const uploadFlag = process.argv.indexOf('--upload')
const tag = uploadFlag === -1 ? null : process.argv[uploadFlag + 1]
if (uploadFlag !== -1 && !tag) fail('--upload needs a release tag')

if (!existsSync(RELEASE_DIR)) fail(`no ${RELEASE_DIR}/ directory — package first`)
const names = readdirSync(RELEASE_DIR, { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name)

// Deliverables are matched against the version being released, so a local
// release/ full of earlier builds is not ambiguous and a stale artifact can
// never be the one uploaded. The trailing `[._]` keeps 1.0.0 from matching
// 1.0.0-rc.1 or 1.0.3 from matching 1.0.30.
const version = JSON.parse(readFileSync('package.json', 'utf8')).version
const versionPattern = new RegExp(`(^|[-_ ])${version.replace(/\./g, '\\.')}[._]`)
const isVersion = (n) => versionPattern.test(n)

/** Exactly one top-level file matching `test`, or fail naming what was found. */
function one(label, test) {
  const found = names.filter(test)
  if (found.length !== 1) {
    fail(
      `expected one ${label} in ${RELEASE_DIR}/, found ${found.length}: ${found.join(', ') || 'none'}`
    )
  }
  return found[0]
}

/**
 * The `blockMapSize` recorded for `url` in an electron-builder update feed.
 * A line scan rather than a YAML parser: the feed is flat, machine-written, and
 * this script should not grow a dependency to read two keys out of it.
 */
function blockMapSizeFor(feed, url) {
  let inEntry = false
  for (const line of feed.split(/\r?\n/)) {
    const entry = line.match(/^\s*-\s+url:\s*(.+?)\s*$/)
    if (entry) {
      inEntry = entry[1] === url
      continue
    }
    if (!inEntry) continue
    if (/^\S/.test(line)) break
    const size = line.match(/^\s+blockMapSize:\s*(\d+)\s*$/)
    if (size) return Number(size[1])
  }
  return null
}

/** `[path, label]` pairs; `gh release upload` shows `label` on the release page. */
let uploads
if (process.platform === 'win32') {
  const exe = one(`${version} .exe installer`, (n) => isVersion(n) && n.endsWith('.exe'))
  const blockmap = one(
    `${version} .exe.blockmap`,
    (n) => isVersion(n) && n.endsWith('.exe.blockmap')
  )
  const feed = one('latest.yml', (n) => n === 'latest.yml')
  uploads = [[exe], [blockmap], [feed]]
} else if (process.platform === 'linux') {
  const appImage = one(`${version} AppImage`, (n) => isVersion(n) && n.endsWith('.AppImage'))
  const deb = one(`${version} .deb`, (n) => isVersion(n) && n.endsWith('.deb'))
  const feed = one('latest-linux.yml', (n) => n === 'latest-linux.yml')
  const size = blockMapSizeFor(readFileSync(join(RELEASE_DIR, feed), 'utf8'), appImage)
  if (!size)
    fail(`${feed} records no blockMapSize for ${appImage} — the embedded blockmap is missing`)
  uploads = [
    [appImage, 'Linux — AppImage (portable, any distro)'],
    [deb, 'Linux — .deb (Debian / Ubuntu)'],
    [feed]
  ]
} else {
  // D10: no macOS target, so there is no artifact set to check.
  fail(`no release artifact set is defined for ${process.platform}`)
}

for (const [name, label] of uploads) console.log(`ok  ${name}${label ? `  (${label})` : ''}`)

if (tag) {
  const args = uploads.map(([name, label]) => join(RELEASE_DIR, name) + (label ? `#${label}` : ''))
  // An argument vector, not a shell line: the labels carry spaces and an em
  // dash, and pwsh and bash would each want them quoted differently.
  const gh = spawnSync('gh', ['release', 'upload', tag, ...args, '--clobber'], { stdio: 'inherit' })
  if (gh.error) fail(`could not run gh: ${gh.error.message}`)
  process.exit(gh.status ?? 1)
}

function fail(message) {
  console.error(`release-artifacts: ${message}`)
  if (existsSync(RELEASE_DIR)) console.error(`contents: ${readdirSync(RELEASE_DIR).join(', ')}`)
  process.exit(1)
}
