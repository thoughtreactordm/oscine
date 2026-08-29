<script setup lang="ts">
import { useOnboardingStore } from '@renderer/stores/onboarding'
import OnboardingRootStep from './OnboardingRootStep.vue'
import OnboardingScanStep from './OnboardingScanStep.vue'
import OnboardingSurface from './OnboardingSurface.vue'

/**
 * The first-run wizard, mounted once in the frame.
 *
 * A `<UModal>` over the dimmed shell, driven by `useOnboardingStore` — the same
 * "store flag flips a modal mounted in the frame" idiom as `NewPlaylistModal`.
 * Cancel, the header close, Esc and a click on the overlay are all `close()`:
 * keep every choice already applied, mark the done-key, hide the dialog
 * (D-ONB-4). Next on the last step is Finish — the same close, and not gated
 * on the scan completing, so the operator can walk into the app while
 * indexing continues.
 */
const wizard = useOnboardingStore()

function onOpenChange(value: boolean): void {
  if (!value) wizard.close()
}
</script>

<template>
  <UModal
    :open="wizard.open"
    :title="wizard.current.title"
    :description="wizard.current.blurb"
    :ui="{ footer: 'justify-between', content: 'sm:max-w-lg' }"
    @update:open="onOpenChange"
  >
    <template #body>
      <div class="flex flex-col gap-4">
        <OnboardingRootStep v-if="wizard.current.id === 'root'" />
        <OnboardingScanStep v-else-if="wizard.current.id === 'scan'" />
        <OnboardingSurface v-else-if="wizard.current.kind === 'surface'" :step="wizard.current" />

        <p v-if="wizard.current.skippable && !wizard.isLast" class="text-xs text-dimmed">
          Skip — you can change this later.
        </p>

        <div
          class="flex items-center justify-center gap-1.5"
          role="img"
          :aria-label="`Step ${wizard.step} of ${wizard.stepCount}`"
        >
          <span
            v-for="n in wizard.stepCount"
            :key="n"
            class="size-1.5 rounded-full"
            :class="n === wizard.step ? 'bg-primary' : 'bg-muted'"
          />
        </div>
      </div>
    </template>

    <template #footer>
      <UButton color="neutral" variant="ghost" @click="wizard.close()">Cancel</UButton>
      <div class="flex items-center gap-2">
        <UButton color="neutral" variant="ghost" :disabled="wizard.isFirst" @click="wizard.back()">
          Back
        </UButton>
        <UButton color="primary" :disabled="!wizard.canAdvance" @click="wizard.next()">
          {{ wizard.isLast ? 'Finish' : 'Next' }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
