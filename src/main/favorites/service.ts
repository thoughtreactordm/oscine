import type Database from 'better-sqlite3'
import type {
  ArtistFavoritesQuery,
  ArtistFavoritesResult,
  FavoriteState,
  FavoriteStateResult,
  ListFavoriteIdsQuery,
  ListFavoriteIdsResult,
  ListFavoritesQuery,
  ListFavoritesResult,
  RemoveFavoritesResult
} from '@shared/favorites'
import { FavoriteStore, type FavoriteScrobbleSink } from './store'

/**
 * Everything the IPC layer needs from favorites, and nothing more — **D18**.
 *
 * The same seam `PlayHistoryService`, `ListenService` and `StatsService` draw.
 * Async on the boundary rather than in the store: every method below is one
 * synchronous SQLite statement or a transaction of two, and a `toggle` that
 * yielded halfway would be a heart that had left one state without arriving at
 * the other.
 *
 * Nothing here reaches a socket, and that stayed true when W11-6 arrived. The
 * loved push writes a `scrobble_queue` row inside the same transaction as the
 * heart and tells the drain worker there is something to do; the sending happens
 * over there, on its own schedule, and a favorite that could not be pushed is
 * still a favorite. That is what makes the gesture instant with the network
 * down, and it is why `toggle` returns the local state rather than a verdict.
 */
export interface FavoriteService {
  /** Flips one track's heart and answers with the state that resulted. */
  toggle(trackId: number): Promise<FavoriteState>
  /** Which of these track ids are favorited. One query, whatever the batch size. */
  state(trackIds: readonly number[]): Promise<FavoriteStateResult>
  /** A page of favorites as display rows, newest-hearted first. */
  list(query: ListFavoritesQuery): Promise<ListFavoritesResult>
  /** The same page as ids, for a range selection and for reading the whole set. */
  listIds(query: ListFavoriteIdsQuery): Promise<ListFavoriteIdsResult>
  /** The seed track's artist's favorites, bounded and newest-hearted first. */
  byArtist(query: ArtistFavoritesQuery): Promise<ArtistFavoritesResult>
  /** Un-favorites a batch. Ids that were not favorited are simply not removed. */
  remove(trackIds: readonly number[]): Promise<RemoveFavoritesResult>
}

export interface SqliteFavoriteDeps {
  db: Database.Database
  /** D19's outbox and its targets. Omitted means this build does not scrobble. */
  scrobble?: FavoriteScrobbleSink
  /**
   * Told after a gesture that may have enqueued, so the drain worker can wake.
   *
   * `ListenService.onCommitted`'s twin, and injected for its reason: the service
   * does not know what a love is, and `main/index.ts` is where the two are
   * joined. Called outside the transaction and never awaited — a drain is a
   * network round trip and the heart must not be holding a write lock through
   * one.
   *
   * Called on every gesture rather than only on one that enqueued, because this
   * layer cannot see whether the store enqueued anything and a wake that finds
   * an empty queue costs a count. It is the cheap half of the pair; the
   * expensive half is a heart that sits unsent until the five-minute backstop,
   * which reads as broken to the operator refreshing their profile.
   */
  onChanged?: () => void
}

export class SqliteFavoriteService implements FavoriteService {
  private readonly store: FavoriteStore
  private readonly onChanged: (() => void) | null

  constructor(deps: SqliteFavoriteDeps) {
    this.store = new FavoriteStore(deps.db, {
      ...(deps.scrobble ? { scrobble: deps.scrobble } : {})
    })
    this.onChanged = deps.onChanged ?? null
  }

  async toggle(trackId: number): Promise<FavoriteState> {
    const state = this.store.toggle(trackId)
    this.onChanged?.()
    return state
  }

  async state(trackIds: readonly number[]): Promise<FavoriteStateResult> {
    return this.store.state(trackIds)
  }

  async list(query: ListFavoritesQuery): Promise<ListFavoritesResult> {
    return this.store.list(query)
  }

  async listIds(query: ListFavoriteIdsQuery): Promise<ListFavoriteIdsResult> {
    return this.store.listIds(query)
  }

  async byArtist(query: ArtistFavoritesQuery): Promise<ArtistFavoritesResult> {
    return this.store.byArtist(query)
  }

  async remove(trackIds: readonly number[]): Promise<RemoveFavoritesResult> {
    const result = this.store.removeMany(trackIds)
    this.onChanged?.()
    return result
  }
}
