<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { DropdownMenuItem } from '@nuxt/ui'
import { panelSettingsSurface } from '@renderer/panels/settings/panelSettings'
import PanelSettingsPopover from '@renderer/panels/settings/PanelSettingsPopover.vue'
import QuickMenu from '@renderer/panels/QuickMenu.vue'
import UpNextOverlay from '@renderer/panels/UpNextOverlay.vue'
import { hasArtwork } from '@shared/ipc'
import { useAddToPlaylistStore } from '@renderer/stores/addToPlaylist'
import { useBrowseStore } from '@renderer/stores/browse'
import { useFavoritesStore } from '@renderer/stores/favorites'
import { usePlaybackStore } from '@renderer/stores/playback'
import { useShellStore } from '@renderer/stores/shell'
import { useTunedeckStore } from '@renderer/stores/tunedeck'

/**
 * The transport island.
 *
 * Knows only the playback store — not the track list, not the library. That is
 * what lets it be docked anywhere later, and it is why "next track" is
 * `playback.next()` rather than anything about rows: the order was captured
 * when playback started and this panel does not need to know what it was.
 */
const playback = usePlaybackStore()

const playbackSettings = panelSettingsSurface('transport')

/**
 * Names the count as well as the control, so the badge is not the only telling.
 *
 * The *hand-queued* count, and the session depth after it. A badge reading 312
 * after every click is noise, and the state the badge exists to make visible —
 * a non-empty queue changes what Next does — is a statement about the tier the
 * operator built by hand (§5 amendment). The scope is still reported, because
 * "nothing queued" would be a lie with three hundred rows lined up behind it.
 */
const queueLabel = computed(() => {
  const queued =
    playback.queuedUserCount === 0
      ? 'Up next: nothing queued'
      : playback.queuedUserCount === 1
        ? 'Up next: 1 track queued'
        : `Up next: ${playback.queuedUserCount.toLocaleString()} tracks queued`
  if (playback.queuedSessionCount === 0) return queued
  return `${queued}, ${playback.queuedSessionCount.toLocaleString()} more in this selection`
})

/**
 * The thumbnail toggles the sidebar's blow-up through the shell store rather
 * than an emit, because nothing between here and the sidebar is a parent of
 * both. This panel never learns whether anything is listening.
 */
const shell = useShellStore()

/** The deck's toggle, for the same reason and by the same route. */
const tunedeck = useTunedeckStore()

/**
 * The Quick Menu belongs to the Now Playing screen alone (D26). The transport is
 * always mounted, so without this its handle would follow the operator onto
 * every tab; gating on the active route keeps it scoped to where the drawer is.
 */
const onNowPlayingScreen = computed(() => shell.activeTab === 'now-playing')

/**
 * The heart — **D18**.
 *
 * The one place this panel reads something that is not the playback store, and
 * it stays within the island rule: the store is asked about the `Track` the
 * transport already handed over, not about a list or a library. A track hearted
 * here fills the matching row in the song list because both go through the same
 * store, without either panel knowing the other exists.
 */
const favorites = useFavoritesStore()

/** `null` with nothing playing, which is the state where there is no heart to draw. */
const nowPlayingFavorite = computed(() => {
  const track = playback.nowPlaying
  return track ? favorites.isFavorite(track) : null
})

const favoriteLabel = computed(() => {
  const track = playback.nowPlaying
  if (!track) return 'Favorite'
  return nowPlayingFavorite.value ? `Unfavorite ${track.title}` : `Favorite ${track.title}`
})

function toggleFavorite(): void {
  const track = playback.nowPlaying
  if (track) void favorites.toggle(track.id)
}

/**
 * The 3-dot menu, scoped to the track on the bar (**G3**).
 *
 * Three verbs, all about the one track: add it to a playlist, and follow its
 * artist or its album into the library. The set is deliberately the one G8 will
 * give a track row — the transport is just another surface that acts on a
 * track, and two menus of the same verbs that drifted apart would be the bug.
 */
const addToPlaylist = useAddToPlaylistStore()
const browse = useBrowseStore()
const router = useRouter()

