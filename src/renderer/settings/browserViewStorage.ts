import type { ViewStorageArea } from './viewStore'

/**
 * `localStorage`, guarded — the only module in `src/` that names it.
 *
 * Five modules used to hold a copy of this function, each with its own guard
 * and its own silent-failure comment. There is one now, and the reason for the
 * guard has not changed: storage can genuinely fail, on a quota error or in a
 * Chromium build launched with site data disabled, and a pane width is not
 * worth taking the frame down for. A failure degrades to the defaults for the
 * session.
 *
 * `globalThis.localStorage` rather than the bare global because this runs
 * before anything guarantees a window — the optional chain is load-bearing.
 */
export function browserViewStorage(): ViewStorageArea {
  return {
    read: (key) => {
      try {
        return globalThis.localStorage?.getItem(key) ?? null
      } catch {
        return null
      }
    },
    write: (key, value) => {
      try {
        globalThis.localStorage?.setItem(key, value)
      } catch {
        // Nothing useful to do: the value stays correct for this session.
      }
    },
    remove: (key) => {
      try {
        globalThis.localStorage?.removeItem(key)
      } catch {
        // Same. A key that could not be removed is re-read and re-absorbed
        // next launch, which is a no-op rather than a loss.
      }
    }
  }
}
