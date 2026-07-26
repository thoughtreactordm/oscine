<script setup lang="ts">
import { computed } from 'vue'
import { useShellStore } from '@renderer/stores/shell'

// Placeholder shell. W4-1 replaces this with the real virtualized TrackList
// island; for now it exists to prove the renderer stack is wired end to end.
const shell = useShellStore()

const versions = computed(() => window.fermata.versions)
</script>

<template>
  <main class="min-h-screen bg-default text-default p-10">
    <div class="mx-auto max-w-2xl space-y-6">
      <div class="flex items-center gap-3">
        <UIcon name="i-lucide-music-4" class="size-7 text-primary" />
        <h1 class="text-2xl font-semibold text-highlighted">Fermata</h1>
      </div>

      <p class="text-muted">
        Scaffold only — no library, no playback yet. The shell, the renderer stack and the preload
        bridge are up.
      </p>

      <UCard>
        <dl class="grid grid-cols-2 gap-y-2 text-sm">
          <dt class="text-muted">Electron</dt>
          <dd class="text-right tabular-nums">{{ versions.electron }}</dd>
          <dt class="text-muted">Chromium</dt>
          <dd class="text-right tabular-nums">{{ versions.chrome }}</dd>
          <dt class="text-muted">Node</dt>
          <dd class="text-right tabular-nums">{{ versions.node }}</dd>
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