/**
 * View artist / view album, from the bar.
 *
 * The bar shows *tags as read* — a track carries its artist and album as names,
 * not as facet ids, and the renderer has no cheap way to turn one into the
 * other — so this reveals by search text, the honest route the Listening
 * dashboard already takes (see `browse.revealSearch`): naming text that cannot
 * be resolved to a facet id puts the phrase in the search box, where it is
 * visible and editable, rather than hiding an approximation inside a query.
 * Then it moves the frame to the library that renders the result — the same
 * two-step `RelationsPane` does for its exact reveal, because filtering without
 * navigating leaves the operator wondering what their click did.
 */
async function reveal(text: string): Promise<void> {
  browse.revealSearch(text)
  await router.push({ name: 'library' })
}

const songMenu = computed<DropdownMenuItem[]>(() => {
  const track = playback.nowPlaying
  if (!track) return []
  const artist = track.albumArtist ?? track.artist
  const album = track.album
  return [
    // The one add-to-playlist model (see `stores/addToPlaylist`), so the wording,
    // the trailing "New playlist…" and the failure text match every other
    // surface that offers it. Its submenu is authored as a `ContextMenuItem`;
    // the two item types are structurally identical for the fields it sets, so
    // it drops straight into a dropdown.
    addToPlaylist.menuItem({
      trackIds: () => Promise.resolve([track.id]),
      count: 1
    }) as DropdownMenuItem,
    {
      label: 'View artist',
      icon: 'i-tabler-user',
      // Disabled rather than hidden: an untagged file has no artist to follow,
      // and a verb that silently vanished would read as the menu being broken.
      disabled: artist === null,
      onSelect: artist === null ? undefined : () => void reveal(artist)
    },
    {
      label: 'View album',
      icon: 'i-tabler-vinyl',
      disabled: album === null,
      onSelect: album === null ? undefined : () => void reveal(album)
    }
  ]
})

/**
 * The cover to bleed behind the bar, or null when there is nothing worth
 * blowing up. `large` rather than `small`: it is scaled well past its own size
 * either way, and the blur is what hides the upscale.
 */
const backdrop = computed(() => {
  const url = playback.nowPlaying?.artwork.large
  return url && hasArtwork(url) ? url : null
})

const repeatLabel = computed(() => {
  if (playback.repeatMode === 'all') return 'Repeat: all'
  if (playback.repeatMode === 'one') return 'Repeat: this track'
  return 'Repeat: off'
})

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/**
 * Whether the volume bar is open — hover, keyboard focus, or a drag in progress.
 *
 * Hover is read from the pointer's *geometry* against the control's box, not from
 * `:hover` or `pointerenter`/`pointerleave`. The slider takes pointer capture
 * while it is dragged, and Chromium leaves both `:hover` and the enter/leave
 * boundary tracking stuck on the capture target after release — the bar latches
 * open for as long as the cursor is anywhere in the window, which is the bug this
 * replaces. A window `pointermove` keeps reporting true coordinates throughout a
 * capture and after it, so testing them against the section's rect is immune. The
 * one cost is a rect read per move, on a single element; cheap enough to leave
 * always-on rather than juggle listeners that the same bug could stick.
 *
 * Keyboard focus opens it too, but not the click that also focuses the thumb —
 * see `onVolumeFocusIn`. The drag flag holds it through a grab whose captured
 * pointer strays off the row.
 */
const volumeHovered = ref(false)
const volumeKeyboard = ref(false)
const volumeDragging = ref(false)
const volumeOpen = computed(
  () => volumeHovered.value || volumeKeyboard.value || volumeDragging.value
)
const volumeSection = ref<HTMLElement | null>(null)

/** Modality of the last interaction, to tell a Tab-focus from a click-focus. */
let volumeFocusFromKeyboard = false

function onWindowPointerMove(event: PointerEvent): void {
  const el = volumeSection.value
  if (!el) {
    volumeHovered.value = false
    return
  }
  const rect = el.getBoundingClientRect()
  volumeHovered.value =
    event.clientX >= rect.left &&
    event.clientX <= rect.right &&
    event.clientY >= rect.top &&
    event.clientY <= rect.bottom
}

function onWindowKeydown(): void {
  volumeFocusFromKeyboard = true
}

function onWindowPointerdown(): void {
  volumeFocusFromKeyboard = false
}

