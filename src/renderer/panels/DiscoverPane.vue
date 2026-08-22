<script setup lang="ts">
/**
 * What Discover shows: shelves, and nothing behind them yet.
 *
 * The pane is a placeholder and says so on its face rather than in a comment —
 * an operator who cannot tell a stubbed shelf from an empty one will report the
 * wrong bug. What it is *not* is a scaffold in the earlier sense: Discover is
 * permanent, so this file is the beginning of a pane rather than a stand-in for
 * one, and the shelves are the shape the real thing will fill.
 *
 * A different idiom from the Library tab on purpose. Library is where a hundred
 * thousand tracks are searched, and it is a dense grid of rows because that is
 * what searching wants. Discover is where a few dozen curated things are
 * browsed, and a wall of artwork is what browsing wants. The two tabs do not
 * want the same furniture.
 *
 * Not virtualized, and not an exception to the invariant: there is no list here.
 * The shelves are a fixed number of fixed skeletons with no source under them.
 * The commit that gives a shelf real rows is the commit that has to virtualize
 * it — a wall of cards is still a list — and that is why each shelf is already
 * its own element with its own scroll axis rather than a `flex-wrap` of squares
 * that would have to be torn apart before anything could window them.
 */
const shelves = [
  { id: 'for-you', title: 'Built for you', hint: 'From what you have been playing', slots: 6 },
  { id: 'unplayed', title: 'Sitting unplayed', hint: 'In your library, never heard', slots: 6 },
  { id: 'revisit', title: 'Worth revisiting', hint: 'Played once, a long time ago', slots: 6 },
  {
    id: 'artists',
    title: 'Deep in an artist',
    hint: 'Where the tail of a discography is',
    slots: 6
  }
]
</script>

<template>
  <div class="h-full min-h-0 overflow-y-auto">
    <div class="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-8">
      <header class="flex flex-col gap-2">
        <div class="flex items-center gap-2">
          <p class="text-xs font-semibold uppercase tracking-widest text-primary">Discover</p>
          <UBadge color="neutral" variant="subtle" size="sm">Placeholder</UBadge>
        </div>
        <h2 class="text-3xl font-bold tracking-tight text-highlighted">
          Everything you own, arranged for you
        </h2>
        <p class="max-w-prose text-sm text-muted">
          Shelves that read your library the way a streaming service reads its catalogue — except
          the catalogue is yours, and nothing here phones anywhere. Pick a playlist from the rail to
          edit one, or start a new one from a shelf once these are wired up.
        </p>
      </header>

      <section v-for="shelf in shelves" :key="shelf.id" class="flex flex-col gap-3">
        <div class="flex items-baseline gap-3">
          <h3 class="text-sm font-semibold text-highlighted">{{ shelf.title }}</h3>
          <p class="text-xs text-dimmed">{{ shelf.hint }}</p>
        </div>

        <!--
          Its own horizontal scroller per shelf, which is the axis the real
          version windows along. `overflow-x-auto` here rather than a wrap so
          that adding a viewport to one shelf later does not change the layout of
          the others.
        -->
        <div class="flex gap-4 overflow-x-auto pb-1">
          <div v-for="slot in shelf.slots" :key="slot" class="flex w-40 shrink-0 flex-col gap-2">
            <div
              class="flex aspect-square items-center justify-center rounded-lg border border-default bg-elevated/60"
            >
              <UIcon name="i-tabler-vinyl" class="size-8 text-dimmed/40" aria-hidden="true" />
            </div>
            <USkeleton class="h-3 w-3/4" />
            <USkeleton class="h-3 w-1/2" />
          </div>
        </div>
      </section>
    </div>
  </div>
</template>
