import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { RemoveTagResult, Tag, TagSummary, TrackTagView } from '@shared/tags'
import { tags } from '@renderer/ipc'

/**
 * User tags in the renderer — **W15**.
 *
 * Two things the surfaces share and neither owns: the vocabulary the browse
 * column draws, and a per-track cache of the two vocabularies a deck pane or a
 * track row shows. Both are held here because a tag applied over *there* has to
 * be visible *here* without either surface re-fetching — the column that shows
 * the count and the pane that shows the assignment came from different requests
 * and neither watches the other.
 *
 * Nothing is staged. A write calls IPC and, on the authoritative answer main
 * hands back, updates the caches and publishes `changed` — the favorites store's
 * arrangement, and the settings convention: there is no OK/Cancel a tag edit
 * sits behind, the write is the gesture. `add` and `rename` answer with the
 * vocabulary row main minted rather than a guess, so the caches redraw from the
 * same truth two surfaces would otherwise disagree about.
 *
 * No push from main, following the favorites store: every change here is one
 * this renderer asked for, and a second window would need the broadcast this
 * deliberately does not invent yet.
 */
export const useTagsStore = defineStore('tags', () => {
  /**
   * The vocabulary with per-tag counts, for the browse-by-tag column. Empty
   * until `loadVocabulary` — a surface that needs it asks, and a write refreshes
   * it only while something is holding it.
   */
  const vocabulary = ref<TagSummary[]>([])

  /**
   * A track's two vocabularies as main last reported them, keyed by track id.
   *
   * A reactive `Map` for the favorites store's reason: reads are per-track inside
   * whatever pane is open, and Vue tracks `Map.get` at the key, so one track's
   * tags repaint without every other cached track re-rendering.
   */
  const trackTags = ref(new Map<number, TrackTagView>())

  /**
   * `forTrack` fetches in flight, by track id, so two mounts of the same track
   * share one round trip rather than each opening its own. Not reactive — it is
   * plumbing, and nothing renders off it.
   */
  const inFlight = new Map<number, Promise<TrackTagView>>()

  /**
   * The last write that landed, and a sequence so two edits are two events.
   *
   * Carries the track ids it touched, like favorites' `changed` carries its one:
   * a pane can tell whether it is looking at one of them without re-reading, and
   * only then reload. A rename with no id argument means "any track may carry
   * this" — see `noteChanged`.
   */
  const changed = ref<{ trackIds: readonly number[]; seq: number } | null>(null)

  /** Loads (or reloads) the vocabulary. The browse column's own call. */
  async function loadVocabulary(): Promise<void> {
    vocabulary.value = await tags.list()
  }

  /** The cached view for a track, or `undefined` if it has not been fetched. */
  function forTrack(trackId: number): TrackTagView | undefined {
    return trackTags.value.get(trackId)
  }

  /**
   * Fetches a track's tags once and caches them, returning the cached view on
   * every later call. A second concurrent request for the same track waits on
   * the first rather than opening its own.
   */
  async function ensureTrack(trackId: number): Promise<TrackTagView> {
    const cached = trackTags.value.get(trackId)
    if (cached) return cached
    const existing = inFlight.get(trackId)
    if (existing) return existing
    const pending = tags
      .forTrack(trackId)
      .then((view) => {
        trackTags.value.set(trackId, view)
        return view
      })
      .finally(() => {
        inFlight.delete(trackId)
      })
    inFlight.set(trackId, pending)
    return pending
  }

  /**
   * Applies one label to a batch and reflects what main coined.
   *
   * Never rejects: a tag write that could throw into a selection gesture is a
   * decoration with the power to break it. A failed add costs the edit and
   * nothing else, and answers `null` — the same answer main gives for a label
   * that normalised away, which the validate layer already refuses.
   */
  async function add(trackIds: readonly number[], label: string): Promise<Tag | null> {
    try {
      const tag = await tags.add(trackIds, label)
      if (tag) applyAdded(trackIds, tag)
      return tag
    } catch {
      return null
    }
  }

  /** Removes one tag from a batch and reflects the removal. Never rejects. */
  async function remove(trackIds: readonly number[], tagId: number): Promise<RemoveTagResult> {
    try {
      const result = await tags.remove(trackIds, tagId)
      applyRemoved(trackIds, tagId)
      return result
    } catch {
      return { removed: 0, pruned: false }
    }
  }

  /**
   * Re-spells one tag and reflects the surviving row.
   *
   * The survivor's id may differ from the one asked to rename — that is a merge,
   * and the caches repoint the old id onto it. Never rejects.
   */
  async function rename(tagId: number, label: string): Promise<Tag | null> {
    try {
      const tag = await tags.rename(tagId, label)
      if (tag) applyRenamed(tagId, tag)
      return tag
    } catch {
      return null
    }
  }

  function applyAdded(trackIds: readonly number[], tag: Tag): void {
    for (const trackId of trackIds) {
      const view = trackTags.value.get(trackId)
      if (!view) continue
      if (view.user.some((t) => t.id === tag.id)) continue
      trackTags.value.set(trackId, {
        file: view.file,
        user: [...view.user, { id: tag.id, label: tag.label, source: 'user' }]
      })
    }
    noteChanged(trackIds)
  }

  function applyRemoved(trackIds: readonly number[], tagId: number): void {
    for (const trackId of trackIds) {
      const view = trackTags.value.get(trackId)
      if (!view) continue
      const user = view.user.filter((t) => t.id !== tagId)
      if (user.length === view.user.length) continue
      trackTags.value.set(trackId, { file: view.file, user })
    }
    noteChanged(trackIds)
  }

  function applyRenamed(tagId: number, tag: Tag): void {
    // A rename can touch any cached track that carries the old id, not a known
    // batch — so every view is rewritten: the old id becomes the survivor's,
    // relabelled, and a track that already held the survivor keeps one copy.
    for (const [trackId, view] of trackTags.value) {
      if (!view.user.some((t) => t.id === tagId)) continue
      const seen = new Set<number>()
      const user = view.user
        .map((t) => (t.id === tagId ? { id: tag.id, label: tag.label, source: t.source } : t))
        .filter((t) => {
          if (seen.has(t.id)) return false
          seen.add(t.id)
          return true
        })
      trackTags.value.set(trackId, { file: view.file, user })
    }
    // No id list: a listener that shows any track has to consider itself touched.
    noteChanged([])
  }

  function noteChanged(trackIds: readonly number[]): void {
    changed.value = { trackIds, seq: (changed.value?.seq ?? 0) + 1 }
    // Refresh the vocabulary only while a surface is holding it — a count moved,
    // and possibly a row appeared or a merge took one away.
    if (vocabulary.value.length > 0) void refreshVocabulary()
  }

  async function refreshVocabulary(): Promise<void> {
    try {
      vocabulary.value = await tags.list()
    } catch {
      // Silent: a stale count is a smaller wrong than a thrown reload.
    }
  }

  return {
    vocabulary,
    trackTags,
    changed,
    loadVocabulary,
    forTrack,
    ensureTrack,
    add,
    remove,
    rename,
    refreshVocabulary
  }
})
