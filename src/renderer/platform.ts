/**
 * The host OS as preload reported it, or null where there is no preload.
 *
 * Null is the unit tests — they import renderer modules under plain Node with
 * no `window` — and reads as "every platform", so a row filtered by platform is
 * still exercised there. In the app it is always a `process.platform` value.
 *
 * Read off `globalThis` rather than `window` so this stays importable from
 * `tests/`, which compiles without the DOM lib — `catalog.ts` depends on it.
 */
export const HOST_PLATFORM: string | null =
  (globalThis as { oscine?: { platform?: string } }).oscine?.platform ?? null
