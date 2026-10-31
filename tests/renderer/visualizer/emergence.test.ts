import { describe, expect, it } from 'vitest'
import {
  createEmergence,
  EMERGENCE_SEC,
  PAUSE_HOLD_SEC
} from '../../../src/renderer/visualizer/emergence'

const DT = 1 / 60

function run(emergence: ReturnType<typeof createEmergence>, playing: boolean, seconds: number) {
  for (let t = 0; t < seconds; t += DT) emergence.update(playing, DT)
}

describe('createEmergence', () => {
  it('starts at rest, at the wash', () => {
    const emergence = createEmergence()
    expect(emergence.value).toBe(0)
    expect(emergence.atRest).toBe(true)
  })

  it('grows to 1 over EMERGENCE_SEC while playing', () => {
    const emergence = createEmergence()
    run(emergence, true, EMERGENCE_SEC / 2)
    expect(emergence.value).toBeGreaterThan(0.3)
    expect(emergence.value).toBeLessThan(0.7)
    expect(emergence.atRest).toBe(false)
    run(emergence, true, EMERGENCE_SEC)
    expect(emergence.value).toBe(1)
  })

  it('holds through a short pause and then settles back to rest', () => {
    const emergence = createEmergence()
    run(emergence, true, EMERGENCE_SEC + 0.1)
    run(emergence, false, PAUSE_HOLD_SEC - 0.2)
    expect(emergence.value).toBe(1)
    expect(emergence.atRest).toBe(false)
    run(emergence, false, 0.2 + EMERGENCE_SEC + 0.1)
    expect(emergence.value).toBe(0)
    expect(emergence.atRest).toBe(true)
  })

  it('does not grow while paused, even inside the hold', () => {
    const emergence = createEmergence()
    run(emergence, true, EMERGENCE_SEC / 4)
    const held = emergence.value
    run(emergence, false, 1)
    expect(emergence.value).toBe(held)
  })

  it('resumes growing on resume', () => {
    const emergence = createEmergence()
    run(emergence, true, EMERGENCE_SEC + 0.1)
    run(emergence, false, PAUSE_HOLD_SEC + EMERGENCE_SEC + 0.1)
    expect(emergence.atRest).toBe(true)
    emergence.update(true, DT)
    expect(emergence.atRest).toBe(false)
    expect(emergence.value).toBeGreaterThan(0)
  })

  it('clamps a stall to the frame cap rather than jumping', () => {
    const emergence = createEmergence()
    emergence.update(true, 5)
    expect(emergence.value).toBeLessThan(0.1)
  })
})
