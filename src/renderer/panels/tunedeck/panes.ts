import { PLAY_HISTORY_CAP } from '@shared/history'
import { NEIGHBOURHOOD_STRANDS, type RelatedStrand } from '@shared/related'
import { countRelatedRows } from './relatedRows'
import AlbumTracksPane from './AlbumTracksPane.vue'
import ArtistCatalogPane from './ArtistCatalogPane.vue'
import ArtistIdentityHeader from './ArtistIdentityHeader.vue'
import BiographyPane from './BiographyPane.vue'
import DecodePathPane from './DecodePathPane.vue'
import FormatPane from './FormatPane.vue'
import LoudnessPane from './LoudnessPane.vue'
import NeighbourhoodPane from './NeighbourhoodPane.vue'
import RelationsPane from './RelationsPane.vue'
import TrailPane from './TrailPane.vue'
import UpNextPane from './UpNextPane.vue'
import { countOwnedRelations } from './relationRows'
import { createTunedeckRegistry } from './tunedeckPanes'
import { useArtistRelationsStore } from '@renderer/stores/artistRelations'
import { usePlaybackStore } from '@renderer/stores/playback'
import { usePlayHistoryStore } from '@renderer/stores/playHistory'
import { useQueueCommandsStore } from '@renderer/stores/queueCommands'
import { useRelatedStore } from '@renderer/stores/related'

/**
 * The one file a new tab or group touches.
 *
 * Split from `tunedeckPanes.ts` so that the rules — no blank id, no duplicate
 * id, no empty tab, order preserved — can be tested under a Vitest that has no
 * Vue plugin and therefore cannot import a `.vue` file at all. This half exists
 * to name the components; that half exists to check them.
 *
 * A registry rather than side-effecting registration calls, because an import
 * whose only purpose is a side effect is an import a bundler is entitled to
 * drop. A pane that vanished from a production build and not a dev one would be
 * a bad afternoon.
 *
 * ## Why four tabs rather than one stack
 *
 * The deck shipped a pane per card and stacked them, which is an accumulation
 * and not an arrangement: four unrelated questions answered at once down a
 * 380px column, each with its own standing footnote. The split is by *subject*
 * — who made this, what is this file, what else is like it, what is happening —
 * because that is the axis an operator arrives on. D15 names five surfaces and
 * no arrangement for them, so this is filling a gap rather than reopening a
 * decision.
 *
 * Within a tab exactly one group is open at a time (see `resolveGroupId`).
 * That is what buys back the vertical space the tab bar costs, and it is why
 * every group carries a `badge`: a shut group has to be able to say whether it
 * is worth opening.
 *
 * ## Where the helper text went
 *
 * Every `hint` below was a permanent line of grey text under a list. They are
 * statements about a *feature* — what the queue does on quit, what a
 * double-click means, how much to trust a genre match — which is to say they
 * are read once and then re-read on every render forever. On the header, behind
 * a tooltip, they are available where the question is asked and silent
 * otherwise. Empty states did not move: when one of those shows it is the whole
 * of the pane's content, so it is the answer rather than a caption on one.
 *
 * ## Stores at module scope
 *
 * The `badge` and `action` thunks call `use*Store()` inside the arrow rather
 * than beside it.
 * This module is imported while the app is being constructed, which is before
 * Pinia is installed; the thunks run during render, which is after. Hoisting
 * one of these calls out of its closure is an "no active Pinia" crash on boot.
 */

const ARTIST_STRANDS: readonly RelatedStrand[] = ['artist-albums', 'compilations']
const ALBUM_STRANDS: readonly RelatedStrand[] = ['album-tracks']

/** Shared by the three groups that draw relations — one verb, said once each. */
const ENQUEUE_HINT =
  'Double-click adds to the end of the queue. Nothing here interrupts what is playing.'

