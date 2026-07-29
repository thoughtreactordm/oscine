#!/usr/bin/env node
/**
 * Integration probe for W3-5's twenty-minute streaming fallback.
 *
 * Prepare the fixture once:
 *
 *   npm run probe:fixture -- --long-minutes 20
 *   npm run dev -- -- --remote-debugging-port=9222 --inspect=9229
 *   npm run probe:r1-fallback
 *
 * The probe uses only the app's own list/play paths, watches renderer memory
 * through Electron's cross-platform metrics, and requires the media clock to
 * advance. Advancing currentTime after `play()` is the automatable evidence
 * that Chromium has started consuming audible media; no full-file decode log
 * or decoded-path admission is allowed.
 */
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { parseArgs } from 'node:util'

import { connectToMain, connectToRenderer, rendererMiB } from './lib/cdp.mjs'

const { values } = parseArgs({
  options: {
    fixture: { type: 'string' },
    help: { type: 'boolean', default: false }
  }
})
if (values.help) {
  console.log('Usage: node scripts/r1-fallback-probe.mjs [--fixture <dir>]')
  process.exit(0)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const MIB = 1024 ** 2
const TOTAL_BUDGET_MIB = (600 * MIB) / MIB
const fixtureDir = resolvePath(values.fixture ?? join(tmpdir(), 'fermata-probe-fixture'))
const PLAYBACK =
  "document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('playback')"

console.log('R1 fallback integration probe')
const renderer = await connectToRenderer()
const main = await connectToMain()

try {
  await renderer.evaluate(`
    window.__r1ProbeLog = []
    if (!window.__r1ProbeConsoleInstalled) {
      window.__r1ProbeConsoleInstalled = true
      const original = console.info.bind(console)
      console.info = (...args) => {
        window.__r1ProbeLog.push(args.map((value) =>
          typeof value === 'string' ? value : JSON.stringify(value)
        ).join(' '))
        original(...args)
      }
    }
    return true
  `)

  // Add through the same picker/IPC/scan path as a user. The one-call dialog
  // stub is restored even if addRoot fails; no database shortcut is involved.
  const rootsResult = await renderer.evaluate('return await window.fermata.library.listRoots()')
  if (!rootsResult.ok) throw new Error(rootsResult.error.message)
  let fixtureRoot = rootsResult.value.find((root) => resolvePath(root.path) === fixtureDir)
  if (!fixtureRoot) {
    const addResult = await main
      .evaluate(
        `const { dialog } = require('electron')
         const original = dialog.showOpenDialog
         dialog.showOpenDialog = async () => ({
           canceled: false, filePaths: [${JSON.stringify(fixtureDir)}]
         })
         globalThis.__r1ProbeRestoreDialog = () => { dialog.showOpenDialog = original }
         return true`
      )
      .then(() => renderer.evaluate('return await window.fermata.library.addRoot()'))
      .finally(() =>
        main.evaluate(
          'globalThis.__r1ProbeRestoreDialog?.(); delete globalThis.__r1ProbeRestoreDialog; return true'
        )
      )
    if (!addResult.ok) throw new Error(addResult.error.message)
    fixtureRoot = addResult.value
  }
  if (!fixtureRoot) throw new Error(`Could not add fixture root ${fixtureDir}`)
  const scanResult = await renderer.evaluate(
    `return await window.fermata.library.scanRoot(${fixtureRoot.id})`
  )
  if (!scanResult.ok) throw new Error(scanResult.error.message)

  const candidate = await renderer.evaluate(`
    let offset = 0
    let index = 0
    while (true) {
      const result = await window.fermata.library.listTracks({
        sort: 'durationSec', direction: 'desc', offset, limit: 1000
      })
      if (!result.ok) throw new Error(result.error.message)
      const local = result.value.tracks.findIndex((track) => track.title === 'Probe Long Decode')
      if (local >= 0) {
        const track = result.value.tracks[local]
        return { index: index + local, id: track.id, durationSec: track.durationSec }
      }
      if (offset + result.value.tracks.length >= result.value.total) return null
      offset += result.value.tracks.length
      index = offset
    }
  `)

  if (!candidate || candidate.durationSec < 19 * 60 || candidate.durationSec > 21 * 60) {
    throw new Error(
      'No twenty-minute "Probe Long Decode" track found. ' +
        'Run: npm run probe:fixture -- --long-minutes 20.'
    )
  }

  for (let i = 0; i < 4; i++) {
    await renderer.send('HeapProfiler.collectGarbage')
    await sleep(350)
  }
  const baselineMiB = await rendererMiB(main)
  if (baselineMiB === null) throw new Error('Renderer process disappeared before playback.')
  const samples = [baselineMiB]
  let sampling = true
  const sampler = (async () => {
    while (sampling) {
      const sample = await rendererMiB(main)
      if (sample === null) break
      samples.push(sample)
      await sleep(100)
    }
  })()

  const playback = await renderer.evaluate(`
    window.__r1ProbeLog.length = 0
    const pb = ${PLAYBACK}
    const started = performance.now()
    await pb.playFromList({
      sort: 'durationSec', direction: 'desc', index: ${candidate.index}
    })
    const toPlayingMs = Math.round(performance.now() - started)
    const firstTime = pb.currentTime
    await new Promise((resolve) => setTimeout(resolve, 1250))
    return {
      status: pb.status,
      error: pb.error,
      toPlayingMs,
      firstTime,
      laterTime: pb.currentTime,
      duration: pb.duration
    }
  `)

  sampling = false
  await sampler
  const peakMiB = Math.max(...samples)
  const growthMiB = peakMiB - baselineMiB
  const logs = await renderer.evaluate('return window.__r1ProbeLog')
  const admission = logs.find((line) => line.includes('[audio] R1 admission')) ?? null
  const decoded = logs.find((line) => line.includes('[audio] R1 track=')) ?? null

  const checks = {
    selectedStreaming:
      admission?.includes('"path":"streaming"') && admission.includes('"reason":"per-track-cap"'),
    noWholeBufferDecode: decoded === null,
    playing: playback.status === 'playing' && playback.error === null,
    mediaClockAdvanced: playback.laterTime > playback.firstTime + 0.5,
    rendererGrowthWithinBudget: growthMiB <= TOTAL_BUDGET_MIB
  }

  console.log(
    JSON.stringify(
      {
        track: candidate,
        playback,
        admission,
        rendererMemoryMiB: {
          baseline: +baselineMiB.toFixed(1),
          peak: +peakMiB.toFixed(1),
          growth: +growthMiB.toFixed(1),
          configuredBudget: TOTAL_BUDGET_MIB
        },
        checks
      },
      null,
      2
    )
  )

  if (!Object.values(checks).every(Boolean)) process.exitCode = 1
} finally {
  renderer.close()
  main.close()
}
