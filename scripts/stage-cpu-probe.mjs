#!/usr/bin/env node
/**
 * A few seconds of the renderer's V8 CPU profile, as self time per function.
 *
 * The third of the W23-16 probes: `stage-trace-probe.mjs` says the renderer's
 * main thread is the one saturated; this says on what. Native canvas calls show
 * up under their JS caller's name with `(program)` / `(garbage collector)` for
 * what V8 cannot attribute.
 *
 *   node scripts/stage-cpu-probe.mjs [seconds]
 */
import { connectToRenderer } from './lib/cdp.mjs'

const SECONDS = Number(process.argv[2] ?? 3)
const renderer = await connectToRenderer()
try {
  await renderer.send('Profiler.enable')
  await renderer.send('Profiler.setSamplingInterval', { interval: 200 })
  await renderer.send('Profiler.start')
  await new Promise((r) => setTimeout(r, SECONDS * 1000))
  const { result } = await renderer.send('Profiler.stop')
  const profile = result.profile

  const byId = new Map(profile.nodes.map((node) => [node.id, node]))
  const parent = new Map()
  for (const node of profile.nodes)
    for (const child of node.children ?? []) parent.set(child, node.id)
  const counts = new Map()
  for (const id of profile.samples) counts.set(id, (counts.get(id) ?? 0) + 1)
  const total = profile.samples.length
  const intervalMs = (profile.endTime - profile.startTime) / 1000 / total

  const label = (node) => {
    const frame = node.callFrame
    const file = frame.url ? frame.url.split('/').pop().split('?')[0] : ''
    return `${frame.functionName || '(anonymous)'}${file ? ` ${file}:${frame.lineNumber + 1}` : ''}`
  }

  const self = new Map()
  const inclusive = new Map()
  for (const [id, count] of counts) {
    const node = byId.get(id)
    self.set(label(node), (self.get(label(node)) ?? 0) + count)
    const seen = new Set()
    for (let at = id; at !== undefined; at = parent.get(at)) {
      const name = label(byId.get(at))
      if (seen.has(name)) continue
      seen.add(name)
      inclusive.set(name, (inclusive.get(name) ?? 0) + count)
    }
  }
  const print = (title, map) => {
    console.log(`\n${title}`)
    for (const [name, count] of [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
      console.log(
        `  ${((count / total) * 100).toFixed(1).padStart(5)}%  ${(count * intervalMs).toFixed(0).padStart(6)} ms  ${name}`
      )
    }
  }
  console.log(
    `${total} samples over ${((profile.endTime - profile.startTime) / 1000).toFixed(0)} ms`
  )
  print('self time', self)
  print('inclusive time', inclusive)
} finally {
  renderer.close()
}
