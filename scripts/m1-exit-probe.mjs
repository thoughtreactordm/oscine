#!/usr/bin/env node
/**
 * The M1 exit gate (card W6-2), executed rather than remembered.
 *
 * The gate is a six-step manual procedure plus three figures to record, and it
 * has to produce comparable results on Windows and on Linux — D10 makes both
 * first-class, and a milestone gate that measures the two platforms differently
 * is not a gate. The first Linux run was driven by hand through a scatter of
 * one-off `cdp-eval` expressions, `/proc` reads and a bash ffmpeg script. Every
 * one of those was Linux-only, and none of it survived the session. This is that
 * run, written down, so the Windows column is the same experiment and not a
 * second opinion.
 *
 * Nothing here is platform-conditional. Memory comes from Chromium's own
 * `app.getAppMetrics()` via the main-process inspector, which reports the same
 * shape on both platforms; the fixture is synthesised identically on both; and
 * every path is composed rather than written.
 *
 * ## Running it
 *
 *   npm run probe:fixture                         # once per machine
 *   npm run dev -- -- --remote-debugging-port=9222 --inspect=9229
 *   npm run probe:m1-exit
 *
 * Step 1 of the gate adds a folder through the native picker, which no script can
 * click. Rather than reach around the app and write the root into SQLite — which
 * would skip `addRoot`'s resolve, stat, conflict check and background scan, i.e.
 * most of what step 1 is actually testing — the probe stubs
 * `dialog.showOpenDialog` in the main process for exactly one call and restores
 * it afterwards. Everything downstream of the human's click is the real path.
 *
 * ## What it does not cover
 *
 * The look of the thing. Steps 3 to 6 are checked here for behaviour and timing,
 * not for whether the result is pleasant to use; the operator still signs off the
 * UI. And it never touches the database directly — every fact it records came
 * back over the app's own IPC surface.
 */
import { writeFile } from 'node:fs/promises'
import { hostname, platform, release, tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { parseArgs } from 'node:util'

import { appMetrics, connectToMain, connectToRenderer, rendererMiB } from './lib/cdp.mjs'

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    fixture: { type: 'string' },
    help: { type: 'boolean', default: false }
  }
})

if (values.help) {
  console.log('Usage: node scripts/m1-exit-probe.mjs [--out <file>] [--fixture <dir>]')
  process.exit(0)
}

const outPath = values.out ?? join(tmpdir(), `m1-exit-${platform()}.md`)
// Must agree with make-probe-fixture.mjs's default, and does so by construction:
// both compose it from `tmpdir()` rather than writing it down twice.
const fixtureDir = values.fixture ?? join(tmpdir(), 'fermata-probe-fixture')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const mib = (bytes) => bytes / 1024 ** 2
const round = (n, places = 1) => Number(n.toFixed(places))

/** Collected as we go; rendered to markdown at the end. */
const report = { steps: [], notes: [] }
const record = (title, data) => {
  report.steps.push({ title, data })
  console.log(`  ✓ ${title}`)
  return data
}
const note = (text) => {
  report.notes.push(text)
  console.log(`  ! ${text}`)
}

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

console.log('M1 exit probe')
const renderer = await connectToRenderer()
const main = await connectToMain()

/**
 * Capture everything the renderer logs, so "were there any warnings" is answered
 * by evidence rather than by whether anyone was looking at the console. Installed
 * before anything else runs.
 */
await renderer.evaluate(`
  if (!window.__probeLog) {
    window.__probeLog = []
    for (const level of ['log', 'info', 'warn', 'error']) {
      const original = console[level].bind(console)
      console[level] = (...args) => {
        window.__probeLog.push(level + ': ' + args.map(String).join(' '))
        original(...args)
      }
    }
  }
  return true
`)

const logsSince = async (mark) => renderer.evaluate(`return window.__probeLog.slice(${mark})`)
const logMark = async () => renderer.evaluate('return window.__probeLog.length')

/** The Pinia playback store, reached the way devtools reaches it. */
const PLAYBACK = `document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('playback')`

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

