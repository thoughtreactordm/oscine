<script setup lang="ts">
import { computed, ref } from 'vue'
import { useSettings } from '@renderer/settings'
import { useInstalledThemes } from './useInstalledThemes'
import { theme as themeIpc } from '@renderer/ipc'
import { THEME_NAME_KEY } from '@shared/settings'
import { findTheme } from '@shared/theme'

/**
 * The Theme section's file actions — take a theme somewhere else, or bring one
 * in — the theme-shaped counterpart to `ProfileActions`.
 *
 * Themes left the settings profile (they are non-portable now) and travel as
 * their own named `.osctheme` files. Export names one and writes it; import
 * copies one into the themes folder; the folder button reveals where they live
 * so the operator can drop files in by hand. All three cross IPC into main —
 * the renderer never touches the filesystem — and a dismissed dialog resolves
 * to null rather than raising, so cancelling is silent.
 */
const settings = useSettings()
const { refresh } = useInstalledThemes()
const toast = useToast()

const busy = ref(false)

/** The export name prompt. Defaults to the base theme's label. */
const naming = ref(false)
const draftName = ref('')

function openExport(): void {
  const base = settings.get<string>(THEME_NAME_KEY)
  draftName.value = findTheme(base)?.label ?? 'My theme'
  naming.value = true
}

const canExport = computed(() => draftName.value.trim().length > 0)

async function confirmExport(): Promise<void> {
  if (!canExport.value) return
  naming.value = false
  busy.value = true
  try {
    const result = await themeIpc.export(draftName.value.trim())
    if (!result) return
    toast.add({
      title: `Exported theme to ${result.fileName}`,
      icon: 'i-tabler-file-export',
      color: 'primary'
    })
  } catch (error) {
    toast.add({
      title: 'That theme could not be exported',
      description: (error as Error).message,
      icon: 'i-tabler-alert-triangle',
      color: 'error'
    })
  } finally {
    busy.value = false
  }
}

async function importTheme(): Promise<void> {
  busy.value = true
  try {
    const result = await themeIpc.import()
    if (!result) return
    await refresh()
    toast.add({
      title: `Added “${result.name}” to your themes`,
      description: 'Pick it from the Theme menu above.',
      icon: 'i-tabler-file-import',
      color: 'primary'
    })
  } catch (error) {
    toast.add({
      title: 'That theme could not be imported',
      description: (error as Error).message,
      icon: 'i-tabler-alert-triangle',
      color: 'error'
    })
  } finally {
    busy.value = false
  }
}

async function openFolder(): Promise<void> {
  try {
    await themeIpc.revealFolder()
    // The folder may have gained or lost files since it was last read.
    await refresh()
  } catch (error) {
    toast.add({
      title: 'The themes folder could not be opened',
      description: (error as Error).message,
      icon: 'i-tabler-alert-triangle',
      color: 'error'
    })
  }
}
</script>

<template>
  <UTooltip text="Save the current theme as a shareable .osctheme file">
    <UButton
      size="xs"
      color="neutral"
      variant="ghost"
      icon="i-tabler-file-export"
      label="Export theme…"
      class="shrink-0 text-xs"
      :disabled="busy"
      @click="openExport"
    />
  </UTooltip>

  <UTooltip text="Add a .osctheme file to your themes">
    <UButton
      size="xs"
      color="neutral"
      variant="ghost"
      icon="i-tabler-file-import"
      label="Import theme…"
      class="shrink-0 text-xs"
      :disabled="busy"
      @click="importTheme"
    />
  </UTooltip>

  <UTooltip text="Open the folder your themes live in">
    <UButton
      size="xs"
      color="neutral"
      variant="ghost"
      icon="i-tabler-folder"
      label="Themes folder…"
      class="shrink-0 text-xs"
      :disabled="busy"
      @click="openFolder"
    />
  </UTooltip>

  <UModal
    v-model:open="naming"
    title="Export theme"
    description="Name this theme. The name is what the picker shows on any machine it is dropped into."
  >
    <template #body>
      <UFormField label="Theme name">
        <UInput
          v-model="draftName"
          autofocus
          placeholder="My theme"
          class="w-full"
          @keydown.enter.prevent="confirmExport"
        />
      </UFormField>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" label="Cancel" @click="naming = false" />
        <UButton
          color="primary"
          icon="i-tabler-file-export"
          label="Export…"
          :disabled="!canExport"
          @click="confirmExport"
        />
      </div>
    </template>
  </UModal>
</template>