onMounted(() => {
  window.addEventListener('pointermove', onWindowPointerMove)
  // Capture, so the modality is recorded before the focus these produce lands.
  window.addEventListener('keydown', onWindowKeydown, true)
  window.addEventListener('pointerdown', onWindowPointerdown, true)
})
onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onWindowPointerMove)
  window.removeEventListener('keydown', onWindowKeydown, true)
  window.removeEventListener('pointerdown', onWindowPointerdown, true)
  window.removeEventListener('pointerup', endVolumeAdjust)
  window.removeEventListener('pointercancel', endVolumeAdjust)
})

function onVolumeFocusIn(): void {
  // Not `:focus-visible`: reka focuses the thumb from its own pointerdown, and
  // Chromium matches `:focus-visible` on that programmatic focus — so a mouse
  // click would key the bar open until the next click landed elsewhere. The
  // focus is "keyboard" only when the interaction that caused it was a key.
  volumeKeyboard.value = volumeFocusFromKeyboard
}

function beginVolumeAdjust(): void {
  volumeDragging.value = true
  window.addEventListener('pointerup', endVolumeAdjust)
  window.addEventListener('pointercancel', endVolumeAdjust)
}

function endVolumeAdjust(): void {
  volumeDragging.value = false
  window.removeEventListener('pointerup', endVolumeAdjust)
  window.removeEventListener('pointercancel', endVolumeAdjust)
}

function onSeekInput(value: number | undefined): void {
  if (value === undefined) return
  // A drag has already announced itself with `pointerdown`, so the position is
  // held until release. Keyboard seeking produces no pointer events at all and
  // commits immediately — otherwise an arrow key would move the handle and
  // never reach the audio.
  if (playback.scrubbing) playback.scrubTo(value)
  else playback.seek(value)
}
</script>

