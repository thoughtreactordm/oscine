<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  briefChanged,
  exclusionLabel,
  exclusionSourceLabel,
  normalizeBrief,
  refreshedLabel,
  SMART_PLAYLIST_ICON,
  SMART_PLAYLIST_LABEL
} from '@renderer/panels/smartPlaylist'
import { usePlaylistsStore } from '@renderer/stores/playlists'
import { MAX_PLAYLIST_BRIEF_LENGTH, type Playlist, type PlaylistExclusion } from '@shared/playlists'

/**
 * A smart playlist's header controls — **W24-9**, `oscine-mcp` → D36.8.
 *
 * The badge opens the operator's side of the flag: the brief they write, the
 * notes the last agent left (read-only here; only an agent writes them), and
 * the tracks kept out, each of which can be let back in. Nothing here asks an
 * agent to do anything — that is the operator's own client, never this app.
 */
const props = defineProps<{ playlist: Playlist }>()

const playlists = usePlaylistsStore()

/** Exclusions are drawn up to here; Clear all reaches the rest. */
const MAX_DRAWN_EXCLUSIONS = 200

const open = ref(false)
const draft = ref('')
const saving = ref(false)
const exclusions = ref<PlaylistExclusion[]>([])
const loadingExclusions = ref(false)

const canSave = computed(() => !saving.value && briefChanged(draft.value, props.playlist.brief))
const drawn = computed(() => exclusions.value.slice(0, MAX_DRAWN_EXCLUSIONS))

async function loadExclusions(): Promise<void> {
  loadingExclusions.value = true
  const rows = await playlists.listExclusions(props.playlist.id)
  loadingExclusions.value = false
  if (rows !== null) exclusions.value = rows
}

// Opening starts from what is stored; an agent may have changed it since.
watch(open, (isOpen) => {
  if (!isOpen) return
  draft.value = props.playlist.brief ?? ''
  void loadExclusions()
})

// A removal, a Clear or an agent's write while the popover is open.
watch(
  () => [props.playlist.id, props.playlist.exclusionCount, props.playlist.updatedAt] as const,
  () => {
    if (open.value) void loadExclusions()
  }
)

async function saveBrief(): Promise<void> {
  if (!canSave.value) return
  saving.value = true
  const saved = await playlists.setBrief(props.playlist.id, normalizeBrief(draft.value))
  saving.value = false
  if (saved) draft.value = props.playlist.brief ?? ''
}

function letBackIn(trackId: number): void {
  void playlists.clearExclusions(props.playlist.id, [trackId])
}

function clearAll(): void {
  void playlists.clearExclusions(props.playlist.id)
}

function makeStatic(): void {
  open.value = false
  void playlists.setKind(props.playlist.id, 'static')
}
</script>

<template>
  <UPopover v-model:open="open" :ui="{ content: 'w-96' }">
    <UTooltip :text="SMART_PLAYLIST_LABEL">
      <UButton
        size="xs"
        color="primary"
        variant="subtle"
        :icon="SMART_PLAYLIST_ICON"
        label="Smart"
        :aria-label="`${SMART_PLAYLIST_LABEL}. Show brief and exclusions.`"
      />
    </UTooltip>

    <template #content>
      <div class="flex flex-col">
        <div class="flex flex-col gap-0.5 border-b border-default px-3 py-2">
          <h3 class="text-sm font-semibold text-highlighted">Smart playlist</h3>
          <p class="text-xs text-muted">
            {{ SMART_PLAYLIST_LABEL }}. Ask your agent to refresh it; Oscine never changes it on its
            own.
          </p>
        </div>

        <form
          class="flex flex-col gap-2 border-b border-default px-3 py-2"
          @submit.prevent="saveBrief"
        >
          <UFormField label="Brief" help="What belongs here, in your own words.">
            <UTextarea
              v-model="draft"
              :rows="3"
              autoresize
              :maxrows="8"
              :maxlength="MAX_PLAYLIST_BRIEF_LENGTH"
              placeholder="Late-night instrumental hip-hop, no vocals, nothing over 95 BPM"
              class="w-full"
            />
          </UFormField>
          <div class="flex justify-end">
            <UButton type="submit" size="xs" :disabled="!canSave" :loading="saving">
              Save brief
            </UButton>
          </div>
        </form>

        <div class="flex flex-col gap-1 border-b border-default px-3 py-2">
          <div class="flex items-center gap-2">
            <h4 class="text-xs font-semibold text-highlighted">Agent notes</h4>
            <span class="ms-auto text-xs text-dimmed">
              {{ refreshedLabel(playlist.refreshedAt) }}
            </span>
          </div>
          <p
            v-if="playlist.agentNotes !== null"
            class="max-h-32 overflow-y-auto whitespace-pre-wrap break-words text-xs text-muted"
          >
            {{ playlist.agentNotes }}
          </p>
          <p v-else class="text-xs text-dimmed">None yet. Your agent leaves them on a refresh.</p>
        </div>

        <div class="flex flex-col gap-1 px-3 py-2">
          <div class="flex items-center gap-2">
            <h4 class="text-xs font-semibold text-highlighted">
              Kept out ({{ playlist.exclusionCount.toLocaleString() }})
            </h4>
            <UButton
              v-if="playlist.exclusionCount > 0"
              class="ms-auto"
              size="xs"
              color="neutral"
              variant="ghost"
              icon="i-tabler-arrow-back-up"
              @click="clearAll"
            >
              Clear all
            </UButton>
          </div>
          <p v-if="playlist.exclusionCount === 0" class="text-xs text-dimmed">
            Tracks you remove stay out of later refreshes. Adding one back by hand lets it in.
          </p>
          <ul v-else class="max-h-48 overflow-y-auto" :aria-busy="loadingExclusions">
            <li
              v-for="exclusion in drawn"
              :key="exclusion.trackId"
              class="flex items-center gap-2 py-0.5 text-xs"
            >
              <span class="min-w-0 flex-1 truncate text-default" :title="exclusionLabel(exclusion)">
                {{ exclusionLabel(exclusion) }}
              </span>
              <span class="shrink-0 text-dimmed">{{ exclusionSourceLabel(exclusion) }}</span>
              <UButton
                size="xs"
                color="neutral"
                variant="ghost"
                icon="i-tabler-arrow-back-up"
                :aria-label="`Let ${exclusionLabel(exclusion)} back in`"
                @click="letBackIn(exclusion.trackId)"
              />
            </li>
            <li v-if="exclusions.length > drawn.length" class="py-0.5 text-xs text-dimmed">
              and {{ (exclusions.length - drawn.length).toLocaleString() }} more
            </li>
          </ul>
        </div>

        <div class="flex justify-end border-t border-default px-3 py-2">
          <UButton
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-tabler-playlist"
            @click="makeStatic"
          >
            Make static
          </UButton>
        </div>
      </div>
    </template>
  </UPopover>
</template>
