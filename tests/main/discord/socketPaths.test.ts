import { describe, expect, it } from 'vitest'
import { discordSocketCandidates } from '../../../src/main/discord/socketPaths'

describe('Discord socket path probe (W20-2)', () => {
  it('lists the ten Windows named pipes, lowest index first', () => {
    const paths = discordSocketCandidates({ platform: 'win32', env: {} })
    expect(paths).toHaveLength(10)
    expect(paths[0]).toBe('\\\\?\\pipe\\discord-ipc-0')
    expect(paths[9]).toBe('\\\\?\\pipe\\discord-ipc-9')
  })

  it('covers the plain, Flatpak and Snap locations under XDG_RUNTIME_DIR on Linux', () => {
    const paths = discordSocketCandidates({
      platform: 'linux',
      env: { XDG_RUNTIME_DIR: '/run/user/1000' }
    })
    // Index-outer: all three variants for index 0 come before index 1.
    expect(paths.slice(0, 3)).toEqual([
      '/run/user/1000/discord-ipc-0',
      '/run/user/1000/.flatpak/com.discordapp.Discord/xdg-run/discord-ipc-0',
      '/run/user/1000/snap.discord/discord-ipc-0'
    ])
    expect(paths[3]).toBe('/run/user/1000/discord-ipc-1')
    expect(paths).toHaveLength(30)
  })

  it('prefers XDG_RUNTIME_DIR but falls back through the temp vars to /tmp', () => {
    expect(discordSocketCandidates({ platform: 'linux', env: { TMPDIR: '/var/tmp' } })[0]).toBe(
      '/var/tmp/discord-ipc-0'
    )
    expect(discordSocketCandidates({ platform: 'linux', env: {} })[0]).toBe('/tmp/discord-ipc-0')
  })
})
