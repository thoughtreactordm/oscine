import { FrameDecoder, type DecodedFrame } from '../../../src/main/discord/frames'
import type { DiscordSocket } from '../../../src/main/discord/transport'
import type {
  DiscordActivity,
  DiscordClient,
  DiscordConnectionState
} from '../../../src/main/discord/client'

/**
 * A controllable `DiscordSocket` for the client's lifecycle tests — no real
 * socket, no live Discord. It records what the client writes and lets the test
 * play Discord back: push bytes, drop the connection, raise an error.
 */
export class FakeDiscordSocket implements DiscordSocket {
  readonly writes: Buffer[] = []
  destroyed = false

  private dataListener: ((chunk: Buffer) => void) | null = null
  private closeListener: (() => void) | null = null
  private errorListener: ((error: Error) => void) | null = null

  write(data: Buffer): void {
    if (this.destroyed) return
    this.writes.push(data)
  }

  onData(listener: (chunk: Buffer) => void): void {
    this.dataListener = listener
  }

  onClose(listener: () => void): void {
    this.closeListener = listener
  }

  onError(listener: (error: Error) => void): void {
    this.errorListener = listener
  }

  destroy(): void {
    this.destroyed = true
  }

  /** Play a frame (or raw op + payload) back to the client as Discord would. */
  push(chunk: Buffer): void {
    this.dataListener?.(chunk)
  }

  emitClose(): void {
    this.closeListener?.()
  }

  emitError(error: Error = new Error('socket error')): void {
    this.errorListener?.(error)
  }

  /** The frames the client has written so far, decoded. */
  decodeWrites(): DecodedFrame[] {
    const decoder = new FrameDecoder()
    const frames: DecodedFrame[] = []
    for (const write of this.writes) frames.push(...decoder.push(write))
    return frames
  }
}

/**
 * A fake `DiscordClient` for the service tests (W20-3) — records what it was
 * asked to broadcast without opening a socket.
 */
export interface FakeDiscordClient extends DiscordClient {
  readonly activities: Array<DiscordActivity | null>
  started: boolean
  closed: boolean
  /** Drive the state the service reads, as a real connection would change it. */
  setStateForTest(next: DiscordConnectionState): void
}

export function createFakeDiscordClient(): FakeDiscordClient {
  const activities: Array<DiscordActivity | null> = []
  let state: DiscordConnectionState = 'idle'
  const client: FakeDiscordClient = {
    activities,
    started: false,
    closed: false,
    start() {
      client.started = true
    },
    setActivity(activity) {
      activities.push(activity)
    },
    getState() {
      return state
    },
    close() {
      client.closed = true
    },
    setStateForTest(next) {
      state = next
    }
  }
  return client
}
