<script setup lang="ts">
/**
 * Curate's body.
 *
 * Scaffold for W5, and deliberately a different idiom from the Library tab: a
 * scrolling wall of artwork rather than a dense grid of rows. Library is where
 * a hundred thousand tracks are searched; Curate is where a few dozen curated
 * things are browsed, and the two do not want the same furniture.
 *
 * The shelves are placeholders. What replaces them is real data behind a
 * virtualized container — a wall of cards is still a list, and lists here are
 * virtualized from their first commit.
 */
const shelves = [
  { id: 'playlists', title: 'Your playlists', icon: 'i-tabler-playlist' },
  { id: 'recent', title: 'Recently played', icon: 'i-tabler-history' },
  { id: 'albums', title: 'Albums you own', icon: 'i-tabler-vinyl' }
]
</script>

<template>
  <section class="flex h-full min-h-0 min-w-0 flex-col bg-default" aria-label="Curate">
    <div class="flex h-9 shrink-0 items-center gap-2 border-b border-default bg-elevated/40 px-2">
      <UIcon name="i-tabler-sparkles" class="size-4 text-primary" />
      <h2 class="font-semibold text-highlighted">Curate</h2>
      <UBadge class="ml-auto" color="neutral" variant="subtle" size="sm">Scaffold</UBadge>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto flex max-w-5xl flex-col gap-8 p-6">
        <header class="flex flex-col gap-1">
          <p class="text-xs font-semibold uppercase tracking-widest text-primary">Collection</p>
          <h3 class="text-3xl font-bold tracking-tight text-highlighted">Make something of it</h3>
          <p class="max-w-prose text-sm text-muted">
            Playlists, smart rules and the queue live here. Nothing is wired up yet — this tab
            exists so the frame around it can be.
          </p>
        </header>

        <section v-for="shelf in shelves" :key="shelf.id" class="flex flex-col gap-3">
          <div class="flex items-center gap-2">
            <UIcon :name="shelf.icon" class="size-4 text-dimmed" />
            <h4 class="text-sm font-semibold text-highlighted">{{ shelf.title }}</h4>
          </div>
          <div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <div v-for="slot in 5" :key="slot" class="flex flex-col gap-2">
              <div class="aspect-square rounded-lg border border-default bg-elevated/60" />
              <USkeleton class="h-3 w-3/4" />
              <USkeleton class="h-3 w-1/2" />
            </div>
          </div>
        </section>
      </div>
    </div>
  </section>
</template>
