import { describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '@shared/ipc'
import type { PresenceSignal } from '@shared/presence'
import { createNoopPresenceSink } from '../../../src/main/discord/presenceSink'
import { assertPresenceSignal } from '../../../src/main/ipc/validate'

const CLEAR: PresenceSignal = { track: null, positionMs: 0, paused: false, playing: false }
const PLAYING: PresenceSignal = {
  track: { title: 'So What', artist: 'Miles Davis', album: 'Kind of Blue', durationMs: 545_000 },
  positionMs: 1_000,
  paused: false,
  playing: true
}

describe('presence channel and sink (W20-1)', () => {
  it('declares presence.update in the contract, so the registry startup check covers it', () => {
    // The `assertEveryChannelHandled` gate fails fast at startup for any channel
    // in this list without a handler; membership here is what makes it demand one.
    expect(IPC_CHANNELS).toContain('presence.update')
  })

  it('runs the handler path — validate then sink — for a clear signal without throwing', () => {
    const sink = createNoopPresenceSink()
    // Exactly what the registered handler does, on the "clear presence" case.
    expect(() => sink.update(assertPresenceSignal(CLEAR))).not.toThrow()
  })

  it('forwards a validated signal to the sink verbatim', () => {
    const update = vi.fn()
    const sink = { update }
    sink.update(assertPresenceSignal(PLAYING))
    expect(update).toHaveBeenCalledWith(PLAYING)
  })
})
