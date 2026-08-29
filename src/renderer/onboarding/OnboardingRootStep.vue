<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { OscineError, library } from '@renderer/ipc'
import { useLibraryRootsStore } from '@renderer/stores/libraryRoots'
import { pickOnboardingRoot } from './rootStep'

/**
 * The one mandatory wizard step: pick a music folder.
 *
 * The picker is main-side (`library.addRoot`); a successful add immediately
 * kicks off `scanRoot` so indexing overlaps the rest of the wizard. Next is
 * gated on the roots store, not on this component, so a re-run that already
 * has a folder lights Next without opening the dialog again. A folder added
 * from the title bar while this is open shows up here too — both read the
 * same store.
 */
const roots = useLibraryRootsStore()
const picking = ref(false)
const error = ref<string | null>(null)

const chosen = computed(() => roots.roots)

onMounted(() => {
  void roots.refresh()
})

async function pickFolder(): Promise<void> {
  if (chosen.value.length > 0 || picking.value) return
  picking.value = true
  error.value = null
  try {
    const root = await pickOnboardingRoot({
      roots: roots.roots,
      addRoot: library.addRoot,
      scanRoot: library.scanRoot
    })
    if (root) await roots.refresh()
  } catch (cause) {
    error.value = cause instanceof OscineError ? cause.message : 'That folder could not be added.'
  } finally {
    picking.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <ul v-if="chosen.length > 0" class="flex flex-col gap-2">
      <li
        v-for="root in chosen"
        :key="root.id"
        class="flex min-w-0 items-center gap-3 rounded-md border border-default bg-elevated px-3 py-2.5"
      >
        <UIcon name="i-tabler-folder" class="size-5 shrink-0 text-primary" />
        <p class="min-w-0 truncate text-sm text-highlighted" :title="root.path">{{ root.path }}</p>
      </li>
    </ul>

    <UButton
      v-else
      color="primary"
      icon="i-tabler-folder-plus"
      label="Add music folder…"
      :loading="picking"
      :disabled="picking"
      class="self-start"
      @click="pickFolder"
    />

    <p v-if="error" class="text-xs text-error" role="alert">{{ error }}</p>
  </div>
</template>
