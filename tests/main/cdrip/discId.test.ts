import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { computeDiscId } from '@shared/cdrip'
import { discIdInput } from '@shared/discId'
import { fromToc } from './tocFixture'
import fixtures from './fixtures/disc-ids.json'

describe('MusicBrainz disc ID', () => {
  it.each(fixtures)('matches published $name ID', (fixture) => {
    const toc = fromToc(fixture.toc)
    if ('dataTrack' in fixture) toc.entries[fixture.dataTrack! - 1].isAudio = false
    expect(computeDiscId(toc)).toBe(fixture.id)
  })
  it('adds 150 to track and lead-out LBA addresses', () => {
    expect(discIdInput(fromToc('1 1 118623 150')).slice(0, 20)).toBe('01010001CF5F00000096')
  })
  it('always pads to 99 offsets, with zero rather than biased unused entries', () => {
    const input = discIdInput(fromToc('1 1 118623 150'))
    expect(input.length).toBe(804)
    expect(input.slice(20)).toBe('00000000'.repeat(98))
  })
  it('agrees with Node SHA-1 across varied TOCs', () => {
    for (let n = 1; n <= 99; n++) {
      const toc = fromToc(
        `1 ${n} ${n * 3000 + 150} ${Array.from({ length: n }, (_, i) => i * 3000 + 150).join(' ')}`
      )
      const expected = createHash('sha1')
        .update(discIdInput(toc))
        .digest('base64')
        .replaceAll('+', '.')
        .replaceAll('/', '_')
        .replaceAll('=', '-')
      expect(computeDiscId(toc)).toBe(expected)
    }
  })
  it('rejects malformed TOCs instead of making plausible IDs', () => {
    const toc = fromToc(fixtures[0].toc)
    expect(() => computeDiscId({ ...toc, lastTrack: 99 })).toThrow()
    expect(() => computeDiscId({ ...toc, leadOutSector: 0 })).toThrow()
  })
})
