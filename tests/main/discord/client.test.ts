import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDiscordClient,
  DISCORD_HANDSHAKE_TIMEOUT_MS,
  DISCORD_RECONNECT_BASE_MS,
  DISCORD_RECONNECT_MAX_MS,
  type DiscordActivity,
  type DiscordClient,
  type DiscordConnectionState
} from '../../../src/main/discord/client'
import { DISCORD_OP, encodeFrame, type DecodedFrame } from '../../../src/main/discord/frames'
import type { DiscordSocket } from '../../../src/main/discord/transport'
import { FakeDiscordSocket } from './fakes'

/** A hand-driven timer queue: nothing fires until the test says so. */
class FakeClock {
  private readonly timers = new Map<number, { handler: () => void; delay: number }>()
  private nextId = 1

  readonly setTimeout = (handler: () => void, delay: number): ReturnType<typeof setTimeout> => {
    const id = this.nextId++
    this.timers.set(id, { handler, delay })
    return id as unknown as ReturnType<typeof setTimeout>
  }

  readonly clearTimeout = (handle: ReturnType<typeof setTimeout>): void => {
    this.timers.delete(handle as unknown as number)
  }

  get size(): number {
    return this.timers.size
  }

  pendingDelays(): number[] {
    return [...this.timers.values()].map((timer) => timer.delay)
  }

  /** Fire every timer pending right now; ones scheduled during the run stay. */
  runAll(): void {
    const snapshot = [...this.timers.values()]
    this.timers.clear()
    for (const timer of snapshot) timer.handler()
  }
}

/** Flush microtasks — the client `await`s its connector once per attempt. */
function settle(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0))
}

const READY = encodeFrame(DISCORD_OP.FRAME, { cmd: 'DISPATCH', evt: 'READY', data: {} })

function setSize(frames: DecodedFrame[]): DecodedFrame[] {
  return frames.filter(
    (frame) => (frame.payload as { cmd?: string } | undefined)?.cmd === 'SET_ACTIVITY'
  )
}

