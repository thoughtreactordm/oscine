<script setup lang="ts">
import { ref } from 'vue'
import { stats } from '@renderer/ipc'

/**
 * "Rebuild play counts" — the repair for the two columns D17 makes caches.
 *
 * In the Library section's header rather than as a row in it, because the
 * generated surface below is one thing: a descriptor, a stored value and a
 * control that edits it. This has no value to store and nothing to revert to,
 * and giving it a registry key with a default nobody reads in order to borrow
 * the row layout would be a lie told to a validator. The header is already where
 * the actions that are not settings live — "Revert section" is one — so this
 * sits beside it.
 *
 * `play_count` and `last_played_at` are maintained by the listen commit and
 * rebuilt automatically after a migration that moves `listens` or a D11 import.
 * This is the third case: the operator who suspects the numbers. Offering it is
 * most of the point — a cache the operator cannot rebuild is a cache they have
 * to take on faith, and the whole argument for these columns being derived is
 * that they never have to.
 */
const toast = useToast()

const busy = ref(false)

async function rebuild(): Promise<void> {
  busy.value = true
  try {
    const result = await stats.rebuildCounters()
    const { tracksChanged, tracksScanned, listensCounted } = result
    toast.add({
      // Zero changed is the good news and is worded as such. A repair that
      // reported "done" either way would teach the operator nothing about
      // whether there was anything wrong, which is the only question they were
      // asking by pressing it.
      title:
        tracksChanged === 0
          ? 'Play counts already match the listening log'
          : `Corrected ${tracksChanged} ${tracksChanged === 1 ? 'track' : 'tracks'}`,
      description:
        `${tracksScanned} ${tracksScanned === 1 ? 'track' : 'tracks'} checked against ` +
        `${listensCounted} ${listensCounted === 1 ? 'listen' : 'listens'}.`,
      icon: tracksChanged === 0 ? 'i-tabler-circle-check' : 'i-tabler-refresh',
      color: 'primary'
    })
  } catch (error) {
    toast.add({
      title: 'Play counts could not be rebuilt',
      description: (error as Error).message,
      icon: 'i-tabler-alert-triangle',
      color: 'error'
    })
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <UButton
    size="xs"
    color="neutral"
    variant="ghost"
    icon="i-tabler-refresh"
    label="Rebuild play counts"
    title="Recompute every track’s play count and last-played date from the listening log"
    :loading="busy"
    :disabled="busy"
    class="shrink-0 text-xs"
    @click="rebuild"
  />
</template>
