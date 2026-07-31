<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { addToPlaylistLabel } from '@renderer/panels/addToPlaylist'
import { PLAYLIST_NAME_MAX_LENGTH } from '@renderer/panels/playlistRename'
import { useAddToPlaylistStore } from '@renderer/stores/addToPlaylist'

/**
 * The name prompt for "New playlist…", and the only thing that reports how an
 * add went.
 *
 * Mounted once by the frame rather than by whichever pane offered the gesture,
 * and that is the whole reason it is a component of its own. The Artists pane is
 * a routed sidebar view: it is unmounted the moment the operator glances at Now
 * Playing, and a modal living inside it would vanish mid-typing. The frame
 * outlives every tab, so this does too — and so does the background add it
 * starts, which is what lets the dialog close before the work is finished.
 *
 * The toast is here for the same reason and one more: `useToast` is a composable
 * and wants a component, while the store that performs the add is deliberately
 * neither. The store publishes an outcome the way `playlists` publishes
 * `entriesEdited` — a value with a sequence, so two adds to the same playlist
 * are two notifications — and this watches it.
 *
 * It matters that something does. These adds run detached from the click that
 * started them, from a tab where `playlists.notice` is not drawn: without this,
 * a failed add while browsing the library would be entirely silent.
 */
const model = useAddToPlaylistStore()
const toast = useToast()

const nameInput = ref<{ inputRef: HTMLInputElement | null } | null>(null)

const heading = computed(() => addToPlaylistLabel(model.count, model.unit))

/**
 * Blank is a cancel further in — see `confirm` — but the button says so up
 * front rather than looking live and then doing nothing.
 */
const canConfirm = computed(() => model.draft.trim().length > 0)

/**
 * Focused and *selected*, because the field is usually not empty: an album or
 * an artist arrives with its own name suggested, and a suggestion the operator
 * has to clear by hand is worse than no suggestion at all.
 *
 * After a tick — `UModal` mounts its content when it opens, so on the frame the
 * watcher fires there is nothing to focus yet.
 */
watch(
  () => model.open,
  async (open) => {
    if (!open) return
    await nextTick()
    const input = nameInput.value?.inputRef
    input?.focus()
    input?.select()
  }
)

watch(
  () => model.outcome,
  (outcome) => {
    if (!outcome) return
    toast.add({
      title: outcome.message,
      icon: outcome.kind === 'added' ? 'i-tabler-playlist-add' : 'i-tabler-alert-triangle',
      color: outcome.kind === 'added' ? 'primary' : 'warning'
    })
  }
)
</script>

<template>
  <UModal
    :open="model.open"
    :title="heading"
    description="It appears in the rail. Nothing opens — carry on browsing."
    :ui="{ footer: 'justify-end' }"
    @update:open="(value: boolean) => !value && model.cancel()"
  >
    <template #body>
      <UFormField label="Playlist name" :ui="{ label: 'sr-only' }">
        <UInput
          ref="nameInput"
          v-model="model.draft"
          class="w-full"
          placeholder="Playlist name"
          :maxlength="PLAYLIST_NAME_MAX_LENGTH"
          aria-label="Playlist name"
          @keydown.enter.prevent="model.confirm()"
          @keydown.esc.prevent="model.cancel()"
        />
      </UFormField>
    </template>

    <template #footer>
      <UButton color="neutral" variant="ghost" @click="model.cancel()">Cancel</UButton>
      <UButton
        color="primary"
        icon="i-tabler-plus"
        :disabled="!canConfirm"
        @click="model.confirm()"
      >
        Create
      </UButton>
    </template>
  </UModal>
</template>
