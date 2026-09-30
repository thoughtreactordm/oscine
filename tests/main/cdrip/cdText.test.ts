import { expect, it } from 'vitest'
import { parseCdText } from '../../../src/main/cdrip/cdText'
import { cdText, pack } from './cdTextFixture'
import type { CdToc } from '@shared/cdrip'
const toc: CdToc = {
  firstTrack: 1,
  lastTrack: 1,
  leadOutSector: 1000,
  entries: [{ number: 1, startSector: 0, sectorCount: 1000, isAudio: true, preEmphasis: false }]
}
it('reads disc and track fields, including a title split across packs', () => {
  const text = cdText(
    pack(0x80, 0, 'Album\0Long t'),
    pack(0x80, 1, 'itle\0', 1, 6),
    pack(0x81, 0, 'Band\0Guest\0', 2)
  )
  expect(parseCdText({ ...toc, cdText: text })).toEqual({
    source: 'cdtext',
    album: 'Album',
    albumArtist: 'Band',
    year: null,
    tracks: [{ number: 1, title: 'Long title', artist: 'Guest' }]
  })
})
it('accepts declared Latin-1 and tab repetition', () => {
  expect(
    parseCdText({ ...toc, cdText: cdText(pack(0x8f, 0, [0]), pack(0x80, 0, 'Café\0\t\0', 1)) })
      ?.tracks[0].title
  ).toBe('Café')
})
it('falls back for no text, broken CRC, truncated text, unsupported charset and double-byte packs', () => {
  expect(parseCdText(toc)).toBeNull()
  for (const text of [
    cdText(),
    cdText(pack(0x8f, 0, [0x80]), pack(0x80, 0, 'Album\0', 1)),
    cdText(pack(0x80, 0, 'Album\0', 0, 0x80)),
    cdText(pack(0x80, 0, 'Café\0')),
    cdText(pack(0x80, 0, 'unterminated'))
  ]) {
    expect(parseCdText({ ...toc, cdText: text })).toBeNull()
  }
  const broken = cdText(pack(0x80, 0, 'Album\0'))
  broken[8] ^= 1
  expect(parseCdText({ ...toc, cdText: broken })).toBeNull()
  expect(parseCdText({ ...toc, cdText: broken.subarray(0, 10) })).toBeNull()
})

it('uses the saturated continuation marker for text spanning three packs', () => {
  const text = cdText(
    pack(0x80, 0, 'abcdefghijkl'),
    pack(0x80, 0, 'mnopqrstuvwx', 1, 12),
    pack(0x80, 0, 'yz\0', 2, 15)
  )
  expect(parseCdText({ ...toc, cdText: text })?.album).toBe('abcdefghijklmnopqrstuvwxyz')
  const missing = cdText(pack(0x80, 0, 'abcdefghijkl'), pack(0x80, 0, 'yz\0', 2, 15))
  expect(parseCdText({ ...toc, cdText: missing })).toBeNull()
})
