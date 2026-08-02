<script setup lang="ts">
import { computed } from 'vue'
import { describeIdentity } from '@renderer/panels/tunedeck/artistIdentity'
import ArtistPicker from '@renderer/panels/tunedeck/ArtistPicker.vue'
import { useArtistIdentityStore } from '@renderer/stores/artistIdentity'

/**
 * Who the deck thinks is playing, and the one control that says otherwise —
 * **R5**'s "not this artist?" affordance.
 *
 * Above the accordion rather than inside a group, because the risk it mitigates
 * is a *confident, wrong* identity: the operator has to be able to see that the
 * deck has picked the wrong Nirvana at the moment the biography beneath it is
 * telling them about the wrong band, not after they have gone looking for a
 * control. A chevron in front of it would be the difference.
 *
 * The button is present in every state including `resolved`. A correction
 * affordance that only appears when the deck already knows it is unsure is an
 * affordance that is missing in exactly the case it exists for.
 */

const identity = useArtistIdentityStore()

const wording = computed(() =>
  describeIdentity(identity.resolution, {
    loading: identity.loading,
    failed: identity.failed
  })
)

const headlineClass = computed(() =>
  wording.value.tone === 'resolved' ? 'text-highlighted' : 'text-muted'
)
</script>

<template>
  <div class="flex shrink-0 items-start gap-2 border-b border-default px-3 py-2">
    <UIcon
      :name="identity.resolved ? 'i-tabler-user-check' : 'i-tabler-user-question'"
      class="mt-0.5 size-4 shrink-0"
      :class="wording.tone === 'problem' ? 'text-warning' : 'text-dimmed'"
      aria-hidden="true"
    />

    <div class="min-w-0 flex-1">
      <p class="truncate text-sm font-medium" :class="headlineClass">
        {{ wording.headline }}
      </p>
      <p v-if="wording.detail" class="truncate text-xs text-dimmed">
        {{ identity.loading ? 'Looking…' : wording.detail }}
      </p>
    </div>

    <UTooltip v-if="wording.retryable" text="Try the lookup again">
      <UButton
        variant="ghost"
        size="xs"
        icon="i-tabler-refresh"
        square
        class="shrink-0 text-dimmed"
        aria-label="Try the lookup again"
        :loading="identity.loading"
        @click="identity.refresh()"
      />
    </UTooltip>

    <!--
      Worded as a question rather than as "Change": the operator is being invited
      to disagree, and a neutral verb reads as a settings control they have no
      reason to touch.
    -->
    <UTooltip v-if="wording.correctable" text="Not this artist?">
      <UButton
        variant="ghost"
        size="xs"
        icon="i-tabler-switch-horizontal"
        square
        class="shrink-0"
        :class="identity.corrected ? 'text-primary' : 'text-dimmed'"
        aria-label="Not this artist?"
        @click="identity.openPicker()"
      />
    </UTooltip>

    <ArtistPicker />
  </div>
</template>
