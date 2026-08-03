<script setup lang="ts">
import { computed } from 'vue'
import { usePlaybackStore } from '@renderer/stores/playback'

/**
 * What is playing, as the Track tab's standing strip.
 *
 * The same shape as `ArtistIdentityHeader` — an icon, the answer to the tab's
 * question in the largest text in the deck, and one indented line of context
 * under it — because the two are the same *kind* of thing: the subject the
 * groups below are describing. Two tabs that named their subject in two
 * different arrangements would read as two panels, which is the thing the
 * backdrop is already careful not to do.
 *
 * It answers a question the tab was leaving to the transport bar. Format,
 * ReplayGain and decode path are all statements about a file, and the file was
 * only ever named at the other end of the window — an operator reading "24-bit
 * · 96 kHz" had to look away from the deck to find out what it was 24 bits of.
 *
 * ## Why the track's artist rather than the album's
 *
 * `NowPlaying` shows `albumArtist`, which is right for a transport bar: it is
 * saying what record is on. This is the file's own credit, and on a compilation
 * the two differ — which is exactly the case where a readout about *this track*
 * should not be answering about the album around it.
 *
 * It is also the field the Artist tab resolves against (`artists.forTrack`
 * joins `tracks.artist_id`), so the name here and the name one tab over are the
 * same string rather than two that usually agree.
 *
 * ## Why there is no verb on it
 *
 * The artist strip carries two buttons because R5 requires a wrong identity to
 * be correctable where it is asserted. Nothing here is a guess — these are the
 * tags as read — so there is nothing to disagree with, and a control added for
 * symmetry would be a control with nothing behind it.
 */

const playback = usePlaybackStore()

const track = computed(() => playback.nowPlaying)

/**
 * A missing tag is simply absent rather than filled with "Unknown album".
 *
 * The deck's own habit: `describeIdentity` drops its detail line when the
 * headline has said everything, and a placeholder repeated on every untagged
 * file is a standing line of grey text that never varies. The title needs no
 * such treatment — the scanner falls back to the filename, so it is always
 * something.
 */
const album = computed(() => track.value?.album ?? null)
const artist = computed(() => track.value?.artist ?? null)
</script>

<template>
  <div class="flex shrink-0 items-center gap-2 px-4 pb-6 pt-7">
    <div class="min-w-0 flex-1">
      <div class="flex min-w-0 items-center gap-3">
        <UIcon
          :name="track ? 'i-tabler-music' : 'i-tabler-music-off'"
          class="size-5 shrink-0 text-dimmed"
          aria-hidden="true"
        />

        <h3
          class="truncate text-xl font-bold leading-tight tracking-tight"
          :class="track ? 'text-highlighted' : 'text-muted'"
        >
          {{ track?.title ?? 'Nothing playing' }}
        </h3>
      </div>

      <!--
        Indented past the icon so the two lines share a left edge, and the
        separator spaced the way the transport bar spaces its own: the album and
        the artist are two facts on one line rather than a phrase, and a tight
        bullet reads as punctuation inside a title.
      -->
      <p v-if="album || artist" class="mt-1.5 truncate ps-8 text-sm text-muted">
        <span v-if="album">{{ album }}</span>
        <span v-if="album && artist">&nbsp;&nbsp;•&nbsp;&nbsp;</span>
        <span v-if="artist">{{ artist }}</span>
      </p>
    </div>
  </div>
</template>
