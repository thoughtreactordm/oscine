/**
 * Stand-in for the reference `flac` binary. Modes are selected with
 * `FAKE_FLAC_MODE` so encoder failure paths can run without a real encoder.
 *
 *   ok     — drain stdin and write a stub dest
 *   fail   — print a diagnostic, leave a truncated dest, exit 1
 *   none   — drain stdin, print a diagnostic, exit 0, write nothing
 *   hang   — write a truncated dest and stay alive
 *   pipe   — exit 0 without reading stdin (broken pipe for the parent)
 */
import { writeFileSync } from 'node:fs'

const destIdx = process.argv.indexOf('-o')
const dest = destIdx >= 0 ? process.argv[destIdx + 1] : ''
const mode = process.env.FAKE_FLAC_MODE ?? 'ok'

function drain() {
  return new Promise((resolve) => {
    process.stdin.on('end', resolve)
    process.stdin.resume()
  })
}

if (mode === 'fail') {
  process.stderr.write('encoder exploded: bad pcm\n')
  if (dest) writeFileSync(dest, 'partial')
  process.exit(1)
}
if (mode === 'pipe') {
  process.exit(0)
}
if (mode === 'hang') {
  if (dest) writeFileSync(dest, 'partial')
  // Keep the event loop alive without an unsettled top-level await — Node 24
  // treats that as a warning and exits, which collapses this mode into a
  // generic non-zero exit.
  setInterval(() => {}, 1 << 30)
} else if (mode === 'none') {
  await drain()
  process.stderr.write('nothing to write\n')
} else {
  await drain()
  if (dest) writeFileSync(dest, 'fLaC')
}
