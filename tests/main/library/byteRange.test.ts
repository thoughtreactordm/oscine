import { describe, expect, it } from 'vitest'
import { parseByteRange, UNSATISFIABLE_RANGE } from '../../../src/main/library/byteRange'

describe('parseByteRange', () => {
  it('leaves an ordinary full response alone', () => {
    expect(parseByteRange(null, 10_000)).toBeNull()
  })

  it('parses bounded and open-ended media ranges', () => {
    expect(parseByteRange('bytes=1000-1999', 10_000)).toEqual({
      start: 1000,
      end: 1999,
      length: 1000
    })
    expect(parseByteRange('bytes=8000-', 10_000)).toEqual({
      start: 8000,
      end: 9999,
      length: 2000
    })
  })

  it('parses suffix ranges and clamps them to the file', () => {
    expect(parseByteRange('bytes=-500', 10_000)).toEqual({
      start: 9500,
      end: 9999,
      length: 500
    })
    expect(parseByteRange('bytes=-20000', 10_000)).toEqual({
      start: 0,
      end: 9999,
      length: 10_000
    })
  })

  it('clamps an oversized end to the final byte', () => {
    expect(parseByteRange('bytes=9000-20000', 10_000)).toEqual({
      start: 9000,
      end: 9999,
      length: 1000
    })
  })

  it('rejects malformed, multiple and out-of-bounds ranges', () => {
    for (const header of ['items=0-1', 'bytes=-', 'bytes=20-10', 'bytes=10000-', 'bytes=0-1,3-4']) {
      expect(parseByteRange(header, 10_000)).toBe(UNSATISFIABLE_RANGE)
    }
  })
})
