import { watch } from 'vue'
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

  watch(
    [() => tunedeck.open, () => playback.nowPlaying?.id ?? null],
    ([open, trackId]) => {
      if (!open) return
      // Idempotent and guarded in the store — reopening the deck is not a
      // second read of five hundred rows.
      void trail.load()
      void related.load(trackId)
    },
    { immediate: true }
  )
}
