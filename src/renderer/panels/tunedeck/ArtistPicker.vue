<script setup lang="ts">
import { computed } from 'vue'
import { describeCandidate } from '@renderer/panels/tunedeck/artistIdentity'
import { useArtistIdentityStore } from '@renderer/stores/artistIdentity'

/**
 * The disambiguation picker — where **R5**'s ambiguity is resolved by the one
 * party who actually knows.
 *
 * Eleven artists are called "Nirvana" and no amount of scoring picks the right
 * one; this dialog is the honest end of that. What it shows is therefore not a
 * ranked list dressed as a recommendation but a list of *distinguishable*
 * things: MusicBrainz's disambiguation comment leads every row, because that is
 * the sentence a human wrote to answer exactly this question.
 *
 * Scores are shown. They are the deck saying what it thought, which is the
 * difference between an operator confirming a guess and correcting one — and if
 * the numbers look wrong to somebody, that is a bug report about the threshold
 * rather than a silent correction we never hear about.
 *
 * Two escapes below the list. "Not on MusicBrainz" is a decision and is stored;
 * "Match automatically" throws the decision away. They are different verbs and
 * they are deliberately not one toggle.
 */

const identity = useArtistIdentityStore()

const resolution = computed(() => identity.resolution)

const candidates = computed(() => resolution.value?.candidates ?? [])

/**
 * External lookups are off, as distinct from MusicBrainz having nothing (**W7-14**).
 *
 * The two used to share one line, which told an operator to correct a tag when
 * the real fix was to turn networking on — a wrong next move. Declined reads as
 * a state; a genuine empty result keeps the tag-correction hint.
 */
const declined = computed(() => resolution.value?.failure?.kind === 'declined')

const heading = computed(() => `Which “${resolution.value?.name ?? 'artist'}”?`)

const description = computed(() => {
  const query = resolution.value?.query
  if (query && resolution.value && query !== resolution.value.name) {
    // Worth saying out loud: the operator typed one thing into their tags and
    // we searched for another. A featured-artist credit is the usual reason and
    // it is invisible otherwise.
    return `Searched MusicBrainz for “${query}”. Your choice is kept until you change it.`
  }
  return 'Your choice is kept until you change it, and nothing automatic overwrites it.'
})

function isChosen(mbid: string): boolean {
  return resolution.value?.mbid === mbid
}
</script>

<template>
  <UModal
    :open="identity.pickerOpen"
    :title="heading"
    :description="description"
    :ui="{ footer: 'justify-between' }"
    @update:open="(value: boolean) => !value && identity.closePicker()"
  >
    <template #body>
      <div v-if="identity.searching && candidates.length === 0" class="py-8 text-center">
        <UIcon name="i-tabler-loader-2" class="size-5 animate-spin text-dimmed" />
      </div>

      <!--
        Declined first, and on its own: not an error, and not a reason to correct
        a tag. The local panes are all intact behind this dialog — the property
        D14 asks for — so it says what is off and how to turn it on.
      -->
      <p v-else-if="declined" class="px-1 py-6 text-center text-xs text-muted">
        External lookups are off. Turn them on in Settings to search MusicBrainz.
      </p>

      <!--
        The offline and genuinely-empty case. A reachable failure shows its own
        message; MusicBrainz having nothing keeps the tag-correction hint, which
        is the real way in when the name simply does not resolve.
      -->
      <p v-else-if="candidates.length === 0" class="px-1 py-6 text-center text-xs text-muted">
        {{
          resolution?.failure?.message ??
          'MusicBrainz has no artist under this name. Correcting the tag is the way in.'
        }}
      </p>

      <ul v-else class="m-0 flex list-none flex-col gap-1 p-0">
        <li v-for="candidate in candidates" :key="candidate.mbid">
          <button
            type="button"
            class="flex w-full min-w-0 cursor-default items-start gap-2 rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:bg-elevated/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/70"
            :class="isChosen(candidate.mbid) ? 'bg-elevated/80' : ''"
            :aria-current="isChosen(candidate.mbid) ? 'true' : undefined"
            @click="identity.choose(candidate.mbid)"
          >
            <UIcon
              :name="isChosen(candidate.mbid) ? 'i-tabler-circle-check' : 'i-tabler-circle'"
              class="mt-0.5 size-4 shrink-0"
              :class="isChosen(candidate.mbid) ? 'text-primary' : 'text-dimmed'"
              aria-hidden="true"
            />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm text-highlighted">{{ candidate.name }}</span>
              <span v-if="describeCandidate(candidate)" class="block truncate text-xs text-dimmed">
                {{ describeCandidate(candidate) }}
              </span>
            </span>
            <UBadge
              :label="String(candidate.score)"
              size="sm"
              color="neutral"
              variant="subtle"
              class="mt-0.5 shrink-0 tabular-nums"
            />
          </button>
        </li>
      </ul>
    </template>

    <template #footer>
      <UButton
        color="neutral"
        variant="ghost"
        icon="i-tabler-user-off"
        @click="identity.choose(null)"
      >
        Not on MusicBrainz
      </UButton>
      <UButton
        v-if="identity.corrected"
        color="neutral"
        variant="ghost"
        icon="i-tabler-wand"
        :loading="identity.searching"
        @click="identity.matchAutomatically()"
      >
        Match automatically
      </UButton>
    </template>
  </UModal>
</template>
