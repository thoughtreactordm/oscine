import { describe, expect, it, vi } from 'vitest'
import { Emitter } from '../../../src/renderer/audio/emitter'

interface TestEvents {
  tick: number
  label: string
}

describe('Emitter', () => {
  it('delivers a payload to every listener of that type', () => {
    const emitter = new Emitter<TestEvents>()
    const first = vi.fn()
    const second = vi.fn()
    const other = vi.fn()

    emitter.on('tick', first)
    emitter.on('tick', second)
    emitter.on('label', other)
    emitter.emit('tick', 7)

    expect(first).toHaveBeenCalledWith(7)
    expect(second).toHaveBeenCalledWith(7)
    expect(other).not.toHaveBeenCalled()
  })

  it('is inert when nothing is listening', () => {
    const emitter = new Emitter<TestEvents>()
    expect(() => emitter.emit('tick', 1)).not.toThrow()
  })

  it('stops delivery once unsubscribed', () => {
    const emitter = new Emitter<TestEvents>()
    const listener = vi.fn()

    const off = emitter.on('tick', listener)
    emitter.emit('tick', 1)
    off()
    emitter.emit('tick', 2)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(emitter.count('tick')).toBe(0)
  })

  it('tolerates unsubscribing twice', () => {
    const emitter = new Emitter<TestEvents>()
    const off = emitter.on('tick', vi.fn())

    off()
    expect(off).not.toThrow()
  })

  it('lets a listener unsubscribe itself mid-emit', () => {
    // The engine does exactly this — a one-shot listener that detaches on the
    // first event. Iterating the live set would skip whatever followed it.
    const emitter = new Emitter<TestEvents>()
    const calls: string[] = []

    const off = emitter.on('tick', () => {
      calls.push('self-removing')
      off()
    })
    emitter.on('tick', () => calls.push('survivor'))

    emitter.emit('tick', 1)
    emitter.emit('tick', 2)

    expect(calls).toEqual(['self-removing', 'survivor', 'survivor'])
  })

  it('does not deliver to a listener added during the same emit', () => {
    const emitter = new Emitter<TestEvents>()
    const late = vi.fn()

    emitter.on('tick', () => emitter.on('tick', late))
    emitter.emit('tick', 1)

    expect(late).not.toHaveBeenCalled()
    emitter.emit('tick', 2)
    expect(late).toHaveBeenCalledTimes(1)
  })

  it('drops every listener on clear', () => {
    // `dispose` relies on this: a discarded engine must not keep the UI alive
    // through a listener it still holds.
    const emitter = new Emitter<TestEvents>()
    const listener = vi.fn()

    emitter.on('tick', listener)
    emitter.on('label', listener)
    emitter.clear()
    emitter.emit('tick', 1)
    emitter.emit('label', 'x')

    expect(listener).not.toHaveBeenCalled()
    expect(emitter.count('tick')).toBe(0)
  })
})
