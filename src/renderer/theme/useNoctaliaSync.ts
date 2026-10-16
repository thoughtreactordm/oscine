/**
 * Noctalia sync, the renderer's half: follow main's status and hand the palette
 * to the theme layer.
 *
 * Main is the authority on whether sync is on — it publishes a null palette the
 * moment `theme.colorSource` leaves `noctalia`, and always does off Linux — so
 * this reads the palette off the status and never second-guesses it with the
 * setting. That matters at launch: the settings store hydrates after mount, and
 * reading its default `oscine` here would drop the pre-paint palette for one
 * frame before the real value arrived.
 *
 * `noctaliaStatus` is module state rather than a store because it has two
 * readers — this and `ColorSourceControl` — and one writer, and the control has
 * to see the same snapshot the theme was painted from.
 */

import { onScopeDispose, shallowRef, watch } from 'vue'
import type { NoctaliaStatus } from '@shared/theme'
import { theme } from '@renderer/ipc'
import { cacheNoctaliaPalette } from './noctaliaCache'
import { updateTheme } from './index'

/** Null until main has answered once. */
export const noctaliaStatus = shallowRef<NoctaliaStatus | null>(null)

export function useNoctaliaSync(): void {
  let received = false
  const stop = theme.onNoctaliaChanged((status) => {
    received = true
    noctaliaStatus.value = status
  })
  theme
    .noctaliaStatus()
    .then((status) => {
      // A push that landed first is newer than this answer.
      if (!received) noctaliaStatus.value = status
    })
    .catch((error: unknown) => {
      console.warn('[theme] could not read Noctalia sync status:', error)
    })
  onScopeDispose(stop)

  watch(noctaliaStatus, (status) => {
    if (status === null) return
    updateTheme({ noctalia: status.palette })
    cacheNoctaliaPalette(status.palette)
  })
}
