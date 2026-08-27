import type Database from 'better-sqlite3'
import { normalizeLabel } from '@shared/genre'

/**
 * `tags` and `track_tags`, and the statements they are made of — **migration
 * 018, D7**.
 *
 * Its own module beside `../favorites/store`, following the precedent that
 * precedent set: one pair of tables the library layer never writes. Where the
 * scanner rebuilds `track_genres` from the file on every rescan, nothing here is
 * derived from a file at all — a user tag is a fact the operator authored, kept
 * app-side because D7 forbids writing it back to disk, and a rescan is exactly
 * the event it must survive.
 *
 * Electron-free, so the whole thing is drivable under plain Node against a temp
 * file — its tests do precisely that through the real migration list, because
 * the load-bearing claims (the shared casefold, the cascade, rescan-safety) are
 * about what is durably in SQLite.
 *
 * ## The shared key
 *
 * A tag's identity is `normalizeLabel`'s `key` — the same casefold
 * `track_genres.genre_key` is built from (`@shared/genre`). That is deliberate
 * and load-bearing: it is what lets a later W15 card treat a user tag `Hip-Hop`
 * and a file genre `hip-hop` as one thing. This module never invents a second
 * normalisation; if the fold changes, it changes in one place for both.
 *
 * ## The batch shape
 *
 * `addTag` and `removeTag` take `trackIds: number[]`, not a single id, from the
 * first commit. The Tunedeck tag pane and the D14 suggestion pass both apply a
 * tag to an album's or an artist's worth of tracks at once, and a batch built in
 * later would be a widening of every call site rather than a parameter already
 * there. A single-track gesture is just a batch of one.
 *
 * ## Orphan vocabulary: pruned on the remove gesture, not on cascade
 *
 * Deleting the last `track_tags` row for a tag leaves a vocabulary row nothing
 * references. The decision (migration 018 defers it here on purpose): `removeTag`
 * **prunes** a tag it empties, so the vocabulary means "tags actually in use" —
 * which is what `listTags` and the browse-by-tag surface want, and which gives
 * the operator the only way to retire a mis-coined tag, by untagging its last
 * track. A track *vanishing* from the library is different: its cascade severs
 * the assignment but leaves the vocabulary, because a file leaving disk is not
 * the operator un-coining a tag they built and may reapply.
 */

/**
 * The wire shapes moved to `src/shared/tags` — the only cross-process contract —
 * so the renderer that draws these rows and the main process that mints them
 * import one definition and cannot drift. Re-exported here so this store's own
 * callers (and its tests) need not know they moved.
 */
export type {
  TagSource,
  Tag,
  TagSummary,
  TagCoverage,
  ArtistTagsView,
  TrackTagAssignment,
  TrackTagView,
  RemoveTagResult
} from '@shared/tags'
import type {
  TagSource,
  Tag,
  TagSummary,
  TagCoverage,
  ArtistTagsView,
  TrackTagAssignment,
  TrackTagView,
  RemoveTagResult
} from '@shared/tags'

export class TagStore {
  private readonly statements: {
    list: Database.Statement<[]>
    fileTags: Database.Statement<[number]>
    userTags: Database.Statement<[number]>
    artistCoverage: Database.Statement<[number]>
    artistTrackCount: Database.Statement<[number]>
    upsertVocab: Database.Statement<{ key: string; label: string; createdAt: number }>
    vocabByKey: Database.Statement<[string]>
    vocabById: Database.Statement<[number]>
    insertJoin: Database.Statement<{
      trackId: number
      tagId: number
      source: string
      createdAt: number
    }>
    removeJoin: Database.Statement<{ tagId: number; ids: string }>
    countForTag: Database.Statement<[number]>
    pruneTag: Database.Statement<[number]>
    renameInPlace: Database.Statement<{ id: number; key: string; label: string }>
    renameLabel: Database.Statement<{ id: number; label: string }>
    repointForMerge: Database.Statement<{ source: number; target: number }>
  }

  private readonly addTransaction: (params: {
    key: string
    label: string
    source: TagSource
    ids: number[]
    now: number
  }) => Tag

  private readonly removeTransaction: (params: { tagId: number; ids: string }) => RemoveTagResult

  private readonly renameTransaction: (params: {
    tagId: number
    key: string
    label: string
  }) => Tag | null

