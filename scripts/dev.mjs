/**
 * `electron-vite dev` with Chromium's known-benign stderr noise filtered out.
 *
 * Why a wrapper rather than a flag: electron-vite spawns Electron with
 * `stdio: 'inherit'`, so the GPU process writes straight to the terminal's file
 * descriptor. Nothing inside the app — no `app.commandLine` switch short of
 * `--log-level=3`, which would also mute genuine Chromium errors — can
 * intercept it. The only seam is around the whole command, which is here.
 *
 * The filter is a named allowlist of things we have decided are noise. Every
 * other line reaches the terminal untouched, and the suppressed count is
 * reported on exit so nothing disappears silently. `npm run dev:raw` bypasses
 * this entirely.
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { constants } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

const require = createRequire(import.meta.url)

const NOISE = [
  {
    /*
     * viz measures a frame's draw time against the BeginFrame timestamp it was
     * scheduled for. Under Wayland the two clocks disagree by microseconds, so
     * a frame drawn a hair early reads as negative latency and it logs at
     * ERROR — per frame, which is roughly sixty lines a second while anything
     * animates. The magnitudes (~0.03ms) are the giveaway: this is scheduler
     * rounding, not a dropped frame. Upstream has logged it at ERROR for years.
     */
    pattern: /ERROR:.*\bdisplay\.cc.*Frame latency is negative/,
    reason: 'viz frame-timing rounding (Chromium on Wayland)'
  }
]

const suppressed = new Map(NOISE.map((entry) => [entry.reason, 0]))

/** @returns the reason this line is noise, or null to let it through. */
function noiseReason(line) {
  for (const { pattern, reason } of NOISE) {
    if (pattern.test(line)) return reason
  }
  return null
}

const cli = join(dirname(require.resolve('electron-vite/package.json')), 'bin', 'electron-vite.js')

const child = spawn(process.execPath, [cli, 'dev', ...process.argv.slice(2)], {
  // stdout and stdin stay inherited: Vite's output keeps its TTY, its colours
  // and its cursor control. Only stderr — the one Chromium shouts down — is
  // piped, and picocolors needs telling that its far end is still a terminal.
  stdio: ['inherit', 'inherit', 'pipe'],
  env: process.stderr.isTTY ? { ...process.env, FORCE_COLOR: '1' } : process.env
})

createInterface({ input: child.stderr, crlfDelay: Infinity }).on('line', (line) => {
  const reason = noiseReason(line)
  if (reason === null) {
    process.stderr.write(`${line}\n`)
    return
  }
  suppressed.set(reason, suppressed.get(reason) + 1)
})

// Ctrl-C already reaches the child through the foreground process group; these
// cover the case where something signals this process directly instead.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => child.kill(signal))
}

child.on('close', (code, signal) => {
  for (const [reason, count] of suppressed) {
    if (count > 0) process.stderr.write(`[dev] suppressed ${count} lines — ${reason}\n`)
  }
  // A signalled child has no exit code; report it the way a shell would.
  process.exit(signal ? 128 + (constants.signals[signal] ?? 0) : (code ?? 0))
})

child.on('error', (error) => {
  process.stderr.write(`[dev] could not start electron-vite: ${error.message}\n`)
  process.exit(1)
})