const versions = await main.evaluate(
  'return JSON.stringify({ electron: process.versions.electron, chrome: process.versions.chrome,' +
    ' node: process.versions.node, v8: process.versions.v8, arch: process.arch })'
)
const audioContext = await renderer.evaluate(`
  const ctx = new AudioContext()
  const rate = ctx.sampleRate
  await ctx.close()
  return rate
`)

record('environment', {
  platform: platform(),
  release: release(),
  hostname: hostname(),
  ...JSON.parse(versions),
  audioContextSampleRateHz: audioContext,
  processes: (await appMetrics(main)).map((p) => ({ type: p.type, mib: round(p.kb / 1024, 0) }))
})

// ---------------------------------------------------------------------------
// Step 1 — the fixture root
// ---------------------------------------------------------------------------

const rootsNow = async () =>
  (await renderer.evaluate('return await window.fermata.library.listRoots()')).value

// `addRoot` resolves and normalises what the dialog hands back, so compare on the
// resolved form rather than on the string we passed in.
const resolvedFixture = resolvePath(fixtureDir)

let fixtureRoot = (await rootsNow()).find((root) => resolvePath(root.path) === resolvedFixture)

if (!fixtureRoot) {
  const addResult = await main
    .evaluate(
      `const { dialog } = require('electron')
       const original = dialog.showOpenDialog
       dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [${JSON.stringify(resolvedFixture)}] })
       globalThis.__probeRestoreDialog = () => { dialog.showOpenDialog = original }
       return 'stubbed'`
    )
    .then(() => renderer.evaluate('return await window.fermata.library.addRoot()'))
    .finally(() =>
      main.evaluate(
        'if (globalThis.__probeRestoreDialog) { globalThis.__probeRestoreDialog(); delete globalThis.__probeRestoreDialog }\nreturn true'
      )
    )

  if (!addResult?.ok) {
    console.error(`\naddRoot failed: ${JSON.stringify(addResult)}`)
    console.error(`Does ${resolvedFixture} exist? Run: npm run probe:fixture`)
    process.exit(1)
  }

  // `addRoot` kicks off the first scan without awaiting it, so give that scan a
  // moment to finish before the explicit rescan below measures a second one.
  await sleep(2000)
  fixtureRoot = (await rootsNow()).find((root) => resolvePath(root.path) === resolvedFixture)
}

record('step 1 — add root', {
  fixture: resolvedFixture,
  rootId: fixtureRoot.id,
  trackCount: fixtureRoot.trackCount,
  viaStubbedDialog: true,
  // M1's IPC surface has `addRoot` but no `removeRoot`, so this root outlives
  // the probe. Recorded rather than flagged: it is a known shape of M1, not a
  // finding from this run.
  caveat: 'this root persists — M1 has no removeRoot on the IPC surface'
})

// ---------------------------------------------------------------------------
// Step 2 — rescan it, watching progress
// ---------------------------------------------------------------------------

const scan = await renderer.evaluate(`
  const events = []
  const off = window.fermata.library.onScanProgress((p) => events.push(JSON.parse(JSON.stringify(p))))
  const started = performance.now()
  const summary = await window.fermata.library.scanRoot(${fixtureRoot.id})
  await new Promise((r) => setTimeout(r, 500))
  if (typeof off === 'function') off()
  return { summary, elapsedMs: Math.round(performance.now() - started), events }
`)

record('step 2 — scan', {
  root: fixtureRoot.path,
  summary: scan.summary.value ?? scan.summary,
  elapsedMs: scan.elapsedMs,
  progressEvents: scan.events.length,
  sawTerminalEvent: scan.events.some((event) => event.done === true),
  monotonic: scan.events.every(
    (event, i, all) => i === 0 || event.filesSeen >= all[i - 1].filesSeen
  )
})

const summary = scan.summary.value ?? scan.summary
if (summary.filesSkipped > 0) note(`scan skipped ${summary.filesSkipped} file(s) in the fixture`)

// ---------------------------------------------------------------------------
// Census, and locating every track's index in a chosen order
// ---------------------------------------------------------------------------

