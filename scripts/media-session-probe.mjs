#!/usr/bin/env node
/**
 * Settles W3-10's three unknowns by observation instead of assumption.
 *
 * The card names them explicitly because each one is a fork in the
 * implementation and none can be answered by reading Fermata's code:
 *
 *  1. Can Chromium resolve a `oscine://` artwork URL for MPRIS `mpris:artUrl`,
 *     which requires it to materialise the image as a file?
 *  2. What bus name does Electron actually publish? Chromium derives it from
 *     its product name, and whether `app.setName` moves it is worth checking
 *     rather than assuming.
 *  3. Does the Linux `SystemMediaControls` path need `enable-features=` on
 *     Electron 43? An unnecessary switch is a liability, so it only goes in if
 *     it is observably required.
 *
 * This runs a throwaway Electron app in its own temporary user-data directory:
 * it never opens the real library, and it can run alongside a dev instance
 * without contending for the single-instance lock. What it reproduces is the
 * exact mechanism `browserMediaSession.ts` uses — a privileged `oscine://`
 * scheme, a silent looping WAV anchor, `navigator.mediaSession` — so a result
 * here is a result about Fermata.
 *
 *   node scripts/media-session-probe.mjs
 *
 * Prints a report and exits non-zero if no MPRIS name appears at all.
 */
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import electron from 'electron'
import sharp from 'sharp'

const workDir = mkdtempSync(join(tmpdir(), 'fermata-media-session-'))

/**
 * The page under test. Deliberately a near-copy of `browserMediaSession.ts`
 * rather than an import of it: the probe has to keep working when that file is
 * refactored, and what is being measured is Chromium's behaviour, not ours.
 */
const page = `<!doctype html>
<meta charset="utf-8" />
<title>Fermata media session probe</title>
<body style="background:#0a0a0a;color:#ddd;font:13px system-ui;padding:1rem">
<pre id="log">starting…</pre>
<script>
const log = (line) => {
  document.getElementById('log').textContent += '\\n' + line
  console.log('[probe] ' + line)
}

// Ten seconds of 8 kHz mono silence. 8-bit PCM is unsigned, so silence is 0x80.
function silentWavUrl() {
  const dataBytes = 10 * 8000
  const buffer = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(buffer)
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
  }
  ascii(0, 'RIFF'); view.setUint32(4, 36 + dataBytes, true); ascii(8, 'WAVE')
  ascii(12, 'fmt '); view.setUint32(16, 16, true)
  view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, 8000, true); view.setUint32(28, 8000, true)
  view.setUint16(32, 1, true); view.setUint16(34, 8, true)
  ascii(36, 'data'); view.setUint32(40, dataBytes, true)
  new Uint8Array(buffer, 44).fill(0x80)
  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }))
}

const anchor = new Audio(silentWavUrl())
anchor.loop = true
anchor.volume = 1

for (const action of ['play','pause','stop','previoustrack','nexttrack','seekbackward','seekforward','seekto']) {
  try {
    navigator.mediaSession.setActionHandler(action, (details) => {
      log('ACTION ' + action + ' ' + JSON.stringify(details ?? {}))
    })
  } catch (error) {
    log('UNSUPPORTED ACTION ' + action + ': ' + error.message)
  }
}

// Two artwork sources, chosen by env, so the report says which one was under
// test. "scheme" is what W3-10 assumed would work; "blob" is the fallback.
const artworkMode = ${JSON.stringify(process.env.FERMATA_PROBE_ARTWORK ?? 'scheme')}

async function artworkSrc() {
  if (artworkMode !== 'blob') return 'oscine://artwork/probe/large'
  // The renderer can still *fetch* the privileged scheme — it is only
  // MediaImage that refuses it — so re-wrapping the bytes costs one request.
  const response = await fetch('oscine://artwork/probe/large')
  const url = URL.createObjectURL(await response.blob())
  log('artwork re-wrapped as ' + url.slice(0, 12) + '…')
  return url
}

artworkSrc().then((src) => {
  navigator.mediaSession.metadata = new MediaMetadata({
    title: 'Probe Title',
    artist: 'Probe Artist',
    album: 'Probe Album',
    artwork: [{ src, sizes: '640x640', type: 'image/png' }]
  })
})

anchor.play().then(() => {
  navigator.mediaSession.playbackState = 'playing'
  navigator.mediaSession.setPositionState({ duration: 545, position: 12, playbackRate: 1 })
  log('anchor playing; session should be live')
}).catch((error) => log('ANCHOR REFUSED: ' + error.message))
</script>
</body>`

