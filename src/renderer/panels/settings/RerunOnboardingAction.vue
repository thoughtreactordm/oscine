<script setup lang="ts">
import { useOnboardingStore } from '@renderer/stores/onboarding'

/**
 * "Run setup again" — D-ONB-6's Settings entry point.
 *
 * In the Library section's header rather than as a generated row, for the
 * same reason Rebuild play counts is: this has no stored value. The done-key
 * is `internal` and must stay that way — it is not a toggle — and stuffing a
 * button into the registry so it can borrow a row would put a command in the
 * changed-from-default filter and the palette's `/` mode. The header is already
 * where the actions that are not settings live.
 *
 * `openWizard` resets to step 1 and does not clear the done-key. Re-running
 * is not un-onboarding. The root step shows any folder already in the library
 * and will not add it twice.
 */
const onboarding = useOnboardingStore()

function rerun(): void {
  onboarding.openWizard()
}
</script>

<template>
  <UTooltip
    text="Walk through first-run setup again. Your library folder stays; this does not reset onboarding."
  >
    <UButton
      size="xs"
      color="neutral"
      variant="ghost"
      icon="i-tabler-flag"
      label="Run setup again"
      class="shrink-0 text-xs"
      @click="rerun"
    />
  </UTooltip>
</template>
