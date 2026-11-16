import { describe, expect, it, vi } from 'vitest'
import { matchCommands } from '../../../src/renderer/shell/commandRegistry'
import {
  buildReplayGainCommands,
  type ReplayGainCommandDeps
} from '../../../src/renderer/shell/replayGainCommands'

/**
 * W25-1's palette verb. Contract: it closes the palette, asks the store to
 * measure (which picks start or resume), and owns its toast — the outcome on
 * success, main's reason on refusal.
 */

function deps(overrides: Partial<ReplayGainCommandDeps> = {}): ReplayGainCommandDeps {
  return {
    measure: vi.fn(async () => ({ kind: 'started', total: 1204 }) as const),
    notify: vi.fn(),
    fail: vi.fn(),
    close: vi.fn(),
    ...overrides
  }
}

describe('buildReplayGainCommands', () => {
  it("offers the card's label, found by 'replaygain' and 'loudness'", () => {
    const commands = buildReplayGainCommands(deps())
    expect(commands.map((c) => c.label)).toEqual(['Measure missing ReplayGain'])
    expect(matchCommands(commands, 'replaygain')).toHaveLength(1)
    expect(matchCommands(commands, 'loudness')).toHaveLength(1)
    expect(matchCommands(commands, 'shuffle')).toHaveLength(0)
  })

  it('closes the palette, measures and toasts the outcome', async () => {
    const d = deps()
    await buildReplayGainCommands(d)[0].run()
    expect(d.close).toHaveBeenCalledOnce()
    expect(d.measure).toHaveBeenCalledOnce()
    expect(d.notify).toHaveBeenCalledWith('Measuring ReplayGain for 1,204 tracks')
    expect(d.fail).not.toHaveBeenCalled()
  })

  it("surfaces main's refusal rather than swallowing it", async () => {
    const d = deps({
      measure: vi.fn(async () => {
        throw new Error('Analyzing untagged tracks is turned off in audio settings.')
      })
    })
    await buildReplayGainCommands(d)[0].run()
    expect(d.notify).not.toHaveBeenCalled()
    expect(d.fail).toHaveBeenCalledWith(
      'ReplayGain could not be measured',
      'Analyzing untagged tracks is turned off in audio settings.'
    )
  })
})