export const tunedeckRegistry = createTunedeckRegistry([
  // First, because it is the widest question and the one the deck grows into:
  // M7's biography, relations, images and links all land as further groups
  // here, above a catalog half that already works offline.
  {
    id: 'artist',
    title: 'Artist',
    icon: 'i-tabler-microphone-2',
    // R5's correction affordance, and the only thing in the deck outside a
    // collapsible group. A wrong identity has to be visible and correctable
    // while the panes below it are asserting things about the wrong artist —
    // which is a statement about *position*, not about which group is open.
    header: ArtistIdentityHeader,
    groups: [
      // First, and therefore the group the tab opens on: it is the one that
      // answers "who is this" in words. The catalog below it answers the same
      // question in track listings and is the half that works with lookups
      // declined, which is why it is the one that keeps working rather than the
      // one that comes first.
      {
        id: 'artist-biography',
        title: 'Biography',
        icon: 'i-tabler-book',
        hint: 'From Wikipedia, by way of the artist’s MusicBrainz identity. Fetched only while the deck is open, and only with online lookups turned on.',
        component: BiographyPane
      },
      // Second, and above the catalog for the same reason the biography is: it
      // is the half that answers "who is this" with something the library alone
      // could not say. The badge counts what you *own* rather than what
      // MusicBrainz knows, which is the only number worth putting on a shut
      // group here — see `countOwnedRelations`.
      //
      // "Members" rather than "Connections", which is what it was called first.
      // The generic word was accurate and told an operator nothing: the group
      // leads with a line-up, the sections under it are all bands by another
      // name, and the id stays `artist-relations` because that is still what the
      // data is. A heading names what you are about to read, not the shape of
      // the query behind it.
      {
        id: 'artist-relations',
        title: 'Members',
        icon: 'i-tabler-users',
        hint: 'Line-ups, bands, side projects and collaborations from MusicBrainz, matched against your library. Double-click an artist you own to open them. A match made on the name alone is marked, because two artists can share one.',
        badge: () => countOwnedRelations(useArtistRelationsStore().result),
        component: RelationsPane
      },
      {
        id: 'artist-catalog',
        title: 'In your library',
        icon: 'i-tabler-library',
        hint: ENQUEUE_HINT,
        badge: () => countRelatedRows(useRelatedStore().result, ARTIST_STRANDS),
        component: ArtistCatalogPane
      }
    ]
  },
  {
    id: 'track',
    title: 'Track',
    icon: 'i-tabler-wave-sine',
    groups: [
      // In descending order of how often they are looked at.
      {
        id: 'format',
        title: 'Format',
        icon: 'i-tabler-file-music',
        component: FormatPane
      },
      {
        id: 'loudness',
        title: 'ReplayGain',
        icon: 'i-tabler-adjustments-alt',
        hint: 'What is being applied right now, which is not always what is selected — album mode on a track with only a track gain falls back.',
        component: LoudnessPane
      },
      {
        id: 'decode',
        title: 'Decode path',
        icon: 'i-tabler-cpu',
        hint: 'Whether this track was decoded into memory or streamed past the cap. A streamed track cannot be gapless.',
        component: DecodePathPane
      }
    ]
  },
  {
    id: 'related',
    title: 'Related',
    icon: 'i-tabler-affiliate',
    groups: [
      // The catalog strand first and alone: it is derived from identity, and
      // the three below it are derived from coincidence. Two groups rather than
      // one list with a divider in it is the same distinction the divider was
      // making, drawn by the structure instead of by a row of grey text.
      {
        id: 'related-album',
        title: 'On this album',
        icon: 'i-tabler-disc',
        hint: ENQUEUE_HINT,
        badge: () => countRelatedRows(useRelatedStore().result, ALBUM_STRANDS),
        component: AlbumTracksPane
      },
      {
        id: 'related-neighbourhood',
        title: 'Looser connections',
        icon: 'i-tabler-tag',
        hint: `Matched on a shared genre, year or folder rather than on a credit, so any of the three can be a coincidence. ${ENQUEUE_HINT}`,
        badge: () => countRelatedRows(useRelatedStore().result, NEIGHBOURHOOD_STRANDS),
        component: NeighbourhoodPane
      }
    ]
  },
  // Last, and outside the reading of the three above it. Artist, track and
  // related are all about the library; this one is about the session — what
  // will play and what did.
  {
    id: 'playing',
    title: 'Playing',
    icon: 'i-tabler-player-play',
    groups: [
      {
        id: 'up-next',
        title: 'Up next',
        icon: 'i-tabler-playlist',
        hint: 'The queue empties when Fermata quits. Drag a row to reorder it; double-click to jump to it.',
        badge: () => {
          const queued = usePlaybackStore().queuedCount
          return queued === 0 ? null : queued.toLocaleString()
        },
        // Clears the hand-queued rows and not the scope. The session tier is
        // not the operator's to lose — it comes back on the next click, so a
        // Clear that wiped it would be a button that undoes nothing it did.
        // Which is also why this is gated on `queuedUserCount` while the badge
        // above counts both tiers.
        action: {
          label: 'Clear the queue',
          icon: 'i-tabler-eraser',
          available: () => usePlaybackStore().queuedUserCount > 0,
          run: () => useQueueCommandsStore().clearUser()
        },
        component: UpNextPane
      },
      {
        id: 'trail',
        title: 'Trail',
        icon: 'i-tabler-history',
        hint: `Double-click to play a track again — it cuts in, then playback resumes where it was. The last ${PLAY_HISTORY_CAP.toLocaleString()} plays are kept.`,
        badge: () => {
          const played = usePlayHistoryStore().entries.length
          return played === 0 ? null : played.toLocaleString()
        },
        // A record of what someone listened to is theirs to drop. Nothing else
        // in the app reads this table, so erasing it costs no other feature
        // anything — which is also the argument for it being out of D11's
        // bundle.
        action: {
          label: 'Clear the trail',
          icon: 'i-tabler-eraser',
          available: () => usePlayHistoryStore().entries.length > 0,
          run: () => void usePlayHistoryStore().clear()
        },
        component: TrailPane
      }
    ]
  }
])