const pagePath = join(workDir, 'probe.html')
writeFileSync(pagePath, page)

/**
 * A real 640x640 cover, generated rather than embedded.
 *
 * Size is load-bearing: Chromium's media-image manager scores candidates and
 * discards ones below its minimum, so a 1x1 placeholder would fail the artwork
 * question for a reason that has nothing to do with the URL scheme under test.
 */
const pngBase64 = (
  await sharp({
    create: { width: 640, height: 640, channels: 3, background: { r: 200, g: 40, b: 90 } }
  })
    .png()
    .toBuffer()
).toString('base64')

const mainPath = join(workDir, 'main.cjs')
writeFileSync(
  mainPath,
  `const { app, BrowserWindow, protocol } = require('electron')
protocol.registerSchemesAsPrivileged([
  { scheme: 'oscine', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }
])
app.setAppUserModelId('app.oscine.desktop')
${process.env.FERMATA_PROBE_SET_NAME === '1' ? "app.setName('Fermata')" : '// app.setName deliberately not called; see src/main/index.ts'}
app.whenReady().then(() => {
  protocol.handle('oscine', () =>
    new Response(Buffer.from(${JSON.stringify(pngBase64)}, 'base64'), { headers: { 'content-type': 'image/png' } })
  )
  const win = new BrowserWindow({ width: 520, height: 300, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } })
  win.loadFile(${JSON.stringify(pagePath)})
  win.webContents.on('console-message', (event) => {
    if (String(event.message ?? '').startsWith('[probe]')) process.stdout.write(String(event.message) + '\\n')
  })
  process.stdout.write('[probe] window loaded from ' + ${JSON.stringify(pathToFileURL(pagePath).toString())} + '\\n')
})
app.on('window-all-closed', () => app.quit())
`
)

const sh = (command, args) => {
  try {
    return execFileSync(command, args, { encoding: 'utf8' }).trim()
  } catch (error) {
    return `(${command} failed: ${error.message.split('\n')[0]})`
  }
}

const child = spawn(electron, [mainPath], {
  stdio: ['ignore', 'inherit', 'inherit'],
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' }
})

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let failed = false
try {
  // Chromium opens the session a beat after playback actually starts.
  await wait(6000)

  const names = sh('busctl', ['--user', 'list', '--no-legend'])
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((name) => name?.startsWith('org.mpris.MediaPlayer2.'))

  const players = sh('playerctl', ['-l'])
    .split('\n')
    .filter((name) => name && !name.startsWith('('))

  console.log('\n===== W3-10 media session probe =====')
  console.log(`electron:            ${sh(electron, ['--version'])}`)
  console.log(`session type:        ${process.env.XDG_SESSION_TYPE ?? 'unknown'}`)
  console.log(`app.setName called:  ${process.env.FERMATA_PROBE_SET_NAME === '1' ? 'yes' : 'no'}`)
  console.log(`artwork mode:        ${process.env.FERMATA_PROBE_ARTWORK ?? 'scheme'}`)
  console.log(`\n[2] MPRIS bus names: ${names.length ? names.join(', ') : 'NONE'}`)
  console.log(`    playerctl sees:  ${players.length ? players.join(', ') : 'NONE'}`)

  if (!names.length) {
    failed = true
    console.log(
      '\n[3] No name published. Re-run with FERMATA_PROBE_FEATURES set to a\n' +
        '    Chromium --enable-features value to test whether a switch is required.'
    )
  } else {
    const target = players[0] ?? names[0].replace('org.mpris.MediaPlayer2.', '')
    console.log(`\n[1] metadata:\n${sh('playerctl', ['-p', target, 'metadata'])}`)
    console.log(`\n    status: ${sh('playerctl', ['-p', target, 'status'])}`)
    console.log('\n    sending play-pause; an "ACTION pause" line above means keys reach us')
    sh('playerctl', ['-p', target, 'play-pause'])
    await wait(1500)
  }
  console.log('=====================================\n')
} finally {
  child.kill()
  rmSync(workDir, { recursive: true, force: true })
}

process.exit(failed ? 1 : 0)
