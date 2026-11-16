import type { Command } from './commandRegistry'
import { measureOutcomeMessage, type MeasureOutcome } from '../replaygain/measureModel'

/**
 * W25-1's palette entry: "Measure missing ReplayGain".
 *
 * An Actions verb, like the onboarding re-run, and pure and injected like the
 * other builders — `measure` is the store's, which resumes a paused or
 * cancelled job and otherwise starts one, so the palette never trips main's
 * "resume instead of starting another" refusal. The command closes the palette
 * first and then owns its toast (D22): the outcome on success, main's own
 * reason when the gate refuses.
 */

export interface ReplayGainCommandDeps {
  measure: () => Promise<MeasureOutcome>
  notify: (message: string) => void
  fail: (title: string, detail: string) => void
  close: () => void
}

export function buildReplayGainCommands(deps: ReplayGainCommandDeps): Command[] {
  return [
    {
      id: 'replayGain.measure',
      label: 'Measure missing ReplayGain',
      icon: 'i-tabler-wave-sine',
      keywords: ['replaygain', 'loudness', 'normalisation', 'normalization', 'analyze', 'measure'],
      run: async () => {
        deps.close()
        try {
          deps.notify(measureOutcomeMessage(await deps.measure()))
        } catch (error) {
          deps.fail('ReplayGain could not be measured', (error as Error).message)
        }
      }
    }
  ]
}
