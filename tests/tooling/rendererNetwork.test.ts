import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

/**
 * W7-7 asks that no `fetch`/XHR to an external host exist under `src/renderer`,
 * "reviewed, and worth a lint rule if it is cheap". A review holds until the
 * next person adds a call; this runs on every push.
 *
 * Like `pathPortability.test.ts`, it goes through the real `eslint.config.mjs`
 * rather than instantiating the rule. The rule being correct is the easy half —
 * what protects D14 is that it is switched on, for the renderer, at error
 * severity, and that is the wiring under test.
 *
 * None of the filenames below exist. ESLint resolves configuration from a path
 * rather than from its contents, so a fictional one is enough to ask "what would
 * happen to a file here" without leaving a fixture anyone could mistake for real
 * code.
 */

const eslint = new ESLint()

async function lint(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath })
  return result.messages.map((message) => message.ruleId ?? '<fatal>')
}

const RULE = 'fermata/no-renderer-network'
const RENDERER = 'src/renderer/panels/network-probe.ts'
const MAIN = 'src/main/net/network-probe.ts'

describe('the renderer is held off the network', () => {
  it('rejects XMLHttpRequest', async () => {
    expect(await lint('export const x = new XMLHttpRequest()', RENDERER)).toContain(RULE)
  })

  it('rejects a WebSocket', async () => {
    expect(await lint(`export const s = new WebSocket('wss://example.com')`, RENDERER)).toContain(
      RULE
    )
  })

  it('rejects an EventSource', async () => {
    expect(await lint(`export const e = new EventSource('/stream')`, RENDERER)).toContain(RULE)
  })

  it('rejects navigator.sendBeacon', async () => {
    expect(await lint(`export const go = () => navigator.sendBeacon('/x')`, RENDERER)).toContain(
      RULE
    )
  })

  it('rejects fetch to an https literal', async () => {
    expect(
      await lint(`export const go = () => fetch('https://musicbrainz.org/ws/2/artist')`, RENDERER)
    ).toContain(RULE)
  })

  it('rejects fetch to a remote template literal', async () => {
    expect(
      await lint(
        'export const go = (q: string) => fetch(`https://musicbrainz.org/ws/2/artist?query=${q}`)',
        RENDERER
      )
    ).toContain(RULE)
  })

  it('rejects a protocol-relative URL', async () => {
    expect(await lint(`export const go = () => fetch('//example.com/x')`, RENDERER)).toContain(RULE)
  })

  it('reports at error severity, so lint exits non-zero', async () => {
    const [result] = await eslint.lintText(`export const go = () => fetch('https://example.com')`, {
      filePath: RENDERER
    })
    expect(result.errorCount).toBeGreaterThan(0)
  })
})

describe('the rule leaves the renderer’s legitimate reads alone', () => {
  it('accepts a fetch of a fermata:// URL', async () => {
    // What `audio/DecodedAudioEngine.ts` does with a URL main minted.
    expect(
      await lint(`export const go = () => fetch('fermata://track/12')`, RENDERER)
    ).not.toContain(RULE)
  })

  it('accepts a fetch of a URL it cannot see', async () => {
    // What `playback/browserMediaSession.ts` does with an artwork src. The rule
    // deliberately declines to guess; the CSP and the custom protocol are what
    // bound this case at runtime.
    expect(await lint('export const go = (url: string) => fetch(url)', RENDERER)).not.toContain(
      RULE
    )
  })

  it('accepts a local variable that merely shares a banned name', async () => {
    const code = ['const WebSocket = { fake: true }', 'export const s = WebSocket'].join('\n')
    expect(await lint(code, RENDERER)).not.toContain(RULE)
  })
})

describe('the rule stays out of main, where the sockets belong', () => {
  it('allows a remote fetch from src/main', async () => {
    expect(
      await lint(`export const go = () => fetch('https://musicbrainz.org/ws/2/artist')`, MAIN)
    ).not.toContain(RULE)
  })
})
