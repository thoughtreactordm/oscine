/**
 * The `mcp_*` views as an agent sees them — `describe_views`, **W24-5**,
 * `oscine-mcp` → D36.4.
 *
 * The SQL is migration 029 (`src/main/db/migrations/029-mcp-views.ts`). This is
 * its documentation, kept by hand because SQLite reports no useful type for an
 * expression column, and held equal to the live schema — names, order, nothing
 * missing — by `tests/main/mcp/queryViews.test.ts`. A view migration that adds
 * a column fails that test until the column is described here.
 */

export type McpColumnType = 'integer' | 'real' | 'text' | 'boolean' | 'json'

export interface McpViewColumn {
  name: string
  type: McpColumnType
  /** Whether the column can be NULL. */
  nullable: boolean
  description: string
}

export interface McpView {
  name: string
  description: string
  columns: readonly McpViewColumn[]
}

const col = (
  name: string,
  type: McpColumnType,
  description: string,
  nullable = true
): McpViewColumn => ({ name, type, nullable, description })

const ISO = 'ISO 8601 UTC text, so it sorts and compares as a string.'

export const MCP_VIEWS: readonly McpView[] = [
  {
    name: 'mcp_tracks',
    description:
      'One row per indexed track, with effective values: the file’s tags with the operator’s ' +
      'staged corrections applied, exactly as the track list shows them.',
    columns: [
      col('id', 'integer', 'Track id, the same id every other tool uses.', false),
      col('root', 'text', 'Name of the library root the file is under (never a path).', false),
      col('path', 'text', 'POSIX path relative to the root.', false),
      col('title', 'text', 'Title.'),
      col('artist_id', 'integer', 'Track artist id (mcp_artists.id).'),
      col('artist', 'text', 'Track artist.'),
      col('album_id', 'integer', 'Album id (mcp_albums.id).'),
      col('album', 'text', 'Album title.'),
      col('album_artist_id', 'integer', 'Album artist id (mcp_artists.id).'),
      col(
        'album_artist',
        'text',
        'Album artist as the library groups it; a file with no album-artist tag is grouped ' +
          'under its track artist.'
      ),
      col('track_no', 'integer', 'Track number.'),
      col('disc_no', 'integer', 'Disc number.'),
      col('year', 'integer', 'The album’s year, as the track list shows it.'),
      col(
        'track_year',
        'integer',
        'This track’s own year: a staged correction, else the file’s tag. NULL when the file ' +
          'has not been re-read since the column was added.'
      ),
      col('genre', 'text', 'Genre tag, with a staged correction applied; NULL when empty.'),
      col('duration_ms', 'integer', 'Duration in milliseconds.'),
      col('codec', 'text', 'Codec, e.g. flac, mp3, aac, opus, vorbis.'),
      col('sample_rate', 'integer', 'Sample rate in Hz.'),
      col('channels', 'integer', 'Channel count.'),
      col('bit_depth', 'integer', 'Bits per sample; NULL for lossy codecs.'),
      col('size_bytes', 'integer', 'File size in bytes.', false),
      col('rg_track_gain', 'real', 'ReplayGain track gain in dB.'),
      col('rg_track_peak', 'real', 'ReplayGain track peak (linear).'),
      col('rg_album_gain', 'real', 'ReplayGain album gain in dB.'),
      col('rg_album_peak', 'real', 'ReplayGain album peak (linear).'),
      col('play_count', 'integer', 'Completed listens.', false),
      col('last_played_at', 'text', `Last completed listen; ${ISO}`),
      col('favorite', 'boolean', '1 when the operator has hearted the track.', false),
      col('has_artwork', 'boolean', '1 when the track resolves a cover.', false),
      col(
        'has_corrections',
        'boolean',
        '1 when any staged correction (tag or artwork) stands for the track.',
        false
      ),
      col(
        'staged_tags',
        'json',
        'Staged corrections to extended tag fields, as a JSON object of field → value (null ' +
          'means "clear the tag"). These fields’ file values are not indexed. NULL when none.'
      )
    ]
  },
  {
    name: 'mcp_albums',
    description: 'One row per album.',
    columns: [
      col('id', 'integer', 'Album id.', false),
      col('title', 'text', 'Album title.', false),
      col('album_artist_id', 'integer', 'Album artist id (mcp_artists.id).'),
      col('album_artist', 'text', 'Album artist.'),
      col('year', 'integer', 'Year.'),
      col('has_artwork', 'boolean', '1 when the album has a cover from its files.', false),
      col('track_count', 'integer', 'Tracks on the album.', false),
      col('duration_ms', 'integer', 'Total duration in milliseconds.', false)
    ]
  },
  {
    name: 'mcp_artists',
    description: 'One row per artist name, whether it appears as a track or an album artist.',
    columns: [
      col('id', 'integer', 'Artist id.', false),
      col('name', 'text', 'Name.', false),
      col('sort_name', 'text', 'Sort name.'),
      col('mbid', 'text', 'MusicBrainz artist id.'),
      col('track_count', 'integer', 'Tracks with this track artist.', false),
      col('album_count', 'integer', 'Albums with this album artist.', false)
    ]
  },
  {
    name: 'mcp_playlists',
    description: 'One row per playlist.',
    columns: [
      col('id', 'integer', 'Playlist id.', false),
      col('name', 'text', 'Name.', false),
      col('position', 'integer', 'Order in the playlist rail.', false),
      col('created_at', 'text', `Created; ${ISO}`, false),
      col('updated_at', 'text', `Last changed; ${ISO}`, false),
      col('entry_count', 'integer', 'Entries (a track can appear more than once).', false)
    ]
  },
  {
    name: 'mcp_playlist_entries',
    description:
      'One row per playlist entry. ORDER BY position for playlist order; positions are not ' +
      'contiguous.',
    columns: [
      col('id', 'integer', 'Entry id, the one playlist edits address.', false),
      col('playlist_id', 'integer', 'Playlist id (mcp_playlists.id).', false),
      col('track_id', 'integer', 'Track id (mcp_tracks.id).', false),
      col('position', 'real', 'Sort key within the playlist.', false)
    ]
  },
  {
    name: 'mcp_listens',
    description:
      'The listens log: one row per completed listen, with names as they were when played.',
    columns: [
      col('id', 'integer', 'Listen id.', false),
      col('track_id', 'integer', 'Track id, or NULL if the track has left the library.'),
      col('started_at', 'text', `When the listen started; ${ISO}`, false),
      col('ms_listened', 'integer', 'Milliseconds actually listened.', false),
      col('duration_ms', 'integer', 'Track duration at the time.'),
      col('title', 'text', 'Title when played.', false),
      col('artist', 'text', 'Artist when played.'),
      col('album', 'text', 'Album when played.'),
      col('album_artist', 'text', 'Album artist when played.')
    ]
  },
  {
    name: 'mcp_track_tags',
    description: 'The operator’s user tags (not file tags): one row per tag on a track.',
    columns: [
      col('track_id', 'integer', 'Track id (mcp_tracks.id).', false),
      col('tag', 'text', 'Tag as displayed.', false),
      col('tag_key', 'text', 'Normalised tag key.', false),
      col('source', 'text', "'user' or 'suggested'.", false),
      col('added_at', 'text', `When the tag was added; ${ISO}`, false)
    ]
  }
]
