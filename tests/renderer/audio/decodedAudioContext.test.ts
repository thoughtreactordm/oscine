import { describe, expect, it, vi } from 'vitest'
import { DecodedAudioContextPool } from '../../../src/renderer/audio/decodedAudioContext'

describe('DecodedAudioContextPool', () => {
  it('shares one clock and closes it after the final slot releases', () => {
    const close = vi.fn(async () => {})
    const context = { close }
    const pool = new DecodedAudioContextPool(() => context)
    const current = pool.acquire()
    const next = pool.acquire()

    expect(current.context).toBe(next.context)
    current.release()
    expect(close).not.toHaveBeenCalled()

    next.release()
    next.release()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('creates a fresh clock after every owner released the old one', () => {
    const contexts = [{ close: vi.fn(async () => {}) }, { close: vi.fn(async () => {}) }]
    const createContext = vi.fn().mockReturnValueOnce(contexts[0]).mockReturnValueOnce(contexts[1])
    const pool = new DecodedAudioContextPool(createContext)
    const first = pool.acquire()
    first.release()
    const second = pool.acquire()

    expect(first.context).toBe(contexts[0])
    expect(second.context).toBe(contexts[1])
    second.release()
  })
})
