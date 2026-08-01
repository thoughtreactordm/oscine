<script setup lang="ts">
import { ref } from 'vue'
import { useSettings } from '@renderer/settings'

/**
 * The confirmation in front of the one destructive action on this surface.
 *
 * Everything else in settings applies immediately and has a revert beside it,
 * which is what makes "no OK and no Cancel" safe (W8-4). This is the exception:
 * it drops every stored value at once, the per-row reverts it consumes are the
 * only record of what those values were, and nothing anywhere keeps the old ones
 * to put back. So it asks first, and the asking says plainly that there is no
 * undo rather than implying it with a red button.
 *
 * What it does *not* touch is said too. A key this build has never heard of
 * belongs to another branch and is preserved, and an operator who switches
 * branches after resetting should not have to discover that by finding their
 * other settings intact and being surprised.
 */
const settings = useSettings()

const open = ref(false)
const running = ref(false)

async function confirm(): Promise<void> {
  running.value = true
  try {
    await settings.resetAll()
    open.value = false
  } finally {
    running.value = false
  }
}
</script>

<template>
  <UButton
    color="neutral"
    variant="ghost"
    size="xs"
    icon="i-tabler-rotate-2"
    label="Reset all settings…"
    class="w-full justify-start text-xs"
    @click="open = true"
  />

  <UModal
    v-model:open="open"
    title="Reset all settings?"
    description="Every setting goes back to the value Fermata ships with."
    :ui="{ footer: 'justify-end' }"
  >
    <template #body>
      <div class="flex flex-col gap-3 text-sm text-muted">
        <p>
          This clears every stored value in one go — both the ones synced with your library and the
          ones about this machine, in every category. It happens immediately and
          <strong class="font-semibold text-highlighted">cannot be undone</strong>: nothing keeps a
          copy of what the values were.
        </p>
        <p class="text-xs text-dimmed">
          Settings belonging to a version of Fermata this build does not know about are left alone.
        </p>
      </div>
    </template>

    <template #footer>
      <UButton color="neutral" variant="ghost" :disabled="running" @click="open = false">
        Cancel
      </UButton>
      <UButton color="error" icon="i-tabler-rotate-2" :loading="running" @click="confirm">
        Reset everything
      </UButton>
    </template>
  </UModal>
</template>
