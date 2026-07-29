#!/usr/bin/env node
/**
 * M2's repeatable Windows/Linux exit gate (W6-4).
 *
 * One invocation builds deterministic fixtures, runs the ordinary repository
 * gate, launches the built Electron app against an isolated user-data
 * directory, and drives the real IPC/playback paths through Chromium's
 * debugger. Web Audio calls are observed at the browser boundary; no production
 * test hook or database shortcut is used.
 */
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { hostname, platform, release, tmpdir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import electronPath from 'electron'

import { appMetrics, connectToMain, connectToRenderer, rendererMiB } from './lib/cdp.mjs'
import { buildM2Fixture, M2_REPLAYGAIN_REFERENCE, M2_SAMPLE_RATE } from './lib/m2-fixture.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT = resolvePath(HERE, '..')
const R1_RESIDENCY_BUDGET_MIB = 600
const PLAYBACK =
  "document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('playback')"

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    fixture: { type: 'string' },
    'renderer-port': { type: 'string', default: '9322' },
    'main-port': { type: 'string', default: '9329' },
    'skip-repo-gate': { type: 'boolean', default: false },
    'allow-dirty': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false }
  }
})

if (values.help) {
  console.log(
    'Usage: node scripts/m2-exit-probe.mjs [--out <file>] [--fixture <dir>] ' +
      '[--renderer-port <port>] [--main-port <port>] [--skip-repo-gate] [--allow-dirty]'
  )
  process.exit(0)
}

const rendererPort = positivePort(values['renderer-port'], 'renderer-port')
const mainPort = positivePort(values['main-port'], 'main-port')
const runRoot = resolvePath(
  values.fixture ?? join(tmpdir(), `fermata-m2-exit-${platform()}-${process.pid}`)
)
const fixtureRoot = join(runRoot, 'fixture')
const userDataDir = join(runRoot, 'user-data')
const outPath = resolvePath(values.out ?? join(tmpdir(), `m2-exit-${platform()}.md`))
const rendererEndpoint = `http://127.0.0.1:${rendererPort}`
const mainEndpoint = `http://127.0.0.1:${mainPort}`

const report = {
  startedAt: new Date().toISOString(),
  host: { hostname: hostname(), platform: platform(), release: release(), arch: process.arch },
  source: {},
  repositoryGate: [],
  fixture: null,
  cases: [],
  checks: [],
  diagnostics: {},
  fatal: null
}

let renderer = null
let main = null
let electron = null
let fixture = null
let appExit = null

function positivePort(value, name) {
  const port = Number.parseInt(value, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError(`--${name} must be a port from 1 to 65535.`)
  }
  return port
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const round = (value, places = 3) => Number(value.toFixed(places))

function record(title, data) {
  report.cases.push({ title, data })
}

function check(name, passed, detail = null) {
  report.checks.push({ name, passed: Boolean(passed), detail })
  return Boolean(passed)
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message)
}