  constructor(db: Database.Database) {
    this.statements = {
      // The vocabulary with a live per-tag count. `LEFT JOIN` and `count(track_id)`
      // so a hypothetical orphan (one the prune should have taken) still lists,
      // honestly, at zero rather than vanishing — the prune is a decision, not a
      // load-bearing invariant this query gets to assume. Ordered by display
      // spelling, `NOCASE`, so the list reads alphabetically however each was
      // capitalised; `id` breaks ties so a paged reader never sees a row twice.
      list: db.prepare(`
        SELECT t.id AS id, t.key AS key, t.label AS label, count(tt.track_id) AS trackCount
        FROM tags t
        LEFT JOIN track_tags tt ON tt.tag_id = t.id
        GROUP BY t.id
        ORDER BY t.label COLLATE NOCASE, t.id
      `),
      // The file half of `tagsForTrack`: display spellings out of the derived
      // genre table, read-only here. `NOCASE` order for the same reason.
      fileTags: db.prepare(`
        SELECT genre FROM track_genres WHERE track_id = ? ORDER BY genre COLLATE NOCASE
      `),
      // The user half: the assignments on a track, joined to their vocabulary for
      // the display spelling and carrying `source` so the pane can tell an operator
      // tag from a suggestion.
      userTags: db.prepare(`
        SELECT t.id AS id, t.label AS label, tt.source AS source
        FROM track_tags tt
        JOIN tags t ON t.id = tt.tag_id
        WHERE tt.track_id = ?
        ORDER BY t.label COLLATE NOCASE, t.id
      `),
      // W15-7 — coverage over one browse-dimension artist's catalogue. Every tag
      // used by any of the artist's tracks, with `carried` = how many carry it;
      // `count(tt.track_id)` needs no DISTINCT because `(track_id, tag_id)` is the
      // join's primary key, so a (tag, track) pair appears at most once. The
      // artist is `COALESCE(al.album_artist_id, t.artist_id)` — the same
      // BROWSE_ARTIST_ID the library store's Artist facet and `trackFacets` use
      // (kept a literal here to leave this module free of the library store), so a
      // suggestion applied "to everything by this artist" and this readout name
      // one set. Ordered most-covered first: the tags nearest to being the
      // artist's own read at the top, ties alphabetical so the order is stable.
      artistCoverage: db.prepare(`
        SELECT t.id AS id, t.key AS key, t.label AS label, count(tt.track_id) AS carried
        FROM tags t
        JOIN track_tags tt ON tt.tag_id = t.id
        JOIN tracks tr ON tr.id = tt.track_id
        LEFT JOIN albums al ON al.id = tr.album_id
        WHERE COALESCE(al.album_artist_id, tr.artist_id) = ?
        GROUP BY t.id
        ORDER BY carried DESC, t.label COLLATE NOCASE, t.id
      `),
      // The denominator the coverage above reads against — the artist's own track
      // count, by the same COALESCE so numerator and denominator describe one set.
      artistTrackCount: db.prepare(`
        SELECT count(*) AS n
        FROM tracks tr
        LEFT JOIN albums al ON al.id = tr.album_id
        WHERE COALESCE(al.album_artist_id, tr.artist_id) = ?
      `),
      // Coin the vocabulary row, or leave the existing one untouched. `DO NOTHING`
      // rather than an upsert of the label: `label` is the spelling as *first*
      // entered, so a second `addTag` with different capitalisation reuses the row
      // and keeps the original spelling. Renaming is `renameTag`'s job, not a side
      // effect of applying a tag.
      upsertVocab: db.prepare(`
        INSERT INTO tags (key, label, created_at) VALUES (@key, @label, @createdAt)
        ON CONFLICT(key) DO NOTHING
      `),
      vocabByKey: db.prepare('SELECT id, key, label FROM tags WHERE key = ?'),
      vocabById: db.prepare('SELECT id, key, label FROM tags WHERE id = ?'),
      // Assign the tag, guarding on the track's existence the way the favorite
      // insert does — `SELECT FROM tracks` means a track that left between render
      // and click is a `changes` of zero, not a foreign-key throw over a row the
      // operator just tagged.
      //
      // On an assignment that already exists, `DO UPDATE` promotes `'suggested'`
      // to `'user'` and never the reverse: an operator explicitly applying a tag a
      // suggestion offered should own it, but re-running the suggestion pass over a
      // tag the operator already applied must not demote it. `created_at` is left
      // at its first value — it records when the tag first landed on the track.
      insertJoin: db.prepare(`
        INSERT INTO track_tags (track_id, tag_id, source, created_at)
        SELECT t.id, @tagId, @source, @createdAt FROM tracks t WHERE t.id = @trackId
        ON CONFLICT(track_id, tag_id) DO UPDATE SET source = 'user'
          WHERE excluded.source = 'user' AND track_tags.source <> 'user'
      `),
      // One statement whatever the batch size — the ids arrive as a JSON array and
      // drive `json_each` into the primary key, so removing a tag from four hundred
      // tracks is four hundred b-tree probes and one prepared statement, not a
      // placeholder list re-compiled per distinct length.
      removeJoin: db.prepare(`
        DELETE FROM track_tags
        WHERE tag_id = @tagId AND track_id IN (SELECT value FROM json_each(@ids))
      `),
      countForTag: db.prepare('SELECT count(*) AS n FROM track_tags WHERE tag_id = ?'),
      pruneTag: db.prepare('DELETE FROM tags WHERE id = ?'),
      renameInPlace: db.prepare('UPDATE tags SET key = @key, label = @label WHERE id = @id'),
      renameLabel: db.prepare('UPDATE tags SET label = @label WHERE id = @id'),
      // Merge one tag's assignments into another's. `UPDATE OR IGNORE` skips the
      // rows whose track already carries the target — the primary key would collide
      // — leaving them pointing at the soon-to-be-deleted source, which the source's
      // own `ON DELETE CASCADE` then sweeps. Net: every track ends with exactly one
      // assignment to the target, and no duplicate was ever visible.
      repointForMerge: db.prepare(
        'UPDATE OR IGNORE track_tags SET tag_id = @target WHERE tag_id = @source'
      )
    }

    // Coin-or-reuse the vocabulary, then assign it to each track. One transaction,
    // so a batch is all-or-nothing and no reader sees the tag applied to some of
    // the tracks and not the rest.
    this.addTransaction = db.transaction(
      (params: {
        key: string
        label: string
        source: TagSource
        ids: number[]
        now: number
      }): Tag => {
        this.statements.upsertVocab.run({
          key: params.key,
          label: params.label,
          createdAt: params.now
        })
        const tag = this.statements.vocabByKey.get(params.key) as Tag
        for (const trackId of params.ids) {
          this.statements.insertJoin.run({
            trackId,
            tagId: tag.id,
            source: params.source,
            createdAt: params.now
          })
        }
        return tag
      }
    )

    // Remove the assignments, then retire the tag if that emptied it. One
    // transaction: the count that decides the prune and the delete it follows must
    // not be separable by another connection tagging the same tag in between.
    this.removeTransaction = db.transaction(
      (params: { tagId: number; ids: string }): RemoveTagResult => {
        const { changes } = this.statements.removeJoin.run(params)
        const { n } = this.statements.countForTag.get(params.tagId) as { n: number }
        let pruned = false
        if (n === 0) {
          pruned = this.statements.pruneTag.run(params.tagId).changes > 0
        }
        return { removed: changes, pruned }
      }
    )

    // Re-derive the tag's key from the new label and act on what the new key
    // implies: a display-only rename when the identity is unchanged, a free rename
    // when the new key is unclaimed, or a merge when it collides. One transaction,
    // because the collision check and the write it decides are one gesture.
    this.renameTransaction = db.transaction(
      (params: { tagId: number; key: string; label: string }): Tag | null => {
        const current = this.statements.vocabById.get(params.tagId) as Tag | undefined
        if (current === undefined) return null

        // Same identity, new spelling — e.g. `hiphop` → `HipHop`. The key does not
        // move, so nothing merges; only the display label changes.
        if (current.key === params.key) {
          this.statements.renameLabel.run({ id: params.tagId, label: params.label })
          return { id: params.tagId, key: params.key, label: params.label }
        }

        const collision = this.statements.vocabByKey.get(params.key) as Tag | undefined
        if (collision !== undefined) {
          // The new key is already a tag: fold this one into it. The surviving tag
          // keeps *its* first-entered spelling — a rename onto an existing tag is
          // the operator saying "these are the same tag", and the existing one is
          // the tag that was there first.
          this.statements.repointForMerge.run({ source: params.tagId, target: collision.id })
          this.statements.pruneTag.run(params.tagId)
          return collision
        }

        // The new key is free: move this tag onto it, spelling and all.
        this.statements.renameInPlace.run({
          id: params.tagId,
          key: params.key,
          label: params.label
        })
        return { id: params.tagId, key: params.key, label: params.label }
      }
    )
  }

