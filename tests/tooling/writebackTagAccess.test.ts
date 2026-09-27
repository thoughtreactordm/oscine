import { describe, expect, it } from 'vitest'
import {
  CombinedTag,
  Id3v1Tag,
  Id3v2CommentsFrame,
  Id3v2FrameClassType,
  Id3v2Tag,
  TagTypes,
  type Tag
} from 'node-taglib-sharp'
import { readTagProperty, writeTagProperty } from '../../src/main/library/writeback/genericFields'
import * as gate from '../../scripts/lib/writeback-tag-access.mjs'

/**
 * W16-19. The writer reads and writes ID3v2's comment through its plain
 * (empty-description) COMM frame, never node-taglib-sharp's portable accessor,
 * which reuses a *described* frame another tool owns. The W16-16 corpus gate runs
 * under plain Node and carries a mirror of that accessor; every scenario here runs
 * through both and requires the same frames and the same read.
 */

/** The seeded neighbours the corpus uses: described COMM frames that are not the comment. */
function described(): Id3v2CommentsFrame[] {
  return [
    ['oscine-a', 'alpha'],
    ['oscine-b', 'beta']
  ].map(([description, text]) => {
    const frame = Id3v2CommentsFrame.fromDescription(description!, 'eng')
    frame.text = text!
    return frame
  })
}

function plain(text: string, language = 'eng'): Id3v2CommentsFrame {
  const frame = Id3v2CommentsFrame.fromDescription('', language)
  frame.text = text
  return frame
}

function id3v2(frames: Id3v2CommentsFrame[]): Id3v2Tag {
  const tag = Id3v2Tag.fromEmpty()
  for (const frame of frames) tag.addFrame(frame)
  return tag
}

/** Saved and reopened, so a result only counts once it survives serialisation. */
function reopened(tag: Id3v2Tag): Id3v2Tag {
  return Id3v2Tag.fromData(tag.render())
}

function commFrames(tag: Id3v2Tag): Array<[string, string]> {
  return tag
    .getFramesByClassType<Id3v2CommentsFrame>(Id3v2FrameClassType.CommentsFrame)
    .map((frame) => [frame.description, frame.text])
}

/** A combined tag over given leaves, the way an MP3's sandwich reads and writes. */
class TestCombinedTag extends CombinedTag {
  constructor(tags: Tag[]) {
    super(TagTypes.AllTags, true, tags)
  }

  createTag(): Tag {
    throw new Error('not used')
  }
}

const IMPLEMENTATIONS = [
  ['writer', { readTagProperty, writeTagProperty }],
  ['gate mirror', gate]
] as const

describe.each(IMPLEMENTATIONS)('ID3v2 comment through the %s', (_, access) => {
  it('reads no comment from a tag whose only COMM frames are described', () => {
    expect(access.readTagProperty(id3v2(described()), 'comment')).toBeUndefined()
    // The portable accessor is the bug: it answers with a neighbour's text.
    expect(id3v2(described()).comment).toBe('alpha')
  })

  it('sets the comment as a new plain frame, leaving described frames alone', () => {
    const tag = id3v2(described())
    access.writeTagProperty(tag, 'comment', 'Line one\nLine two')
    const after = reopened(tag)
    expect(access.readTagProperty(after, 'comment')).toBe('Line one\nLine two')
    expect(commFrames(after)).toEqual([
      ['oscine-a', 'alpha'],
      ['oscine-b', 'beta'],
      ['', 'Line one\nLine two']
    ])
  })

  it('updates an existing plain frame in place rather than adding another', () => {
    const tag = id3v2([...described(), plain('old')])
    access.writeTagProperty(tag, 'comment', 'new')
    expect(commFrames(reopened(tag))).toEqual([
      ['oscine-a', 'alpha'],
      ['oscine-b', 'beta'],
      ['', 'new']
    ])
  })

  it('reads the plain frame even when a described one comes first', () => {
    expect(access.readTagProperty(id3v2([...described(), plain('mine')]), 'comment')).toBe('mine')
  })

  it('clears only the plain frames, in every language', () => {
    const tag = id3v2([...described(), plain('mine'), plain('mien', 'fra')])
    access.writeTagProperty(tag, 'comment', undefined)
    const after = reopened(tag)
    expect(access.readTagProperty(after, 'comment')).toBeUndefined()
    expect(commFrames(after)).toEqual([
      ['oscine-a', 'alpha'],
      ['oscine-b', 'beta']
    ])
  })

  it('writes every tag of a combined tag and reads the first that has a comment', () => {
    const v2 = id3v2(described())
    const v1 = Id3v1Tag.fromEmpty()
    v1.comment = 'from v1'
    const combined = new TestCombinedTag([v2, v1])
    // ID3v2 has no plain frame, so ID3v1 answers — as the combined getter would.
    expect(access.readTagProperty(combined, 'comment')).toBe('from v1')

    access.writeTagProperty(combined, 'comment', 'both')
    expect(access.readTagProperty(combined, 'comment')).toBe('both')
    expect(v1.comment).toBe('both')
    expect(commFrames(v2)).toEqual([
      ['oscine-a', 'alpha'],
      ['oscine-b', 'beta'],
      ['', 'both']
    ])
  })

  it('leaves a tag with no ID3v2 to the portable accessor', () => {
    const v1 = Id3v1Tag.fromEmpty()
    access.writeTagProperty(v1, 'comment', 'plain')
    expect(v1.comment).toBe('plain')
    expect(access.readTagProperty(v1, 'comment')).toBe('plain')
  })

  it('reads and assigns any other property as the plain Tag property', () => {
    const tag = id3v2([])
    access.writeTagProperty(tag, 'conductor', 'Nadia Boulanger')
    expect(tag.conductor).toBe('Nadia Boulanger')
    expect(access.readTagProperty(tag, 'conductor')).toBe('Nadia Boulanger')
  })
})
