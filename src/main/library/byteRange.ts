export interface ByteRange {
  start: number
  end: number
  length: number
}

export const UNSATISFIABLE_RANGE = Symbol('unsatisfiable-range')

/**
 * Parses the single byte range Chromium media requests use.
 *
 * Multiple ranges would require a multipart response, which the track protocol
 * does not need. Rejecting them with 416 is preferable to returning mislabeled
 * bytes and making the media timeline restart at zero.
 */
export function parseByteRange(
  header: string | null,
  totalBytes: number
): ByteRange | null | typeof UNSATISFIABLE_RANGE {
  if (header === null) return null
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) return UNSATISFIABLE_RANGE

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match || (match[1] === '' && match[2] === '')) return UNSATISFIABLE_RANGE

  let start: number
  let end: number
  if (match[1] === '') {
    const suffixLength = Number(match[2])
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return UNSATISFIABLE_RANGE
    }
    start = Math.max(0, totalBytes - suffixLength)
    end = totalBytes - 1
  } else {
    start = Number(match[1])
    if (!Number.isSafeInteger(start) || start >= totalBytes) {
      return UNSATISFIABLE_RANGE
    }
    end = match[2] === '' ? totalBytes - 1 : Number(match[2])
    if (!Number.isSafeInteger(end) || end < start) return UNSATISFIABLE_RANGE
    end = Math.min(end, totalBytes - 1)
  }

  return { start, end, length: end - start + 1 }
}
