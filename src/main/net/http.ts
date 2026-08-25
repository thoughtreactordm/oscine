/**
 * Byte-bounded, stall-guarded HTTP reads.
 *
 * These began under `podcasts/` and moved here when W7-7 made `src/main/net`
 * the one place in the application that opens a socket. Nothing about them was
 * ever specific to feeds: a ceiling on a response body and a deadline on a
 * quiet host are what every remote read wants, and having the metadata client
 * import them from `podcasts/` would have inverted the layering the move
 * exists to establish.
 *
 * Everything downstream of here talks to hosts nobody vetted, so two rules
 * hold: a response body is never buffered without a ceiling, and a transfer
 * that stops producing bytes is abandoned rather than waited on forever.
 *
 * The second rule is why episode downloads do not use `AbortSignal.timeout`.
 * That signal stays attached to the body stream, so it is a deadline on the
 * whole transfer, not on the connection — a two-hour episode on a slow link
 * would be cancelled mid-download for the crime of being long. What we
 * actually want to catch is a host that has gone quiet, which is a gap between
 * bytes, not an elapsed total.
 */

export { OSCINE_USER_AGENT } from './userAgent'

export class ResponseTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`Response exceeded ${maxBytes} bytes.`)
    this.name = 'ResponseTooLargeError'
  }
}

export class TransferStalledError extends Error {
  constructor(readonly idleMs: number) {
    super(`Transfer produced no data for ${idleMs}ms.`)
    this.name = 'TransferStalledError'
  }
}

/**
 * Read a whole response body into memory, refusing to exceed `maxBytes`.
 *
 * A declared `content-length` over the cap fails before a byte is read; hosts
 * that lie or omit it are caught by the running total.
 */
export async function readCappedBytes(
  response: Response,
  maxBytes: number
): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ResponseTooLargeError(maxBytes)
  }

  const body = response.body
  if (!body) return new Uint8Array(0)

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) throw new ResponseTooLargeError(maxBytes)
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }

  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/** Same as `readCappedBytes`, decoded as UTF-8 text. */
export async function readCappedText(response: Response, maxBytes: number): Promise<string> {
  return new TextDecoder().decode(await readCappedBytes(response, maxBytes))
}

export interface StallGuard {
  /** Pass to `fetch`; aborts when a countdown expires. */
  readonly signal: AbortSignal
  /** Restart the countdown. Call once per arriving chunk. */
  keepAlive(idleMs: number): void
  /** Stop the countdown once the transfer has finished, successfully or not. */
  release(): void
}

/**
 * An abort signal driven by inactivity rather than elapsed time.
 *
 * Armed with `firstByteMs` for the connection and headers; the caller re-arms
 * it with a shorter idle budget as body chunks arrive.
 */
export function createStallGuard(firstByteMs: number): StallGuard {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | null = null

  const arm = (idleMs: number): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      controller.abort(new TransferStalledError(idleMs))
    }, idleMs)
    // A pending download must never be the reason the main process stays up.
    timer.unref?.()
  }

  arm(firstByteMs)

  return {
    signal: controller.signal,
    keepAlive: arm,
    release(): void {
      if (timer) clearTimeout(timer)
      timer = null
    }
  }
}
