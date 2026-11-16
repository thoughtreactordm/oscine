/**
 * How the W16-16 corpus gate reads and assigns a registry property — the same
 * way the writer does. `readTagProperty` / `writeTagProperty` in
 * `src/main/library/writeback/genericFields.ts` are the authority; the probe runs
 * under plain Node and cannot import that TS module, so this is a mirror, and
 * `tests/tooling/writebackTagAccess.test.ts` runs both over the same tags and
 * fails the moment they disagree.
 *
 * A gate that assigned `tag[property]` directly would be testing node-taglib-sharp
 * rather than the writer: W16-19's ID3v2 `comment` would stay red after the
 * writer stopped clobbering described COMM frames, or go green without it; W16-20's
 * MP4 artist-id clears would throw where the writer does not; RG-5's Opus gains
 * would be written as `REPLAYGAIN_*` rather than `R128_*`.
 */
import taglib from 'node-taglib-sharp'

const {
  CombinedTag,
  Id3v2CommentsFrame,
  Id3v2FrameClassType,
  Id3v2Tag,
  Mpeg4AppleTag,
  OggOpusCodec,
  XiphComment
} = taglib

/** Every non-Opus file, and any caller that has only a tag. */
export const PLAIN_TAG_CONTEXT = Object.freeze({ opus: false })

/** Whether an open file's Ogg stream is Opus — from the codec, never the extension. */
export function tagAccessContext(file) {
  const codecs = file.properties?.codecs ?? []
  return { opus: codecs.some((codec) => codec instanceof OggOpusCodec) }
}

function leafTags(tag) {
  return tag instanceof CombinedTag ? tag.tags : [tag]
}

function plainCommentFrames(tag) {
  return tag
    .getFramesByClassType(Id3v2FrameClassType.CommentsFrame)
    .filter((frame) => frame.description === '')
}

function plainCommentFrame(tag) {
  const frames = plainCommentFrames(tag)
  return frames.find((frame) => frame.language === Id3v2Tag.language) ?? frames[0]
}

