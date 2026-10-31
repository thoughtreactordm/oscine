import type { Command } from './commandRegistry'

/**
 * The visualizer's Command Palette entries — W23-6, D35.5, through W13's
 * command surface. They ride the Actions group beside Zen.
 *
 * Toggle, next and previous call the same verbs as the stage button and the
 * shortcuts (the visualizer store), and there is one entry per *available*
 * effect. Unlike the shortcuts they are not stage-only: the palette is an
 * explicit, named request, so from another tab they set what the stage will
 * show when the operator gets there, the way a setting command would.
 *
 * Holds no `@renderer` import and no Pinia — the verbs arrive as `deps`, so the
 * tests drive it with fakes.
 */

export interface VisualizerCommandDeps {
  /** The effects that can run this session, in registry order. */
  effects: readonly { readonly id: string; readonly label: string }[]
  toggle: () => void
  next: () => void
  previous: () => void
  select: (id: string) => void
  /** The D22 confirmation toast. */
  notify: (message: string) => void
  /** Dismiss the palette. */
  close: () => void
}

const KEYWORDS = ['visualizer', 'visualiser', 'visualisation', 'effect', 'spectrum']

export function buildVisualizerCommands(deps: VisualizerCommandDeps): Command[] {
  const finish = (message: string): void => {
    deps.notify(message)
    deps.close()
  }

  return [
    {
      id: 'visualizer:toggle',
      label: 'Toggle visualizer',
      icon: 'i-tabler-chart-bar',
      keywords: [...KEYWORDS, 'toggle', 'show', 'hide', 'now playing'],
      run: () => {
        deps.toggle()
        finish('Toggled the visualizer')
      }
    },
    {
      id: 'visualizer:next',
      label: 'Next visualizer',
      icon: 'i-tabler-chevron-right',
      keywords: [...KEYWORDS, 'next', 'cycle'],
      run: () => {
        deps.next()
        finish('Next visualizer')
      }
    },
    {
      id: 'visualizer:previous',
      label: 'Previous visualizer',
      icon: 'i-tabler-chevron-left',
      keywords: [...KEYWORDS, 'previous', 'prev', 'back'],
      run: () => {
        deps.previous()
        finish('Previous visualizer')
      }
    },
    ...deps.effects.map((effect): Command => ({
      id: `visualizer:effect:${effect.id}`,
      label: `Visualizer: ${effect.label}`,
      icon: 'i-tabler-chart-bar',
      keywords: [...KEYWORDS, effect.label.toLowerCase()],
      run: () => {
        deps.select(effect.id)
        finish(`Visualizer: ${effect.label}`)
      }
    }))
  ]
}