<template>
  <USlider
    :model-value="playback.currentTime"
    aria-label="Seek"
    size="xs"
    :min="0"
    :max="playback.duration || 1"
    :step="0.01"
    :disabled="!playback.canSeek"
    :ui="{
      root: 'group relative -mt-1 backdrop-blur-lg',
      track: 'rounded-none h-1',
      range: 'rounded-none h-1',
      thumb: 'opacity-0 cursor-pointer group-hover:opacity-100 w-2 h-2 z-20 transition-transform'
    }"
    @pointerdown="playback.beginScrub()"
    @update:model-value="onSeekInput"
    @change="playback.endScrub()"
    @pointerup="playback.endScrub()"
  />
  <UCard
    as="footer"
    variant="soft"
    class="relative isolate h-full min-h-0 overflow-hidden rounded-none ring-0"
    :ui="{ body: 'flex w-full h-full items-center justify-between gap-6 overflow-hidden px-3' }"
    aria-label="Now playing"
  >
    <!--
      Keyed so a track change crossfades: Vue keeps the outgoing cover mounted
      while the incoming one arrives, and both are out of flow, so they overlap
      rather than shunting the controls.

      Two elements rather than one because the drift never ends. Vue decides what
      to wait for by taking the longest duration it can see, so an infinite
      animation on the transitioning element means it waits for an `animationend`
      that never arrives and the outgoing layer is never unmounted. The outer
      element owns the crossfade, the inner owns the drift, and neither has to
      know the other's timing.
    -->
    <Transition name="cover">
      <div v-if="backdrop" :key="backdrop" class="cover-bleed" aria-hidden="true">
        <div
          class="cover-bleed-art"
          :style="{
            backgroundImage: `url('${backdrop}')`,
            animationPlayState: playback.isPlaying ? 'running' : 'paused'
          }"
        />
      </div>
    </Transition>

    <!-- The transport: the elapsed / total time stacked over the controls, centred. -->
    <section class="order-2 flex shrink-0 flex-col items-center justify-center gap-0.5">
      <div class="flex items-center gap-1">
        <UButton
          icon="i-tabler-player-skip-back-filled"
          color="neutral"
          variant="ghost"
          :disabled="!playback.hasTrack"
          aria-label="Previous track"
          size="sm"
          @click="playback.previous()"
        />
        <UButton
          variant="ghost"
          :icon="
            playback.isPlaying ? 'i-tabler-player-pause-filled' : 'i-tabler-player-play-filled'
          "
          :color="playback.hasTrack ? 'primary' : 'neutral'"
          :loading="playback.isLoading"
          :disabled="!playback.hasTrack"
          size="xl"
          :aria-label="playback.isPlaying ? 'Pause' : 'Play'"
          :ui="{
            leadingIcon: 'size-8'
          }"
          @click="playback.toggle()"
        />
        <UButton
          icon="i-tabler-player-skip-forward-filled"
          color="neutral"
          variant="ghost"
          :disabled="!playback.hasTrack"
          size="sm"
          aria-label="Next track"
          @click="playback.next()"
        />
      </div>

      <div
        v-if="playback.hasTrack"
        class="order-first flex justify-between tabular-nums text-xs font-medium text-muted"
      >
        <span>{{ formatTime(playback.currentTime) }}</span>
        <span>&nbsp;/&nbsp;</span>
        <span>{{ formatTime(playback.duration) }}</span>
      </div>
    </section>

    <!--
      The now-playing track — cover, title, favourite, options — is the panel's
      left column (`order-1`). It and the right cluster both take `flex-1`, so
      they reserve equal width and the transport between them reads as centred in
      the bar whatever is, or is not, playing.
    -->
    <Transition name="trackInfo" mode="out-in">
      <div v-if="playback.hasTrack" class="order-1 flex min-w-0 flex-1 items-center">
        <!--
          The thumbnail is the control for the sidebar's blow-up, and it stands
          down once that blow-up is on screen — two copies of the same cover a
          few hundred pixels apart is one too many, and the sidebar pane carries
          its own dismiss.

          A real button rather than a click handler on the avatar: this has to be
          reachable by keyboard and announce its state, and the art inside it
          stays decorative because the button carries the label.

          Its trailing space lives on the inner element rather than on a `gap`
          between flex children. A gap belongs to the parent and would survive
          the collapse to the last frame, then vanish — a 12px jump exactly when
          the motion is meant to have settled.
        -->
        <Transition name="coverThumb">
          <div v-if="!shell.coverExpanded" class="cover-thumb">
            <div class="cover-thumb-inner pr-3">
              <UTooltip text="Show cover art">
                <button
                  type="button"
                  class="cover-toggle shrink-0 rounded-sm"
                  aria-label="Show cover art"
                  @click="shell.toggleCover()"
                >
                  <UAvatar
                    :src="playback.nowPlaying?.artwork.small"
                    :icon="playback.nowPlaying ? undefined : 'i-tabler-vinyl'"
                    alt=""
                    size="3xl"
                    class="rounded-sm"
                    :ui="{ image: 'size-full object-cover', icon: 'size-6 text-dimmed' }"
                    aria-hidden="true"
                  />
                  <span class="cover-toggle-hint" aria-hidden="true">
                    <UIcon name="i-tabler-arrows-diagonal" class="size-5 text-inverted" />
                  </span>
                </button>
              </UTooltip>
            </div>
          </div>
        </Transition>
        <!--
          Read against its left edge always, now the column is anchored there.
          When the thumbnail wipes away for the sidebar's blow-up the text holds
          its place rather than sliding to centre — the operator asked to see the
          art bigger, not to have the title move house.
        -->
        <div class="flex min-w-0 flex-col justify-center">
          <p class="truncate text-sm font-medium text-highlighted max-w-60">
            {{ playback.nowPlaying?.title ?? 'Nothing playing' }}
          </p>
          <p class="truncate text-xs text-muted">
            <span>{{ playback.nowPlaying?.album }}</span>
            <span v-if="playback.nowPlaying?.year"
              >&nbsp;&nbsp;•&nbsp;&nbsp;{{ playback.nowPlaying?.year }}</span
            >
          </p>
          <p class="truncate text-xs text-primary">{{ playback.nowPlaying?.albumArtist }}</p>
          <p v-if="playback.error" class="truncate text-xs text-error">{{ playback.error }}</p>
        </div>
        <div class="pl-3">
          <!--
            A two-state toggle, so it announces its state rather than only an
            action — the same treatment shuffle gets below. Disabled with nothing
            playing: there is no track for the click to be about, and a heart
            that filled against silence would be a lie the next track inherits.
          -->
          <UTooltip :text="nowPlayingFavorite ? 'Remove from favorites' : 'Add to favorites'">
            <UButton
              variant="ghost"
              square
              :icon="nowPlayingFavorite ? 'i-tabler-heart-filled' : 'i-tabler-heart'"
              :color="nowPlayingFavorite ? 'primary' : 'neutral'"
              :disabled="nowPlayingFavorite === null"
              :aria-pressed="nowPlayingFavorite === true"
              :aria-label="favoriteLabel"
              @click="toggleFavorite()"
            />
          </UTooltip>
          <UTooltip text="Song options">
            <UDropdownMenu :items="songMenu" :content="{ align: 'end' }">
              <UButton
                variant="ghost"
                icon="i-tabler-dots-vertical-filled"
                square
                aria-label="Song options"
              />
            </UDropdownMenu>
          </UTooltip>
        </div>
      </div>
    </Transition>

    <div class="order-3 flex min-w-0 flex-1 items-center justify-end gap-3">
      <!--
        Collapsed to its icon and readout until pointed at or focused, then the
        bar wipes open to be set and folds away again once the pointer leaves.
        The transport is read at a glance far more often than the volume is
        moved, and a slider always out is a slider always catching the eye and
        the cursor. `is-adjusting` keeps it open through a drag whose pointer
        strays off the row — the slider captures the pointer, so the grab must
        outlive the hover that revealed it.
      -->
      <!--
        The whole control's hover buffer: an even hit-area — taller top and
        bottom than it is wide — that opens the bar as the cursor arrives and
        holds it while the aim drifts toward the thumb. The negative margins
        cancel the padding in the margin box, so the row's spacing is untouched;
        only the hoverable area grows.
      -->
      <section
        ref="volumeSection"
        class="volume -mx-2 -my-3 flex items-center gap-1 px-2 py-3"
        :class="{ 'is-open': volumeOpen }"
        @focusin="onVolumeFocusIn"
        @focusout="volumeKeyboard = false"
      >
        <UIcon name="i-tabler-volume" class="size-5 shrink-0 text-muted" />
        <div class="volume-track">
          <USlider
            :model-value="playback.volume"
            class="w-24"
            aria-label="Volume"
            :min="0"
            :max="1"
            :step="0.01"
            :ui="{
              root: 'group px-2',
              track: 'h-1.5',
              range: 'h-1.5',
              thumb:
                'opacity-0 cursor-pointer group-hover:opacity-100 w-3 h-3 -ml-0.5 transition-opacity'
            }"
            @pointerdown="beginVolumeAdjust"
            @update:model-value="(value) => value !== undefined && playback.setVolume(value)"
          />
        </div>
        <span class="w-7 shrink-0 text-right tabular-nums text-xs text-muted">
          {{ Math.round(playback.volume * 100) }}
        </span>
      </section>

      <!--
        Both are modes, so both announce a state rather than only an action:
        `aria-pressed` for shuffle, which is on or off, and a label that names
        the current mode for repeat, which has three.
      -->
      <UTooltip :text="playback.shuffleEnabled ? 'Shuffle: on' : 'Shuffle: off'">
        <UButton
          variant="ghost"
          size="lg"
          :icon="playback.shuffleEnabled ? 'i-tabler-arrows-shuffle' : 'i-tabler-arrows-right'"
          :color="playback.shuffleEnabled ? 'primary' : 'neutral'"
          :aria-pressed="playback.shuffleEnabled"
          aria-label="Shuffle"
          @click="playback.toggleShuffle()"
        />
      </UTooltip>

      <UTooltip :text="repeatLabel">
        <UButton
          variant="ghost"
          size="lg"
          :icon="playback.repeatMode === 'one' ? 'i-tabler-repeat-once' : 'i-tabler-repeat'"
          :color="playback.repeatMode === 'off' ? 'neutral' : 'primary'"
          :aria-pressed="playback.repeatMode !== 'off'"
          :aria-label="repeatLabel"
          @click="playback.cycleRepeat()"
        />
      </UTooltip>

      <!--
        The queued count is on the transport rather than inside the popover,
        because a non-empty queue changes what Next does and must never be
        invisible. The badge is the count; the popover is what it is.

        The count is the *user* tier. The session tier is always non-empty
        under a playing scope, so badging it would make the badge mean "music
        is playing" — which the transport already says, and which would drown
        out the one thing this is here to signal.
      -->
      <UTooltip :text="queueLabel">
        <UPopover :ui="{ content: 'p-0' }">
          <UButton
            variant="ghost"
            size="lg"
            icon="i-tabler-list-numbers"
            :color="playback.queuedUserCount > 0 ? 'primary' : 'neutral'"
            :aria-label="queueLabel"
          >
            <UBadge
              v-if="playback.queuedUserCount > 0"
              color="primary"
              variant="solid"
              size="sm"
              class="tabular-nums"
            >
              {{ playback.queuedUserCount.toLocaleString() }}
            </UBadge>
          </UButton>

          <template #content> <UpNextOverlay /> </template>
        </UPopover>
      </UTooltip>

      <!--
        Crossfade and levelling, next to the thing they act on. Both are judged
        by ear against what is playing right now, and a round trip to a settings
        tab to move a slider and back to hear it is how a knob stops being
        tuned. Generated from the same descriptors the settings view draws, and
        every row links through to its place there.
      -->
      <PanelSettingsPopover :surface="playbackSettings" />

      <!--
        A mode, like shuffle above it, so it announces a state rather than only
        an action. The store is the entire coupling: this panel does not import
        the deck and the deck does not import this panel, which is what lets
        either be docked elsewhere later (D4, D15).
      -->
      <UTooltip
        :text="
          playback.hasTrack
            ? tunedeck.showing
              ? 'Close Tunedeck'
              : 'Open Tunedeck'
            : 'The Tunedeck needs a track'
        "
      >
        <!--
          Disabled with nothing loaded, because every tab in the deck is a
          readout on a track: opening it onto four empty panes would be the
          button working and the feature not. The tooltip says which, since a
          control that is simply dead teaches nothing about when it will not be.

          `showing` rather than `open` for the lit state — the operator's
          standing preference survives an empty transport, and a button
          reporting itself pressed beside a deck that is not on screen would be
          announcing the preference rather than the panel.
        -->
        <UButton
          variant="ghost"
          size="lg"
          icon="i-tabler-device-audio-tape"
          :color="tunedeck.showing ? 'primary' : 'neutral'"
          :disabled="!playback.hasTrack"
          :aria-pressed="tunedeck.showing"
          aria-label="Tunedeck"
          @click="tunedeck.toggle()"
        />
      </UTooltip>
    </div>
  </UCard>

  <!--
    The Quick Menu — a left-edge drawer of favorite playlists, recent additions
    and favorite artists (D26). Rendered by the transport as the spec asks, but
    scoped to the Now Playing screen and drawn as a fixed pull-tab on the
    window's left edge rather than a control in this bar; opposite the Tunedeck
    toggle on the right, so the drawer it opens never fights a deck that is open.
  -->
  <QuickMenu v-if="onNowPlayingScreen" />
