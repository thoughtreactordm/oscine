import { beforeEach, describe, expect, it } from 'vitest'
import type { PresenceSignal } from '@shared/presence'
import type { SettingsChange } from '@shared/settings'
import type { DiscordSettings } from '@shared/settings/discord'
import type {
  DiscordActivity,
  DiscordClient,
  DiscordConnectionState
} from '../../../src/main/discord/client'
import { createPresenceService, PRESENCE_MIN_INTERVAL_MS } from '../../../src/main/discord/service'

/** A fake `DiscordClient` that records what it was driven to do. */
function fakeClient() {
  const activities: (DiscordActivity | null)[] = []
  const counts = { started: 0, closed: 0 }
  const client: DiscordClient = {
    start: () => {
      counts.started += 1
    },
    setActivity: (activity) => {
      activities.push(activity)
    },
    getState: (): DiscordConnectionState => 'connected',
    close: () => {
      counts.closed += 1
    }
  }
  return { client, activities, counts }
}

/** A controllable clock + timer queue, so the throttle is exercised without real time. */
function clockHarness(start = 1_000_000) {
  let clock = start
  let nextId = 1
  const timers = new Map<number, { at: number; fire: () => void }>()
  return {
    now: () => clock,
    setTimeout: (fire: () => void, ms: number) => {
      const id = nextId++
      timers.set(id, { at: clock + ms, fire })
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clearTimeout: (handle: ReturnType<typeof setTimeout>) => {
      timers.delete(handle as unknown as number)
    },
    advance(ms: number) {
      clock += ms
      const due = [...timers.entries()]
        .filter(([, t]) => t.at <= clock)
        .sort((a, b) => a[1].at - b[1].at)
      for (const [id, t] of due) {
        timers.delete(id)
        t.fire()
      }
    }
  }
}

const TRACK = { title: 'Teardrop', artist: 'Massive Attack', durationMs: 330_000 }

function playing(positionMs = 30_000, overrides: Partial<PresenceSignal> = {}): PresenceSignal {
  return { track: TRACK, positionMs, paused: false, playing: true, ...overrides }
}

const STOPPED: PresenceSignal = { track: null, positionMs: 0, paused: false, playing: false }

function changed(...keys: string[]): SettingsChange[] {
  return keys.map((key) => ({ key })) as unknown as SettingsChange[]
}

type MutableSettings = { -readonly [K in keyof DiscordSettings]: DiscordSettings[K] }
let settings: MutableSettings
function setup() {
  const clock = clockHarness()
  const { client, activities, counts } = fakeClient()
  const service = createPresenceService({
    client,
    settings: () => settings,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  })
  return { service, activities, counts, clock }
}

beforeEach(() => {
  settings = { enabled: true, display: 'title-artist', showTimestamp: true, whenPaused: 'paused' }
})

describe('presence service — enable gate', () => {
  it('never starts the client or sends anything while disabled', () => {
    settings.enabled = false
    const { service, activities, counts } = setup()
    service.update(playing())
    expect(counts.started).toBe(0)
    expect(activities).toHaveLength(0)
  })

  it('does not connect merely to clear — a first stopped signal starts nothing', () => {
    const { service, activities, counts } = setup()
    service.update(STOPPED)
    expect(counts.started).toBe(0)
    expect(activities).toHaveLength(0)
  })

  it('connects and sends on the first thing worth showing', () => {
    const { service, activities, counts } = setup()
    service.update(playing())
    expect(counts.started).toBe(1)
    expect(activities).toHaveLength(1)
    expect(activities[0]?.details).toBe('Teardrop')
  })
})

describe('presence service — dedupe', () => {
  it('does not resend an identical activity', () => {
    const { service, activities } = setup()
    service.update(playing(30_000))
    service.update(playing(30_000))
    expect(activities).toHaveLength(1)
  })

  it('a steady heartbeat on an unchanged track does not spam SET_ACTIVITY', () => {
    const { service, activities, clock } = setup()
    service.update(playing(30_000))
    // 15s later, 15s further into the track: same start/end anchor -> deduped.
    clock.advance(PRESENCE_MIN_INTERVAL_MS)
    service.update(playing(45_000))
    expect(activities).toHaveLength(1)
  })
})

describe('presence service — throttle', () => {
  it('coalesces a burst to the leading send plus one trailing latest', () => {
    const { service, activities, clock } = setup()
    service.update(playing(10_000, { track: { ...TRACK, title: 'A' } }))
    clock.advance(1_000)
    service.update(playing(11_000, { track: { ...TRACK, title: 'B' } }))
    service.update(playing(12_000, { track: { ...TRACK, title: 'C' } }))
    // Only the leading 'A' has gone out; 'B'/'C' are coalesced behind the timer.
    expect(activities).toHaveLength(1)
    expect(activities[0]?.details).toBe('A')
    clock.advance(PRESENCE_MIN_INTERVAL_MS - 1_000)
    // The trailing send is the latest, not every intermediate one.
    expect(activities).toHaveLength(2)
    expect(activities[1]?.details).toBe('C')
  })
})

describe('presence service — clears', () => {
  it('clears immediately and closes the socket when disabled live', () => {
    const { service, activities, counts } = setup()
    service.update(playing())
    expect(counts.started).toBe(1)
    settings.enabled = false
    service.onSettingsChanged(changed('discord.enabled'))
    expect(counts.closed).toBe(1)
    // Re-enabling starts a fresh connection on the next worth-showing signal.
    settings.enabled = true
    service.update(playing())
    expect(counts.started).toBe(2)
    expect(activities.length).toBeGreaterThanOrEqual(2)
  })

  it('clears the card when whenPaused is hide', () => {
    settings.whenPaused = 'hide'
    const { service, activities, clock } = setup()
    service.update(playing())
    clock.advance(PRESENCE_MIN_INTERVAL_MS)
    service.update(playing(35_000, { paused: true }))
    expect(activities).toHaveLength(2)
    expect(activities[1]).toBeNull()
  })

  it('shows a Paused card with no timestamps when whenPaused is paused', () => {
    settings.whenPaused = 'paused'
    const { service, activities, clock } = setup()
    service.update(playing())
    clock.advance(PRESENCE_MIN_INTERVAL_MS)
    service.update(playing(35_000, { paused: true }))
    expect(activities).toHaveLength(2)
    expect(activities[1]?.state).toBe('Paused')
    expect(activities[1]?.timestamps).toBeUndefined()
  })

  it('clears and disconnects on stop (quit), cancelling any pending send', () => {
    const { service, activities, counts, clock } = setup()
    service.update(playing(10_000, { track: { ...TRACK, title: 'A' } }))
    clock.advance(1_000)
    service.update(playing(11_000, { track: { ...TRACK, title: 'B' } })) // queued behind the timer
    service.stop()
    expect(counts.closed).toBe(1)
    // The queued 'B' must not fire after teardown.
    clock.advance(PRESENCE_MIN_INTERVAL_MS)
    expect(activities).toHaveLength(1)
  })
})

describe('presence service — live settings', () => {
  it('re-derives on a display change without waiting for the next track', () => {
    const { service, activities, clock } = setup()
    service.update(playing())
    expect(activities[0]?.state).toBe('Massive Attack')
    clock.advance(PRESENCE_MIN_INTERVAL_MS)
    settings.display = 'title-only'
    service.onSettingsChanged(changed('discord.display'))
    expect(activities).toHaveLength(2)
    expect(activities[1]?.state).toBeUndefined()
  })

  it('ignores changes to non-discord settings', () => {
    const { service, activities } = setup()
    service.update(playing())
    service.onSettingsChanged(changed('audio.replayGain', 'interface.density'))
    expect(activities).toHaveLength(1)
  })

  it('takes a live card down even before any track has played', () => {
    const { service, counts } = setup()
    service.update(playing())
    expect(counts.started).toBe(1)
    settings.enabled = false
    service.onSettingsChanged(changed('discord.enabled'))
    expect(counts.closed).toBe(1)
  })
})