/**
 * `playFromList` addresses a track by its position in a sort order, so the probe
 * has to know where each fixture track sits. Paging the whole order is O(n) but
 * an order of 100k rows costs about a hundred 1.5ms calls, which is cheaper than
 * any cleverness would be to maintain.
 */
const census = await renderer.evaluate(`
  const byRoot = {}, fixture = []
  let offset = 0, total = Infinity
  while (offset < total) {
    const { value } = await window.fermata.library.listTracks({
      sort: 'durationSec', direction: 'desc', offset, limit: 1000
    })
    total = value.total
    value.tracks.forEach((t, i) => {
      byRoot[t.rootId] = (byRoot[t.rootId] ?? 0) + 1
      if (t.rootId === ${fixtureRoot.id}) fixture.push({ index: offset + i, ...t })
    })
    offset += 1000
  }
  const { value: longest } = await window.fermata.library.listTracks({
    sort: 'durationSec', direction: 'desc', offset: 0, limit: 1
  })
  return { total, byRoot, fixture, longest: longest.tracks[0] }
`)

record('library census', {
  totalTracks: census.total,
  tracksByRoot: census.byRoot,
  fixtureTracks: census.fixture.length,
  fixtureCodecs: census.fixture.map((t) => t.codec).sort()
})

// ---------------------------------------------------------------------------
// Step 3 — sort, every column, both directions
// ---------------------------------------------------------------------------

const sorts = await renderer.evaluate(`
  const out = []
  for (const sort of ['trackNo', 'title', 'artist', 'album', 'durationSec']) {
    for (const direction of ['asc', 'desc']) {
      const started = performance.now()
      const r = await window.fermata.library.listTracks({ sort, direction, offset: 0, limit: 100 })
      out.push({ sort, direction, ms: +(performance.now() - started).toFixed(1),
                 ok: r.ok, rows: r.value.tracks.length, total: r.value.total })
    }
  }
  const deep = Math.max(0, ${census.total} - 100)
  const started = performance.now()
  const r = await window.fermata.library.listTracks({ sort: 'artist', direction: 'asc', offset: deep, limit: 100 })
  out.push({ sort: 'artist', direction: 'asc @ ' + deep, ms: +(performance.now() - started).toFixed(1),
             ok: r.ok, rows: r.value.tracks.length, total: r.value.total })
  return out
`)

record('step 3 — sort', {
  pairs: sorts.length,
  allOk: sorts.every((s) => s.ok),
  slowestMs: Math.max(...sorts.map((s) => s.ms)),
  timings: sorts
})

if (!sorts.every((s) => s.ok)) note('at least one sort returned not-ok')

// ---------------------------------------------------------------------------
// Step 4 — one track of every format, with seek and volume
// ---------------------------------------------------------------------------

const shortFixtures = census.fixture.filter((t) => t.durationSec < 120)
const formats = []
for (const track of shortFixtures) {
  const mark = await logMark()
  const result = await renderer.evaluate(`
    const pb = ${PLAYBACK}
    const started = performance.now()
    await pb.playFromList({ sort: 'durationSec', direction: 'desc', index: ${track.index} })
    while (pb.status !== 'playing' && !pb.error && performance.now() - started < 30000) {
      await new Promise((r) => setTimeout(r, 50))
    }
    const toPlayingMs = Math.round(performance.now() - started)
    await new Promise((r) => setTimeout(r, 800))
    const seekTarget = Math.min(10, Math.floor(pb.duration * 0.5))
    pb.seek(seekTarget)
    await new Promise((r) => setTimeout(r, 700))
    const afterSeek = pb.currentTime
    pb.setVolume(0.25)
    await new Promise((r) => setTimeout(r, 200))
    const quiet = pb.volume
    pb.setVolume(1)
    await new Promise((r) => setTimeout(r, 200))
    return {
      status: pb.status, error: pb.error, duration: pb.duration,
      reportedCodec: pb.nowPlaying?.codec, toPlayingMs,
      seekTarget, afterSeek: +afterSeek.toFixed(2), seekDrift: +(afterSeek - seekTarget).toFixed(2),
      volumeQuiet: quiet, volumeLoud: pb.volume
    }
  `)
  formats.push({
    codec: track.codec,
    expectedDuration: track.durationSec,
    ...result,
    decodeLog: (await logsSince(mark)).filter((l) => l.includes('[audio] R1 track='))
  })
}

