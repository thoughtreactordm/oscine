import { describe, expect, it } from 'vitest'
import { DISCORD_OP, encodeFrame, FrameDecoder } from '../../../src/main/discord/frames'

describe('Discord IPC frame codec (W20-2)', () => {
  it('round-trips an opcode and a JSON body', () => {
    const decoder = new FrameDecoder()
    const frames = decoder.push(encodeFrame(DISCORD_OP.HANDSHAKE, { v: 1, client_id: 'abc' }))
    expect(frames).toEqual([{ op: DISCORD_OP.HANDSHAKE, payload: { v: 1, client_id: 'abc' } }])
  })

  it('reassembles a frame split across chunks', () => {
    const frame = encodeFrame(DISCORD_OP.FRAME, { cmd: 'SET_ACTIVITY' })
    const decoder = new FrameDecoder()
    // Split mid-header and again mid-body — the socket may hand over any slice.
    expect(decoder.push(frame.subarray(0, 3))).toEqual([])
    expect(decoder.push(frame.subarray(3, 10))).toEqual([])
    expect(decoder.push(frame.subarray(10))).toEqual([
      { op: DISCORD_OP.FRAME, payload: { cmd: 'SET_ACTIVITY' } }
    ])
  })

  it('yields several frames coalesced into one chunk', () => {
    const decoder = new FrameDecoder()
    const chunk = Buffer.concat([
      encodeFrame(DISCORD_OP.PING, { n: 1 }),
      encodeFrame(DISCORD_OP.PONG, { n: 1 }),
      encodeFrame(DISCORD_OP.CLOSE, { code: 1000 })
    ])
    expect(decoder.push(chunk)).toEqual([
      { op: DISCORD_OP.PING, payload: { n: 1 } },
      { op: DISCORD_OP.PONG, payload: { n: 1 } },
      { op: DISCORD_OP.CLOSE, payload: { code: 1000 } }
    ])
  })

  it('holds a partial trailing frame until the rest arrives', () => {
    const decoder = new FrameDecoder()
    const first = encodeFrame(DISCORD_OP.FRAME, { a: 1 })
    const second = encodeFrame(DISCORD_OP.FRAME, { b: 2 })
    const chunk = Buffer.concat([first, second.subarray(0, 4)])
    expect(decoder.push(chunk)).toEqual([{ op: DISCORD_OP.FRAME, payload: { a: 1 } }])
    expect(decoder.push(second.subarray(4))).toEqual([{ op: DISCORD_OP.FRAME, payload: { b: 2 } }])
  })

  it('encodes a nullish payload as JSON null and decodes it back', () => {
    const decoder = new FrameDecoder()
    expect(decoder.push(encodeFrame(DISCORD_OP.PONG, undefined))).toEqual([
      { op: DISCORD_OP.PONG, payload: null }
    ])
  })

  it('decodes a zero-length body as undefined rather than throwing', () => {
    const header = Buffer.alloc(8)
    header.writeUInt32LE(DISCORD_OP.PING, 0)
    header.writeUInt32LE(0, 4)
    const decoder = new FrameDecoder()
    expect(decoder.push(header)).toEqual([{ op: DISCORD_OP.PING, payload: undefined }])
  })
})