/** W16-19: ID3v2's comment is its plain (empty-description) COMM frame, only. */
function readComment(tag) {
  const leaves = leafTags(tag)
  if (!leaves.some((leaf) => leaf instanceof Id3v2Tag)) return tag.comment
  for (const leaf of leaves) {
    const value = leaf instanceof Id3v2Tag ? plainCommentFrame(leaf)?.text : leaf.comment
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

function writeComment(tag, value) {
  const text = typeof value === 'string' && value !== '' ? value : undefined
  const leaves = leafTags(tag)
  if (!leaves.some((leaf) => leaf instanceof Id3v2Tag)) {
    tag.comment = text
    return
  }
  for (const leaf of leaves) {
    if (!(leaf instanceof Id3v2Tag)) {
      leaf.comment = text
    } else if (text === undefined) {
      for (const frame of plainCommentFrames(leaf)) leaf.removeFrame(frame)
    } else {
      let frame = plainCommentFrame(leaf)
      if (frame === undefined) {
        frame = Id3v2CommentsFrame.fromDescription('', Id3v2Tag.language)
        leaf.addFrame(frame)
      }
      frame.text = text
    }
  }
}

function plainRead(property) {
  return (tag) => tag[property]
}

/** W16-20: MP4's MB artist-id setters split on `/`, so a clear goes as `''`. */
function writeSplitId(property) {
  return (tag, value) => {
    const cleared = value === undefined || value === null || value === ''
    tag[property] = cleared && tag instanceof Mpeg4AppleTag ? '' : value
  }
}

/**
 * Opus ReplayGain (RG-5, D37 Decision E): `src/shared/audio/r128.ts`'s Q7.8
 * conversion, mirrored — `gainDb = q / 256 + 5`, rounded and clamped to int16.
 */
const R128_OFFSET_DB = 5

export function gainDbToR128Q78(gainDb) {
  if (!Number.isFinite(gainDb)) throw new RangeError(`non-finite gain ${gainDb}`)
  const q = Math.min(32767, Math.max(-32768, Math.round((gainDb - R128_OFFSET_DB) * 256)))
  return q === 0 ? 0 : q
}

export function parseR128Q78(text) {
  const trimmed = String(text ?? '').trim()
  if (!/^[+-]?\d{1,6}$/.test(trimmed)) return null
  const value = Number.parseInt(trimmed, 10)
  if (value < -32768 || value > 32767) return null
  return value === 0 ? 0 : value
}

export function r128Q78ToGainDb(value) {
  return value / 256 + R128_OFFSET_DB
}

/** Each Opus gain scope: its R128 field, and the same scope's REPLAYGAIN_* it replaces. */
export const OPUS_GAIN_SCOPES = Object.freeze({
  replayGainTrackGain: Object.freeze({
    r128: 'R128_TRACK_GAIN',
    legacy: Object.freeze(['REPLAYGAIN_TRACK_GAIN', 'REPLAYGAIN_TRACK_PEAK'])
  }),
  replayGainAlbumGain: Object.freeze({
    r128: 'R128_ALBUM_GAIN',
    legacy: Object.freeze(['REPLAYGAIN_ALBUM_GAIN', 'REPLAYGAIN_ALBUM_PEAK'])
  })
})

function xiphComments(tag) {
  return leafTags(tag).filter((leaf) => leaf instanceof XiphComment)
}

function readOpusGain(property) {
  const scope = OPUS_GAIN_SCOPES[property]
  return (tag) => {
    for (const comment of xiphComments(tag)) {
      const q = parseR128Q78(comment.getFieldFirstValue(scope.r128) ?? '')
      if (q !== null) return r128Q78ToGainDb(q)
    }
    return tag[property]
  }
}

function writeOpusGain(property) {
  const scope = OPUS_GAIN_SCOPES[property]
  return (tag, value) => {
    const comments = xiphComments(tag)
    if (comments.length === 0) throw new Error(`no Xiph comment to write ${scope.r128} into`)
    const cleared = value === undefined || value === null || Number.isNaN(value)
    if (!cleared && typeof value !== 'number') {
      throw new TypeError(`${property} must be a number, got ${typeof value}`)
    }
    const text = cleared ? null : String(gainDbToR128Q78(value))
    for (const comment of comments) {
      comment.removeField(scope.r128)
      for (const legacy of scope.legacy) comment.removeField(legacy)
    }
    if (text !== null) comments[0].setFieldAsStrings(scope.r128, text)
  }
}

function refuseOpusPeak(property) {
  return () => {
    throw new Error(`refusing ${property} on Opus: R128 has no peak tag (D37 Decision E)`)
  }
}

function opusAware(property, opus) {
  return Object.freeze({
    read: (tag, context) => (context.opus ? opus.read(tag) : tag[property]),
    write: (tag, value, context) => {
      if (context.opus) opus.write(tag, value)
      else tag[property] = value
    }
  })
}

const PROPERTY_ACCESS = Object.freeze({
  comment: Object.freeze({ read: readComment, write: writeComment }),
  musicBrainzArtistId: Object.freeze({
    read: plainRead('musicBrainzArtistId'),
    write: writeSplitId('musicBrainzArtistId')
  }),
  musicBrainzReleaseArtistId: Object.freeze({
    read: plainRead('musicBrainzReleaseArtistId'),
    write: writeSplitId('musicBrainzReleaseArtistId')
  }),
  replayGainTrackGain: opusAware('replayGainTrackGain', {
    read: readOpusGain('replayGainTrackGain'),
    write: writeOpusGain('replayGainTrackGain')
  }),
  replayGainAlbumGain: opusAware('replayGainAlbumGain', {
    read: readOpusGain('replayGainAlbumGain'),
    write: writeOpusGain('replayGainAlbumGain')
  }),
  replayGainTrackPeak: opusAware('replayGainTrackPeak', {
    read: plainRead('replayGainTrackPeak'),
    write: refuseOpusPeak('replayGainTrackPeak')
  }),
  replayGainAlbumPeak: opusAware('replayGainAlbumPeak', {
    read: plainRead('replayGainAlbumPeak'),
    write: refuseOpusPeak('replayGainAlbumPeak')
  })
})

/** A registry property's raw value, through its safe accessor. */
export function readTagProperty(tag, property, context = PLAIN_TAG_CONTEXT) {
  const access = PROPERTY_ACCESS[property]
  return access !== undefined ? access.read(tag, context) : tag[property]
}

/** Assigns a registry property's raw value, through its safe accessor. */
export function writeTagProperty(tag, property, value, context = PLAIN_TAG_CONTEXT) {
  const access = PROPERTY_ACCESS[property]
  if (access !== undefined) access.write(tag, value, context)
  else tag[property] = value
}
