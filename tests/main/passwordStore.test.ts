/**
 * Which credential backend Fermata asks Chromium for.
 *
 * The rule is narrow on purpose — fill in a blank, never correct an answer — and
 * both halves of it are load-bearing in a way a reading of the code will not
 * show. Overriding a recognised desktop moves a KDE operator's credentials to a
 * store their session never unlocks. Failing to leave the switch off when there
 * is no keyring hangs the app at startup, inside libsecret, before there is a
 * window to report it in. Neither is a condition the app can recover from, so
 * both get a test rather than a comment.
 */

import { describe, expect, it } from 'vitest'
import {
  desktopIsRecognised,
  GNOME_LIBSECRET_STORE,
  hasKeyringOnDisk,
  keyringsDirectory,
  secretServiceIsInstalled,
  selectPasswordStore,
  type KeyringProbe
} from '../../src/main/passwordStore'

/** A fake filesystem: the set of paths that exist, with optional contents. */
function probeOf(files: Record<string, string | true>): KeyringProbe {
  return {
    read: (path) => {
      const entry = files[path]
      return typeof entry === 'string' ? entry : null
    },
    exists: (path) => path in files
  }
}

const HOME = '/home/operator'
const KEYRINGS = keyringsDirectory({}, HOME)

function select(
  env: NodeJS.ProcessEnv,
  files: Record<string, string | true> = {},
  platform: NodeJS.Platform = 'linux'
): string | null {
  return selectPasswordStore({ platform, env, homeDirectory: HOME, probe: probeOf(files) })
}

describe('where the keyrings directory is', () => {
  it('follows XDG_DATA_HOME when it is set', () => {
    expect(keyringsDirectory({ XDG_DATA_HOME: '/data' }, HOME)).toBe('/data/keyrings')
  })

  it('falls back to the specified default', () => {
    expect(keyringsDirectory({}, HOME)).toBe('/home/operator/.local/share/keyrings')
  })

  it('ignores an empty XDG_DATA_HOME rather than rooting at the separator', () => {
    expect(keyringsDirectory({ XDG_DATA_HOME: '   ' }, HOME)).toBe(
      '/home/operator/.local/share/keyrings'
    )
  })
})

describe('whether a keyring exists to be opened', () => {
  it('accepts a default file naming a keyring that is there', () => {
    const files = { [`${KEYRINGS}/default`]: 'login', [`${KEYRINGS}/login.keyring`]: true } as const
    expect(hasKeyringOnDisk(KEYRINGS, probeOf(files))).toBe(true)
  })

  it('accepts a login keyring with no default file, which is the alias fallback', () => {
    expect(hasKeyringOnDisk(KEYRINGS, probeOf({ [`${KEYRINGS}/login.keyring`]: true }))).toBe(true)
  })

  it('accepts a default naming something other than login', () => {
    const files = { [`${KEYRINGS}/default`]: 'work\n', [`${KEYRINGS}/work.keyring`]: true } as const
    expect(hasKeyringOnDisk(KEYRINGS, probeOf(files))).toBe(true)
  })

  it('accepts the keyring gnome-keyring creates for itself on a PAM-less session', () => {
    // Observed, not assumed: on a Hyprland box with no login keyring and no PAM
    // wiring, the first client to ask for a default collection got a
    // `Default_Keyring` created for it. A check that only knew about `login`
    // would call that machine keyringless while it was sitting there working.
    const files = { [`${KEYRINGS}/Default_Keyring.keyring`]: true } as const
    expect(hasKeyringOnDisk(KEYRINGS, probeOf(files))).toBe(true)
  })

  it('rejects a default that names a keyring which is not there', () => {
    expect(hasKeyringOnDisk(KEYRINGS, probeOf({ [`${KEYRINGS}/default`]: 'login' }))).toBe(false)
  })

  it('rejects an empty directory', () => {
    expect(hasKeyringOnDisk(KEYRINGS, probeOf({}))).toBe(false)
  })
})

describe('whether a secret service is installed at all', () => {
  const SERVICE = '/usr/share/dbus-1/services/org.freedesktop.secrets.service'

  it('finds the activation file in the specified default path', () => {
    expect(secretServiceIsInstalled({}, HOME, probeOf({ [SERVICE]: true }))).toBe(true)
  })

  it('honours XDG_DATA_DIRS', () => {
    const path = '/opt/share/dbus-1/services/org.freedesktop.secrets.service'
    expect(
      secretServiceIsInstalled({ XDG_DATA_DIRS: '/opt/share' }, HOME, probeOf({ [path]: true }))
    ).toBe(true)
  })

  it('looks in the per-user directory too', () => {
    const path = `${HOME}/.local/share/dbus-1/services/org.freedesktop.secrets.service`
    expect(secretServiceIsInstalled({}, HOME, probeOf({ [path]: true }))).toBe(true)
  })

  it('says no when nothing provides one', () => {
    expect(secretServiceIsInstalled({}, HOME, probeOf({}))).toBe(false)
  })
})

