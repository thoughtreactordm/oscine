/**
 * Discord's local-IPC wire format — **W20-2**.
 *
 * The protocol is length-prefixed JSON: an 8-byte little-endian header (a 4-byte
 * opcode, a 4-byte body length) followed by a UTF-8 JSON body. Hand-rolled
 * rather than taken from a dependency (settled in W20-2): it is a few dozen lines
 * of stable framing, it adds no runtime dependency to the release tree, and it
 * keeps the failure domain in-tree where R12's reconnect and rate-limit handling
 * already live. See `[[oscine-discord-presence]]` D31.
 *
 * This module is pure: encode a frame, and reassemble frames from a byte stream
 * that may split or coalesce them however the OS pleases. No socket, no state
 * beyond the decoder's own buffer — so the codec is a table test.
 */

/** The four opcodes presence uses. */
export const DISCORD_OP = {
  HANDSHAKE: 0,
  FRAME: 1,
  CLOSE: 2,
  PING: 3,
  PONG: 4
} as const

export type DiscordOp = (typeof DISCORD_OP)[keyof typeof DISCORD_OP]

const HEADER_BYTES = 8

/** One length-prefixed frame: the opcode and its JSON body ready to write. */
export function encodeFrame(op: DiscordOp, payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload ?? null), 'utf8')
  const frame = Buffer.allocUnsafe(HEADER_BYTES + body.length)
  frame.writeUInt32LE(op, 0)
  frame.writeUInt32LE(body.length, 4)
  body.copy(frame, HEADER_BYTES)
  return frame
}

export interface DecodedFrame {
  readonly op: number
  /** The parsed JSON body, or `undefined` when it is empty or unparseable. */
  readonly payload: unknown
}

/**
 * Reassembles whole frames from an arbitrarily chunked byte stream.
 *
 * A socket hands over bytes, not messages: one `data` event may carry half a
 * frame, or three and a bit. Feed every chunk in; get back the frames that have
 * fully arrived, with the remainder held for the next chunk. Stateful by
 * necessity — that boundary is exactly what the header length is for.
 */
export class FrameDecoder {
  #buffer: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): DecodedFrame[] {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk])
    const frames: DecodedFrame[] = []
    while (this.#buffer.length >= HEADER_BYTES) {
      const op = this.#buffer.readUInt32LE(0)
      const length = this.#buffer.readUInt32LE(4)
      if (this.#buffer.length < HEADER_BYTES + length) break
      const body = this.#buffer.subarray(HEADER_BYTES, HEADER_BYTES + length)
      this.#buffer = this.#buffer.subarray(HEADER_BYTES + length)
      frames.push({ op, payload: parseJson(body) })
    }
    return frames
  }
}

function parseJson(body: Buffer): unknown {
  if (body.length === 0) return undefined
  try {
    return JSON.parse(body.toString('utf8')) as unknown
  } catch {
    return undefined
  }
}
