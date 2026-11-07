#!/usr/bin/env node
/**
 * A few seconds of Chromium trace across every process, summarised per thread.
 *
 * The companion to `stage-frame-probe.mjs` (W23-16): that one says how fast the
 * stage runs, this one says which thread is saturated and on what. Needs the
 * app started with `--remote-debugging-port=9222`; it talks to the *browser*
 * target, because only that one can trace the GPU process and viz.
 *
 *   node scripts/stage-trace-probe.mjs [seconds] [out.json]
 */
import { writeFileSync } from 'node:fs'

const SECONDS = Number(process.argv[2] ?? 3)
const OUT = process.argv[3] ?? null
const CATEGORIES = [
  'toplevel',
  'blink',
  'cc',
  'gpu',
  'viz',
  'v8',
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-gpu.service',
  'skia'
].join(',')

const version = await (await fetch('http://127.0.0.1:9222/json/version')).json()
const socket = new WebSocket(version.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.onopen = resolve
  socket.onerror = () => reject(new Error('could not open the browser target'))
})

const events = []
let nextId = 0
let done
const finished = new Promise((resolve) => (done = resolve))
socket.onmessage = (message) => {
  const data = JSON.parse(message.data)
  if (data.method === 'Tracing.dataCollected') events.push(...data.params.value)
  if (data.method === 'Tracing.tracingComplete') done()
}
const send = (method, params = {}) => socket.send(JSON.stringify({ id: ++nextId, method, params }))

send('Tracing.start', {
  traceConfig: { includedCategories: CATEGORIES.split(','), recordMode: 'recordContinuously' },
  transferMode: 'ReportEvents'
})
await new Promise((r) => setTimeout(r, SECONDS * 1000))
send('Tracing.end')
await finished
socket.close()
if (OUT) writeFileSync(OUT, JSON.stringify(events))

// Names for processes and threads.
const processes = new Map()
const threads = new Map()
for (const e of events) {
  if (e.ph !== 'M') continue
  if (e.name === 'process_name') processes.set(e.pid, e.args.name)
  if (e.name === 'thread_name') threads.set(`${e.pid}:${e.tid}`, e.args.name)
}

// Complete events only; the window is the span they cover.
const complete = events.filter((e) => e.ph === 'X' && typeof e.dur === 'number')
let start = Infinity
let end = -Infinity
for (const e of complete) {
  if (e.ts < start) start = e.ts
  if (e.ts + e.dur > end) end = e.ts + e.dur
}
const windowUs = end - start

/** Per thread: busy time from the top-level task events, and the heaviest names. */
const perThread = new Map()
for (const e of complete) {
  const key = `${e.pid}:${e.tid}`
  let entry = perThread.get(key)
  if (!entry) perThread.set(key, (entry = { busy: 0, names: new Map() }))
  if (e.cat?.includes('toplevel')) entry.busy += e.dur
  entry.names.set(e.name, (entry.names.get(e.name) ?? 0) + e.dur)
}

const frames = complete.filter(
  (e) => e.name === 'AnimationFrame' || e.name === 'FireAnimationFrame'
)
console.log(
  `window ${(windowUs / 1000).toFixed(0)} ms, ${events.length} events, ${frames.length} rAF callbacks`
)
const rows = [...perThread.entries()]
  .map(([key, entry]) => ({
    key,
    label: `${processes.get(Number(key.split(':')[0])) ?? '?'} / ${threads.get(key) ?? key}`,
    busyPct: (entry.busy / windowUs) * 100,
    entry
  }))
  .filter((row) => row.busyPct > 3)
  .sort((a, b) => b.busyPct - a.busyPct)
for (const row of rows) {
  console.log(`\n${row.label} — ${row.busyPct.toFixed(1)}% busy`)
  const top = [...row.entry.names.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
  for (const [name, dur] of top) {
    console.log(`  ${(dur / 1000).toFixed(1).padStart(8)} ms  ${name}`)
  }
}
