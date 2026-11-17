import { describe, expect, it, vi } from 'vitest'
import { buildToolCommands, type ToolCommandDeps } from '../../../src/renderer/shell/toolCommands'
import { matchCommands } from '../../../src/renderer/shell/commandRegistry'

/** Palette entries for each tool and each saved EQ preset. */

function deps(overrides: Partial<ToolCommandDeps> = {}): ToolCommandDeps {
  return {
    tools: [
      { id: 'tag-writeback', label: 'Tag write-back', icon: 'i-a' },
      { id: 'equalizer', label: 'Equalizer', icon: 'i-b' }
    ],
    presets: [
      { id: 'p1', name: 'Car' },
      { id: 'p2', name: 'Late night' }
    ],
    equalizerEnabled: false,
    openTool: vi.fn(),
    switchPreset: vi.fn(),
    toggleEqualizer: vi.fn(),
    notify: vi.fn(),
    close: vi.fn(),
    ...overrides
  }
}

describe('buildToolCommands', () => {
  it('offers one open per tool, the EQ switch, then one entry per preset', () => {
    const commands = buildToolCommands(deps())
    expect(commands.map((c) => c.label)).toEqual([
      'Open Tag write-back',
      'Open Equalizer',
      'Turn equalizer on',
      'Equalizer: Car',
      'Equalizer: Late night'
    ])
    expect(new Set(commands.map((c) => c.id)).size).toBe(commands.length)
  })

  it('opens a tool and closes without a toast', () => {
    const d = deps()
    const open = buildToolCommands(d).find((c) => c.id === 'tool:open:equalizer')
    void open?.run()
    expect(d.openTool).toHaveBeenCalledWith('equalizer')
    expect(d.close).toHaveBeenCalledOnce()
    expect(d.notify).not.toHaveBeenCalled()
  })

  it('switches preset, toasts and closes', () => {
    const d = deps()
    void buildToolCommands(d)
      .find((c) => c.id === 'equalizer:preset:p2')
      ?.run()
    expect(d.switchPreset).toHaveBeenCalledWith('p2')
    expect(d.notify).toHaveBeenCalledWith('Equalizer: Late night')
    expect(d.close).toHaveBeenCalledOnce()
  })

  it('labels and toasts the toggle by the current state', () => {
    const d = deps({ equalizerEnabled: true })
    const toggle = buildToolCommands(d).find((c) => c.id === 'equalizer:toggle')
    expect(toggle?.label).toBe('Turn equalizer off')
    void toggle?.run()
    expect(d.toggleEqualizer).toHaveBeenCalledOnce()
    expect(d.notify).toHaveBeenCalledWith('Equalizer off')
  })

  it('is found by "eq" and by a preset name', () => {
    const commands = buildToolCommands(deps())
    expect(matchCommands(commands, 'eq').map((c) => c.id)).toEqual([
      'tool:open:equalizer',
      'equalizer:toggle',
      'equalizer:preset:p1',
      'equalizer:preset:p2'
    ])
    expect(matchCommands(commands, 'late').map((c) => c.id)).toEqual(['equalizer:preset:p2'])
  })
})
