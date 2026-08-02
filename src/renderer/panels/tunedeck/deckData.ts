import { watch } from 'vue'
import { useArtistBiographyStore } from '@renderer/stores/artistBiography'
import { useArtistIdentityStore } from '@renderer/stores/artistIdentity'
import { usePlaybackStore } from '@renderer/stores/playback'
import { usePlayHistoryStore } from '@renderer/stores/playHistory'
import { useRelatedStore } from '@renderer/stores/related'
import { useTunedeckStore } from '@renderer/stores/tunedeck'

/**
 * Keeps the deck's shared stores current while the deck is open.
 *
 * ## Why this is not in the panes
 *
 * It used to be: `TrailPane` loaded the history on mount and `RelatedPane`
 * watched the transport for a seed. That worked when every pane was mounted at
 * once. With one group open per tab it does not — the badge on a *shut* group
 * is read from the same store the shut group would have filled, so a collapsed
 * Trail would report an empty history until you opened it, and then report the
 * truth. A number that only becomes correct once you have looked inside is
 * worse than no number, because it is the number you use to decide whether to
 * look inside.
 *
 * So the loading moved up to the one thing that is mounted regardless of which
 * group is open. The panes are now pure readers, which is also the arrangement
 * that makes three related groups over one result cost one query rather than
 * three.
 *
 * ## Why it is gated on `open` rather than on mount
 *
 * The deck is always mounted — `AppShell` collapses its width to zero and marks
 * it `inert` rather than tearing it down, so that reopening it is not a
 * remount. Hydrating on mount would therefore run both queries on every launch
 * for a surface that is shut as often as not, which is exactly the cost
 * `usePlayHistoryStore.load` says it exists to avoid. Gating on `open` keeps
 * that promise while moving who makes the call.
 *
 * One watcher rather than two: both stores want the same trigger, and a
 * transport change while the deck is shut should leave both alone rather than
 * queue work for a surface nobody is looking at. Reopening catches up in the
 * same tick, because the deck's own `open` flag is what fires it.
 */
export function useDeckData(): void {
  const tunedeck = useTunedeckStore()
  const playback = usePlaybackStore()
  const trail = usePlayHistoryStore()
  const related = useRelatedStore()
  const identity = useArtistIdentityStore()
  const biography = useArtistBiographyStore()

  watch(
    [() => tunedeck.open, () => playback.nowPlaying?.id ?? null],
    ([open, trackId]) => {
      if (!open) return
      // Idempotent and guarded in the store — reopening the deck is not a
      // second read of five hundred rows.
      void trail.load()
      void related.load(trackId)
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
   * The biography follows the resolved *artist*, not the track.
   *
   * A second watcher rather than a line in the first, because its trigger is
   * different in kind: the identity resolves asynchronously, so at the moment
   * the track changes there is no artist id to ask about yet, and skipping
   * between two tracks by the same artist must not re-ask at all. Watching the
   * store's own output is what makes both true — the biography loads when the
   * identity arrives, and does not move when the identity does not.
   *
   * Gated on the deck being open for `identity.load`'s reason, which is D14
   * rather than performance. An artist the deck resolved to "none of these"
   * clears the pane instead of leaving the previous band's history under the new
   * one's name.
   */
  watch(
    [
      () => tunedeck.open,
      () => (identity.resolution?.mbid === null ? null : (identity.resolution?.artistId ?? null))
    ],
    ([open, artistId]) => {
      if (!open) return
      void biography.load(artistId)
    },
    { immediate: true }
  )
}
