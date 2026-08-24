import type Database from 'better-sqlite3'
import type { SearchQuery, SearchResult } from '@shared/search'
import { SearchStore } from './store'

/**
 * Everything the IPC layer needs from search, and nothing more — **D23**.
 *
 * The same seam `FavoriteService` and `StatsService` draw, and like them it
 * reaches no socket: the palette's finder is local by construction. Async on the
 * boundary rather than in the store, where the query is one synchronous grouped
 * read — the boundary is uniform, not the work behind it.
 */
export interface SearchService {
  /** One blended, grouped, ranked pass over every local entity type. */
  query(query: SearchQuery): Promise<SearchResult>
}

export interface SqliteSearchDeps {
  db: Database.Database
}

export class SqliteSearchService implements SearchService {
  private readonly store: SearchStore

  constructor(deps: SqliteSearchDeps) {
    this.store = new SearchStore(deps.db)
  }

  async query(query: SearchQuery): Promise<SearchResult> {
    return this.store.query(query)
  }
}
