import { watch } from 'vue'
import { useArtistBiographyStore } from '@renderer/stores/artistBiography'
import { useArtistFavoritesStore } from '@renderer/stores/artistFavorites'
import { useArtistIdentityStore } from '@renderer/stores/artistIdentity'
import { useArtistImageStore } from '@renderer/stores/artistImage'
import { useArtistLinksStore } from '@renderer/stores/artistLinks'
import { useArtistRelationsStore } from '@renderer/stores/artistRelations'
import { usePlaybackStore } from '@renderer/stores/playback'
import { usePlayHistoryStore } from '@renderer/stores/playHistory'
import { useRelatedStore } from '@renderer/stores/related'
import { useTrackStatsStore } from '@renderer/stores/trackStats'
import { useTunedeckStore } from '@renderer/stores/tunedeck'

/**
 * Keeps the deck's shared stores current while the deck is open.
 *
 * ## Why this is not in the panes
 *
 * It used to be: `TrailPane` loaded the history on mount and `RelatedPane`
 * watched the transport for a seed. That worked when every pane was mounted at
 * once. Once a group could be collapsed it does not — the badge on a *shut*
 * group is read from the same store the shut group would have filled, so a
 * collapsed Trail would report an empty history until you opened it, and then
 * report the truth. A number that only becomes correct once you have looked
 * inside is worse than no number, because it is the number you use to decide
 * whether to look inside.
 *
 * So the loading moved up to the one thing that is mounted regardless of which
 * group is open. The panes are now pure readers, which is also the arrangement
 * that makes three related groups over one result cost one query rather than
 * three.
 *
 * ## Why it is gated on `showing` rather than on mount
 *
 * The deck is always mounted — `AppShell` collapses its width to zero and marks
 * it `inert` rather than tearing it down, so that reopening it is not a
 * remount. Hydrating on mount would therefore run both queries on every launch
 * for a surface that is shut as often as not, which is exactly the cost
 * `usePlayHistoryStore.load` says it exists to avoid. Gating on the flag keeps
 * that promise while moving who makes the call.
 *
 * `showing` and not `open`, so a deck standing down for an empty transport does
 * not fetch either. The two differ only where it matters: `open` is what the
 * operator asked for and `showing` is whether there is a track to ask about.
 *
 * One watcher rather than two: both stores want the same trigger, and a
 * transport change while the deck is shut should leave both alone rather than
 * queue work for a surface nobody is looking at. Reopening catches up in the
 * same tick, because the deck's own flag is what fires it.
 */
export function useDeckData(): void {
  const tunedeck = useTunedeckStore()
  const playback = usePlaybackStore()
  const trail = usePlayHistoryStore()
  const related = useRelatedStore()
  const identity = useArtistIdentityStore()
  const artistFavorites = useArtistFavoritesStore()
  const trackStats = useTrackStatsStore()
  const biography = useArtistBiographyStore()
  const relations = useArtistRelationsStore()
  const links = useArtistLinksStore()
  const image = useArtistImageStore()

  watch(
    [() => tunedeck.showing, () => playback.nowPlaying?.id ?? null],
    ([showing, trackId]) => {
      if (!showing) return
      // Idempotent and guarded in the store — reopening the deck is not a
      // second read of five hundred rows.
      void trail.load()
      void related.load(trackId)
      // Here rather than in the artist watcher below, which is the whole point
      // of the pane. The Favorite Songs group lives under Artist and answers
      // about the artist, but it is seeded by the *track* and resolves the
      // artist in SQLite — so it is not waiting on `identity.load`, and a
      // machine with the cable pulled draws it in a frame instead of when a
      // MusicBrainz connection times out. D14's third rule; see the store.
      void artistFavorites.load(trackId)
      // Here for the same reason and with the same shape: seeded by the *track*,
      // answered by SQLite, and therefore drawn in a frame on a machine with no
      // network. The artist's totals are under the Artist tab but they are not
      // waiting on `identity.load` any more than the favorites are — main
      // resolves which artist from the seed, which is what keeps a local
      // surface local. See `useTrackStatsStore`.
      void trackStats.load(trackId)
      // The one call here that can leave the machine, and the gate on `open` is
      // therefore not a performance choice but **D14**: fetching is scoped to a
      // drawer the operator has opened. Main declines it anyway when consent is
      // off, and an artist matched once is answered from the database — so the
      // steady-state cost of this line is a `SELECT`.
      void identity.load(trackId)
    },
    { immediate: true }
  )

  /**
   * The biography and the relations follow the resolved *artist*, not the track.
   *
   * A second watcher rather than a line in the first, because its trigger is
   * different in kind: the identity resolves asynchronously, so at the moment
   * the track changes there is no artist id to ask about yet, and skipping
   * between two tracks by the same artist must not re-ask at all. Watching the
   * store's own output is what makes both true — the panes load when the
   * identity arrives, and do not move when the identity does not.
   *
   * Gated on the deck showing for `identity.load`'s reason, which is D14
   * rather than performance. An artist the deck resolved to "none of these"
   * clears both panes instead of leaving the previous band's history, and the
   * previous band's line-up, under the new one's name.
   *
   * Four calls and one watcher, because they are the same trigger and the four
   * stores are independent of each other: a Wikipedia outage must not stop the
   * relations or the links loading, a Commons outage must not stop any of them,
   * and no lookup blocks another. All four are idempotent per artist, so the set
   * costs one round trip each per new artist and nothing at all per track.
   */
  watch(
    [
      () => tunedeck.showing,
      () => (identity.resolution?.mbid === null ? null : (identity.resolution?.artistId ?? null))
    ],
    ([showing, artistId]) => {
      if (!showing) return
      void biography.load(artistId)
      void relations.load(artistId)
      void links.load(artistId)
      void image.load(artistId)
    },
    { immediate: true }
  )
}
