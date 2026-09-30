import path from 'node:path'

/**
 * Where Discord's local-IPC socket lives, per platform — **W20-2**.
 *
 * This is the one place platform difference lives: the `DiscordClient` above it
 * is handed a candidate list and never sees a path literal, the way `AudioEngine`
 * hides Web Audio and `CdDrive` hides the ioctl backends. Discord registers its
 * socket at index `0..9` (multiple running clients take successive indices), so
 * the probe walks the indices and the caller takes the first that answers.
 *
 * On Linux the socket sits in the XDG runtime dir, but a Flatpak or Snap Discord
 * confines it to a sandbox subdir, so those variants are probed too. On Windows
 * it is a named pipe, which is an OS IPC endpoint rather than a stored library
 * path — the one honest exception to `oscine/no-windows-path-literals`,
 * annotated at its literal below.
 */

/** Discord probes `discord-ipc-0` through `discord-ipc-9`. */
const SOCKET_INDEX_MAX = 9

/**
 * Runtime-dir env vars, in Discord's own order of preference. `XDG_RUNTIME_DIR`
 * is the correct home; the temp vars are where a login session without one puts
 * the socket, and `/tmp` is the last resort Discord itself falls back to.
 */
const RUNTIME_DIR_ENV_KEYS = ['XDG_RUNTIME_DIR', 'TMPDIR', 'TMP', 'TEMP'] as const

// A Windows named-pipe address, not a library path: an OS IPC endpoint with a
// fixed backslash form, never stored or rejoined per platform. This is the
// "not a path" case `oscine/no-windows-path-literals` documents an exception for.
// eslint-disable-next-line oscine/no-windows-path-literals
const WINDOWS_PIPE_PREFIX = '\\\\?\\pipe\\'

export interface SocketPathEnvironment {
  readonly platform: NodeJS.Platform
  readonly env: NodeJS.ProcessEnv
}

/**
 * The ordered socket paths to probe. Lower indices first, and for each index the
 * plain, Flatpak and Snap locations — so whichever Discord is installed is found
 * without knowing in advance which one it is.
 */
export function discordSocketCandidates({ platform, env }: SocketPathEnvironment): string[] {
  if (platform === 'win32') {
    const paths: string[] = []
    for (let index = 0; index <= SOCKET_INDEX_MAX; index++) {
      paths.push(`${WINDOWS_PIPE_PREFIX}discord-ipc-${index}`)
    }
    return paths
  }

  const base = unixRuntimeDir(env)
  const dirs = [
    base,
    // Flatpak bind-mounts Discord's socket under the sandbox's xdg-run.
    path.posix.join(base, '.flatpak', 'com.discordapp.Discord', 'xdg-run'),
    // Snap confines Discord's runtime to a per-snap directory.
    path.posix.join(base, 'snap.discord')
  ]

  const paths: string[] = []
  for (let index = 0; index <= SOCKET_INDEX_MAX; index++) {
    for (const dir of dirs) paths.push(path.posix.join(dir, `discord-ipc-${index}`))
  }
  return paths
}

function unixRuntimeDir(env: NodeJS.ProcessEnv): string {
  for (const key of RUNTIME_DIR_ENV_KEYS) {
    const value = env[key]
    if (value) return value
  }
  return '/tmp'
}
