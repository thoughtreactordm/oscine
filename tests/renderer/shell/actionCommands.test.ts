import { describe, expect, it, vi } from 'vitest'
import {
  buildActionCommands,
  type ActionCommandDeps
} from '../../../src/renderer/shell/actionCommands'
import { matchCommands } from '../../../src/renderer/shell/commandRegistry'

/**
 * The Actions group, D21's `>` mode. Global transport verbs, each an existing
 * playback-store method (product rule 5). The contract worth pinning is D22's:
 * a command dispatches to the store, toasts, and dismisses — tested here with
 * fakes rather than a store, because the module holds neither Pinia nor a DOM.
 */

function deps(overrides: Partial<ActionCommandDeps> = {}): ActionCommandDeps {
  return {
    toggle: vi.fn(),
    next: vi.fn(),
    previous: vi.fn(),
    toggleShuffle: vi.fn(),
    cycleRepeat: vi.fn(),
    clearQueue: vi.fn(),
    notify: vi.fn(),
    close: vi.fn(),
    ...overrides
  }
}

function command(commands: ReturnType<typeof buildActionCommands>, id: string) {
  const found = commands.find((c) => c.id === id)
  if (!found) throw new Error(`no command ${id}`)
  return found
}

describe('buildActionCommands', () => {
  it('offers the transport and queue verbs, each with a keyword set', () => {
    const commands = buildActionCommands(deps())
    expect(commands.map((c) => c.id)).toEqual([
      'action:playPause',
      'action:next',
      'action:previous',
      'action:shuffle',
      'action:repeat',
      'action:clearQueue'
    ])
    for (const c of commands) expect(c.keywords.length).toBeGreaterThan(0)
  })

  it('dispatches to the right store verb, then toasts and closes', async () => {
    const d = deps()
    const commands = buildActionCommands(d)

    await command(commands, 'action:next').run()

    expect(d.next).toHaveBeenCalledOnce()
    expect(d.notify).toHaveBeenCalledOnce()
    expect(d.close).toHaveBeenCalledOnce()
    // No collateral: skipping is not clearing.
    expect(d.clearQueue).not.toHaveBeenCalled()
  })

  it('clears the queue through the queue verb', async () => {
    const d = deps()
    await command(buildActionCommands(d), 'action:clearQueue').run()
    expect(d.clearQueue).toHaveBeenCalledOnce()
    expect(d.close).toHaveBeenCalledOnce()
  })

  it('awaits the async transport verbs before confirming', async () => {
    const order: string[] = []
    const d = deps({
      toggle: vi.fn(async () => {
        order.push('toggle')
      }),
      notify: vi.fn(() => order.push('notify'))
    })
    await command(buildActionCommands(d), 'action:playPause').run()
    expect(order).toEqual(['toggle', 'notify'])
  })
})

describe('matchCommands over the Actions group', () => {
  const commands = buildActionCommands(deps())

  it('returns every command for empty text', () => {
    expect(matchCommands(commands, '')).toHaveLength(commands.length)
  })

  it('matches a keyword the label does not contain', () => {
    // "random" is a keyword of Toggle shuffle; the label says neither.
    expect(matchCommands(commands, 'random').map((c) => c.id)).toEqual(['action:shuffle'])
  })

  it('matches on the label too', () => {
    expect(matchCommands(commands, 'previous').map((c) => c.id)).toEqual(['action:previous'])
  })
})
