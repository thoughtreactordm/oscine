import { describe, expect, it, vi } from 'vitest'
import {
  AudioOutputRouter,
  SYSTEM_DEFAULT_OUTPUT_DEVICE,
  type SinkCapableContext
} from '../../../src/renderer/audio/outputDevice'

class FakeContext implements SinkCapableContext {
  state = 'running'
  readonly sinks: string[] = []
  fails = false

  async setSinkId(sinkId: string): Promise<void> {
    if (this.fails) throw new Error(`no such device: ${sinkId}`)
    this.sinks.push(sinkId)
  }
}

/** A runtime whose `AudioContext` predates `setSinkId`. */
class SinklessContext implements SinkCapableContext {
  state = 'running'
}

describe('AudioOutputRouter', () => {
  it('starts on the system default and says so as the empty string', () => {
    expect(new AudioOutputRouter().deviceId).toBe(SYSTEM_DEFAULT_OUTPUT_DEVICE)
  })

  it('points every live context at a chosen device', async () => {
    const router = new AudioOutputRouter()
    const decoded = router.adopt(new FakeContext())
    const streaming = router.adopt(new FakeContext())

    await router.setDevice('usb-dac')

    expect(decoded.sinks).toEqual(['usb-dac'])
    expect(streaming.sinks).toEqual(['usb-dac'])
    expect(router.deviceId).toBe('usb-dac')
  })

  it('points a context built later at the device already chosen', async () => {
    // The case the router exists for: the streaming path builds its context the
    // first time a track streams, which can be long after the operator picked a
    // device. A per-engine setter would have missed this one.
    const router = new AudioOutputRouter()
    await router.setDevice('usb-dac')

    const late = router.adopt(new FakeContext())
    await Promise.resolve()

    expect(late.sinks).toEqual(['usb-dac'])
  })

  it('does not touch a new context while the system default is selected', () => {
    // `setSinkId('')` and never calling it are the same outcome, and the second
    // costs nothing on the path to playing a track.
    const router = new AudioOutputRouter()
    const context = router.adopt(new FakeContext())

    expect(context.sinks).toEqual([])
  })

  it('keeps the other contexts pointed correctly when one refuses', async () => {
    const router = new AudioOutputRouter()
    const broken = router.adopt(new FakeContext())
    const working = router.adopt(new FakeContext())
    broken.fails = true
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(router.setDevice('usb-dac')).resolves.toBeUndefined()

    expect(working.sinks).toEqual(['usb-dac'])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('forgets a context once it has been closed', async () => {
    // The pool closes its context when the last slot is disposed and never tells
    // the router. Holding it would leak it and make every later switch do work
    // that can only reject.
    const router = new AudioOutputRouter()
    const closed = router.adopt(new FakeContext())
    const live = router.adopt(new FakeContext())
    closed.state = 'closed'

    await router.setDevice('usb-dac')

    expect(closed.sinks).toEqual([])
    expect(live.sinks).toEqual(['usb-dac'])
  })

  it('reports a runtime that cannot re-point a context at all', async () => {
    const router = new AudioOutputRouter()
    router.adopt(new SinklessContext())

    expect(router.supported).toBe(false)
    // Still resolves: the setting is stored either way, and a future runtime or
    // a context built by a different path may well honour it.
    await expect(router.setDevice('usb-dac')).resolves.toBeUndefined()

    router.adopt(new FakeContext())
    expect(router.supported).toBe(true)
  })
})