function command(commandName, args, options = {}) {
  return new Promise((resolve, reject) => {
    const started = performance.now()
    const child = spawn(commandName, args, {
      cwd: options.cwd ?? PROJECT,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      options.onStdout?.(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      options.onStderr?.(chunk)
    })
    child.on('error', reject)
    child.on('close', (code, signal) =>
      resolve({
        code,
        signal,
        durationMs: Math.round(performance.now() - started),
        stdout,
        stderr
      })
    )
  })
}

async function git(...args) {
  const result = await command('git', args)
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed:\n${result.stderr}`)
  return result.stdout.trim()
}

async function runNpmScript(name) {
  const npmCli = process.env.npm_execpath
  requireCondition(npmCli, 'npm_execpath is absent; invoke this probe through npm.')
  console.log(`  npm run ${name}`)
  const result = await command(process.execPath, [npmCli, 'run', name])
  const evidence = {
    command: `npm run ${name}`,
    passed: result.code === 0,
    exitCode: result.code,
    durationMs: result.durationMs,
    tail: [...result.stdout.trim().split(/\r?\n/), ...result.stderr.trim().split(/\r?\n/)]
      .filter(Boolean)
      .slice(-12)
  }
  report.repositoryGate.push(evidence)
  return evidence.passed
}

async function runRepositoryGate() {
  let passed = true
  for (const name of ['lint', 'format:check', 'typecheck', 'test', 'build']) {
    if (!(await runNpmScript(name))) passed = false
  }
  check('ordinary repository gate passes', passed, report.repositoryGate)
  requireCondition(passed, 'The ordinary repository gate failed.')
}

async function waitForDebugger(endpoint, label, child) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`${label} never opened; Electron exited ${child.exitCode}.`)
    }
    try {
      const response = await fetch(`${endpoint}/json`)
      if (response.ok) return
    } catch {
      // Startup is the expected failure here.
    }
    await sleep(125)
  }
  throw new Error(`Timed out waiting for ${label} at ${endpoint}.`)
}

function launchElectron() {
  const output = { stdout: '', stderr: '' }
  const child = spawn(
    electronPath,
    [
      `--user-data-dir=${userDataDir}`,
      `--remote-debugging-port=${rendererPort}`,
      `--inspect=${mainPort}`,
      '--autoplay-policy=no-user-gesture-required',
      '.'
    ],
    {
      cwd: PROJECT,
      env: { ...process.env, ELECTRON_RENDERER_URL: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    }
  )
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    output.stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    output.stderr += chunk
  })
  const exited = new Promise((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal }))
  })
  child.on('error', (error) => {
    output.stderr += `\nspawn error: ${error.message}`
  })
  return { child, output, exited }
}

async function stopElectron() {
  if (!electron || electron.child.exitCode !== null) return
  let quitRequested = false
  try {
    if (main) {
      await main.evaluate("require('electron').app.quit(); return true")
      quitRequested = true
    }
  } catch {
    quitRequested = electron.child.exitCode !== null
  } finally {
    // Node keeps a process alive while its inspector remains attached. Closing
    // both sessions before waiting distinguishes that from a leaked worker.
    renderer?.close()
    main?.close()
    renderer = null
    main = null
  }
  if (!quitRequested && electron.child.exitCode === null) {
    electron.child.kill()
  }
  let timeout
  const result = await Promise.race([
    electron.exited,
    new Promise((resolve) => {
      timeout = setTimeout(() => resolve(null), 15_000)
    })
  ])
  clearTimeout(timeout)
  if (result === null) {
    electron.child.kill()
    appExit = { passed: false, forced: true }
    return
  }
  appExit = { passed: result.code === 0, forced: false, ...result }
}

async function installMainDiagnostics() {
  return main.evaluate(`
    globalThis.__m2MainProbe = { console: [], uncaught: [], rejections: [] }
    for (const level of ['warn', 'error']) {
      const original = console[level].bind(console)
      console[level] = (...args) => {
        globalThis.__m2MainProbe.console.push({
          level,
          text: args.map((value) => value instanceof Error ? value.stack : String(value)).join(' ')
        })
        original(...args)
      }
    }
    process.on('uncaughtExceptionMonitor', (error) => {
      globalThis.__m2MainProbe.uncaught.push(error?.stack ?? String(error))
    })
    process.on('unhandledRejection', (reason) => {
      globalThis.__m2MainProbe.rejections.push(reason?.stack ?? String(reason))
    })
    return {
      resources: process.getActiveResourcesInfo(),
      metrics: require('electron').app.getAppMetrics().map((entry) => ({
        type: entry.type, pid: entry.pid
      }))
    }
  `)
}

async function installRendererInstrumentation() {
  return renderer.evaluate(`
    const probe = window.__m2Probe = {
      console: [], errors: [], rejections: [], audio: [], delayTrackId: null, delayMs: 0
    }
    const safe = (value) => {
      if (typeof value === 'string') return value
      if (value instanceof Error) return value.stack || value.message
      try { return JSON.stringify(value) } catch { return String(value) }
    }
    for (const level of ['info', 'warn', 'error']) {
      const original = console[level].bind(console)
      console[level] = (...args) => {
        probe.console.push({
          level, atMs: performance.now(), text: args.map(safe).join(' ')
        })
        original(...args)
      }
    }
    window.addEventListener('error', (event) => {
      probe.errors.push(event.error?.stack || event.message || 'window error')
    })
    window.addEventListener('unhandledrejection', (event) => {
      probe.rejections.push(event.reason?.stack || safe(event.reason))
    })

    const nativeFetch = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url
      const delayed = probe.delayTrackId !== null && url.endsWith('/' + probe.delayTrackId)
      if (delayed) await new Promise((resolve) => setTimeout(resolve, probe.delayMs))
      return nativeFetch(input, init)
    }

    const NativeAudioContext = window.AudioContext
    const contextIds = new WeakMap()
    let nextContext = 1
    let nextNode = 1
    const contextId = (context) => {
      if (!contextIds.has(context)) contextIds.set(context, nextContext++)
      return contextIds.get(context)
    }
    const event = (type, data) => probe.audio.push({
      type, atMs: performance.now(), ...data
    })

    const nativeCreateGain = NativeAudioContext.prototype.createGain
    NativeAudioContext.prototype.createGain = function() {
      const node = nativeCreateGain.call(this)
      const nodeId = nextNode++
      const nativeCurve = node.gain.setValueCurveAtTime.bind(node.gain)
      node.gain.setValueCurveAtTime = (values, startTime, duration) => {
        const copy = Array.from(values)
        event('gain-curve', {
          contextId: contextId(this), nodeId, startTime, duration,
          points: copy.length, first: copy[0],
          midpoint: copy[Math.floor(copy.length / 2)], last: copy.at(-1)
        })
        return nativeCurve(values, startTime, duration)
      }
      return node
    }

    const nativeCreateSource = NativeAudioContext.prototype.createBufferSource
    NativeAudioContext.prototype.createBufferSource = function() {
      const node = nativeCreateSource.call(this)
      const nodeId = nextNode++
      const nativeStart = node.start.bind(node)
      node.start = (...args) => {
        event('source-start', {
          contextId: contextId(this), nodeId,
          when: args[0] ?? 0, offset: args[1] ?? 0,
          durationArg: args[2] ?? null,
          bufferDuration: node.buffer?.duration ?? null,
          bufferLength: node.buffer?.length ?? null,
          bufferSampleRate: node.buffer?.sampleRate ?? null
        })
        return nativeStart(...args)
      }
      return node
    }

    const nativeDecode = NativeAudioContext.prototype.decodeAudioData
    NativeAudioContext.prototype.decodeAudioData = async function(...args) {
      const started = performance.now()
      const buffer = await nativeDecode.apply(this, args)
      event('decode-complete', {
        contextId: contextId(this), durationMs: performance.now() - started,
        length: buffer.length, channels: buffer.numberOfChannels,
        sampleRate: buffer.sampleRate
      })
      return buffer
    }

    const nativeClose = NativeAudioContext.prototype.close
    NativeAudioContext.prototype.close = function() {
      event('context-close', { contextId: contextId(this) })
      return nativeClose.call(this)
    }

    window.AudioContext = class ProbeAudioContext extends NativeAudioContext {
      constructor(...args) {
        super(...args)
        event('context', {
          contextId: contextId(this), sampleRate: this.sampleRate,
          baseLatency: this.baseLatency ?? null, outputLatency: this.outputLatency ?? null
        })
      }
    }

    const nativeMediaPlay = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = async function() {
      const started = performance.now()
      const result = await nativeMediaPlay.call(this)
      event('media-play', {
        src: this.currentSrc || this.src, readyState: this.readyState,
        currentTime: this.currentTime, startLatencyMs: performance.now() - started
      })
      return result
    }
    return true
  `)
}

async function addAndScanFixture() {
  await main.evaluate(`
    const { dialog } = require('electron')
    const original = dialog.showOpenDialog
    dialog.showOpenDialog = async () => ({
      canceled: false, filePaths: [${JSON.stringify(fixture.libraryDir)}]
    })
    globalThis.__m2RestoreDialog = () => { dialog.showOpenDialog = original }
    return true
  `)
  const added = await renderer
    .evaluate('return await window.fermata.library.addRoot()')
    .finally(() =>
      main.evaluate(
        'globalThis.__m2RestoreDialog?.(); delete globalThis.__m2RestoreDialog; return true'
      )
    )
  requireCondition(added.ok, added.error?.message ?? 'Could not add the M2 fixture root.')
  const scanned = await renderer.evaluate(
    `return await window.fermata.library.scanRoot(${added.value.id})`
  )
  requireCondition(scanned.ok, scanned.error?.message ?? 'Could not scan the M2 fixture root.')
  return { root: added.value, scan: scanned.value }
}

async function census() {
  const result = await renderer.evaluate(`
    const result = await window.fermata.library.listTracks({
      sort: 'title', direction: 'asc', offset: 0, limit: 1000
    })
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  `)
  return {
    ...result,
    byTitle: new Map(result.tracks.map((track, index) => [track.title, { ...track, index }]))
  }
}

async function playbackSnapshot() {
  return renderer.evaluate(`
    const pb = ${PLAYBACK}
    return {
      title: pb.nowPlaying?.title ?? null, trackId: pb.nowPlaying?.id ?? null,
      status: pb.status, currentTime: pb.currentTime, duration: pb.duration,
      orderIndex: pb.orderIndex, prefetchStatus: pb.prefetchStatus,
      prefetchedTrackId: pb.prefetchedTrackId, prefetchError: pb.prefetchError,
      error: pb.error, crossfadeMs: pb.crossfadeMs
    }
  `)
}

async function waitForPlayback(predicate, description, timeoutMs = 15_000) {
  return renderer.evaluate(`
    const pb = ${PLAYBACK}
    const started = performance.now()
    while (performance.now() - started < ${timeoutMs}) {
      if (${predicate}) return {
        title: pb.nowPlaying?.title ?? null, trackId: pb.nowPlaying?.id ?? null,
        status: pb.status, currentTime: pb.currentTime, duration: pb.duration,
        orderIndex: pb.orderIndex, prefetchStatus: pb.prefetchStatus,
        prefetchedTrackId: pb.prefetchedTrackId, prefetchError: pb.prefetchError,
        error: pb.error, crossfadeMs: pb.crossfadeMs
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error(${JSON.stringify(`Timed out waiting for ${description}.`)})
  `)
}

async function startTrack(track, crossfadeMs = 0) {
  return renderer.evaluate(`
    const pb = ${PLAYBACK}
    pb.stop()
    pb.setCrossfadeMs(${crossfadeMs})
    await pb.playFromList({
      sort: 'title', direction: 'asc', index: ${track.index}
    })
    return {
      title: pb.nowPlaying?.title ?? null, trackId: pb.nowPlaying?.id ?? null,
      status: pb.status, currentTime: pb.currentTime, duration: pb.duration,
      orderIndex: pb.orderIndex, prefetchStatus: pb.prefetchStatus,
      prefetchedTrackId: pb.prefetchedTrackId, error: pb.error
    }
  `)
}

async function collectRendererGarbage() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await renderer.send('HeapProfiler.collectGarbage')
    await sleep(200)
  }
}

async function withMemorySampler(action) {
  await collectRendererGarbage()
  const baseline = await rendererMiB(main)
  requireCondition(baseline !== null, 'The renderer disappeared before memory sampling.')
  const samples = [baseline]
  let running = true
  const sampler = (async () => {
    while (running) {
      const sample = await rendererMiB(main)
      if (sample !== null) samples.push(sample)
      await sleep(100)
    }
  })()
  try {
    const value = await action()
    return {
      value,
      memory: {
        baselineMiB: round(baseline, 1),
        peakMiB: round(Math.max(...samples), 1),
        growthMiB: round(Math.max(...samples) - baseline, 1),
        samples: samples.length,
        configuredResidencyBudgetMiB: R1_RESIDENCY_BUDGET_MIB
      }
    }
  } finally {
    running = false
    await sampler
  }
}

function parseDiagnostic(lines, prefix) {
  return lines
    .filter((entry) => entry.text.includes(prefix))
    .map((entry) => {
      const start = entry.text.indexOf('{')
      try {
        return { atMs: entry.atMs, ...JSON.parse(entry.text.slice(start)) }
      } catch {
        return { atMs: entry.atMs, malformed: entry.text }
      }
    })
}

async function rendererEvidence() {
  return renderer.evaluate(`
    return {
      console: window.__m2Probe.console,
      errors: window.__m2Probe.errors,
      rejections: window.__m2Probe.rejections,
      audio: window.__m2Probe.audio
    }
  `)
}

async function audioMarker() {
  return renderer.evaluate('return window.__m2Probe.audio.length')
}

async function consoleMarker() {
  return renderer.evaluate('return window.__m2Probe.console.length')
}

async function audioSince(marker) {
  return renderer.evaluate(`return window.__m2Probe.audio.slice(${marker})`)
}

async function consoleSince(marker) {
  return renderer.evaluate(`return window.__m2Probe.console.slice(${marker})`)
}

async function gaplessOracle(referencePath, leftPath, rightPath) {
  const { AudioContext, OfflineAudioContext } = await import('node-web-audio-api')
  const decoder = new AudioContext({
    sampleRate: M2_SAMPLE_RATE,
    sinkId: { type: 'none' }
  })
  const decode = async (path) => {
    const bytes = await readFile(path)
    return decoder.decodeAudioData(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    )
  }
  const [reference, left, right] = await Promise.all([
    decode(referencePath),
    decode(leftPath),
    decode(rightPath)
  ])
  await decoder.close()

  const lead = 19
  const render = async (shiftSamples) => {
    const context = new OfflineAudioContext(
      1,
      lead + reference.length + Math.max(0, shiftSamples),
      reference.sampleRate
    )
    for (const [buffer, startSample] of [
      [left, lead],
      [right, lead + left.length + shiftSamples]
    ]) {
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(context.destination)
      source.start(startSample / reference.sampleRate)
    }
    const output = await context.startRendering()
    const samples = new Float32Array(output.length)
    output.copyFromChannel(samples, 0)
    let maximum = 0
    const joinSample = lead + left.length
    for (let sample = joinSample - 4; sample <= joinSample + 4; sample += 1) {
      const expectedIndex = sample - lead
      const expected = expectedIndex >= 0 ? (reference.getChannelData(0)[expectedIndex] ?? 0) : 0
      maximum = Math.max(maximum, Math.abs(samples[sample] - expected))
    }
    return maximum
  }
  return {
    sampleRateHz: reference.sampleRate,
    referenceSamples: reference.length,
    leftSamples: left.length,
    rightSamples: right.length,
    exactMaximumError: await render(0),
    earlyMaximumError: await render(-1),
    lateMaximumError: await render(1)
  }
}

function gaplessSchedule(starts) {
  for (let firstIndex = 0; firstIndex < starts.length; firstIndex += 1) {
    const first = starts[firstIndex]
    for (let nextIndex = firstIndex + 1; nextIndex < starts.length; nextIndex += 1) {
      const next = starts[nextIndex]
      if (
        first.contextId === next.contextId &&
        first.bufferDuration !== null &&
        first.bufferSampleRate === next.bufferSampleRate
      ) {
        const expected = first.when + first.bufferDuration - first.offset
        return {
          first,
          next,
          expectedNextStartSec: expected,
          boundaryErrorSec: next.when - expected,
          boundaryErrorSamples: (next.when - expected) * first.bufferSampleRate
        }
      }
    }
  }
  return null
}

function crossfadeEnvelope(events, durationSec) {
  const candidates = events.filter(
    (entry) => entry.type === 'gain-curve' && Math.abs(entry.duration - durationSec) < 1e-6
  )
  for (const outgoing of candidates) {
    for (const incoming of candidates) {
      if (
        outgoing !== incoming &&
        outgoing.contextId === incoming.contextId &&
        Math.abs(outgoing.startTime - incoming.startTime) < 1e-6 &&
        outgoing.first > 0.99 &&
        outgoing.last < 0.01 &&
        incoming.first < 0.01 &&
        incoming.last > 0.99
      ) {
        return {
          outgoing,
          incoming,
          midpointPower: outgoing.midpoint ** 2 + incoming.midpoint ** 2
        }
      }
    }
  }
  return null
}

function resourceCounts(resources) {
  return Object.fromEntries(
    [...new Set(resources)]
      .sort()
      .map((name) => [name, resources.filter((value) => value === name).length])
  )
}

function unexpectedElectronStderr(lines) {
  const allowed = [
    /^Debugger listening on /,
    /^Debugger ending on /,
    /^For help, see: /,
    /^DevTools listening on /,
    /^Debugger attached\.$/,
    /^Waiting for the debugger to disconnect\.\.\.$/,
    /^Fontconfig warning: We will not regenerate the cache because some cache files were generated by a newer version/,
    /^\[\d+:\d+\/\d+\.\d+:ERROR:components\/viz\/service\/display\/display\.cc:\d+\] Frame latency is negative: -\d+\.\d+ ms$/
  ]
  return lines.filter((line) => !allowed.some((pattern) => pattern.test(line)))
}

async function waitForReplayGain(predicate, description, timeoutMs = 45_000) {
  return renderer.evaluate(`
    const started = performance.now()
    while (performance.now() - started < ${timeoutMs}) {
      const result = await window.fermata.library.getReplayGainJob()
      if (!result.ok) throw new Error(result.error.message)
      const job = result.value
      if (job && (${predicate})) return job
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error(${JSON.stringify(`Timed out waiting for ${description}.`)})
  `)
}

async function runCases() {
  const scan = await addAndScanFixture()
  const library = await census()
  const expectedTracks = Object.values(fixture.tracks)
  const byKey = Object.fromEntries(
    Object.entries(fixture.tracks).map(([key, item]) => {
      const track = library.byTitle.get(item.title)
      requireCondition(track, `Scanned fixture is missing "${item.title}".`)
      return [key, track]
    })
  )
  record('isolated fixture scan', {
    root: scan.root,
    scan: scan.scan,
    totalTracks: library.total,
    expectedTracks: expectedTracks.length,
    titles: library.tracks.map((track) => track.title)
  })
  check(
    'fixture scan indexes every deterministic track',
    library.total === expectedTracks.length && scan.scan.filesSkipped === 0
  )

  const oracle = await gaplessOracle(
    fixture.referencePath,
    join(fixture.libraryDir, fixture.tracks.gaplessA.fileName),
    join(fixture.libraryDir, fixture.tracks.gaplessB.fileName)
  )
  record('split-signal offline oracle', oracle)
  check('split signal matches its continuous reference', oracle.exactMaximumError <= 1e-7, oracle)
  check(
    'split-signal assertion rejects both ±1 sample controls',
    oracle.earlyMaximumError > 1e-7 && oracle.lateMaximumError > 1e-7,
    oracle
  )

  let marker = await audioMarker()
  const gaplessMemory = await withMemorySampler(async () => {
    await startTrack(byKey.gaplessA, 0)
    const prepared = await waitForPlayback(
      `pb.prefetchStatus === 'ready' && pb.prefetchedTrackId === ${byKey.gaplessB.id}`,
      'decoded gapless prefetch'
    )
    const transitioned = await waitForPlayback(
      `pb.nowPlaying?.id === ${byKey.gaplessB.id} && pb.status === 'playing'`,
      'natural gapless transition'
    )
    return { prepared, transitioned }
  })
  const gaplessAudio = await audioSince(marker)
  const schedule = gaplessSchedule(gaplessAudio.filter((entry) => entry.type === 'source-start'))
  record('decoded prefetch and natural gapless transition', {
    ...gaplessMemory,
    contexts: gaplessAudio.filter((entry) => entry.type === 'context'),
    decodes: gaplessAudio.filter((entry) => entry.type === 'decode-complete'),
    schedule,
    gainCurves: gaplessAudio.filter((entry) => entry.type === 'gain-curve')
  })
  check(
    'decoded current and next are both prepared',
    gaplessAudio.filter((entry) => entry.type === 'decode-complete').length >= 2
  )
  check(
    'zero-duration boundary is sample-accurate on the runtime AudioContext',
    schedule && Math.abs(schedule.boundaryErrorSamples) < 0.01,
    schedule
  )
  check(
    'zero-duration boundary schedules no fade curve',
    gaplessAudio.every((entry) => entry.type !== 'gain-curve')
  )
  check(
    'natural transition promotes the prepared successor',
    gaplessMemory.value.transitioned.trackId === byKey.gaplessB.id &&
      gaplessMemory.value.transitioned.error === null
  )

  marker = await audioMarker()
  await renderer.evaluate(`
    window.__m2Probe.delayTrackId = ${byKey.skipB.id}
    window.__m2Probe.delayMs = 800
    return true
  `)
  await startTrack(byKey.skipA, 0)
  const loading = await waitForPlayback(
    `pb.prefetchStatus === 'loading' && pb.prefetchedTrackId === ${byKey.skipB.id}`,
    'deliberately delayed prefetch'
  )
  const skipped = await renderer.evaluate(`
    const pb = ${PLAYBACK}
    await pb.next()
    window.__m2Probe.delayTrackId = null
    return {
      title: pb.nowPlaying?.title ?? null, trackId: pb.nowPlaying?.id ?? null,
      status: pb.status, error: pb.error, prefetchStatus: pb.prefetchStatus
    }
  `)
  const skipNext = await waitForPlayback(
    `pb.prefetchStatus === 'ready' && pb.prefetchedTrackId === ${byKey.skipC.id}`,
    'successor prefetch after skip'
  )
  const skipAudio = await audioSince(marker)
  record('skip while successor prefetch is in flight', { loading, skipped, skipNext, skipAudio })
  check(
    'skip during prefetch adopts the requested track and continues prefetching',
    skipped.trackId === byKey.skipB.id &&
      skipped.status === 'playing' &&
      skipped.error === null &&
      skipNext.prefetchedTrackId === byKey.skipC.id
  )

  for (const boundary of [
    { key: 'crossfade250A', nextKey: 'crossfade250B', durationMs: 250 },
    { key: 'crossfade750A', nextKey: 'crossfade750B', durationMs: 750 }
  ]) {
    marker = await audioMarker()
    await startTrack(byKey[boundary.key], boundary.durationMs)
    await waitForPlayback(
      `pb.prefetchStatus === 'ready' && pb.prefetchedTrackId === ${byKey[boundary.nextKey].id}`,
      `${boundary.durationMs} ms crossfade prefetch`
    )
    const transitioned = await waitForPlayback(
      `pb.nowPlaying?.id === ${byKey[boundary.nextKey].id} && pb.status === 'playing'`,
      `${boundary.durationMs} ms crossfade transition`
    )
    const events = await audioSince(marker)
    const envelope = crossfadeEnvelope(events, boundary.durationMs / 1000)
    record(`equal-power ${boundary.durationMs} ms crossfade`, {
      transitioned,
      envelope,
      sourceStarts: events.filter((entry) => entry.type === 'source-start')
    })
    check(
      `${boundary.durationMs} ms crossfade uses complementary equal-power curves`,
      envelope &&
        Math.abs(envelope.midpointPower - 1) < 1e-5 &&
        transitioned.trackId === byKey[boundary.nextKey].id,
      envelope
    )
  }

  marker = await audioMarker()
  await startTrack(byKey.boundaryDecoded, 750)
  const hardPrepared = await waitForPlayback(
    `pb.prefetchStatus === 'ready' && pb.prefetchedTrackId === ${byKey.boundaryStreaming.id}`,
    'streaming fallback prefetch'
  )
  const beforeBoundary = await playbackSnapshot()
  await renderer.evaluate(`
    const pb = ${PLAYBACK}
    pb.seek(Math.max(0, pb.duration - 0.4))
    return true
  `)
  const hardTransitioned = await waitForPlayback(
    `pb.nowPlaying?.id === ${byKey.boundaryStreaming.id} && pb.status === 'playing'`,
    'decoded-to-streaming hard boundary',
    10_000
  )
  await sleep(750)
  const hardAdvanced = await playbackSnapshot()
  const hardEvents = await audioSince(marker)
  record('boundary involving streaming fallback', {
    hardPrepared,
    beforeBoundary,
    hardTransitioned,
    hardAdvanced,
    mediaPlay: hardEvents.filter((entry) => entry.type === 'media-play'),
    gainCurves: hardEvents.filter((entry) => entry.type === 'gain-curve')
  })
  check(
    'streaming fallback boundary is hard even when crossfade is configured',
    hardTransitioned.trackId === byKey.boundaryStreaming.id &&
      hardAdvanced.currentTime > hardTransitioned.currentTime + 0.4 &&
      hardEvents.every((entry) => entry.type !== 'gain-curve')
  )

  marker = await audioMarker()
  let logMarker = await consoleMarker()
  const longRun = await withMemorySampler(async () => {
    const started = performance.now()
    const first = await startTrack(byKey.boundaryStreaming, 0)
    const toPlayingMs = performance.now() - started
    await sleep(1250)
    const later = await playbackSnapshot()
    return { first, later, toPlayingMs: round(toPlayingMs, 1) }
  })
  const longEvents = await audioSince(marker)
  const longLogs = await consoleSince(logMarker)
  const admissions = parseDiagnostic(longLogs, '[audio] R1 admission')
  const longAdmission = admissions.find((entry) => entry.trackId === byKey.boundaryStreaming.id)
  const longDecodeLog = longLogs.find((entry) =>
    entry.text.includes(`[audio] R1 track=${byKey.boundaryStreaming.id} `)
  )
  record('twenty-minute streaming fallback and memory', {
    ...longRun,
    admission: longAdmission ?? null,
    wholeBufferDecodeLog: longDecodeLog ?? null,
    contexts: longEvents.filter((entry) => entry.type === 'context'),
    mediaPlay: longEvents.filter((entry) => entry.type === 'media-play')
  })
  check(
    'twenty-minute track is admitted to streaming for the recorded R1 reason',
    longAdmission?.path === 'streaming' &&
      longAdmission.reason === 'per-track-cap' &&
      Number.isFinite(longAdmission.targetSampleRateHz),
    longAdmission
  )
  check(
    'streaming becomes audible without a whole-buffer decode',
    longRun.value.first.status === 'playing' &&
      longRun.value.later.currentTime > longRun.value.first.currentTime + 0.5 &&
      !longDecodeLog
  )
  check(
    'streaming renderer memory remains inside the configured budget',
    longRun.memory.growthMiB <= R1_RESIDENCY_BUDGET_MIB,
    longRun.memory
  )

  logMarker = await consoleMarker()
  await startTrack(byKey.replayGainTagged, 0)
  const taggedLogs = await consoleSince(logMarker)
  const taggedDecision = parseDiagnostic(taggedLogs, '[audio] ReplayGain').find(
    (entry) => entry.trackId === byKey.replayGainTagged.id
  )
  record('tagged ReplayGain application', {
    scanned: byKey.replayGainTagged,
    decision: taggedDecision ?? null
  })
  check(
    'tagged ReplayGain is selected and applied',
    byKey.replayGainTagged.rgSource === 'tag' &&
      Math.abs(byKey.replayGainTagged.rgTrackGainDb + 7.25) < 1e-6 &&
      taggedDecision?.source === 'tag' &&
      taggedDecision.field === 'track' &&
      Math.abs(taggedDecision.gainDb + 7.25) < 1e-6,
    taggedDecision
  )

  const resourcesBefore = await main.evaluate('return process.getActiveResourcesInfo()')
  await renderer.evaluate(`
    window.__m2ReplayGainProgress = []
    window.__m2ReplayGainOff = window.fermata.library.onReplayGainProgress((progress) => {
      window.__m2ReplayGainProgress.push(progress)
    })
    return true
  `)
  const startedJobResult = await renderer.evaluate(
    'return await window.fermata.library.startReplayGain()'
  )
  requireCondition(
    startedJobResult.ok,
    startedJobResult.error?.message ?? 'ReplayGain did not start.'
  )
  const checkpoint = await waitForReplayGain(
    'job.completed >= 1',
    'a durable ReplayGain checkpoint',
    45_000
  )
  const resourcesDuring = await main.evaluate('return process.getActiveResourcesInfo()')
  const cancelledResult = await renderer.evaluate(
    `return await window.fermata.library.cancelReplayGain(${startedJobResult.value.jobId})`
  )
  requireCondition(
    cancelledResult.ok,
    cancelledResult.error?.message ?? 'ReplayGain did not cancel.'
  )
  const cancelled = cancelledResult.value
  const resumedResult = await renderer.evaluate(
    `return await window.fermata.library.resumeReplayGain(${startedJobResult.value.jobId})`
  )
  requireCondition(resumedResult.ok, resumedResult.error?.message ?? 'ReplayGain did not resume.')
  const completed = await waitForReplayGain(
    "job.state === 'completed'",
    'resumed ReplayGain completion',
    120_000
  )
  await sleep(500)
  const resourcesAfter = await main.evaluate('return process.getActiveResourcesInfo()')
  const progressEvents = await renderer.evaluate(`
    window.__m2ReplayGainOff?.()
    delete window.__m2ReplayGainOff
    return window.__m2ReplayGainProgress
  `)
  const refreshed = await census()
  const computedTrack = refreshed.byTitle.get(fixture.tracks.replayGainComputed.title)
  requireCondition(computedTrack, 'Computed ReplayGain track disappeared from the library.')
  record('compute-when-missing progress, cancel, resume and persistence', {
    started: startedJobResult.value,
    checkpoint,
    cancelled,
    resumed: resumedResult.value,
    completed,
    progressEvents,
    computedTrack,
    resourcesBefore: resourceCounts(resourcesBefore),
    resourcesDuring: resourceCounts(resourcesDuring),
    resourcesAfter: resourceCounts(resourcesAfter)
  })
  check(
    'ReplayGain job reports progress, cancellation and resumed completion',
    startedJobResult.value.total === 4 &&
      checkpoint.completed >= 1 &&
      cancelled.state === 'cancelled' &&
      cancelled.pending > 0 &&
      completed.state === 'completed' &&
      completed.completed === 4 &&
      progressEvents.some((entry) => entry.currentTitle !== null) &&
      progressEvents.some((entry) => entry.state === 'cancelling') &&
      progressEvents.some((entry) => entry.state === 'completed')
  )
  check(
    'computed ReplayGain reference is persisted within tolerance',
    computedTrack.rgSource === 'computed' &&
      Math.abs(computedTrack.rgTrackGainDb - M2_REPLAYGAIN_REFERENCE.gainDb) <=
        M2_REPLAYGAIN_REFERENCE.gainToleranceDb &&
      Math.abs(computedTrack.rgTrackPeak - M2_REPLAYGAIN_REFERENCE.peak) <=
        M2_REPLAYGAIN_REFERENCE.peakTolerance,
    computedTrack
  )
  const beforePorts = resourceCounts(resourcesBefore).MessagePort ?? 0
  const afterPorts = resourceCounts(resourcesAfter).MessagePort ?? 0
  check('ReplayGain worker resources return to baseline', afterPorts <= beforePorts, {
    before: resourceCounts(resourcesBefore),
    during: resourceCounts(resourcesDuring),
    after: resourceCounts(resourcesAfter)
  })

  logMarker = await consoleMarker()
  await startTrack(computedTrack, 0)
  const computedLogs = await consoleSince(logMarker)
  const computedDecision = parseDiagnostic(computedLogs, '[audio] ReplayGain').find(
    (entry) => entry.trackId === computedTrack.id
  )
  record('computed ReplayGain application after resume', {
    track: computedTrack,
    decision: computedDecision ?? null
  })
  check(
    'computed ReplayGain is applied after resume',
    computedDecision?.source === 'computed' &&
      computedDecision.field === 'track' &&
      Math.abs(computedDecision.gainDb - computedTrack.rgTrackGainDb) < 1e-6,
    computedDecision
  )
}

function markdownReport() {
  const passed = report.checks.filter((item) => item.passed).length
  const failed = report.checks.length - passed
  const status = report.fatal || failed > 0 ? 'FAIL' : 'PASS'
  return [
    `# M2 exit probe — ${platform()} — ${status}`,
    '',
    `Host \`${report.host.hostname}\` · ${report.host.release} · ${report.host.arch}.`,
    `Commit \`${report.source.commit ?? 'unknown'}\`${
      report.source.dirty ? ' (dirty worktree — development run only)' : ''
    }.`,
    `Started ${report.startedAt}; finished ${report.finishedAt}.`,
    '',
    `**${passed} passed · ${failed} failed.**`,
    '',
    ...(report.fatal ? ['## Fatal error', '', '```text', report.fatal, '```', ''] : []),
    '## Checks',
    '',
    ...report.checks.map(
      (item) =>
        `- ${item.passed ? 'PASS' : 'FAIL'} — ${item.name}${
          item.detail === null ? '' : ` — \`${JSON.stringify(item.detail)}\``
        }`
    ),
    '',
    ...report.cases.flatMap(({ title, data }) => [
      `## ${title}`,
      '',
      '```json',
      JSON.stringify(data, null, 2),
      '```',
      ''
    ]),
    '## Diagnostics and process cleanup',
    '',
    '```json',
    JSON.stringify(report.diagnostics, null, 2),
    '```',
    '',
    '## Repository gate',
    '',
    '```json',
    JSON.stringify(report.repositoryGate, null, 2),
    '```',
    ''
  ].join('\n')
}

