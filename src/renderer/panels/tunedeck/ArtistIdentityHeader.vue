<script setup lang="ts">
import { computed } from 'vue'
import { describeIdentity } from '@renderer/panels/tunedeck/artistIdentity'
import { describeCredit } from '@renderer/panels/tunedeck/imageCredit'
import ArtistPicker from '@renderer/panels/tunedeck/ArtistPicker.vue'
import { useArtistIdentityStore } from '@renderer/stores/artistIdentity'
import { useArtistImageStore } from '@renderer/stores/artistImage'

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
 *
 * ## Why there is no rule under it
 *
 * Every other section boundary in the deck is a hairline, and this one used to
 * be too. It is not a section: `ArtistBackdrop` runs behind this strip and on
 * past it into the first group, and a border here would draw a line across a
 * continuous surface and cut the picture in half. The header is the top of one
 * thing, not the first of several.
 *
 * ## Why the name is the biggest text in the deck
 *
 * It is the answer to the question the tab asks. Everything below it — the
 * biography, the line-up, the catalogue — is elaboration on this one word, and
 * at the same size and weight as a group heading it read as another label.
 *
 * ## Attribution
 *
 * Commons licences require the author and the licence to be named wherever the
 * work is shown, and `describeCredit` composes that from whatever fields the
 * file actually carried. It is a popover rather than a permanent line because
 * the credit for one file is routinely longer than this deck is wide — the
 * alternative is a truncated attribution, which is a worse answer than a
 * complete one behind a control that is always there while the picture is. The
 * summary is also the button's `aria-label`, so it is never *only* visual.
 */

const identity = useArtistIdentityStore()
const images = useArtistImageStore()

const wording = computed(() =>
  describeIdentity(identity.resolution, {
    loading: identity.loading,
    failed: identity.failed
  })
)

const headlineClass = computed(() =>
  wording.value.tone === 'resolved' ? 'text-highlighted' : 'text-muted'
)

const credit = computed(() => (images.image ? describeCredit(images.image.credit) : null))
</script>

<template>
  <div class="flex shrink-0 items-center gap-2 px-3 pb-3 pt-4">
    <div class="min-w-0 flex-1">
      <div class="flex min-w-0 items-center gap-2">
        <UIcon
          :name="identity.resolved ? 'i-tabler-user-check' : 'i-tabler-user-question'"
          class="size-5 shrink-0"
          :class="wording.tone === 'problem' ? 'text-warning' : 'text-dimmed'"
          aria-hidden="true"
        />

        <h3 class="truncate text-lg font-bold leading-tight tracking-tight" :class="headlineClass">
          {{ wording.headline }}
        </h3>

        <!--
          Inline with the name rather than in the corner: the credit belongs to
          the picture the name is standing on, and a licence control parked with
          the identity controls reads as a third thing to do to the artist.
        -->
        <UPopover v-if="credit" :ui="{ content: 'w-64 p-3' }">
          <UButton
            variant="ghost"
            size="xs"
            icon="i-tabler-info-circle"
            square
            class="shrink-0 text-dimmed"
            :aria-label="credit.summary"
          />

          <template #content>
            <p class="text-xs font-medium text-highlighted">Photograph</p>
            <p v-if="credit.name" class="mt-1 text-xs leading-relaxed text-muted">
              {{ credit.name }}
            </p>
            <p class="mt-2 text-xs leading-relaxed text-dimmed">
              <!--
                `target="_blank"` rather than an IPC call, for the reason the
                biography's licence line gives: main's `setWindowOpenHandler`
                already routes https to the system browser and denies the window.
              -->
              <template v-if="credit.licence">
                <a
                  v-if="credit.licenceUrl"
                  :href="credit.licenceUrl"
                  target="_blank"
                  rel="noreferrer"
                  class="text-muted underline decoration-dotted underline-offset-2 hover:text-default"
                >
                  {{ credit.licence }}
                </a>
                <span v-else>{{ credit.licence }}</span>
                ·
              </template>
              <a
                :href="credit.descriptionUrl"
                target="_blank"
                rel="noreferrer"
                class="text-muted underline decoration-dotted underline-offset-2 hover:text-default"
              >
                Wikimedia Commons
              </a>
            </p>
          </template>
        </UPopover>
      </div>

      <!--
        Indented past the icon, so the two lines share a left edge. Absent
        entirely for a plain automatic match: `describeIdentity` returns no
        detail when the headline and the tick have already said everything, and
        a standing line of grey text that never varies is the thing the deck's
        `hint` tooltips exist to have got rid of.
      -->
      <!--
        `text-muted` rather than `text-dimmed`, which is what it was when this
        line sat on a flat surface. The dimmest step in the ramp is chosen for
        contrast against the panel, and this line no longer sits on the panel —
        it sits on a photograph, which spends part of that margin before the
        text is drawn.
      -->
      <p v-if="wording.detail || identity.loading" class="truncate ps-7 text-sm text-muted">
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
