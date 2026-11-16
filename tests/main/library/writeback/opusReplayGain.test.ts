import { describe, expect, it } from 'vitest'
import {
  Id3v2FrameClassType,
  Id3v2Tag,
  Id3v2UserTextInformationFrame,
  Mpeg4AppleTag,
  Mpeg4IsoUserDataBox,
  OggOpusCodec,
  XiphComment,
  type File as TagFile
} from 'node-taglib-sharp'
import { gainDbToR128Q78, parseR128Q78, r128Q78ToGainDb } from '@shared/audio/r128'
import { REPLAYGAIN_TAG_KEYS } from '@shared/tagFields'
import {
  applyTagFields,
  OPUS_R128_WRITE_CONFIRMED,
  PLAIN_TAG_CONTEXT,
  readTagFieldsFromTag,
  readTagProperty,
  refusedOpusTagField,
  tagAccessContext,
  writeTagProperty
} from '../../../../src/main/library/writeback/genericFields'
import * as gate from '../../../../scripts/lib/writeback-tag-access.mjs'
import { pinAdmission } from '../../../support/pinAdmission'

/**
 * The Opus ReplayGain write — **W25-5 (RG-5)**, `oscine-replaygain` D37
 * Decision E. On Opus a gain is `R128_TRACK_GAIN` / `R128_ALBUM_GAIN` (Q7.8,
 * −23 LUFS), written through the raw Xiph field rather than node-taglib-sharp's
 * portable setter (which writes `REPLAYGAIN_*` on any Ogg); the same scope's
 * `REPLAYGAIN_*` gain and peak go in the same write, and a peak is refused.
 * Every accessor scenario runs through the writer and the W16-16 gate's mirror.
 */

const OPUS = { opus: true } as const

/** Saved and reopened, so a result only counts once it survives serialisation. */
function reopened(comment: XiphComment): XiphComment {
  return XiphComment.fromData(comment.render(true), false)
}

function fields(comment: XiphComment): Record<string, string[]> {
  return Object.fromEntries(comment.fieldNames.map((name) => [name, comment.getField(name)]))
}

const IMPLEMENTATIONS = [
  ['writer', { readTagProperty, writeTagProperty }],
  ['gate mirror', gate]
] as const

