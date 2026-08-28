import type { Command } from './commandRegistry'

/**
 * The Actions group — D21's `>` mode, and the transport half of the registry.
 *
 * Global verbs only. Play/pause, skip and the queue reset act on whatever is
 * playing, so they need no entity and belong here; the entity-scoped verbs —
 * play *this* album, *this* track — ride the search hits themselves in
 * `paletteActivation`, not this list. Every verb is an existing playback-store
 * method (product rule 5: no second play-order builder), so this module only
 * names them, gives each a keyword set and a confirming toast (D22), and closes
 * the palette on dispatch. It holds no `@renderer` import and no Pinia — the
 * store verbs, the toast and the dismissal arrive as `deps`, which is what lets
 * the tests drive it with fakes.
 */

export interface ActionCommandDeps {
  /** Resume if paused, pause if playing. */
  toggle: () => void | Promise<void>
  next: () => void | Promise<void>
  previous: () => void | Promise<void>
  toggleShuffle: () => void | Promise<void>
  cycleRepeat: () => void
  /** Clears both tiers of the up-next queue. */
  clearQueue: () => void
  /** Enters or leaves Zen / Kiosk mode. */
  toggleZen: () => void
  /** The D22 confirmation toast. */
  notify: (message: string) => void
  /** Dismiss the palette — D22, an action dispatches and the modal is gone. */
  close: () => void
}

export function buildActionCommands(deps: ActionCommandDeps): Command[] {
  /** Every action ends the same way: confirm, then dismiss. */
  const finish = (message: string): void => {
    deps.notify(message)
    deps.close()
  }

  return [
    {
      id: 'action:playPause',
      label: 'Play / Pause',
      icon: 'i-tabler-player-play',
      keywords: ['play', 'pause', 'resume', 'toggle', 'stop'],
      run: async () => {
        await deps.toggle()
        finish('Toggled playback')
      }
    },
    {
      id: 'action:next',
      label: 'Next track',
      icon: 'i-tabler-player-track-next',
      keywords: ['next', 'skip', 'forward'],
      run: async () => {
        await deps.next()
        finish('Skipped to the next track')
      }
    },
    {
      id: 'action:previous',
      label: 'Previous track',
      icon: 'i-tabler-player-track-prev',
      keywords: ['previous', 'back', 'prev'],
      run: async () => {
        await deps.previous()
        finish('Went to the previous track')
      }
    },
    {
      id: 'action:shuffle',
      label: 'Toggle shuffle',
      icon: 'i-tabler-arrows-shuffle',
      keywords: ['shuffle', 'random'],
      run: async () => {
        await deps.toggleShuffle()
        finish('Toggled shuffle')
      }
    },
    {
      id: 'action:repeat',
      label: 'Cycle repeat',
      icon: 'i-tabler-repeat',
      keywords: ['repeat', 'loop'],
      run: () => {
        deps.cycleRepeat()
        finish('Cycled the repeat mode')
      }
    },
    {
      id: 'action:clearQueue',
      label: 'Clear queue',
      icon: 'i-tabler-playlist-x',
      keywords: ['clear', 'queue', 'empty', 'reset'],
      run: () => {
        deps.clearQueue()
        finish('Cleared the queue')
      }
    },
    {
      id: 'action:zenMode',
      label: 'Toggle Zen mode',
      icon: 'i-tabler-focus-2',
      keywords: ['zen', 'kiosk', 'fullscreen', 'minimal', 'tv', 'focus', 'display'],
      run: () => {
        deps.toggleZen()
        finish('Toggled Zen mode')
      }
    }
  ]
}