describe('Discord client lifecycle (W20-2)', () => {
  let clock: FakeClock
  let connect: ReturnType<
    typeof vi.fn<(candidates: readonly string[]) => Promise<DiscordSocket | null>>
  >
  let states: DiscordConnectionState[]
  let client: DiscordClient

  beforeEach(() => {
    clock = new FakeClock()
    connect = vi.fn<(candidates: readonly string[]) => Promise<DiscordSocket | null>>()
    states = []
    client = createDiscordClient({
      clientId: 'app-id',
      connect,
      candidates: () => ['/run/user/1000/discord-ipc-0'],
      pid: 4242,
      random: () => 0.5,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      onStateChange: (state) => states.push(state)
    })
  })

  /** Start, resolve the connector to `socket`, and hand back a live READY link. */
  async function connectAndReady(socket = new FakeDiscordSocket()): Promise<FakeDiscordSocket> {
    connect.mockResolvedValueOnce(socket)
    client.start()
    await settle()
    socket.push(READY)
    return socket
  }

  it('handshakes on connect and reaches connected on READY', async () => {
    const socket = new FakeDiscordSocket()
    connect.mockResolvedValueOnce(socket)
    client.start()
    await settle()

    const handshake = socket.decodeWrites()[0]
    expect(handshake.op).toBe(DISCORD_OP.HANDSHAKE)
    expect(handshake.payload).toEqual({ v: 1, client_id: 'app-id' })
    expect(client.getState()).toBe('connecting')

    socket.push(READY)
    expect(client.getState()).toBe('connected')
  })

  it('is a quiet unavailable when Discord is absent — never throws', async () => {
    connect.mockResolvedValueOnce(null)
    expect(() => client.start()).not.toThrow()
    await settle()
    expect(client.getState()).toBe('unavailable')
    // A single retry is pending — a scheduled reconnect, not a spin.
    expect(clock.size).toBe(1)
    expect(clock.pendingDelays()[0]).toBeGreaterThan(0)
  })

  it('reconnects with bounded backoff after a mid-session drop', async () => {
    const socket = await connectAndReady()
    expect(client.getState()).toBe('connected')

    socket.emitClose()
    expect(client.getState()).toBe('connecting')
    expect(socket.destroyed).toBe(true)
    expect(clock.size).toBe(1)
    const [delay] = clock.pendingDelays()
    // attempts reset to 0 on READY, so the first reconnect uses the base window.
    expect(delay).toBeGreaterThanOrEqual(DISCORD_RECONNECT_BASE_MS / 2)
    expect(delay).toBeLessThanOrEqual(DISCORD_RECONNECT_MAX_MS)

    const socket2 = new FakeDiscordSocket()
    connect.mockResolvedValueOnce(socket2)
    clock.runAll()
    await settle()
    expect(socket2.decodeWrites()[0].op).toBe(DISCORD_OP.HANDSHAKE)
  })

  it('grows the backoff across repeated failures without spinning', async () => {
    connect.mockResolvedValue(null)
    client.start()
    await settle()
    const first = clock.pendingDelays()[0]

    clock.runAll()
    await settle()
    const second = clock.pendingDelays()[0]

    expect(client.getState()).toBe('unavailable')
    expect(second).toBeGreaterThan(first)
    expect(clock.size).toBe(1)
  })

  it('gives up on a socket that accepts but never handshakes', async () => {
    const socket = new FakeDiscordSocket()
    connect.mockResolvedValueOnce(socket)
    client.start()
    await settle()
    // The handshake timeout is armed while we wait for READY.
    expect(clock.pendingDelays()).toContain(DISCORD_HANDSHAKE_TIMEOUT_MS)

    clock.runAll()
    expect(socket.destroyed).toBe(true)
    expect(client.getState()).toBe('connecting')
    // A reconnect is now pending in its place.
    expect(clock.size).toBe(1)
  })

  it('answers a PING with a PONG carrying the same payload', async () => {
    const socket = await connectAndReady()
    socket.push(encodeFrame(DISCORD_OP.PING, { nonce: 'ping-1' }))
    const pong = socket.decodeWrites().find((frame) => frame.op === DISCORD_OP.PONG)
    expect(pong?.payload).toEqual({ nonce: 'ping-1' })
  })

  it('sends the activity on connect, and clears with an activity-less frame', async () => {
    const activity: DiscordActivity = { type: 2, details: 'So What', state: 'Miles Davis' }
    client.setActivity(activity)
    const socket = await connectAndReady()

    let sets = setSize(socket.decodeWrites())
    expect(sets).toHaveLength(1)
    expect((sets[0].payload as { args: unknown }).args).toEqual({ pid: 4242, activity })

    client.setActivity(null)
    sets = setSize(socket.decodeWrites())
    expect(sets).toHaveLength(2)
    // Discord's clear: the pid, and no activity key.
    expect((sets[1].payload as { args: unknown }).args).toEqual({ pid: 4242 })
  })

  it('clears presence and tears down on close', async () => {
    const socket = await connectAndReady()
    client.setActivity({ details: 'So What' })

    client.close()
    const sets = setSize(socket.decodeWrites())
    expect((sets.at(-1)?.payload as { args: unknown }).args).toEqual({ pid: 4242 })
    expect(socket.destroyed).toBe(true)
    expect(client.getState()).toBe('idle')
    expect(clock.size).toBe(0)
  })

  it('tolerates a rate-limit rejection without desyncing its current state', async () => {
    const socket = await connectAndReady()
    client.setActivity({ details: 'first' })

    // Discord rejects — a rate limit is an ERROR frame, not a disconnect.
    socket.push(
      encodeFrame(DISCORD_OP.FRAME, {
        cmd: 'SET_ACTIVITY',
        evt: 'ERROR',
        data: { code: 4000, message: 'You are being rate limited.' },
        nonce: '1'
      })
    )
    expect(client.getState()).toBe('connected')

    // The next transition still sends, from an uncorrupted view of state.
    client.setActivity({ details: 'second' })
    const sets = setSize(socket.decodeWrites())
    expect((sets.at(-1)?.payload as { args: { activity: DiscordActivity } }).args.activity).toEqual(
      {
        details: 'second'
      }
    )
    // Still one live connection: the rejection scheduled no reconnect.
    expect(clock.size).toBe(0)
  })

  it('can be restarted after close', async () => {
    await connectAndReady()
    client.close()
    expect(client.getState()).toBe('idle')

    const socket2 = new FakeDiscordSocket()
    connect.mockResolvedValueOnce(socket2)
    client.start()
    await settle()
    expect(socket2.decodeWrites()[0].op).toBe(DISCORD_OP.HANDSHAKE)
  })
})
