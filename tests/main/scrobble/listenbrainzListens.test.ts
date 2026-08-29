/**
 * The `submit-listens` body, built from a `ScrobblePayload` — the ListenBrainz
 * analogue of the Last.fm parameter tests, and the place its wire shape is
 * pinned.
 */

import { describe, expect, it } from 'vitest'
import { nowPlayingBody, submitBody } from '../../../src/main/scrobble/listenbrainz/listens'
import type { NowPlayingPayload, ScrobbleSubmission } from '../../../src/shared/scrobble'

const full: NowPlayingPayload = {
  artistName: 'Talk Talk',
  title: 'I Believe In You',
  albumTitle: 'Spirit of Eden',
  albumArtistName: 'Talk Talk',
  durationSeconds: 380
}

describe('nowPlayingBody', () => {
  it('is a playing_now with one listen and no timestamp', () => {
    const body = nowPlayingBody(full)
    expect(body.listen_type).toBe('playing_now')
    expect(body.payload).toHaveLength(1)
    expect(body.payload[0]?.listened_at).toBeUndefined()
  })

  it('carries artist, track, release and duration in seconds', () => {
    const metadata = nowPlayingBody(full).payload[0]?.track_metadata
    expect(metadata?.artist_name).toBe('Talk Talk')
    expect(metadata?.track_name).toBe('I Believe In You')
    expect(metadata?.release_name).toBe('Spirit of Eden')
    expect(metadata?.additional_info.duration).toBe(380)
    expect(metadata?.additional_info.submission_client).toBe('Oscine')
  })

  it('omits the release when there is no album, rather than sending an empty one', () => {
    const metadata = nowPlayingBody({ ...full, albumTitle: null }).payload[0]?.track_metadata
    expect(metadata && 'release_name' in metadata).toBe(false)
  })

  it('omits the duration when the library does not know it', () => {
    const info = nowPlayingBody({ ...full, durationSeconds: null }).payload[0]?.track_metadata
      .additional_info
    expect(info && 'duration' in info).toBe(false)
  })

  it('drops the album artist, which ListenBrainz’s base schema has no field for', () => {
    const metadata = nowPlayingBody(full).payload[0]?.track_metadata
    expect(JSON.stringify(metadata)).not.toContain('album_artist')
  })
})

describe('submitBody', () => {
  const submission = (id: number, timestamp: number): ScrobbleSubmission => ({
    id,
    payload: {
      artistName: `Artist ${id}`,
      title: `Track ${id}`,
      albumTitle: 'Album',
      albumArtistName: null,
      durationSeconds: 200,
      timestamp
    }
  })

  it('is an import with one payload entry per submission', () => {
    const body = submitBody([submission(7, 1000), submission(8, 2000)])
    expect(body.listen_type).toBe('import')
    expect(body.payload).toHaveLength(2)
  })

  it('stamps each listen with the moment it started, in seconds', () => {
    const body = submitBody([submission(7, 1000), submission(8, 2000)])
    expect(body.payload[0]?.listened_at).toBe(1000)
    expect(body.payload[1]?.listened_at).toBe(2000)
    expect(body.payload[1]?.track_metadata.track_name).toBe('Track 8')
  })
})