console.log('M2 exit probe')
console.log(`  platform: ${platform()}/${process.arch}`)
console.log(`  run root: ${runRoot}`)

try {
  report.source.commit = await git('rev-parse', 'HEAD')
  const dirty = await git('status', '--porcelain')
  report.source.dirty = dirty.length > 0
  report.source.dirtyFiles = dirty ? dirty.split(/\r?\n/) : []
  if (report.source.dirty && !values['allow-dirty']) {
    throw new Error(
      'The M2 exit report must name a reproducible commit. Commit or stash changes, ' +
        'or use --allow-dirty for a development-only run.'
    )
  }

  if (!values['skip-repo-gate']) {
    console.log('Running the ordinary repository gate')
    await runRepositoryGate()
  } else {
    report.repositoryGate.push({ skipped: true, reason: '--skip-repo-gate' })
    check('ordinary repository gate passes', false, 'skipped in a development run')
  }

  console.log('Building deterministic M2 fixtures')
  fixture = await buildM2Fixture(fixtureRoot, (message) => console.log(`  ${message}`))
  report.fixture = fixture

  console.log('Launching isolated built Electron app')
  electron = launchElectron()
  await Promise.all([
    waitForDebugger(rendererEndpoint, 'renderer debugger', electron.child),
    waitForDebugger(mainEndpoint, 'main-process inspector', electron.child)
  ])
  renderer = await connectToRenderer(rendererEndpoint)
  main = await connectToMain(mainEndpoint)
  const mainBaseline = await installMainDiagnostics()
  await installRendererInstrumentation()
  record('process baseline', mainBaseline)

  await runCases()
} catch (error) {
  report.fatal = error instanceof Error ? (error.stack ?? error.message) : String(error)
  console.error(report.fatal)
} finally {
  if (renderer && main) {
    try {
      const [rendererLogs, mainLogs, finalMetrics] = await Promise.all([
        rendererEvidence(),
        main.evaluate('return globalThis.__m2MainProbe'),
        appMetrics(main)
      ])
      report.diagnostics.renderer = {
        consoleWarningsAndErrors: rendererLogs.console.filter(
          (entry) => entry.level === 'warn' || entry.level === 'error'
        ),
        windowErrors: rendererLogs.errors,
        unhandledRejections: rendererLogs.rejections
      }
      report.diagnostics.main = mainLogs
      report.diagnostics.finalAppMetrics = finalMetrics
      const unexpectedRenderer =
        report.diagnostics.renderer.consoleWarningsAndErrors.length +
        rendererLogs.errors.length +
        rendererLogs.rejections.length
      const unexpectedMain =
        mainLogs.console.length + mainLogs.uncaught.length + mainLogs.rejections.length
      check('no unexpected renderer warning, error or rejection', unexpectedRenderer === 0)
      check('no unexpected main-process warning, error or rejection', unexpectedMain === 0)
    } catch (error) {
      report.diagnostics.collectionError =
        error instanceof Error ? (error.stack ?? error.message) : String(error)
    }
  }

  await stopElectron()
  if (electron) {
    const stderrLines = electron.output.stderr.trim().split(/\r?\n/).filter(Boolean)
    const unexpectedStderr = unexpectedElectronStderr(stderrLines)
    report.diagnostics.electronOutput = {
      stdout: electron.output.stdout.trim().split(/\r?\n/).filter(Boolean),
      stderr: stderrLines,
      unexpectedStderr
    }
    report.diagnostics.appExit = appExit
    check('no unexpected Electron stderr', unexpectedStderr.length === 0, unexpectedStderr)
    check(
      'Electron exits cleanly with no worker or child keeping it alive',
      appExit?.passed,
      appExit
    )
  }

  report.finishedAt = new Date().toISOString()
  await writeFile(outPath, markdownReport(), 'utf8')
  console.log(`Report written to ${outPath}`)
  const failed = report.checks.filter((item) => !item.passed)
  if (report.fatal || failed.length > 0) {
    console.error(
      report.fatal
        ? 'M2 exit probe failed before completing every case.'
        : `M2 exit probe failed ${failed.length} check(s).`
    )
    process.exitCode = 1
  } else {
    console.log(`M2 exit probe passed all ${report.checks.length} checks.`)
  }
}
