/**
 * The arithmetic behind the seek bar's readouts, kept pure so it is tested
 * without a DOM: the transport's clock format, and the pointer → time mapping
 * the hover preview uses.
 */

/** `m:ss`, the transport clock. Minutes run past 60 rather than rolling to hours. */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/**
 * Where along the bar a pointer sits, as a 0–1 fraction. Clamped, because a
 * drag keeps reporting once the pointer leaves the bar's ends, and a degenerate
 * (unlaid-out) bar reads as the start rather than dividing by zero.
 */
export function pointerFraction(clientX: number, left: number, width: number): number {
  if (!(width > 0)) return 0
  const fraction = (clientX - left) / width
  return Math.min(1, Math.max(0, fraction))
}
