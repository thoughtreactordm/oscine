/**
 * Which credential backend Chromium should use on Linux, when Chromium cannot
 * work it out for itself.
 *
 * ## The failure this exists for
 *
 * Chromium picks its backend from the *name* in `XDG_CURRENT_DESKTOP`, not from
 * what is actually running. `Hyprland`, `sway` and `river` are not names it
 * knows, so it falls through to `basic_text` — and for `basic_text` Electron's
 * `safeStorage.isEncryptionAvailable()` is false. Measured on Electron 43, on a
 * Hyprland session with gnome-keyring installed:
 *
 * ```
 * --password-store=(auto)            backend=basic_text       available=false
 * --password-store=basic             backend=basic_text       available=false
 * --password-store=gnome-libsecret   backend=gnome_libsecret  available=true
 * ```
 *
 * So on a bare wlroots session an operator can install gnome-keyring, start it,
 * unlock it, and watch Fermata still refuse to save a sign-in — because nothing
 * in that chain changes the string Chromium is branching on. That is not a
 * misconfiguration to be documented, it is a detection rule that does not fit,
 * and the fix belongs here.
 *
 * ## Why detection and not a switch we always pass
 *
 * The first `gnome-libsecret` run on that machine did not answer within thirty
 * seconds and was killed; every run after it answered at once, and a default
 * keyring had appeared on disk in between. The most likely reading is that
 * gnome-keyring was creating one and took its time, but that is a reading and not
 * a measurement — the honest statement is that the first call to an
 * uninitialised secret service can block for a long time, for reasons not
 * established here.
 *
 * That is enough to rule out passing the switch unconditionally, because there
 * are machines with no secret service at all and no way to find out from this
 * function which kind is in front of it. So the switch is appended only where
 * there is evidence a secret service exists: a keyring already on disk, or the
 * D-Bus activation file that would start one. Both are `stat` calls, never a
 * D-Bus round trip — this runs before `app.whenReady()`, and a probe that could
 * block would be the very failure it is guarding against.
 *
 * The call that pays the cost is not on the startup path. `credentials.read` is
 * behind a lazy cache in the Last.fm target, so the first `safeStorage` touch
 * happens when the drain worker or the settings pane first asks who is
 * connected — after there is a window to be slow in front of.
 *
 * ## What it will not second-guess
 *
 * A desktop Chromium already recognises. KDE is the case that would actually
 * hurt — Chromium sends it to kwallet, and overriding that would move a KDE
 * operator's credentials to a store their session does not unlock — so a
 * recognised name is left alone even when a gnome keyring is also present. The
 * rule is "fill in a blank", never "correct an answer".
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** The value Chromium's `--password-store` takes for the libsecret backend. */
export const GNOME_LIBSECRET_STORE = 'gnome-libsecret'

/**
 * Desktop names Chromium maps to a real backend on its own.
 *
 * Compared case-insensitively against the colon-separated tokens of
 * `XDG_CURRENT_DESKTOP`, which is how the specification says to read it and how
 * `GNOME-Classic:GNOME` arrives in practice.
 *
 * Erring towards a longer list is the safe direction: a name wrongly listed here
 * means Fermata leaves a session alone that it could have helped, which is the
 * behaviour every build had before this file. A name wrongly *missing* means
 * overriding a choice Chromium made deliberately, and for KDE that would put the
 * credential somewhere the operator's session never unlocks.
 */
const RECOGNISED_DESKTOPS: readonly string[] = [
  'kde',
  'gnome',
  'gnome-classic',
  'gnome-flashback',
  'unity',
  'cinnamon',
  'x-cinnamon',
  'pantheon',
  'xfce',
  'ukui',
  'deepin',
  'lxqt'
]

/** The file operations this needs, so a test never touches a disk. */
export interface KeyringProbe {
  /** A file's contents, or `null` when it is absent or unreadable. */
  read(path: string): string | null
  exists(path: string): boolean
}

/**
 * Where gnome-keyring keeps its keyrings.
 *
 * `XDG_DATA_HOME` when set, the specified default otherwise. Built with `join`
 * rather than by concatenation, per the repository's path invariant — this file
 * is Linux-only in effect but not in form, and the lint rule does not take
 * "only runs on Linux" for an answer.
 */
export function keyringsDirectory(env: NodeJS.ProcessEnv, homeDirectory: string): string {
  const dataHome = env.XDG_DATA_HOME?.trim()
  return dataHome !== undefined && dataHome !== ''
    ? join(dataHome, 'keyrings')
    : join(homeDirectory, '.local', 'share', 'keyrings')
}

/**
 * Whether there is a keyring for libsecret to open.
 *
 * Three ways to be satisfied, because gnome-keyring writes different things
 * depending on how the keyring came to exist and none of them is guaranteed: a
 * `default` file naming a keyring that is there, a `login.keyring` for the alias
 * to fall back to, or — the case a PAM-less session actually produces — the
 * `Default_Keyring.keyring` that gnome-keyring creates on its own the first time
 * a client asks for a default collection.
 *
 * What is deliberately *not* checked is whether it is unlocked. That is a live
 * question with a live answer, and asking it here would mean the D-Bus call this
 * function exists to avoid. A keyring that exists but is locked still selects
 * the backend, and then `safeStorage` reports it unavailable until the operator
 * unlocks it — which is the honest sequence, and recovers on its own the moment
 * they do.
 */
