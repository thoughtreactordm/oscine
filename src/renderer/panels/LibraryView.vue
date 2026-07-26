<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { FermataError, library } from '@renderer/ipc'
import { useShellStore } from '@renderer/stores/shell'
import type { LibraryRoot } from '@shared/library'

// Placeholder shell. W4-1 replaces this with the real virtualized TrackList
// island; for now it exercises the IPC boundary end to end so the seam is
// proven by use rather than only by types.
const shell = useShellStore()
const versions = window.fermata.versions

const roots = ref<LibraryRoot[]>([])
const loadError = ref<string | null>(null)

onMounted(async () => {
  try {
    roots.value = await library.listRoots()
  } catch (err) {
    // `code` survives because ipc.ts rebuilds the error on this side of the
    // bridge — branch on it rather than on the message.
    loadError.value =
      err instanceof FermataError && err.code === 'internal'
        ? 'The library is still being built.'
        : 'Could not read the library.'
  }
})
</script>

<template>
  <main class="min-h-screen bg-default text-default p-10">
    <div class="mx-auto max-w-2xl space-y-6">
      <div class="flex items-center gap-3">
        <UIcon name="i-lucide-music-4" class="size-7 text-primary" />
        <h1 class="text-2xl font-semibold text-highlighted">Fermata</h1>
      </div>

      <p class="text-muted">
        Scaffold only — no library, no playback yet. The shell, the renderer stack and the typed IPC
        bridge are up.
      </p>

      <UAlert
        v-if="loadError"
        color="warning"
        variant="subtle"
        icon="i-lucide-triangle-alert"
        :description="loadError"
      />

      <UCard>
        <dl class="grid grid-cols-2 gap-y-2 text-sm">
          <dt class="text-muted">Electron</dt>
          <dd class="text-right tabular-nums">{{ versions.electron }}</dd>
          <dt class="text-muted">Chromium</dt>
          <dd class="text-right tabular-nums">{{ versions.chrome }}</dd>
          <dt class="text-muted">Node</dt>
          <dd class="text-right tabular-nums">{{ versions.node }}</dd>
          <dt class="text-muted">Library roots</dt>
          <dd class="text-right tabular-nums">{{ roots.length }}</dd>
          <dt class="text-muted">Booted</dt>
          <dd class="text-right tabular-nums">{{ shell.bootedAt }}</dd>
        </dl>
      </UCard>

      <div class="flex gap-3">
        <UButton color="primary" icon="i-lucide-folder-plus" disabled>Add folder</UButton>
        <UButton color="neutral" variant="subtle" icon="i-lucide-play" disabled>Play</UButton>
      </div>
    </div>
  </main>
</template>
