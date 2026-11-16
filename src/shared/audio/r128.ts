/**
 * Opus `R128_TRACK_GAIN` / `R128_ALBUM_GAIN` ⇄ ReplayGain 2.0 decibels.
 *
 * RFC 7845 §5.2.1 defines both tags as a signed Q7.8 fixed-point integer —
 * 1/256 dB steps — written as decimal text, relative to an EBU R128 reference
 * of −23 LUFS and applied on top of the Opus header's output gain. ReplayGain
 * 2.0 references −18 LUFS, so a gain measured against it is 5 dB louder than
 * the same file's R128 gain: `gainDb = q / 256 + 5`. There is no peak tag.
 *
 * Shared because both halves of D37 Decision E need the same arithmetic: the
 * scanner reads `R128_*` back as decibels, and the write-back (RG-5) turns a
 * computed decibel value into the integer it writes. Keeping one definition is
 * what makes our own writes read back as the value we measured.
 */

/** ReplayGain 2.0 (−18 LUFS) minus EBU R128 (−23 LUFS). */
export const R128_REFERENCE_OFFSET_DB = 5

/** Q7.8 is a signed 16-bit integer: −128 dB to +127.996 dB in 1/256 dB steps. */
export const R128_Q78_MIN = -32768
export const R128_Q78_MAX = 32767

/** A Q7.8 `R128_*` integer as ReplayGain 2.0 decibels. */
export function r128Q78ToGainDb(value: number): number {
  return value / 256 + R128_REFERENCE_OFFSET_DB
}

/**
 * ReplayGain 2.0 decibels as the Q7.8 integer an `R128_*` tag carries.
 *
 * Rounds to the nearest 1/256 dB and clamps to the 16-bit range, so a gain the
 * format cannot express is written as the nearest one it can rather than
 * wrapping. `Math.round` on the negated-zero case returns `-0`, which is
 * normalised so the written text is never `"-0"`.
 */
export function gainDbToR128Q78(gainDb: number): number {
  if (!Number.isFinite(gainDb)) {
    throw new RangeError(`Cannot express a non-finite gain (${gainDb}) as R128 Q7.8`)
  }
  const q = Math.round((gainDb - R128_REFERENCE_OFFSET_DB) * 256)
  const clamped = Math.min(R128_Q78_MAX, Math.max(R128_Q78_MIN, q))
  return clamped === 0 ? 0 : clamped
}

/**
 * Parse an `R128_*` comment value, or `null` when it is not a valid Q7.8 integer.
 *
 * The RFC requires a plain decimal integer in the 16-bit range. Anything else
 * — a decimal point, a `dB` suffix, an out-of-range number — is a malformed
 * tag, and reading it as absent lets the analyzer measure the file instead of
 * trusting a value whose meaning is a guess. Surrounding whitespace is
 * tolerated because taggers disagree about it and it carries no meaning.
 */
export function parseR128Q78(text: string): number | null {
  const trimmed = text.trim()
  if (!/^[+-]?\d{1,6}$/.test(trimmed)) return null
  const value = Number.parseInt(trimmed, 10)
  if (value < R128_Q78_MIN || value > R128_Q78_MAX) return null
  return value === 0 ? 0 : value
}