  /** The whole vocabulary with live track counts, alphabetical by display spelling. */
  listTags(): TagSummary[] {
    return this.statements.list.all() as TagSummary[]
  }

  /**
   * A track's tags, file genres and user tags kept apart.
   *
   * A track with neither — or one not in the library at all — comes back with two
   * empty lists rather than an error: "this track has no tags" is an ordinary
   * answer, and the absent-track case reads the same because it has none either.
   */
  tagsForTrack(trackId: number): TrackTagView {
    const file = (this.statements.fileTags.all(trackId) as { genre: string }[]).map(
      (row) => row.genre
    )
    const user = this.statements.userTags.all(trackId) as TrackTagAssignment[]
    return { file, user }
  }

  /**
   * An artist's tags as coverage over its catalogue — **W15-7**.
   *
   * The union of every tag any of the artist's tracks carries, each with how many
   * of them do, over the artist's own track count. `artistId` is the browse
   * dimension's — the id `trackFacets` hands the pane and `listTrackIds` selects
   * on — so this readout and the "everything by this artist" batch name one set.
   *
   * An artist with nothing tagged answers an empty list over its `total`; one
   * resolved to no tracks at all answers empty over `0`. Neither is an error — an
   * untagged catalogue is an ordinary thing to be looking at.
   */
  tagsForArtist(artistId: number): ArtistTagsView {
    const tags = this.statements.artistCoverage.all(artistId) as TagCoverage[]
    const { n } = this.statements.artistTrackCount.get(artistId) as { n: number }
    return { total: n, tags }
  }

