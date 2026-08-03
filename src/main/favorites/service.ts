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
import { FavoriteStore } from './store'

/**
 * Everything the IPC layer needs from favorites, and nothing more — **D18**.
 *
 * The same seam `PlayHistoryService`, `ListenService` and `StatsService` draw.
 * Async on the boundary rather than in the store: every method below is one
 * synchronous SQLite statement or a transaction of two, and a `toggle` that
 * yielded halfway would be a heart that had left one state without arriving at
 * the other.
 *
 * Nothing here reaches a socket, and that is a property of this card rather
 * than an accident of what is built so far. Pushing a `track.love` to a
 * connected account is D19 and W11-6; it enqueues in the outbox alongside this
 * write, and until it exists the heart is complete without it.
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
}

export class SqliteFavoriteService implements FavoriteService {
  private readonly store: FavoriteStore

  constructor(deps: SqliteFavoriteDeps) {
    this.store = new FavoriteStore(deps.db)
  }

  async toggle(trackId: number): Promise<FavoriteState> {
    return this.store.toggle(trackId)
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
    return this.store.removeMany(trackIds)
  }
}
