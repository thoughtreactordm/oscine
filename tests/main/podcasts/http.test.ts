import { describe, expect, it, vi } from 'vitest'
import {
  createStallGuard,
  readCappedBytes,
  readCappedText,
  ResponseTooLargeError,
  TransferStalledError
} from '../../../src/main/podcasts/http'

/** A body that streams `chunks` and never declares content-length. */
function streaming(chunks: Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    }
  })
  return new Response(stream)
}

describe('readCappedBytes', () => {
  it('reads a body that fits', async () => {
    const bytes = await readCappedBytes(new Response('hello'), 1024)
    expect(new TextDecoder().decode(bytes)).toBe('hello')
  })

  it('rejects on a declared content-length over the cap before reading', async () => {
    const response = new Response('hi', { headers: { 'content-length': '9999' } })
    await expect(readCappedBytes(response, 10)).rejects.toBeInstanceOf(ResponseTooLargeError)
  })

  it('rejects a body that exceeds the cap without declaring it', async () => {
    const chunk = new Uint8Array(8)
    await expect(readCappedBytes(streaming([chunk, chunk, chunk]), 16)).rejects.toBeInstanceOf(
      ResponseTooLargeError
    )
  })

  it('accepts a streamed body exactly at the cap', async () => {
    const chunk = new Uint8Array(8)
    const bytes = await readCappedBytes(streaming([chunk, chunk]), 16)
    expect(bytes.byteLength).toBe(16)
  })

  it('concatenates multi-chunk bodies in order', async () => {
    const encode = (s: string) => new TextEncoder().encode(s)
    const text = await readCappedText(streaming([encode('ab'), encode('cd'), encode('ef')]), 64)
    expect(text).toBe('abcdef')
  })

  it('treats a null body as empty', async () => {
    const bytes = await readCappedBytes(new Response(null, { status: 204 }), 16)
    expect(bytes.byteLength).toBe(0)
  })
})

describe('createStallGuard', () => {
  it('aborts once the countdown expires', async () => {
    vi.useFakeTimers()
    try {
      const guard = createStallGuard(1000)
      expect(guard.signal.aborted).toBe(false)
      vi.advanceTimersByTime(1001)
      expect(guard.signal.aborted).toBe(true)
      expect(guard.signal.reason).toBeInstanceOf(TransferStalledError)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not abort a slow-but-alive transfer', async () => {
    vi.useFakeTimers()
    try {
      const guard = createStallGuard(1000)
      // Headers land inside the connect budget, then ten minutes of steady
      // progress — far past any whole-transfer deadline.
      vi.advanceTimersByTime(500)
      guard.keepAlive(10_000)
      for (let i = 0; i < 60; i++) {
        vi.advanceTimersByTime(9_000)
        guard.keepAlive(10_000)
      }
      expect(guard.signal.aborted).toBe(false)
      guard.release()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops the countdown on release', async () => {
    vi.useFakeTimers()
    try {
      const guard = createStallGuard(1000)
      guard.release()
      vi.advanceTimersByTime(60_000)
      expect(guard.signal.aborted).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
