<script setup lang="ts">
import { ref, shallowRef } from 'vue'
import ImportProfileDialog from '@renderer/panels/settings/ImportProfileDialog.vue'
import { useSettings } from '@renderer/settings'
import type { SettingsProfileFile } from '@shared/settings'

/**
 * Take this configuration somewhere else, or bring one back.
 *
 * In the rail's footer beside "Reset all settings…", because these three are the
 * operations on the whole surface rather than on a row: everything above them
 * edits one key and reverts itself, and everything down here acts on the lot.
 *
 * Both actions open an OS dialog in main — the renderer never touches the
 * filesystem — and a dismissed dialog resolves to null rather than raising, so
 * cancelling is silent. Reading is separate from importing precisely so that
 * picking a file commits the operator to nothing: what it would do is shown
 * first, in `ImportProfileDialog`.
 */
const settings = useSettings()
const toast = useToast()

const busy = ref(false)
/**
 * Shallow, because a parsed file is data rather than state.
 *
 * Nothing edits it, so the deep reactivity a plain `ref` would wrap it in buys
 * nothing — and it costs something real: a reactive proxy cannot cross IPC,
 * because structured cloning refuses a `Proxy`. The store unwraps defensively
 * too, but the honest fix is not to wrap it in the first place.
 */
const picked = shallowRef<SettingsProfileFile | null>(null)

async function exportProfile(): Promise<void> {
  busy.value = true
  try {
    const result = await settings.exportProfile()
    if (!result) return

    const held = result.excluded.length
    toast.add({
      title: `Wrote ${result.keyCount} ${result.keyCount === 1 ? 'setting' : 'settings'} to ${result.fileName}`,
      description:
        held > 0
          ? `${held} ${held === 1 ? 'setting describes' : 'settings describe'} this machine and stayed behind.`
          : undefined,
      icon: 'i-tabler-file-export',
      color: 'primary'
    })
  } catch (error) {
    toast.add({
      title: 'Those settings could not be exported',
      description: (error as Error).message,
      icon: 'i-tabler-alert-triangle',
      color: 'error'
    })
  } finally {
    busy.value = false
  }
}

async function chooseProfile(): Promise<void> {
  busy.value = true
  try {
    picked.value = await settings.readProfile()
  } catch (error) {
    toast.add({
      title: 'That file could not be opened',
      description: (error as Error).message,
      icon: 'i-tabler-alert-triangle',
      color: 'error'
    })
  } finally {
    busy.value = false
  }
}

function applied(count: number): void {
  toast.add({
    title: `Applied ${count} ${count === 1 ? 'setting' : 'settings'}`,
    icon: 'i-tabler-file-import',
    color: 'primary'
  })
}
</script>

<template>
  <UButton
    color="neutral"
    variant="ghost"
    size="xs"
    icon="i-tabler-file-export"
    label="Export settings…"
    class="w-full justify-start text-xs"
    :disabled="busy"
    @click="exportProfile"
  />

  <UButton
    color="neutral"
    variant="ghost"
    size="xs"
    icon="i-tabler-file-import"
    label="Import settings…"
    class="w-full justify-start text-xs"
    :disabled="busy"
    @click="chooseProfile"
  />

  <ImportProfileDialog v-if="picked" :file="picked" @applied="applied" @close="picked = null" />
</template>