record('step 4 — playback per format', formats)

for (const f of formats) {
  if (f.status !== 'playing') note(`${f.codec} did not reach 'playing' (status ${f.status})`)
  if (f.error) note(`${f.codec} reported error ${JSON.stringify(f.error)}`)
  if (Math.abs(f.seekDrift) > 1) note(`${f.codec} seek drifted ${f.seekDrift}s`)
}

// ---------------------------------------------------------------------------
// Step 5 — skip forward and back
// ---------------------------------------------------------------------------

const skipMark = await logMark()
const skips = await renderer.evaluate(`
  const pb = ${PLAYBACK}
  const seen = []
  const snap = (label) => seen.push({ label, status: pb.status, error: pb.error,
    id: pb.nowPlaying?.id, index: pb.orderIndex })
  await pb.playFromList({ sort: 'durationSec', direction: 'asc', index: 2 })
  await new Promise((r) => setTimeout(r, 900)); snap('start')
  for (let i = 0; i < 4; i++) { await pb.next(); await new Promise((r) => setTimeout(r, 900)); snap('next' + (i + 1)) }
  for (let i = 0; i < 3; i++) { await pb.previous(); await new Promise((r) => setTimeout(r, 900)); snap('prev' + (i + 1)) }
  pb.beginScrub(); pb.scrubTo(3); pb.endScrub()
  await new Promise((r) => setTimeout(r, 600))
  const afterScrub = +pb.currentTime.toFixed(2)
  pb.toggle(); await new Promise((r) => setTimeout(r, 400)); const paused = pb.status
  pb.toggle(); await new Promise((r) => setTimeout(r, 400)); const resumed = pb.status
  return { seen, afterScrub, paused, resumed }
`)

const indices = skips.seen.map((s) => s.index)
record('step 5 — skip, scrub, pause', {
  walk: indices,
  walkedCorrectly: indices.join(',') === '2,3,4,5,6,5,4,3',
  afterScrub: skips.afterScrub,
  paused: skips.paused,
  resumed: skips.resumed,
  decodesPerTransition:
    (await logsSince(skipMark)).filter((l) => l.includes('[audio] R1 track=')).length /
    skips.seen.length
})

if (indices.join(',') !== '2,3,4,5,6,5,4,3')
  note(`skip walk was ${indices.join(',')}, expected 2,3,4,5,6,5,4,3`)
if (skips.paused !== 'paused' || skips.resumed !== 'playing')
  note('pause/resume did not round-trip')

// ---------------------------------------------------------------------------
// The R1 measurement — decode the longest track available, watching memory
// ---------------------------------------------------------------------------

/** Four forced collections, then a settle. Used to establish a clean baseline. */
async function forceGc() {
  for (let i = 0; i < 4; i++) {
    await renderer.send('HeapProfiler.collectGarbage')
    await sleep(700)
  }
  await sleep(1000)
}

/**
 * Sampled from the main process rather than from `/proc`, so the number means the
 * same thing on both platforms. Chromium already tracks the peak for us, but the
 * trace matters too: the most useful finding of the first run was the *shape* of
 * the curve across track changes, not any single reading.
 *
 * The forced collection first is not decoration. Decoded buffers are not reclaimed
 * until something applies pressure, so a second measurement taken straight after a
 * first would start from a baseline still holding the first track — and
 * `peakOverDecoded` would come out lower for no reason but measurement order. Ask
 * for a clean baseline explicitly, and the two platforms' numbers mean the same
 * thing.
 */
