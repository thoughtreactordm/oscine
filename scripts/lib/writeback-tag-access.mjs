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
 * MP4 artist-id clears would throw where the writer does not.
 */
import taglib from 'node-taglib-sharp'

const { CombinedTag, Id3v2CommentsFrame, Id3v2FrameClassType, Id3v2Tag, Mpeg4AppleTag } = taglib

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

const PROPERTY_ACCESS = Object.freeze({
  comment: Object.freeze({ read: readComment, write: writeComment }),
  musicBrainzArtistId: Object.freeze({
    read: plainRead('musicBrainzArtistId'),
    write: writeSplitId('musicBrainzArtistId')
  }),
  musicBrainzReleaseArtistId: Object.freeze({
    read: plainRead('musicBrainzReleaseArtistId'),
    write: writeSplitId('musicBrainzReleaseArtistId')
  })
})

/** A registry property's raw value, through its safe accessor. */
export function readTagProperty(tag, property) {
  const access = PROPERTY_ACCESS[property]
  return access !== undefined ? access.read(tag) : tag[property]
}

/** Assigns a registry property's raw value, through its safe accessor. */
export function writeTagProperty(tag, property, value) {
  const access = PROPERTY_ACCESS[property]
  if (access !== undefined) access.write(tag, value)
  else tag[property] = value
}
