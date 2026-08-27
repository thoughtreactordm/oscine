import { MAX_TRACK_ID_PAGE } from './library'

/**
 * User tags — **W15**, the app-side vocabulary that sits beside file genres.
 *
 * A tag is one label the operator coined and hung on a set of tracks; the store
 * (`src/main/tags`) keys it by the *same* rule a file genre is grouped by, so a
 * tag spelled `Hip-Hop` and a file genre spelled `hip-hop` land on one identity
 * rather than two vocabularies that never meet. That keying is D7's line held by
 * construction: **v1 never writes tags to disk** — a file's genres are what the
 * file says, and a user tag is this layer's own, editable here and nowhere near
 * the bytes.
 *
 * The wire shapes below live here rather than in the store because `src/shared`
 * is the only cross-process contract: main mints these rows and the renderer
 * draws them, and the one file both import from is the only thing that keeps the
 * two from drifting. The store re-exports them so its own callers need not know
 * they moved.
 */

/** Whether an assignment was authored by the operator or offered by a suggestion (D14). */
export type TagSource = 'user' | 'suggested'

/** A vocabulary row: the tag's identity and how it is spelled. */
export interface Tag {
  id: number
  key: string
  label: string
}

/** A vocabulary row with how many tracks currently carry it. */
export interface TagSummary extends Tag {
  trackCount: number
}

/** One user tag as it sits on a track. */
export interface TrackTagAssignment {
  id: number
  label: string
  source: TagSource
}

/**
 * A track's tags, the two vocabularies kept apart.
 *
 * `file` is read-only display spelling out of `track_genres` — what the file
 * says, which the operator changes by retagging and rescanning, not here.
 * `user` is the app-side, editable set.
 */
export interface TrackTagView {
  file: string[]
  user: TrackTagAssignment[]
}

/** What `removeTag` did: how many assignments it took, and whether it retired the tag. */
export interface RemoveTagResult {
  removed: number
  pruned: boolean
}

/**
 * A tag the operator might want — what `tags.suggest` carries (**W15-4**).
 *
 * MusicBrainz records `genres[]` and `tags[]` on an artist, each vote-weighted by
 * a `count`. A suggestion is one of those, deduped against what the track already
 * carries and ordered by that weight, so the pane draws the most-agreed-upon
 * label first. The shape was declared minimal by W15-2 so the renderer store was
 * complete before this card existed; the one field added here is the `count` the
 * chips order by, and the store that only ever read `label` is untouched by its
 * arrival.
 */
export interface TagSuggestion {
  readonly label: string
  /**
   * MusicBrainz's net vote weight for this tag on the artist — higher is more
   * agreed-upon, and the order the chips are drawn in. Always positive: a tag
   * the crowd voted down is not offered as one to adopt.
   */
  readonly count: number
}

/** `tags.forTrack` — the one track whose two vocabularies are wanted. */
export interface TrackTagsRequest {
  readonly trackId: number
}

/**
 * `tags.add` — one label onto a batch of tracks, coining the vocabulary row if
 * it is new.
 *
 * Batch-capable because the gesture that reaches it is "tag this selection", not
 * "tag this row": a column multi-select or a whole album is one label across
 * many ids, applied in one transaction so the answer is the single vocabulary
 * row every one of them now carries. The source is not a parameter — everything
 * the renderer adds is `'user'`, and the `'suggested'` source is the suggestion
 * pipeline's to write, not a caller's to claim.
 */
export interface AddTagsRequest {
  readonly trackIds: readonly number[]
  readonly label: string
}

/**
 * `tags.remove` — one tag off a batch of tracks.
 *
 * By `tagId`, not by label: a rename may be in flight, and the row the operator
 * clicked to remove is identified by the vocabulary id it was drawn from, which
 * survives a re-spelling. Removing a tag's last assignment prunes it — see the
 * store — so an emptied tag leaves the vocabulary and the browse surface both.
 */
export interface RemoveTagRequest {
  readonly trackIds: readonly number[]
  readonly tagId: number
}

/**
 * `tags.rename` — re-spell one vocabulary row.
 *
 * The store decides from the new label whether this is a spelling correction, a
 * full rename, or a merge into an existing tag that shares the new key, and
 * answers with the surviving row. The renderer does not predict which: it sends
 * the id and the label and redraws from what comes back.
 */
export interface RenameTagRequest {
  readonly tagId: number
  readonly label: string
}

/** `tags.suggest` — the track to propose tags for. */
export interface SuggestTagsRequest {
  readonly trackId: number
}

/**
 * The ceiling on a batch of track ids for `add`/`remove`, shared with
 * `listTrackIds` rather than chosen anew.
 *
 * A tag is applied to whatever the operator selected, and a selection in a
 * virtualized column legally spans the same window a range resolves through —
 * so the number that bounds the range is the number that bounds the write. A
 * second, smaller cap here would make "tag everything I selected" a two-request
 * operation for no reason a reader could find.
 */
export const MAX_TAG_TRACK_IDS = MAX_TRACK_ID_PAGE

/**
 * The longest a tag label may be. A tag is a word or a short phrase, not a
 * title, so this is well short of a playlist name's ceiling — long enough for
 * `Instrumental Post-Rock` and short enough that the vocabulary column stays a
 * column.
 */
export const MAX_TAG_LABEL_LENGTH = 120
