import { describe, expect, it } from 'vitest'
import {
  armedIntervalMs,
  idleStep,
  type IdleAutoShowGate
} from '../../../src/renderer/shell/idleAutoShow'

/**
 * The idle auto-show's decisions, G4. Both are behaviour `useIdleAutoShow` can
 * only wire, not decide: the three-way arming gate and the trailing timer's
 * fire-or-wait step, kept pure so the countdown can be reasoned about without a
 * `window`, a timer or Pinia.
 */

function gate(over: Partial<IdleAutoShowGate>): IdleAutoShowGate {
  return { interval: '5', playing: true, onNowPlaying: false, ...over }
}

describe('armedIntervalMs', () => {
  it('arms at the chosen interval, in milliseconds', () => {
    expect(armedIntervalMs(gate({ interval: '5' }))).toBe(5 * 60_000)
    expect(armedIntervalMs(gate({ interval: '10' }))).toBe(10 * 60_000)
    expect(armedIntervalMs(gate({ interval: '15' }))).toBe(15 * 60_000)
    expect(armedIntervalMs(gate({ interval: '30' }))).toBe(30 * 60_000)
    expect(armedIntervalMs(gate({ interval: '60' }))).toBe(60 * 60_000)
  })

  it('stands down when off — the default', () => {
    expect(armedIntervalMs(gate({ interval: 'off' }))).toBe(0)
  })

  it('stands down while nothing is playing', () => {
    // The whole feature is scoped to background playback; a paused or stopped
    // transport has no reason to pull the frame anywhere.
    expect(armedIntervalMs(gate({ playing: false }))).toBe(0)
  })

  it('stands down when Now Playing is already the view', () => {
    // Nothing to reveal, and arming here would re-fire the moment it landed.
    expect(armedIntervalMs(gate({ onNowPlaying: true }))).toBe(0)
  })
})

describe('idleStep', () => {
  it('reveals once the quiet span reaches the interval', () => {
    expect(idleStep(5 * 60_000, 5 * 60_000)).toEqual({ reveal: true, nextDelayMs: 0 })
    expect(idleStep(6 * 60_000, 5 * 60_000)).toEqual({ reveal: true, nextDelayMs: 0 })
  })

  it('waits out only the remaining span when interaction was more recent', () => {
    // An interaction two minutes into a five-minute wait leaves three to go —
    // the timer reschedules for exactly that rather than resetting the whole
    // interval, which is what a per-event reset would cost.
    expect(idleStep(2 * 60_000, 5 * 60_000)).toEqual({ reveal: false, nextDelayMs: 3 * 60_000 })
  })
})
