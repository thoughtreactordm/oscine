import { defineStore } from 'pinia'
import { cdrip, net } from '@renderer/ipc'
import { useSettings } from '@renderer/settings'
import { useLibraryRootsStore } from '@renderer/stores/libraryRoots'
import { createCdRipSession } from '@renderer/panels/tools/cdRipSession'
import { NETWORK_EXTERNAL_LOOKUPS_KEY } from '@shared/settings'
import { RIP_DESTINATION_ROOT_KEY, RIP_NAME_TEMPLATE_KEY, RIP_VERIFY_KEY } from '@shared/ripPath'

/**
 * The Rip CD pane's state — **W18-7**. Thin: the session owns poll, lookup and
 * the rip; this is the one place the real IPC and settings surface are bolted
 * on, the same split `tagWriteback` uses.
 */
export const useCdRipStore = defineStore('cdRip', () => {
  const settings = useSettings()
  const roots = useLibraryRootsStore()

  return createCdRipSession({
    cdrip,
    cancelLookups: () => {
      void net.cancelScope('cdrip').catch((err: unknown) => {
        console.warn('[cdrip] could not cancel in-flight lookups:', err)
      })
    },
    settings: {
      getDestination: () => settings.get<string>(RIP_DESTINATION_ROOT_KEY),
      setDestination: (path) => {
        void settings.set(RIP_DESTINATION_ROOT_KEY, path)
      },
      getTemplate: () => settings.get<string>(RIP_NAME_TEMPLATE_KEY),
      setTemplate: (template) => {
        void settings.set(RIP_NAME_TEMPLATE_KEY, template)
      },
      getVerify: () => settings.get<boolean>(RIP_VERIFY_KEY) === true,
      lookupsAllowed: () => settings.get<boolean>(NETWORK_EXTERNAL_LOOKUPS_KEY) === true
    },
    rootPaths: () => roots.roots,
    markLibraryChanged: () => roots.markChanged()
  })
})
