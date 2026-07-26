import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import {
  isFermataError,
  type IpcErrorPayload,
  type IpcResult
} from '@shared/errors'
import {
  IPC_CHANNELS,
  type IpcChannel,
  type IpcEventChannel,
  type IpcEventPayload,
  type IpcRequest,
  type IpcResponse
} from '@shared/ipc'

export type IpcHandler<C extends IpcChannel> = (
  request: IpcRequest<C>,
  event: IpcMainInvokeEvent
) => Promise<IpcResponse<C>> | IpcResponse<C>

const registered = new Set<IpcChannel>()

/**
 * URL prefix the renderer is expected to be served from. Compared as a prefix
 * rather than by origin because every `file://` URL reports its origin as the
 * string `"null"` — origin comparison would therefore accept *any* local file.
 */
let trustedUrlPrefix: string | null = null

export function setTrustedRendererUrl(url: string): void {
  trustedUrlPrefix = url
}

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  if (!trustedUrlPrefix) return false
  try {
    const frame = event.senderFrame
    // Top-level frame only: a nested frame has no business invoking main.
    if (!frame || frame.parent !== null) return false
    return frame.url.startsWith(trustedUrlPrefix)
  } catch {
    // senderFrame throws if the frame was destroyed mid-call.
    return false
  }
}

/**
 * Converts anything thrown by a handler into a payload that is safe to hand the
 * renderer.
 *
 * A `FermataError` was raised deliberately, so its code and message pass
 * through. Anything else is unanticipated and could carry an absolute path, a
 * SQL fragment or a stack trace in its message — so the detail is logged here,
 * in main, and the renderer gets a generic error instead.
 */
function toSafeError(channel: IpcChannel, err: unknown): IpcErrorPayload {
  if (isFermataError(err)) {
    return { code: err.code, message: err.message }
  }
  console.error(`[ipc] unhandled failure on ${channel}:`, err)
  return {
    code: 'internal',
    message: 'Something went wrong. See the application log for details.'
  }
}

/**
 * Registers the one handler for a channel.
 *
 * The generic ties `handler` to the channel's entry in `IpcContract`, so a
 * handler returning the wrong shape is a compile error rather than a runtime
 * surprise in the renderer.
 */
export function handle<C extends IpcChannel>(channel: C, handler: IpcHandler<C>): void {
  if (registered.has(channel)) {
    throw new Error(`IPC channel registered twice: ${channel}`)
  }
  registered.add(channel)

  ipcMain.handle(channel, async (event, request): Promise<IpcResult<IpcResponse<C>>> => {
    if (!isTrustedSender(event)) {
      console.error(`[ipc] rejected ${channel} from untrusted sender`)
      return { ok: false, error: { code: 'invalid-request', message: 'Request rejected.' } }
    }
    try {
      return { ok: true, value: await handler(request as IpcRequest<C>, event) }
    } catch (err) {
      return { ok: false, error: toSafeError(channel, err) }
    }
  })
}

/**
 * Fails fast at startup if a channel in the contract has no handler.
 *
 * Without this, a missing handler surfaces as an inscrutable rejection the
 * first time a user clicks something, possibly milestones later.
 */
export function assertEveryChannelHandled(): void {
  const missing = IPC_CHANNELS.filter((channel) => !registered.has(channel))
  if (missing.length > 0) {
    throw new Error(`IPC channels declared but not handled: ${missing.join(', ')}`)
  }
}

/** Pushes a one-way event to a renderer. */
export function emit<E extends IpcEventChannel>(
  target: WebContents,
  channel: E,
  payload: IpcEventPayload<E>
): void {
  if (target.isDestroyed()) return
  target.send(channel, payload)
}
