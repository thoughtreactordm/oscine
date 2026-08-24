import { ref, type Ref } from 'vue'
import type { SearchQuery, SearchResult } from '@shared/search'
import { parsePaletteQuery, queryReachesMain, type ParsedPaletteQuery } from './paletteMode'

/**
 * The entity side of the palette — the debounced, mode-scoped caller of
 * `search.query` (RQ1's async half).
 *
 * A factory rather than a store so the query function is injected and the whole
 * thing runs under the node test config: the debounce, the mode gate and the
 * stale-response guard are the parts worth testing, and none of them needs a
 * component. `CommandPalette.vue` builds one with the real `search.query`.
 *
 * Two brakes live here. `action` and `setting` modes never call main — their
 * groups are renderer registries — and an empty query calls nothing, so the
 * channel is only hit when there is something to rank. The per-group cap is the
 * third, carried on every request (RQ2).
 */

const EMPTY: SearchResult = { groups: [] }

export interface PaletteSearchDeps {
  query: (query: SearchQuery) => Promise<SearchResult>
  /** Debounce before a keystroke becomes a request. */
  debounceMs?: number
  /** The D21 per-group cap, well under `MAX_SEARCH_LIMIT_PER_GROUP`. */
  limitPerGroup?: number
}

export interface PaletteSearch {
  readonly parsed: Ref<ParsedPaletteQuery>
  readonly result: Ref<SearchResult>
  readonly loading: Ref<boolean>
  /** Feed the raw input, prefix and all; the parse and the debounce happen here. */
  setTerm(raw: string): void
  /** Drop any in-flight request and clear the state — call it as the palette closes. */
  reset(): void
}

export function createPaletteSearch(deps: PaletteSearchDeps): PaletteSearch {
  const debounceMs = deps.debounceMs ?? 150
  const limitPerGroup = deps.limitPerGroup ?? 8
  const parsed = ref<ParsedPaletteQuery>({ mode: 'blended', text: '' })
  const result = ref<SearchResult>(EMPTY)
  const loading = ref(false)

  let handle: ReturnType<typeof setTimeout> | null = null
  /**
   * Every `setTerm` bumps this, so a response that resolves after the query
   * moved on is dropped rather than painted over the current one — the classic
   * out-of-order fix for a debounced async box.
   */
  let seq = 0

  function clearTimer(): void {
    if (handle !== null) {
      clearTimeout(handle)
      handle = null
    }
  }

  function setTerm(raw: string): void {
    const next = parsePaletteQuery(raw)
    parsed.value = next
    clearTimer()
    seq += 1

    if (!queryReachesMain(next.mode) || next.text.length === 0) {
      result.value = EMPTY
      loading.value = false
      return
    }

    loading.value = true
    const ticket = seq
    handle = setTimeout(() => {
      handle = null
      void run(next, ticket)
    }, debounceMs)
  }

  async function run(query: ParsedPaletteQuery, ticket: number): Promise<void> {
    try {
      const res = await deps.query({ text: query.text, mode: query.mode, limitPerGroup })
      if (ticket === seq) result.value = res
    } catch {
      if (ticket === seq) result.value = EMPTY
    } finally {
      if (ticket === seq) loading.value = false
    }
  }

  function reset(): void {
    clearTimer()
    seq += 1
    parsed.value = { mode: 'blended', text: '' }
    result.value = EMPTY
    loading.value = false
  }

  return { parsed, result, loading, setTerm, reset }
}
