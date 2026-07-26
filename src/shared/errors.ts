/**
 * Error vocabulary shared by both sides of the IPC boundary.
 *
 * This module must stay free of any Node or Electron import: the renderer
 * imports it, and the renderer has no filesystem.
 */

export const IPC_ERROR_CODES = [
  /** The request failed validation in main. Treat as a programming error. */
  'invalid-request',
  /** The requested entity does not exist, or is no longer readable. */
  'not-found',
  /** The operation collides with existing state, e.g. adding a duplicate root. */
  'conflict',
  /** The filesystem or database refused the operation. */
  'io-error',
  /** The user dismissed a dialog, or the operation was aborted. */
  'cancelled',
  /** Anything unanticipated. The message is always generic — see `toSafeError`. */
  'internal'
] as const

export type IpcErrorCode = (typeof IPC_ERROR_CODES)[number]

/**
 * The only error shape that crosses IPC.
 *
 * `message` is contractually safe to display: it never carries a stack trace,
 * and never carries an absolute path. Main-side detail is logged in main and
 * deliberately not forwarded — see `toSafeError` in `src/main/ipc/registry.ts`.
 */
export interface IpcErrorPayload {
  code: IpcErrorCode
  message: string
}

/**
 * Thrown in main for *expected* failures, where the code and message are
 * chosen deliberately and are safe to show the user. The preload bridge
 * re-throws the same shape in the renderer, so one `catch` works on both sides.
 *
 * Anything that is not a `FermataError` is treated as unanticipated and
 * flattened to a generic `internal` error before it leaves main.
 */
export class FermataError extends Error {
  readonly code: IpcErrorCode

  constructor(code: IpcErrorCode, message: string) {
    super(message)
    this.name = 'FermataError'
    this.code = code
  }
}

export function isFermataError(value: unknown): value is FermataError {
  return value instanceof FermataError
}

/** Discriminated envelope every handler returns. Never thrown across the wire. */
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: IpcErrorPayload }