async function measureDecode(label, index) {
  await forceGc()

  const samples = []
  let sampling = true
  const sampler = (async () => {
    while (sampling) {
      const value = await rendererMiB(main)
      if (value === null) break
      samples.push(value)
      await sleep(250)
    }
  })()

  const baseline = await rendererMiB(main)
  const mark = await logMark()
  const played = await renderer.evaluate(`
    const pb = ${PLAYBACK}
    const started = performance.now()
    await pb.playFromList({ sort: 'durationSec', direction: 'desc', index: ${index} })
    const callMs = Math.round(performance.now() - started)
    while (pb.status !== 'playing' && !pb.error && performance.now() - started < 180000) {
      await new Promise((r) => setTimeout(r, 100))
    }
    const toPlayingMs = Math.round(performance.now() - started)
    await new Promise((r) => setTimeout(r, 2500))
    return { callMs, toPlayingMs, status: pb.status, error: pb.error,
             title: pb.nowPlaying?.title, codec: pb.nowPlaying?.codec,
             durationSec: pb.duration }
  `)

  sampling = false
  await sampler

  const decodeLog = (await logsSince(mark)).find((l) => l.includes('[audio] R1 track=')) ?? null
  const peak = Math.max(...samples, baseline)
  const settled = samples.at(-1) ?? baseline
  const chromiumPeak = (await appMetrics(main)).find((p) => p.type === 'Tab')?.peakKb ?? 0

  // Everything the log line already computed, parsed back out rather than
  // recomputed — if the two ever disagree, the log is what shipped.
  const decodedBytes = played.durationSec * (await Promise.resolve(audioContext)) * 2 * 4

  return record(`R1 — ${label}`, {
    track: played.title,
    codec: played.codec,
    durationSec: round(played.durationSec, 2),
    status: played.status,
    error: played.error,
    playFromListReturnedMs: played.callMs,
    timeToFirstAudioMs: played.toPlayingMs,
    decodeLog,
    decodedMiBAtContextRate: round(mib(decodedBytes)),
    rssBaselineMiB: round(baseline, 0),
    rssPeakMiB: round(peak, 0),
    rssSettledMiB: round(settled, 0),
    // Chromium's own high-water mark. Monotonic over the whole process lifetime,
    // so after the first measurement it is a lifetime maximum rather than this
    // decode's peak — kept because it is continuous where our 250ms sampling can
    // miss a spike, not because it is per-measurement.
    lifetimePeakMiB: round(chromiumPeak / 1024, 0),
    peakGrowthOverDecoded: round((peak - baseline) / mib(decodedBytes), 2),
    trace: samples.map((s) => Math.round(s))
  })
}

const longFixture = census.fixture.find((t) => t.durationSec >= 120)
if (longFixture) {
  await measureDecode('synthetic long track (comparable across platforms)', longFixture.index)
} else {
  note('no long fixture track found — run make-probe-fixture.mjs to get one')
}

// The real library's worst case, which is realistic but not comparable between
// two machines holding different music. Recorded when it is not the fixture.
if (census.longest && census.longest.rootId !== fixtureRoot.id) {
  await measureDecode('longest real track (this machine only)', 0)
}

// ---------------------------------------------------------------------------
// Reclamation — is unreleased memory a leak, or just uncollected?
// ---------------------------------------------------------------------------

/*
 * The question is whether memory the engine no longer needs comes back. So make
 * it no longer needed first: move to a short track, which drops the large buffer's
 * last reference. Measuring a forced collection while the big track is still
 * playing would only prove that live memory is live.
 */
const shortIndex = shortFixtures.at(-1)?.index ?? 0
await renderer.evaluate(`
  const pb = ${PLAYBACK}
  await pb.playFromList({ sort: 'durationSec', direction: 'desc', index: ${shortIndex} })
  await new Promise((r) => setTimeout(r, 1500))
  return pb.status
`)

const beforeGc = await rendererMiB(main)
await forceGc()
const afterGc = await rendererMiB(main)

record('reclamation', {
  measuredWhilePlaying: 'a short fixture track, so the large buffers are garbage',
  rssBeforeForcedGcMiB: round(beforeGc, 0),
  rssAfterForcedGcMiB: round(afterGc, 0),
  recoveredMiB: round(beforeGc - afterGc, 0),
  verdict:
    beforeGc - afterGc > 100
      ? 'collectable — not a leak, but nothing collects it without pressure'
      : 'little recovered — either already collected, or references are held'
})

