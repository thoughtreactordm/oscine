import { describe, expect, it } from 'vitest'
import {
  defaultTransportPreferences,
  readTransportPreferences,
  writeTransportPreferences,
  type TransportStorage
} from '../../../src/renderer/playback/transportPreferences'

function storage(initial: string | null = null): TransportStorage & { value: string | null } {
  return {
    value: initial,
    read() {
      return this.value
    },
    write(next: string) {
      this.value = next
    }
  }
}

describe('transport preferences', () => {
  it('survives a round trip', () => {
    const store = storage()
    writeTransportPreferences(store, { repeat: 'one', shuffle: true })
    expect(readTransportPreferences(store)).toEqual({ repeat: 'one', shuffle: true })
  })

  it('defaults to off with nothing stored', () => {
    expect(readTransportPreferences(storage())).toEqual({ repeat: 'off', shuffle: false })
    expect(readTransportPreferences(undefined)).toEqual(defaultTransportPreferences())
  })

  it('records no shuffle sequence', () => {
    // Design §5 rule 5 keeps traversal transient: switching shuffle on after a
    // restart reshuffles rather than resurrecting a sequence over a library
    // that may have been rescanned since.
    const store = storage()
    writeTransportPreferences(store, { repeat: 'all', shuffle: true })
    expect(store.value).toBe('{"repeat":"all","shuffle":true}')
  })

  it('degrades field by field rather than discarding the lot', () => {
    expect(readTransportPreferences(storage('{"repeat":"sideways","shuffle":true}'))).toEqual({
      repeat: 'off',
      shuffle: true
    })
    expect(readTransportPreferences(storage('{"repeat":"one"}'))).toEqual({
      repeat: 'one',
      shuffle: false
    })
    expect(readTransportPreferences(storage('{"shuffle":"yes"}'))).toEqual({
      repeat: 'off',
      shuffle: false
    })
  })

  it('survives storage that is not preferences at all', () => {
    for (const stored of ['not json', 'null', '42', '[]', '"off"']) {
      expect(readTransportPreferences(storage(stored))).toEqual(defaultTransportPreferences())
    }
  })

  it('runs unbound', () => {
    // Omitting storage is a supported configuration, not a degraded one — the
    // modes simply last for the session.
    expect(() =>
      writeTransportPreferences(undefined, { repeat: 'all', shuffle: true })
    ).not.toThrow()
  })
})
