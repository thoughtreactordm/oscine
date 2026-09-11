import net from 'node:net'

/**
 * The socket the `DiscordClient` writes frames to — **W20-2**.
 *
 * A narrow duplex, not `net.Socket`, so the client's handshake and reconnect
 * logic is tested against a fake in `tests/main/` with no live Discord and no
 * real socket. The real implementation wraps `net.Socket`, which speaks both
 * unix sockets and Windows named pipes through the same `path` connection — so
 * the only platform difference is the path, and that lives in `socketPaths.ts`.
 */
export interface DiscordSocket {
  write(data: Buffer): void
  onData(listener: (chunk: Buffer) => void): void
  onClose(listener: () => void): void
  onError(listener: (error: Error) => void): void
  destroy(): void
}

/**
 * Opens the first socket path that accepts a connection, or `null` when none do.
 *
 * **Never rejects.** A path that no process is listening on is Discord not
 * running — a normal, expected state (R12), not an error the client should have
 * to catch. The client treats `null` as "unavailable" and schedules a retry.
 */
export type DiscordConnector = (candidates: readonly string[]) => Promise<DiscordSocket | null>

export const connectFirstSocket: DiscordConnector = async (candidates) => {
  for (const socketPath of candidates) {
    const socket = await connectOne(socketPath)
    if (socket) return socket
  }
  return null
}

function connectOne(socketPath: string): Promise<DiscordSocket | null> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ path: socketPath })
    const onError = (): void => {
      socket.destroy()
      resolve(null)
    }
    socket.once('error', onError)
    socket.once('connect', () => {
      socket.removeListener('error', onError)
      resolve(wrapSocket(socket))
    })
  })
}

function wrapSocket(socket: net.Socket): DiscordSocket {
  return {
    write: (data) => {
      // Best-effort: a write that races a close throws EPIPE, and there is
      // nothing to do with it but let the close handler reconnect.
      try {
        socket.write(data)
      } catch {
        socket.destroy()
      }
    },
    onData: (listener) => socket.on('data', listener),
    onClose: (listener) => socket.on('close', listener),
    onError: (listener) => socket.on('error', listener),
    destroy: () => socket.destroy()
  }
}