</template>

<style scoped>
/*
 * Negative z-index rather than a z-index race with the controls: the card root
 * carries `isolate`, so this paints above the card's own surface and below
 * everything in flow without any sibling needing to opt in. `overflow-hidden`
 * there is what clips the overscaled, blurred edges.
 */
.cover-bleed {
  position: absolute;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  opacity: var(--oscine-cover-bleed);
}

.cover-bleed-art {
  position: absolute;
  inset: 0;
  background-position: center;
  background-repeat: no-repeat;
  background-size: 100% 100%;
  filter: blur(var(--oscine-cover-blur)) saturate(3.6);
  /* The resting value for when the drift is off, set to the keyframes' midpoint
     so reduced motion gets the same framing as the average animated frame. */
  transform: scale(1.33);
  animation: cover-drift var(--oscine-cover-drift) ease-in-out infinite alternate;
  /* The blur is expensive to recompute; promoting the layer means the drift is
     a composited transform of a cached result, not a re-blur per frame. */
  will-change: transform;
}

/*
 * Deliberately tiny. Over 42s a 10% scale swing is below the threshold where
 * the eye reads it as animation — it reads as the bar being alive.
 */
@keyframes cover-drift {
  from {
    transform: scale(1.33) translate3d(-1.5%, -1%, 0);
  }
  to {
    transform: scale(1.66) translate3d(1.5%, 1%, 0);
  }
}

