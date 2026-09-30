import type { LyricsLine } from '@shared/lyrics'

/**
 * The timing core of the lyrics pane, kept out of the component so every rule
 * the card names — which line is current at a boundary, a seek backwards, a
 * scrub that must not thrash, the header offset — is a pure function a test can
 * drive without mounting anything.
 *
 * The pane binds these to reactive playback state; nothing here knows about Vue,
 * the DOM or the clock's cadence.
 */

/** One timed line, paired with its index in the source `lines` array. */
export interface TimedEntry {
  /** Position in the document's `lines` — what the pane highlights and scrolls to. */
  readonly srcIndex: number
  /**
   * Display time in milliseconds: the line's `timeMs` with the document offset
   * already applied. Per the LRC contract a positive `[offset:]` makes lines
   * appear *earlier*, so the effective time is `timeMs - offsetMs`.
   */
  readonly effMs: number
}

export interface LyricsCursor {
  /** The document's timed lines, in ascending display-time order. */
  readonly entries: readonly TimedEntry[]
  /**
   * Position in {@link entries} of the line active at `timeMs`: the last line
   * whose effective time is `<= timeMs`, or `-1` before the first line.
   *
   * A binary search, so it is O(log n) per call and correct under any jump —
   * forward, a seek backwards, or a scrub — with no advancing cursor to reset.
   */
  activePosAt(timeMs: number): number
}

/**
 * Build a cursor over a document's lines. Untimed lines (a plain document, or
 * the trailing untimed tail of a synced one) are dropped: they carry no time to
 * search on. A document with no timed lines yields an empty cursor whose
 * `activePosAt` is always `-1`, which is how the pane's plain state never
 * highlights.
 */
export function createLyricsCursor(lines: readonly LyricsLine[], offsetMs = 0): LyricsCursor {
  const entries: TimedEntry[] = []
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.timeMs
    if (t !== null) entries.push({ srcIndex: i, effMs: t - offsetMs })
  }
  // The parser sorts by raw `timeMs`; a single constant offset preserves that
  // order, so `entries` is already ascending by `effMs` and needs no re-sort.

  function activePosAt(timeMs: number): number {
    let lo = 0
    let hi = entries.length - 1
    let found = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (entries[mid]!.effMs <= timeMs) {
        found = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    return found
  }

  return { entries, activePosAt }
}

/**
 * Estimate the playhead in milliseconds between the engine's 250 ms ticks.
 *
 * The engine's `timeupdate` is deliberately coarse and does not tick when the
 * window is hidden (see `DecodedAudioEngine`), which is right for *which line is
 * current* but jerky for *scrolling between* lines. So the pane anchors on the
 * last tick — its time and the wall-clock instant it arrived — and interpolates
 * forward each frame. Only while playing: a paused or seeking track has no
 * forward motion to predict, so the anchor time stands.
 */
export function estimateTimeMs(
  anchorSec: number,
  anchorAtMs: number,
  playing: boolean,
  nowMs: number
): number {
  if (!playing) return anchorSec * 1000
  return anchorSec * 1000 + Math.max(0, nowMs - anchorAtMs)
}

/**
 * How far playback has travelled from the active line toward the next one, as a
 * fraction in `[0, 1]`. Drives the continuous glide between line anchors. The
 * last line (no `nextMs`), or a pair with no positive gap, pins to `0` so the
 * pane simply rests on the final line.
 */
export function scrollFraction(activeMs: number, nextMs: number | null, timeMs: number): number {
  if (nextMs === null) return 0
  const span = nextMs - activeMs
  if (span <= 0) return 0
  const f = (timeMs - activeMs) / span
  return f < 0 ? 0 : f > 1 ? 1 : f
}

export interface RafClock {
  start(): void
  stop(): void
  readonly running: boolean
}

/**
 * A requestAnimationFrame loop the pane can start and stop explicitly — so it
 * runs only while the pane is visible, playing and synced, and is torn down on
 * unmount rather than leaking a frame callback past the component. The scheduler
 * is injectable so a test can prove `stop` cancels the pending frame and that
 * `start` never double-schedules, without a real animation clock.
 */
export function createRafClock(
  onFrame: () => void,
  raf: (cb: FrameRequestCallback) => number = requestAnimationFrame,
  caf: (handle: number) => void = cancelAnimationFrame
): RafClock {
  let handle: number | null = null

  function tick(): void {
    onFrame()
    // Re-read `handle`: `onFrame` may have called `stop`, and a loop that
    // rescheduled regardless would resurrect a clock the pane just killed.
    if (handle !== null) handle = raf(tick)
  }

  return {
    start(): void {
      if (handle !== null) return
      handle = raf(tick)
    },
    stop(): void {
      if (handle !== null) {
        caf(handle)
        handle = null
      }
    },
    get running(): boolean {
      return handle !== null
    }
  }
}
