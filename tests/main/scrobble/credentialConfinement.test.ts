/**
 * D19's rule about the renderer, asserted against the source rather than
 * remembered.
 *
 * The card's acceptance is "grepping the renderer bundle for it finds nothing".
 * A grep of a *bundle* is a thing a person does once, on one machine, on the day
 * they are looking; these are the same question asked on every run, of the
 * inputs the bundle is built from.
 *
 * Three separate ways a credential could reach the renderer, and all three are
 * closed here: importing the store, reaching for `safeStorage` directly, or
 * adding an IPC channel that carries a secret. The third is the one worth having
 * a test for, because it is the one that looks reasonable while it is being
 * written.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { IPC_CHANNELS, IPC_EVENT_CHANNELS } from '../../../src/shared/ipc'

const SRC = join(__dirname, '../../../src')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(ts|vue)$/.test(entry.name) ? [path] : []
  })
}

const rendererSide = [...sourceFiles(join(SRC, 'renderer')), ...sourceFiles(join(SRC, 'preload'))]

describe('the credential stays in main', () => {
  it('is not imported by the renderer or the preload bridge', () => {
    const offenders = rendererSide.filter((path) =>
      /scrobble\/credentials|scrobble\/lastfm\//.test(readFileSync(path, 'utf8'))
    )
    expect(offenders).toEqual([])
  })

  it('leaves safeStorage to main, which is the only process that has it', () => {
    const offenders = rendererSide.filter((path) =>
      /\bsafeStorage\b/.test(readFileSync(path, 'utf8'))
    )
    expect(offenders).toEqual([])
  })

  it('has no channel whose name suggests it carries one', () => {
    // A name check rather than a type check on purpose: the types are the real
    // guarantee and `tsc` already enforces them, but a channel called
    // `scrobble.sessionKey` would be a decision someone made, and this is where
    // that decision gets argued with.
    const suspicious = [...IPC_CHANNELS, ...IPC_EVENT_CHANNELS].filter((channel) =>
      /session|secret|credential|token|password/i.test(channel)
    )
    expect(suspicious).toEqual([])
  })

  it('exposes exactly five scrobbling calls and one event', () => {
    // Pinned so that widening the renderer's view of scrobbling is a deliberate
    // edit to this list rather than a channel that slipped in beside the others.
    //
    // W11-7 made two such edits and both are recorded here rather than absorbed:
    // `connections` became `status`, which carries the outbox's depth and last
    // error alongside the username, and `retry` was added so a stalled queue has
    // a button. Neither widens what is said about the *credential*, which is the
    // thing this file is guarding — and keeping that distinction visible is why
    // the count in the title had to change to let them through.
    expect(IPC_CHANNELS.filter((channel) => channel.startsWith('scrobble.'))).toEqual([
      'scrobble.status',
      'scrobble.connect',
      'scrobble.cancelConnect',
      'scrobble.disconnect',
      'scrobble.retry'
    ])
    expect(IPC_EVENT_CHANNELS.filter((channel) => channel.startsWith('scrobble.'))).toEqual([
      'scrobble.statusChanged'
    ])
  })
})