/*
 * The affordance only appears on hover or focus. A permanent overlay on the
 * thumbnail would compete with the art it is sitting on, and the art is the
 * reason anyone looks at that corner of the bar.
 */
.cover-toggle {
  position: relative;
  display: block;
  cursor: pointer;
  overflow: hidden;
}

.cover-toggle:focus-visible {
  outline: 2px solid var(--ui-primary);
  outline-offset: 2px;
}

.cover-toggle-hint {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in oklab, var(--ui-bg-inverted) 55%, transparent);
  opacity: 0;
  transition: opacity 150ms ease;
}

.cover-toggle:hover .cover-toggle-hint,
.cover-toggle:focus-visible .cover-toggle-hint {
  opacity: 1;
}

/*
 * The thumbnail wipes sideways rather than blinking out, so the track info
 * slides into the space instead of teleporting across it.
 *
 * `1fr` → `0fr` on a grid column rather than a width transition: the thumbnail
 * is sized by its own content, so there is no authored pixel width to animate
 * from, and hardcoding one here would be a second source of truth for the
 * avatar's size.
 */
.cover-thumb {
  display: grid;
  grid-template-columns: 1fr;
}

.cover-thumb-inner {
  min-width: 0;
}

/*
 * Clipping only while it moves. A permanent `overflow: hidden` would crop the
 * button's focus ring, which sits outside the box by design.
 */
