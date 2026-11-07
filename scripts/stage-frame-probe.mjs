#!/usr/bin/env node
/**
 * Where the visualizer stage's frame time goes, measured in the running app.
 *
 * Not a gate: an experiment for the Windows 2D-effect slowdown (W23-16). With
 * the app started as `npm run dev -- -- --remote-debugging-port=9222` and an
 * effect playing on the stage, it samples the frame rate and main-thread work
 * under a series of conditions, each one switching a suspect off:
 *
 *   baseline       — as shipped
 *   no-blur        — every CSS filter / backdrop-filter on the stage removed
 *   effect-hidden  — the effect canvas not composited (it still draws)
 *   wash-hidden    — the wash canvas not composited
 *   bare           — no-blur + both canvases hidden
 *
 * If the effect's own drawing were the cost, only effect-hidden would move
 * (and only a little: hiding a canvas does not stop it drawing). If the
 * compositor were, no-blur would.
 */
import { connectToRenderer } from './lib/cdp.mjs'

const SAMPLE_MS = Number(process.argv[2] ?? 4000)

const CONDITIONS = {
  baseline: '',
  'no-blur': `
    .stage-visualizer *, .stage-visualizer *::before, .stage-visualizer *::after,
    .stage-wash-img, .waveform-ribbon {
      filter: none !important; backdrop-filter: none !important;
    }`,
  'effect-hidden': `.visualizer-layer:last-child { visibility: hidden !important; }`,
  'wash-hidden': `.visualizer-layer:first-child { visibility: hidden !important; }`,
  bare: `
    .stage-visualizer *, .stage-visualizer *::before, .stage-visualizer *::after,
    .stage-wash-img, .waveform-ribbon {
      filter: none !important; backdrop-filter: none !important;
    }
    .visualizer-layer { visibility: hidden !important; }`
}

/** Runs in the renderer: rAF cadence plus long-animation-frame main-thread time. */
const measure = (css, ms) => `
  const style = document.createElement('style')
  style.textContent = ${JSON.stringify(css)}
  document.head.appendChild(style)
  await new Promise((r) => setTimeout(r, 500))
  const intervals = []
  const loaf = []
  const observer = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) loaf.push(e.duration)
  })
  try { observer.observe({ type: 'long-animation-frame', buffered: false }) } catch {}
  let last = 0
  const end = performance.now() + ${ms}
  await new Promise((resolve) => {
    const tick = (now) => {
      if (last) intervals.push(now - last)
      last = now
      if (now < end) requestAnimationFrame(tick)
      else resolve()
    }
    requestAnimationFrame(tick)
  })
  observer.disconnect()
  style.remove()
  intervals.sort((a, b) => a - b)
  const pct = (p) => intervals[Math.min(intervals.length - 1, Math.floor(intervals.length * p))]
  const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length
  return {
    fps: +(1000 / mean).toFixed(1),
    p50: +pct(0.5).toFixed(1),
    p95: +pct(0.95).toFixed(1),
    max: +intervals[intervals.length - 1].toFixed(1),
    longFrames: loaf.length,
    longFrameMeanMs: loaf.length ? +(loaf.reduce((a, b) => a + b, 0) / loaf.length).toFixed(1) : 0
  }
`

const renderer = await connectToRenderer()
try {
  const context = await renderer.evaluate(`
    const stage = document.querySelector('.stage-visualizer')
    const layers = [...document.querySelectorAll('.visualizer-layer')]
    return {
      stage: Boolean(stage),
      dpr: devicePixelRatio,
      canvases: layers.map((c) => c.width + 'x' + c.height),
      window: innerWidth + 'x' + innerHeight
    }
  `)
  console.log('context', JSON.stringify(context))
  if (!context.stage) console.log('!! no .stage-visualizer — is an effect showing on the stage?')
  for (const [name, css] of Object.entries(CONDITIONS)) {
    const result = await renderer.evaluate(measure(css, SAMPLE_MS))
    console.log(name.padEnd(14), JSON.stringify(result))
  }
} finally {
  renderer.close()
}
