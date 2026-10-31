import { describe, expect, it, vi } from 'vitest'
import {
  buildVisualizerCommands,
  type VisualizerCommandDeps
} from '../../../src/renderer/shell/visualizerCommands'
import { matchCommands } from '../../../src/renderer/shell/commandRegistry'

/** W23-6: the visualizer's palette entries dispatch, toast and dismiss (D22). */

function deps(overrides: Partial<VisualizerCommandDeps> = {}): VisualizerCommandDeps {
  return {
    effects: [
      { id: 'bars', label: 'Bars' },
      { id: 'drift', label: 'Drift' }
    ],
    toggle: vi.fn(),
    next: vi.fn(),
    previous: vi.fn(),
    select: vi.fn(),
    notify: vi.fn(),
    close: vi.fn(),
    ...overrides
  }
}

describe('buildVisualizerCommands', () => {
  it('offers toggle, next, previous and one entry per available effect', () => {
    const commands = buildVisualizerCommands(deps())
    expect(commands.map((c) => c.label)).toEqual([
      'Toggle visualizer',
      'Next visualizer',
      'Previous visualizer',
      'Visualizer: Bars',
      'Visualizer: Drift'
    ])
    expect(new Set(commands.map((c) => c.id)).size).toBe(commands.length)
  })

  it('dispatches each verb, then toasts and closes', () => {
    const d = deps()
    const commands = buildVisualizerCommands(d)
    for (const c of commands) void c.run()
    expect(d.toggle).toHaveBeenCalledOnce()
    expect(d.next).toHaveBeenCalledOnce()
    expect(d.previous).toHaveBeenCalledOnce()
    expect(d.select).toHaveBeenNthCalledWith(1, 'bars')
    expect(d.select).toHaveBeenNthCalledWith(2, 'drift')
    expect(d.notify).toHaveBeenCalledTimes(commands.length)
    expect(d.close).toHaveBeenCalledTimes(commands.length)
  })

  it('is found by "visualizer" and by an effect name', () => {
    const commands = buildVisualizerCommands(deps())
    expect(matchCommands(commands, 'visualizer')).toHaveLength(5)
    expect(matchCommands(commands, 'drift').map((c) => c.id)).toEqual(['visualizer:effect:drift'])
  })
})