describe.each(IMPLEMENTATIONS)('Opus ReplayGain through the %s', (_, access) => {
  it('writes a gain as the R128 Q7.8 integer, not REPLAYGAIN_*', () => {
    const comment = XiphComment.fromEmpty()
    access.writeTagProperty(comment, 'replayGainTrackGain', -7.23, OPUS)
    const after = reopened(comment)
    // (−7.23 − 5) × 256 = −3130.88 → −3131.
    expect(fields(after)).toEqual({ R128_TRACK_GAIN: ['-3131'] })
    expect(access.readTagProperty(after, 'replayGainTrackGain', OPUS)).toBeCloseTo(-7.23, 2)
  })

  it("removes the scope's REPLAYGAIN_* gain and peak, and leaves the other scope", () => {
    const comment = XiphComment.fromEmpty()
    comment.setFieldAsStrings('REPLAYGAIN_TRACK_GAIN', '-1.00 dB')
    comment.setFieldAsStrings('REPLAYGAIN_TRACK_PEAK', '0.500000')
    comment.setFieldAsStrings('REPLAYGAIN_ALBUM_GAIN', '-2.00 dB')
    comment.setFieldAsStrings('R128_TRACK_GAIN', '12')
    access.writeTagProperty(comment, 'replayGainTrackGain', 5, OPUS)
    expect(fields(reopened(comment))).toEqual({
      REPLAYGAIN_ALBUM_GAIN: ['-2.00 dB'],
      R128_TRACK_GAIN: ['0']
    })
  })

  it('writes the album gain to R128_ALBUM_GAIN', () => {
    const comment = XiphComment.fromEmpty()
    access.writeTagProperty(comment, 'replayGainAlbumGain', -6.5, OPUS)
    expect(fields(reopened(comment))).toEqual({ R128_ALBUM_GAIN: ['-2944'] })
  })

  it.each([undefined, null, Number.NaN])('clears a gain with %s', (clear) => {
    const comment = XiphComment.fromEmpty()
    access.writeTagProperty(comment, 'replayGainTrackGain', -7.23, OPUS)
    comment.setFieldAsStrings('REPLAYGAIN_TRACK_GAIN', '-1.00 dB')
    access.writeTagProperty(comment, 'replayGainTrackGain', clear, OPUS)
    const after = reopened(comment)
    expect(fields(after)).toEqual({})
    expect(access.readTagProperty(after, 'replayGainTrackGain', OPUS)).toBeNaN()
  })

  it('refuses a peak with the comment untouched', () => {
    const comment = XiphComment.fromEmpty()
    comment.setFieldAsStrings('REPLAYGAIN_TRACK_PEAK', '0.500000')
    expect(() => access.writeTagProperty(comment, 'replayGainTrackPeak', 0.9, OPUS)).toThrow(
      /no peak tag/
    )
    expect(fields(comment)).toEqual({ REPLAYGAIN_TRACK_PEAK: ['0.500000'] })
    // Read as the file holds it — the scanner's precedence.
    expect(access.readTagProperty(comment, 'replayGainTrackPeak', OPUS)).toBe(0.5)
  })

  it('reads R128 over REPLAYGAIN_*, and REPLAYGAIN_* when R128 is absent or malformed', () => {
    const comment = XiphComment.fromEmpty()
    comment.setFieldAsStrings('REPLAYGAIN_TRACK_GAIN', '-1.00 dB')
    expect(access.readTagProperty(comment, 'replayGainTrackGain', OPUS)).toBe(-1)
    comment.setFieldAsStrings('R128_TRACK_GAIN', '1.5 dB')
    expect(access.readTagProperty(comment, 'replayGainTrackGain', OPUS)).toBe(-1)
    comment.setFieldAsStrings('R128_TRACK_GAIN', '-512')
    expect(access.readTagProperty(comment, 'replayGainTrackGain', OPUS)).toBe(3)
  })

  it('refuses a gain Q7.8 cannot express without touching the comment', () => {
    const comment = XiphComment.fromEmpty()
    comment.setFieldAsStrings('REPLAYGAIN_TRACK_GAIN', '-1.00 dB')
    expect(() =>
      access.writeTagProperty(comment, 'replayGainTrackGain', Number.POSITIVE_INFINITY, OPUS)
    ).toThrow()
    expect(fields(comment)).toEqual({ REPLAYGAIN_TRACK_GAIN: ['-1.00 dB'] })
  })

  it('writes REPLAYGAIN_* as before on a non-Opus Xiph comment (FLAC, Vorbis)', () => {
    const comment = XiphComment.fromEmpty()
    access.writeTagProperty(comment, 'replayGainTrackGain', -7.23, PLAIN_TAG_CONTEXT)
    access.writeTagProperty(comment, 'replayGainTrackPeak', 0.987654, PLAIN_TAG_CONTEXT)
    expect(fields(reopened(comment))).toEqual({
      REPLAYGAIN_TRACK_GAIN: ['-7.23 dB'],
      REPLAYGAIN_TRACK_PEAK: ['0.987654']
    })
    // The context defaults to plain.
    expect(access.readTagProperty(comment, 'replayGainTrackGain')).toBe(-7.23)
  })
})

/**
 * OQ4: node-taglib-sharp formats every gain `toFixed(2) + " dB"` and every peak
 * `toFixed(6)`, on ID3v2 `TXXX`, Apple freeform and Xiph alike; and its Apple
 * setter throws on `undefined`, which is why the `real` clear is `NaN`.
 */
describe('ReplayGain formatting and clears across tag families (OQ4)', () => {
  it('writes six-decimal peaks and two-decimal gains on ID3v2 and Apple', () => {
    const id3 = Id3v2Tag.fromEmpty()
    id3.replayGainTrackGain = -7.23
    id3.replayGainTrackPeak = 0.987654
    const txxx = Object.fromEntries(
      id3
        .getFramesByClassType<Id3v2UserTextInformationFrame>(
          Id3v2FrameClassType.UserTextInformationFrame
        )
        .map((frame) => [frame.description, frame.text])
    )
    expect(txxx).toEqual({
      REPLAYGAIN_TRACK_GAIN: ['-7.23 dB'],
      REPLAYGAIN_TRACK_PEAK: ['0.987654']
    })

    const apple = new Mpeg4AppleTag(Mpeg4IsoUserDataBox.fromEmpty())
    apple.replayGainTrackGain = -7.23
    apple.replayGainTrackPeak = 0.987654
    expect(apple.getFirstItunesString('com.apple.iTunes', 'REPLAYGAIN_TRACK_GAIN')).toBe('-7.23 dB')
    expect(apple.getFirstItunesString('com.apple.iTunes', 'REPLAYGAIN_TRACK_PEAK')).toBe('0.987654')
  })

  it('clears Apple ReplayGain with NaN, where undefined throws', () => {
    const apple = new Mpeg4AppleTag(Mpeg4IsoUserDataBox.fromEmpty())
    apple.replayGainTrackGain = -7.23
    expect(() => {
      apple.replayGainTrackGain = undefined as unknown as number
    }).toThrow()
    apple.replayGainTrackGain = Number.NaN
    expect(apple.replayGainTrackGain).toBeNaN()
  })
})

