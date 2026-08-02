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
  }
])
