import RelatedPane from './RelatedPane.vue'
import SignalPane from './SignalPane.vue'
import TrailPane from './TrailPane.vue'
import UpNextPane from './UpNextPane.vue'
import { createTunedeckRegistry } from './tunedeckPanes'

/**
 * The one file a new pane touches.
 *
 * Split from `tunedeckPanes.ts` so that the rules — no blank id, no duplicate
 * id, order preserved — can be tested under a Vitest that has no Vue plugin and
 * therefore cannot import a `.vue` file at all. This half exists to name the
 * components; that half exists to check them.
 *
 * A registry rather than side-effecting registration calls, because an import
 * whose only purpose is a side effect is an import a bundler is entitled to
 * drop. A pane that vanished from a production build and not a dev one would be
 * a bad afternoon.
 *
 * `DeckIntroPane` is gone, deleted rather than grown into: it existed to prove
 * the seam with a component that imported nothing at all, and W7-1 said the
 * first real pane should remove it. Adding this one changed this file and no
 * other, which is what the seam was for.
 */
export const tunedeckRegistry = createTunedeckRegistry([
  {
    id: 'up-next',
    title: 'Up next',
    icon: 'i-tabler-playlist',
    component: UpNextPane
  },
  {
    id: 'signal',
    title: 'Signal',
    icon: 'i-tabler-wave-sine',
    component: SignalPane
  },
  // After Signal rather than before it: the deck reads forwards from what is
  // about to play, through what is playing, to what already did.
  {
    id: 'trail',
    title: 'Trail',
    icon: 'i-tabler-history',
    component: TrailPane
  },
  // Last, and outside the forwards reading of the three above it. Up next,
  // signal and trail are all about *this* session — what will play, what is
  // playing, what did. Related is the one pane that looks away from the session
  // and back at the library, so it reads better as the thing after the sequence
  // than as an interruption inside it.
  {
    id: 'related',
    title: 'Related',
    icon: 'i-tabler-affiliate',
    component: RelatedPane
  }
])