describe("the gate's Q7.8 mirror", () => {
  it('agrees with src/shared/audio/r128.ts', () => {
    for (const gain of [-200, -7.23, -6.51, 0, 4.999, 5, 5.001, 18.7, 200]) {
      expect(gate.gainDbToR128Q78(gain)).toBe(gainDbToR128Q78(gain))
    }
    for (const text of ['-3131', '+12', ' 0 ', '1.5', '40000', '', '-0']) {
      expect(gate.parseR128Q78(text)).toBe(parseR128Q78(text))
    }
    expect(gate.r128Q78ToGainDb(-3131)).toBe(r128Q78ToGainDb(-3131))
  })
})

describe('tagAccessContext', () => {
  it('recognises Opus from the decoded codec, not the extension', () => {
    const opus = Object.create(OggOpusCodec.prototype) as OggOpusCodec
    const file = (codecs: unknown[]) => ({ properties: { codecs } }) as unknown as TagFile
    expect(tagAccessContext(file([opus])).opus).toBe(true)
    expect(tagAccessContext(file([{}])).opus).toBe(false)
    expect(tagAccessContext({} as TagFile).opus).toBe(false)
    expect(gate.tagAccessContext(file([opus])).opus).toBe(true)
  })
})

describe('refusedOpusTagField — Decision E and the R20 hold', () => {
  it('holds every Opus ReplayGain write until R20 is confirmed', () => {
    expect(OPUS_R128_WRITE_CONFIRMED).toBe(false)
    expect(refusedOpusTagField(['replayGainTrackGain'], OPUS)?.reason).toMatch(/R20/)
    expect(refusedOpusTagField(['replayGainAlbumGain'], OPUS)?.reason).toMatch(/R20/)
  })

  it('refuses a peak on Opus for good', () => {
    expect(refusedOpusTagField(['replayGainTrackPeak'], OPUS)?.reason).toMatch(/no peak/)
    expect(refusedOpusTagField(['replayGainAlbumPeak'], OPUS)?.reason).toMatch(/no peak/)
  })

  it('refuses nothing on other codecs, nor non-ReplayGain keys on Opus', () => {
    expect(refusedOpusTagField(REPLAYGAIN_TAG_KEYS, PLAIN_TAG_CONTEXT)).toBeNull()
    expect(refusedOpusTagField(['conductor', 'bpm'], OPUS)).toBeNull()
  })

  describe('applyTagFields, with the ReplayGain fields admitted', () => {
    pinAdmission(Object.fromEntries(REPLAYGAIN_TAG_KEYS.map((key) => [key, true])))

    it('fails an Opus write that names a ReplayGain key, writing nothing', () => {
      const comment = XiphComment.fromEmpty()
      expect(() =>
        applyTagFields(comment, { conductor: 'X', replayGainTrackGain: -7.23 }, OPUS)
      ).toThrow(/R20/)
      expect(() => applyTagFields(comment, { replayGainAlbumPeak: 0.9 }, OPUS)).toThrow(/no peak/)
      expect(fields(comment)).toEqual({})
    })

    it('writes and clears ReplayGain on a non-Opus file, clearing with NaN', () => {
      const apple = new Mpeg4AppleTag(Mpeg4IsoUserDataBox.fromEmpty())
      applyTagFields(apple, { replayGainTrackGain: -7.23, replayGainTrackPeak: 0.987654 })
      expect(
        Object.fromEntries(
          readTagFieldsFromTag(apple, ['replayGainTrackGain', 'replayGainTrackPeak'])
        )
      ).toEqual({ replayGainTrackGain: -7.23, replayGainTrackPeak: 0.987654 })
      // `null` → NaN; `undefined` would throw in the Apple setter.
      applyTagFields(apple, { replayGainTrackGain: null, replayGainTrackPeak: null })
      expect(
        Object.fromEntries(
          readTagFieldsFromTag(apple, ['replayGainTrackGain', 'replayGainTrackPeak'])
        )
      ).toEqual({ replayGainTrackGain: null, replayGainTrackPeak: null })
    })
  })
})