// ---------------------------------------------------------------------------
// Step 6 — virtualization
// ---------------------------------------------------------------------------

/*
 * Anchored on the grid's ARIA roles rather than on "the first thing on the page
 * that scrolls". The loose version silently measured a different panel between
 * two runs of this probe — reporting a flat row count for a list that was never
 * under test, which is the most dangerous kind of green.
 */
const virtualization = await renderer.evaluate(`
  const grid = document.querySelector('[role=grid]')
  if (!grid) return { error: 'no [role=grid] found — is the track list mounted?' }
  const scroller = [...grid.querySelectorAll('*')].find(
    (el) => el.scrollHeight > el.clientHeight + 50 && el.clientHeight > 100
  )
  if (!scroller) return { error: 'the grid has no scrolling viewport' }
  const rows = () => scroller.querySelectorAll('[role=row]').length
  const samples = []
  for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
    scroller.scrollTop = Math.round((scroller.scrollHeight - scroller.clientHeight) * fraction)
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    await new Promise((r) => setTimeout(r, 350))
    samples.push({
      fraction,
      scrollTop: Math.round(scroller.scrollTop),
      rows: rows(),
      domNodes: document.querySelectorAll('*').length
    })
  }
  scroller.scrollTop = 0
  return { scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight, samples }
`)

const rowCounts = virtualization.samples?.map((s) => s.rows) ?? []
const maxRows = rowCounts.length ? Math.max(...rowCounts) : null

/*
 * The claim under test is that the DOM holds a window, not the library. Two ways
 * it can fail: the row count scales with the total, or it *grows* as you scroll —
 * rows appended without the ones that left being removed.
 *
 * Only growth is a failure. The count legitimately falls at the bottom of the
 * list, where fewer rows fit below the last item than above the first; an earlier
 * version of this check called that drift and flagged a healthy list. Compare
 * against the count at rest, and let it shrink.
 */
const windowed = maxRows !== null && maxRows < Math.min(census.total, 200)
const grew = rowCounts.length > 1 && maxRows > rowCounts[0] + 2

record('step 6 — virtualization', {
  ...virtualization,
  totalTracks: census.total,
  maxRowsInDom: maxRows,
  rowsAtEachStop: rowCounts,
  windowed,
  grewWhileScrolling: grew
})

if (virtualization.error) note(`virtualization: ${virtualization.error}`)
else if (!windowed) note(`virtualization: ${maxRows} rows in the DOM for ${census.total} tracks`)
else if (grew) note(`virtualization: row count grew ${rowCounts.join('→')} while scrolling`)

// ---------------------------------------------------------------------------
// Cleanliness
// ---------------------------------------------------------------------------

const allLogs = await renderer.evaluate('return window.__probeLog')
const complaints = allLogs.filter((l) => l.startsWith('warn:') || l.startsWith('error:'))
record('cleanliness', {
  capturedLines: allLogs.length,
  decodeLines: allLogs.filter((l) => l.includes('[audio] R1 track=')).length,
  warningsAndErrors: complaints
})
if (complaints.length > 0) note(`${complaints.length} renderer warning(s)/error(s) — see report`)

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const markdown = [
  `# M1 exit probe — ${platform()}`,
  '',
  `Host \`${hostname()}\` · ${release()} · generated by \`scripts/m1-exit-probe.mjs\`.`,
  '',
  report.notes.length
    ? `**${report.notes.length} thing(s) worth a look:**\n\n` +
      report.notes.map((n) => `- ${n}`).join('\n')
    : '**Nothing flagged.** Every automated check came back as expected.',
  '',
  ...report.steps.flatMap(({ title, data }) => [
    `## ${title}`,
    '',
    '```json',
    JSON.stringify(data, null, 2),
    '```',
    ''
  ])
].join('\n')

await writeFile(outPath, markdown, 'utf8')

renderer.close()
main.close()

console.log(`\nReport written to ${outPath}`)
console.log(report.notes.length ? `${report.notes.length} note(s) flagged.` : 'Nothing flagged.')