  /**
   * Applies a tag to a batch of tracks, coining its vocabulary row if new.
   *
   * Returns the vocabulary row the label resolved to — the caller learns the id
   * and canonical spelling of the tag, whether this call created it or reused an
   * existing one. `null` when the label normalises to nothing (empty, or only
   * whitespace): that is not a tag, and not an error.
   *
   * Ids are deduplicated on the way in, so a track named twice is assigned once.
   * An id that is not a track in the library is simply not assigned — the guard
   * lives in the insert, not here.
   */
  addTag(trackIds: readonly number[], label: string, source: TagSource): Tag | null {
    const norm = normalizeLabel(label)
    if (norm === null) return null

    const ids = [...new Set(trackIds)]
    return this.addTransaction({
      key: norm.key,
      label: norm.label,
      source,
      ids,
      now: Date.now()
    })
  }

  /**
   * Removes a tag from a batch of tracks, retiring the tag if that empties it.
   *
   * `removed` counts the assignments actually deleted, so removing a tag from
   * tracks that never carried it — or asking twice — reports `0` rather than
   * failing; a removal is idempotent by nature. `pruned` says whether the tag was
   * the last of its assignments and so was taken out of the vocabulary (see the
   * class header for why the remove gesture prunes and a cascade does not).
   */
  removeTag(trackIds: readonly number[], tagId: number): RemoveTagResult {
    const ids = [...new Set(trackIds)]
    if (ids.length === 0) return { removed: 0, pruned: false }
    return this.removeTransaction({ tagId, ids: JSON.stringify(ids) })
  }

  /**
   * Renames a tag across the whole vocabulary.
   *
   * The new label is re-normalised to a key, and the outcome follows the key:
   * unchanged key is a display-only respelling; a free new key moves the tag onto
   * it; a key that already belongs to another tag merges the two, folding this
   * tag's tracks into that one and retiring this row. Returns the surviving tag —
   * which on a merge is the *other* one — or `null` if `tagId` is not a tag, or if
   * the label normalises to nothing.
   */
  renameTag(tagId: number, label: string): Tag | null {
    const norm = normalizeLabel(label)
    if (norm === null) return null
    return this.renameTransaction({ tagId, key: norm.key, label: norm.label })
  }
}