describe('whether Chromium already knows this desktop', () => {
  it('recognises the plain names', () => {
    for (const name of ['KDE', 'GNOME', 'XFCE', 'Cinnamon']) {
      expect(desktopIsRecognised(name)).toBe(true)
    }
  })

  it('reads the colon-separated form the specification defines', () => {
    expect(desktopIsRecognised('GNOME-Classic:GNOME')).toBe(true)
  })

  it('is case-insensitive, because sessions disagree about that', () => {
    expect(desktopIsRecognised('kde')).toBe(true)
  })

  it('does not recognise the compositors this whole file is about', () => {
    for (const name of ['Hyprland', 'sway', 'river', 'niri']) {
      expect(desktopIsRecognised(name)).toBe(false)
    }
  })

  it('does not recognise an unset variable', () => {
    expect(desktopIsRecognised(undefined)).toBe(false)
  })
})

describe('the backend Fermata asks for', () => {
  const KEYRING_PRESENT = { [`${KEYRINGS}/login.keyring`]: true } as const
  const SERVICE_INSTALLED = {
    '/usr/share/dbus-1/services/org.freedesktop.secrets.service': true
  } as const

  it('is libsecret on an unrecognised session that has a keyring', () => {
    expect(select({ XDG_CURRENT_DESKTOP: 'Hyprland' }, KEYRING_PRESENT)).toBe(GNOME_LIBSECRET_STORE)
  })

  it('is libsecret when a secret service is merely installed, keyring or not', () => {
    // The case the keyring check alone gets wrong, and the one that started
    // this: gnome-keyring installed, never run, so no keyring exists — because
    // nothing creates one until a client asks, and nothing asks until this
    // switch is passed. Requiring a keyring first is a rule that can never
    // become true on the machine that needs it.
    expect(select({ XDG_CURRENT_DESKTOP: 'Hyprland' }, SERVICE_INSTALLED)).toBe(
      GNOME_LIBSECRET_STORE
    )
  })

  it('is nothing when there is no evidence of a secret service anywhere', () => {
    // The first call to an uninitialised secret service was measured blocking
    // past thirty seconds, so a machine that has none at all is one to leave
    // alone rather than one to find out about the slow way.
    expect(select({ XDG_CURRENT_DESKTOP: 'Hyprland' }, {})).toBeNull()
  })

  it('leaves KDE alone even when a gnome keyring is sitting there', () => {
    // The case that would do real harm. Chromium sends KDE to kwallet, and
    // overriding it would write the credential somewhere the session never
    // unlocks — a sign-in that succeeds once and is gone after a reboot.
    expect(select({ XDG_CURRENT_DESKTOP: 'KDE' }, KEYRING_PRESENT)).toBeNull()
  })

  it('leaves GNOME alone, where Chromium would pick the same thing anyway', () => {
    expect(select({ XDG_CURRENT_DESKTOP: 'GNOME' }, KEYRING_PRESENT)).toBeNull()
  })

  it('handles an unset desktop, which is a bare startx session', () => {
    expect(select({}, KEYRING_PRESENT)).toBe(GNOME_LIBSECRET_STORE)
  })

  it('says nothing on Windows, which has no such switch', () => {
    expect(select({ XDG_CURRENT_DESKTOP: 'Hyprland' }, KEYRING_PRESENT, 'win32')).toBeNull()
  })

  it('yields to an operator who has already decided', () => {
    // Including on a session that would otherwise be left alone, and including
    // to `basic` — this is the way out if detection ever picks a backend that
    // hangs, and a way out that only worked in the easy cases would not be one.
    expect(
      select({ XDG_CURRENT_DESKTOP: 'KDE', FERMATA_PASSWORD_STORE: 'gnome-libsecret' }, {})
    ).toBe('gnome-libsecret')
    expect(select({ XDG_CURRENT_DESKTOP: 'Hyprland', FERMATA_PASSWORD_STORE: 'basic' })).toBe(
      'basic'
    )
  })

  it('ignores a blank override rather than passing an empty switch', () => {
    expect(select({ XDG_CURRENT_DESKTOP: 'Hyprland', FERMATA_PASSWORD_STORE: '  ' })).toBeNull()
  })
})