export function hasKeyringOnDisk(directory: string, probe: KeyringProbe): boolean {
  const named = probe.read(join(directory, 'default'))?.trim()
  if (named !== undefined && named !== '' && probe.exists(join(directory, `${named}.keyring`))) {
    return true
  }
  return (
    probe.exists(join(directory, 'login.keyring')) ||
    probe.exists(join(directory, 'Default_Keyring.keyring'))
  )
}

/**
 * Where D-Bus looks for the activation file that starts a secret service.
 *
 * The specification's search path, in its own precedence order. Fermata only
 * asks whether the file is *there* — starting the service is Chromium's business
 * and happens later, on a thread that is allowed to wait.
 */
export function secretServiceActivationPaths(
  env: NodeJS.ProcessEnv,
  homeDirectory: string
): string[] {
  const name = 'org.freedesktop.secrets.service'
  const dataHome = env.XDG_DATA_HOME?.trim()
  const userDataHome =
    dataHome !== undefined && dataHome !== '' ? dataHome : join(homeDirectory, '.local', 'share')
  const dataDirs = (env.XDG_DATA_DIRS?.trim() ?? '/usr/local/share:/usr/share')
    .split(':')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
  return [userDataHome, ...dataDirs].map((base) => join(base, 'dbus-1', 'services', name))
}

/**
 * Whether a secret service is installed, even if it has never been run.
 *
 * This is the case the keyring check alone gets wrong, and it is the common one:
 * a fresh install with gnome-keyring present and no keyring yet looks identical
 * to a machine with no secret service at all, and the operator who installs
 * gnome-keyring to fix the problem sees nothing change — because a keyring is
 * only created once something asks for one, and nothing does until this switch
 * is passed. The activation file is what distinguishes those two machines
 * without starting anything.
 */
export function secretServiceIsInstalled(
  env: NodeJS.ProcessEnv,
  homeDirectory: string,
  probe: KeyringProbe
): boolean {
  return secretServiceActivationPaths(env, homeDirectory).some((path) => probe.exists(path))
}

/** Whether `XDG_CURRENT_DESKTOP` names something Chromium already handles. */
export function desktopIsRecognised(currentDesktop: string | undefined): boolean {
  if (currentDesktop === undefined) return false
  return currentDesktop
    .split(':')
    .map((token) => token.trim().toLowerCase())
    .some((token) => token !== '' && RECOGNISED_DESKTOPS.includes(token))
}

export interface PasswordStoreSelection {
  readonly platform: NodeJS.Platform
  readonly env: NodeJS.ProcessEnv
  readonly homeDirectory: string
  readonly probe: KeyringProbe
}

/**
 * The value for `--password-store`, or `null` to leave Chromium's choice alone.
 *
 * `null` is the answer for every case that is not "Linux, unrecognised session,
 * a secret service in evidence", and returning it rather than a default is the
 * point: this
 * function's only job is to fill in a blank Chromium left, and a function that
 * always had an opinion would be one that eventually overrode a correct one.
 */
export function selectPasswordStore({
  platform,
  env,
  homeDirectory,
  probe
}: PasswordStoreSelection): string | null {
  if (platform !== 'linux') return null
  // Set by hand, by an operator who has already decided. Reading it here and
  // returning `null` keeps the precedence obvious: their flag wins, and it wins
  // by us not competing for the same switch.
  //
  // `OSCINE_PASSWORD_STORE` is the current name; `FERMATA_PASSWORD_STORE` is the
  // pre-rename spelling, still honoured so an operator who baked it into a shell
  // profile before the rename is not silently dropped back to Chromium's guess.
  // New name wins when both are set.
  const override = env.OSCINE_PASSWORD_STORE?.trim() || env.FERMATA_PASSWORD_STORE?.trim()
  if (override) return override
  if (desktopIsRecognised(env.XDG_CURRENT_DESKTOP)) return null

  const evidence =
    hasKeyringOnDisk(keyringsDirectory(env, homeDirectory), probe) ||
    secretServiceIsInstalled(env, homeDirectory, probe)
  return evidence ? GNOME_LIBSECRET_STORE : null
}

/**
 * The real filesystem, kept out of the functions above so they stay testable.
 *
 * Both calls swallow their errors into "no". A keyrings directory that cannot be
 * read is indistinguishable, for this purpose, from one that is not there — and
 * either way the answer is to leave Chromium's choice alone, which is the branch
 * that cannot hang.
 */
export function createKeyringProbe(): KeyringProbe {
  return {
    read: (path): string | null => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return null
      }
    },
    exists: (path): boolean => {
      try {
        return existsSync(path)
      } catch {
        return false
      }
    }
  }
}
