import { afterEach, describe, expect, it, vi } from 'vitest'
import { DecodedBufferLedger } from '../../../src/renderer/audio/decodedBufferLedger'

/**
 * Deterministic stand-in for a facility whose real callbacks are deliberately
 * controlled by GC. Keeping the target here is fine: the test calls `collect`
 * explicitly to model the notification V8 would eventually deliver.
 */
class FakeFinalizationRegistry<T> {
  static latest: FakeFinalizationRegistry<unknown> | null = null

  readonly #holdings = new Map<object, T>()

  constructor(private readonly onCollected: (heldValue: T) => void) {
    FakeFinalizationRegistry.latest = this as FakeFinalizationRegistry<unknown>
  }

  register(target: object, heldValue: T): void {
    this.#holdings.set(target, heldValue)
  }

  unregister(): boolean {
    return false
  }

  collect(target: object): void {
    const heldValue = this.#holdings.get(target)
    if (heldValue === undefined) throw new Error('Target was not registered')
    this.#holdings.delete(target)
    this.onCollected(heldValue)
  }
}

function fakeRegistry(): FakeFinalizationRegistry<number> {
  const registry = FakeFinalizationRegistry.latest
  if (!registry) throw new Error('No FinalizationRegistry was constructed')
  return registry as FakeFinalizationRegistry<number>
}

afterEach(() => {
  FakeFinalizationRegistry.latest = null
  vi.unstubAllGlobals()
})

describe('DecodedBufferLedger', () => {
  it('counts every issued buffer until collection is proven', () => {
    vi.stubGlobal('FinalizationRegistry', FakeFinalizationRegistry)
    const ledger = new DecodedBufferLedger()
    const first = {}
    const second = {}

    ledger.track(first, 1_382_400_000)
    ledger.track(second, 7_680_000)

    expect(ledger.issuedNotFreedBytes).toBe(1_390_080_000)

    fakeRegistry().collect(first)
    expect(ledger.issuedNotFreedBytes).toBe(7_680_000)

    fakeRegistry().collect(second)
    expect(ledger.issuedNotFreedBytes).toBe(0)
  })

  it('does not invent a release operation when the engine drops a reference', () => {
    vi.stubGlobal('FinalizationRegistry', FakeFinalizationRegistry)
    const ledger = new DecodedBufferLedger()
    let buffer: object | null = {}

    ledger.track(buffer, 352_800)
    buffer = null

    expect(buffer).toBeNull()
    expect(ledger.issuedNotFreedBytes).toBe(352_800)
  })

  it('ignores an empty decoded buffer', () => {
    vi.stubGlobal('FinalizationRegistry', FakeFinalizationRegistry)
    const ledger = new DecodedBufferLedger()

    ledger.track({}, 0)

    expect(ledger.issuedNotFreedBytes).toBe(0)
  })
})