.coverThumb-enter-active .cover-thumb-inner,
.coverThumb-leave-active .cover-thumb-inner {
  overflow: hidden;
}

.coverThumb-enter-active,
.coverThumb-leave-active {
  transition:
    grid-template-columns 260ms ease,
    opacity 260ms ease;
}

.coverThumb-enter-from,
.coverThumb-leave-to {
  grid-template-columns: 0fr;
  opacity: 0;
}

.cover-enter-active,
.cover-leave-active {
  transition: opacity 700ms ease;
}

.cover-enter-from,
.cover-leave-to {
  opacity: 0;
}

.trackInfo-enter-active,
.trackInfo-leave-active {
  transition:
    opacity 300ms ease,
    transform 300ms ease;
}

/*
 * The volume slider keeps to itself until asked for. Collapsed it is width zero
 * and clipped; hover, keyboard focus, or an in-progress drag open it to the
 * slider's own width. Width — not opacity — carries the motion, so the icon and
 * readout slide together as it opens rather than the bar fading in over its
 * neighbours.
 */
.volume-track {
  width: 0;
  /*
   * Clip across, not down. The thumb stands taller and wider than the 1.5px
   * track it rides, so a plain `overflow: hidden` shaves it to a square as it
   * rides the ends and folds away. `clip` on one axis is what lets the other
   * stay `visible` — `hidden` would force it to `auto` — and the slider's own
   * `px-2` keeps the thumb clear of the horizontal clip at either extreme.
   */
  overflow-x: clip;
  overflow-y: visible;
  /*
   * The closing transition. A beat of delay so a cursor that clips the edge for
   * a moment doesn't fold the bar away, then a slightly slower ease-out as it
   * goes. Opening overrides both below to stay immediate — the reveal should
   * meet the cursor, and only the retreat is worth easing.
   */
  transition: width 260ms ease-out 250ms;
}

.volume.is-open .volume-track {
  width: 6rem;
  transition: width 150ms ease 0ms;
}

.trackInfo-enter-from {
  opacity: 0;
  transform: translateY(6px);
}

.trackInfo-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

@media (prefers-reduced-motion: reduce) {
  .cover-bleed-art {
    animation: none;
  }

  .cover-toggle-hint {
    transition-duration: 0ms;
  }

  .coverThumb-enter-active,
  .coverThumb-leave-active {
    transition-duration: 0ms;
  }

  .cover-enter-active,
  .cover-leave-active {
    transition-duration: 200ms;
  }

  .trackInfo-enter-active,
  .trackInfo-leave-active {
    transition-duration: 150ms;
  }

  .trackInfo-enter-from,
  .trackInfo-leave-to {
    transform: none;
  }

  .volume-track,
  .volume.is-open .volume-track {
    transition-duration: 0ms;
    transition-delay: 0ms;
  }
}
</style>
