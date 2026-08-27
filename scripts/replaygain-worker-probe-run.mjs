/**
 * CI entry for the ReplayGain worker packaging probe.
 *
 * The probe itself (`replaygain-worker-probe.mjs`) validates the built worker
 * and then has to tear one down. node-web-audio-api's native binding poisons the
 * process exit code during `worker_threads` teardown on Windows — and can hang
 * doing it — so the probe prints "ReplayGain worker passed …" and then exits
 * non-zero (or not at all) for reasons that have nothing to do with its result.
 * An explicit `process.exit(0)` inside the probe does not help: the crash
 * happens *during* that exit, after the code has already been set.
 *
 * So the packaging step cannot key on that process's exit code. This wrapper
 * runs the probe as a child and judges it by its authoritative success marker on
 * stdout — printed only after every assertion has passed — absorbing the
 * poisoned exit code and killing a teardown that hangs. A genuine failure never
 * prints the marker (it prints an error stack to stderr and exits 1), so real
 * regressions still fail the build. This is the flake-proof half of the
 * long-standing Windows exit-code issue the probe's own comment describes.
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const probePath = join(here, 'replaygain-worker-probe.mjs')

/** The line the probe prints once, and only after, validation fully succeeds. */
const SUCCESS_MARKER = 'ReplayGain worker passed on'

/** How long to let the child's native teardown run once the result is in. */
const TEARDOWN_GRACE_MS = 5000

const child = spawn(process.execPath, [probePath], { stdio: ['ignore', 'pipe', 'inherit'] })

let output = ''
let passed = false
let settled = false

function finish(code) {
  if (settled) return
  settled = true
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill()
    } catch {
      // The child may already be gone; nothing to do.
    }
  }
  process.exit(code)
}

child.stdout.on('data', (chunk) => {
  output += chunk
  process.stdout.write(chunk)
  if (!passed && output.includes(SUCCESS_MARKER)) {
    passed = true
    // The result is in. Give a poisoning/hanging native teardown a moment to
    // finish on its own, then end in success ourselves rather than waiting on an
    // exit code we already know is unreliable.
    setTimeout(() => finish(0), TEARDOWN_GRACE_MS).unref()
  }
})

child.on('error', (error) => {
  console.error(error)
  finish(1)
})

child.on('close', (code, signal) => {
  if (passed) {
    if (code !== 0 || signal) {
      console.error(
        `ReplayGain probe validated but its process exited with ${signal ?? code}; treating as ` +
          'pass — worker_threads native teardown poisons the exit code on Windows.'
      )
    }
    finish(0)
    return
  }
  console.error(
    `ReplayGain probe failed: its success marker was never printed (child exit ${signal ?? code}). ` +
      'See the probe error above.'
  )
  finish(1)
})
