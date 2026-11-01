/**
 * Messages between main and the query process — **W24-5**, `oscine-mcp` → D36.4.
 * Type-only, so the process entry imports nothing from main.
 */

export interface QueryRequest {
  id: number
  sql: string
  rowCap: number
}

/** Why a statement never ran. Each is the agent's to fix, not the app's. */
export type QueryRefusal =
  /** Empty, or nothing but comments. */
  | 'empty'
  /** More than one statement. */
  | 'multiple'
  /** Compiles, but returns no rows: a write, DDL, `VACUUM`, `ATTACH`… */
  | 'not-reader'
  /** Reads something outside the `mcp_*` views, or does something but read. */
  | 'not-authorized'
  /** SQLite rejected it: a syntax error, an unknown column, a runtime error. */
  | 'sql-error'

export type QueryCell = string | number | null

export interface QueryRows {
  ok: true
  columns: string[]
  rows: QueryCell[][]
  /** True when the statement had more rows than `rowCap`; the rest were dropped. */
  truncated: boolean
  /** Text cells cut to {@link MAX_CELL_CHARS}. */
  clippedCells: number
  elapsedMs: number
}

export interface QueryFailure {
  ok: false
  /**
   * `timeout`: the deadline passed and the process was killed (the host's).
   * `unavailable`: no process could answer — not the statement's fault.
   */
  refusal: QueryRefusal | 'timeout' | 'unavailable'
  message: string
}

export type QueryResult = QueryRows | QueryFailure

export type QueryResponse = QueryResult & { id: number }

/** A text cell longer than this is cut, so one wide row cannot flood the agent. */
export const MAX_CELL_CHARS = 2000
